// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import ChannelArchiveScreen, { scanProgressMessage } from './ChannelArchiveScreen';
import { BulkAddProvider } from '../hooks/useBulkAddQueue';
import { LibraryTagsProvider } from '../hooks/useLibraryTags';
import { ChannelArchiveProvider, useChannelArchiveView } from '../hooks/useChannelArchive';
import type {
  ArchiveBacklogAddJobResult,
  ArchiveBacklogJob,
  ArchiveBacklogState,
  ChannelScanEntry,
  ChannelScanProgress,
  ChannelScanResult,
  LibraryVideoLookup,
} from '../../types/electron-api';

// Real timers, as in the other screen tests that drive userEvent.
const CHANNEL_URL = 'https://www.youtube.com/@veritasium';
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function deferred<V>() {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((res) => { resolve = res; });
  return { promise, resolve };
}

function entry(videoId: string, overrides: Partial<ChannelScanEntry> = {}): ChannelScanEntry {
  return { videoId, title: `Title ${videoId}`, durationSeconds: 125, approxTimestamp: 1700000000, membersOnly: false, ...overrides };
}

function scanSuccess(entries: ChannelScanEntry[], overrides: Partial<Extract<ChannelScanResult, { success: true }>> = {}): ChannelScanResult {
  return {
    success: true,
    channel: { id: 'UCHnyfMqiRRG1u-2MsSQLbXA', title: 'Veritasium', url: `${CHANNEL_URL}/videos`, avatarUrl: null },
    total: entries.length,
    entries,
    truncated: false,
    ...overrides,
  };
}

function backlogState(pendingIds: string[] = [], libraryDirMatches = true): ArchiveBacklogState {
  const jobs: ArchiveBacklogJob[] = pendingIds.length === 0 ? [] : [{
    id: 'job-old',
    channelId: null,
    channelTitle: 'Older channel',
    channelUrl: null,
    createdAt: 1,
    options: { download: false, targetResolution: '720', targetLibraryTag: 'DefaultLibrary', batchSize: 20 },
    totalCount: pendingIds.length,
    doneCount: 0,
    items: pendingIds.map((videoId) => ({ videoId, title: videoId, approxTimestamp: null, status: 'pending' as const, attempts: 0 })),
  }];
  return {
    backlog: { version: 1, libraryDir: jobs.length > 0 ? '/library' : null, completedJobs: { totalCount: 0, doneCount: 0 }, jobs },
    counts: { jobs: jobs.length, pending: pendingIds.length, errors: 0, total: pendingIds.length, done: 0 },
    libraryDir: '/library',
    libraryDirMatches,
  };
}

let scanProgressListeners: ((progress: ChannelScanProgress) => void)[] = [];
let libraryLookup: LibraryVideoLookup = {};
let beginScan: (url: string) => Promise<void>;

function addJobSuccess(added: number): ArchiveBacklogAddJobResult {
  return { success: true, jobId: 'job-new', added, duplicatesSkipped: 0, invalidSkipped: 0, ...backlogState(Array.from({ length: added }, (_, i) => `new${i}`)) };
}

function installElectronAPI({ existing = backlogState(), tags = ['DefaultLibrary'] }: { existing?: ArchiveBacklogState; tags?: string[] } = {}) {
  window.electronAPI = {
    ...window.electronAPI,
    getBacklog: vi.fn().mockResolvedValue({ success: true, ...existing }),
    addBacklogJob: vi.fn(async ({ job }: { job: { items: unknown[] } }) => addJobSuccess(job.items.length)),
    applyBacklogResults: vi.fn(),
    clearBacklog: vi.fn().mockResolvedValue({ success: true, ...backlogState() }),
    lookupLibraryVideos: vi.fn(async () => libraryLookup),
    listLibraryTags: vi.fn().mockResolvedValue({ tags: tags.map((name, i) => ({ tagName: name, folderName: name, createdEpoch: i })) }),
    getActiveLibraryTag: vi.fn().mockResolvedValue({ activeLibraryTag: 'DefaultLibrary', activeLibraryTagDir: '/library/DefaultLibrary' }),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
    getVideoInfoResult: vi.fn(() => new Promise<never>(() => {})),
    scanChannel: vi.fn(),
    cancelChannelScan: vi.fn().mockResolvedValue({ cancelled: true }),
    onChannelScanProgress: vi.fn((callback: (progress: ChannelScanProgress) => void) => {
      scanProgressListeners.push(callback);
      return callback;
    }),
    removeChannelScanProgressListener: vi.fn((listener: unknown) => {
      scanProgressListeners = scanProgressListeners.filter((l) => l !== listener);
    }),
  } as unknown as typeof window.electronAPI;
}

beforeEach(() => {
  scanProgressListeners = [];
  libraryLookup = {};
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn(),
    removeProgressListener: vi.fn(),
    cancelDownload: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

// Stands in for the two real entry points: hands the test the provider's
// own beginScan so a scan can be started the way they start one.
function ScanStarter() {
  beginScan = useChannelArchiveView().beginScan;
  return null;
}

async function renderScreen(options: Parameters<typeof installElectronAPI>[0] = {}) {
  installElectronAPI(options);
  const utils = render(
    <MemoryRouter initialEntries={['/channel-archive']}>
      <LibraryTagsProvider>
        <BulkAddProvider>
          <ChannelArchiveProvider>
            <ScanStarter />
            <Routes>
              <Route path="/" element={<div>Downloader home</div>} />
              <Route path="/channel-archive" element={<div style={{ display: 'flex' }}><ChannelArchiveScreen /></div>} />
            </Routes>
          </ChannelArchiveProvider>
        </BulkAddProvider>
      </LibraryTagsProvider>
    </MemoryRouter>,
  );
  await act(async () => { await Promise.resolve(); });
  return utils;
}

// Renders the screen already showing a finished scan. The scan is started
// before the screen mounts, as it is in the app (beginScan, then navigate).
async function renderLoaded(entries: ChannelScanEntry[], options: Parameters<typeof installElectronAPI>[0] & { scan?: Partial<Extract<ChannelScanResult, { success: true }>> } = {}) {
  installElectronAPI(options);
  asMock(window.electronAPI.scanChannel).mockResolvedValue(scanSuccess(entries, options.scan));
  render(
    <MemoryRouter initialEntries={['/start']}>
      <LibraryTagsProvider>
        <BulkAddProvider>
          <ChannelArchiveProvider>
            <ScanStarter />
            <Routes>
              <Route path="/" element={<div>Downloader home</div>} />
              <Route path="/start" element={<StartThenShow />} />
            </Routes>
          </ChannelArchiveProvider>
        </BulkAddProvider>
      </LibraryTagsProvider>
    </MemoryRouter>,
  );
  await act(async () => { await beginScan(CHANNEL_URL); });
  await screen.findByRole('table', { name: 'Channel videos' });
}

// The screen redirects to "/" whenever nothing has been scanned, so tests
// that need it already loaded render it under a path of their own and only
// once a scan exists.
function StartThenShow() {
  const view = useChannelArchiveView();
  return view.scanUrl ? <div style={{ display: 'flex' }}><ChannelArchiveScreen /></div> : <div>waiting for scan</div>;
}

function availableTable() {
  return within(screen.getByRole('table', { name: 'Channel videos' }));
}

function queueTable() {
  return within(screen.getByRole('table', { name: 'Download queue' }));
}

function lastAddJobCall() {
  const calls = asMock(window.electronAPI.addBacklogJob).mock.calls;
  return calls[calls.length - 1][0];
}

async function queueVideos(user: ReturnType<typeof userEvent.setup>, videoIds: string[]) {
  for (const videoId of videoIds) {
    await user.click(availableTable().getByRole('checkbox', { name: `Select Title ${videoId}` }));
  }
  await user.click(screen.getByRole('button', { name: `Add to download queue (${videoIds.length})` }));
}

describe('scanProgressMessage', () => {
  it('describes each stage', () => {
    expect(scanProgressMessage({ status: 'resolving', found: 0, total: null })).toBe('Looking up the channel…');
    expect(scanProgressMessage({ status: 'counting', found: 0, total: null })).toBe('Counting videos…');
    expect(scanProgressMessage({ status: 'listing', found: 120, total: 450 })).toBe('Fetched 120 of ~450 videos');
    expect(scanProgressMessage({ status: 'listing', found: 450, total: 450 })).toBe('Fetched 450 of ~450 videos');
  });

  it('drops the total when it is unknown or already passed', () => {
    expect(scanProgressMessage({ status: 'listing', found: 120, total: null })).toBe('Fetched 120 videos');
    expect(scanProgressMessage({ status: 'listing', found: 460, total: 450 })).toBe('Fetched 460 videos');
  });
});

describe('ChannelArchiveScreen: nothing scanned', () => {
  it('redirects to the Downloader', async () => {
    await renderScreen();
    expect(screen.getByText('Downloader home')).toBeInTheDocument();
    expect(window.electronAPI.scanChannel).not.toHaveBeenCalled();
  });
});

describe('ChannelArchiveScreen: scanning', () => {
  async function renderScanning() {
    installElectronAPI();
    const pending = deferred<ChannelScanResult>();
    asMock(window.electronAPI.scanChannel).mockReturnValue(pending.promise);
    render(
      <MemoryRouter initialEntries={['/start']}>
        <LibraryTagsProvider>
          <BulkAddProvider>
            <ChannelArchiveProvider>
              <ScanStarter />
              <Routes>
                <Route path="/" element={<div>Downloader home</div>} />
                <Route path="/start" element={<StartThenShow />} />
              </Routes>
            </ChannelArchiveProvider>
          </BulkAddProvider>
        </LibraryTagsProvider>
      </MemoryRouter>,
    );
    act(() => { beginScan(CHANNEL_URL); });
    const scanId = asMock(window.electronAPI.scanChannel).mock.calls[0][0];
    const progress = (stage: ChannelScanProgress['stage'], found: number, total: number | null) => act(() => scanProgressListeners.forEach((l) => l({ scanId, stage, found, total })));
    return { pending, progress, scanId };
  }

  it('shows a message for each stage, with the running count', async () => {
    const { progress } = await renderScanning();
    expect(screen.getByRole('status')).toHaveTextContent('Looking up the channel…');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    progress('counting', 0, null);
    expect(screen.getByRole('status')).toHaveTextContent('Counting videos…');
    progress('listing', 120, 450);
    expect(screen.getByRole('status')).toHaveTextContent('Fetched 120 of ~450 videos');
    progress('listing', 460, 450);
    expect(screen.getByRole('status')).toHaveTextContent('Fetched 460 videos');
    progress('listing', 30, null);
    expect(screen.getByRole('status')).toHaveTextContent('Fetched 30 videos');
  });

  it('Cancel stops the scan and goes back to the Downloader', async () => {
    const user = userEvent.setup();
    const { scanId, pending } = await renderScanning();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(window.electronAPI.cancelChannelScan).toHaveBeenCalledWith(scanId);
    expect(screen.getByText('Downloader home')).toBeInTheDocument();
    // The cancelled scan's late answer must not bring anything back.
    await act(async () => { pending.resolve(scanSuccess([entry('v1')])); });
    expect(screen.getByText('Downloader home')).toBeInTheDocument();
  });

  it('shows a readable error with Try again and Back', async () => {
    const user = userEvent.setup();
    const { pending } = await renderScanning();
    await act(async () => { pending.resolve({ success: false, kind: 'botBlock', message: 'Sign in to confirm you\'re not a bot', cancelled: false }); });

    expect(screen.getByText('The channel could not be scanned')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Add cookies from a signed-in account in Options/);

    asMock(window.electronAPI.scanChannel).mockResolvedValue({ success: false, kind: 'unknown', message: 'This channel does not exist.', cancelled: false });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(window.electronAPI.scanChannel).toHaveBeenCalledTimes(2));
    expect(asMock(window.electronAPI.scanChannel).mock.calls[1][1]).toBe(CHANNEL_URL);
    expect(await screen.findByText('This channel does not exist.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Downloader home')).toBeInTheDocument();
  });
});

describe('ChannelArchiveScreen: loaded', () => {
  const ENTRIES = [entry('v1'), entry('v2', { membersOnly: true }), entry('v3'), entry('v4')];

  it('shows the channel, the counts, and which videos are already in the library', async () => {
    libraryLookup = { v3: { videoDir: '/library/c/v3', latestEpoch: '1', hasVideoFile: false, hasAudioFile: false } };
    await renderLoaded(ENTRIES);

    expect(screen.getByRole('heading', { name: 'Veritasium' })).toBeInTheDocument();
    expect(await screen.findByText('4 videos found · 1 already in your library')).toBeInTheDocument();
    expect(window.electronAPI.lookupLibraryVideos).toHaveBeenCalledWith(['v1', 'v2', 'v3', 'v4'], 'DefaultLibrary');

    const inLibraryBox = availableTable().getByRole('checkbox', { name: 'Select Title v3' });
    expect(inLibraryBox).toBeDisabled();
    expect(within(inLibraryBox.closest('tr')!).getByText('In library')).toBeInTheDocument();
    expect(within(availableTable().getByRole('checkbox', { name: 'Select Title v2' }).closest('tr')!).getByText('Members only')).toBeInTheDocument();
    expect(availableTable().getAllByText('2:05')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Add 0 videos' })).toBeDisabled();
    expect(screen.getByText(/Each video is fetched individually/)).toBeInTheDocument();
  });

  it('select-all leaves out the videos already in the library', async () => {
    const user = userEvent.setup();
    libraryLookup = { v3: { videoDir: '/library/c/v3', latestEpoch: '1', hasVideoFile: false, hasAudioFile: false } };
    await renderLoaded(ENTRIES);
    await screen.findByText(/1 already in your library/);

    await user.click(availableTable().getByRole('checkbox', { name: 'Select all videos' }));
    await user.click(screen.getByRole('button', { name: 'Add to download queue (3)' }));
    expect(queueTable().getAllByRole('checkbox', { name: /^Select Title/ })).toHaveLength(3);
    expect(availableTable().getAllByRole('checkbox', { name: /^Select Title/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add 3 videos' })).toBeEnabled();
  });

  it('notes a truncated listing', async () => {
    await renderLoaded(ENTRIES, { scan: { truncated: true } });
    expect(screen.getByText(/only the newest are shown/)).toBeInTheDocument();
  });

  it('moves selected videos to the queue and back out of it', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES);
    expect(screen.getByRole('button', { name: 'Add to download queue (0)' })).toBeDisabled();
    expect(screen.getByText('Nothing chosen yet. Select videos on the left and add them here.')).toBeInTheDocument();

    await queueVideos(user, ['v4', 'v1']);
    expect(queueTable().getByRole('checkbox', { name: 'Select Title v4' })).toBeInTheDocument();
    expect(queueTable().getByRole('checkbox', { name: 'Select Title v1' })).toBeInTheDocument();
    expect(availableTable().queryByRole('checkbox', { name: 'Select Title v1' })).not.toBeInTheDocument();
    expect(availableTable().getByRole('checkbox', { name: 'Select Title v2' })).toBeInTheDocument();
    // The selection that was moved is cleared.
    expect(screen.getByRole('button', { name: 'Add to download queue (0)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add 2 videos' })).toBeEnabled();

    await user.click(queueTable().getByRole('checkbox', { name: 'Select Title v4' }));
    await user.click(screen.getByRole('button', { name: 'Remove selected (1)' }));
    expect(queueTable().queryByRole('checkbox', { name: 'Select Title v4' })).not.toBeInTheDocument();
    expect(availableTable().getByRole('checkbox', { name: 'Select Title v4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 1 video' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove selected (0)' })).toBeDisabled();
  });

  it('submits the queue with the default options and shows that archiving started', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES);
    expect(screen.queryByLabelText('Quality')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add to')).not.toBeInTheDocument();
    await queueVideos(user, ['v2', 'v1']);
    await user.click(screen.getByRole('button', { name: 'Add 2 videos' }));

    expect(await screen.findByText('Archiving 2 videos from Veritasium has started.')).toBeInTheDocument();
    expect(screen.getByText('Progress is in the bulk add panel.')).toBeInTheDocument();
    expect(lastAddJobCall()).toEqual({
      mode: 'append',
      job: {
        channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
        channelTitle: 'Veritasium',
        channelUrl: `${CHANNEL_URL}/videos`,
        options: { download: false, targetResolution: '720', targetLibraryTag: 'DefaultLibrary', batchSize: 20 },
        items: [
          { videoId: 'v2', title: 'Title v2', approxTimestamp: 1700000000 },
          { videoId: 'v1', title: 'Title v1', approxTimestamp: 1700000000 },
        ],
      },
    });

    await user.click(screen.getByRole('button', { name: 'Add more from this channel' }));
    expect(queueTable().queryByRole('checkbox', { name: /^Select Title/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 0 videos' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add to download queue (0)' })).toBeDisabled();
  });

  it('Done on the confirmation goes back to the Downloader', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES);
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));
    expect(await screen.findByText('Archiving 1 video from Veritasium has started.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Downloader home')).toBeInTheDocument();
  });

  it('sends the chosen download quality, sublibrary and a custom batch size', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES, { tags: ['DefaultLibrary', 'Music'] });

    await user.click(screen.getByRole('switch', { name: 'Also download each video' }));
    await user.click(screen.getByRole('combobox', { name: 'Quality' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p', 'MP3']);
    await user.click(screen.getByRole('option', { name: '1080p' }));

    await user.click(await screen.findByRole('combobox', { name: 'Add to' }));
    await user.click(screen.getByRole('option', { name: 'Music' }));
    await waitFor(() => expect(window.electronAPI.lookupLibraryVideos).toHaveBeenLastCalledWith(['v1', 'v2', 'v3', 'v4'], 'Music'));

    expect(screen.getByText('Videos handed to the queue at a time')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Batch size' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['10', '20', '30', '40', '50', 'Other…']);
    await user.click(screen.getByRole('option', { name: 'Other…' }));
    const custom = screen.getByLabelText('Custom batch size');
    await user.clear(custom);
    await user.type(custom, '999');
    await user.tab();
    expect(custom).toHaveValue(500);

    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));
    await screen.findByText(/has started/);
    expect(lastAddJobCall().job.options).toEqual({ download: true, targetResolution: '1080', targetLibraryTag: 'Music', batchSize: 500 });
  });

  it('a preset batch size is sent as chosen, and a custom one below the minimum is raised to it', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES);
    await user.click(screen.getByRole('combobox', { name: 'Batch size' }));
    await user.click(screen.getByRole('option', { name: '40' }));
    expect(screen.queryByLabelText('Custom batch size')).not.toBeInTheDocument();
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));
    await screen.findByText(/has started/);
    expect(lastAddJobCall().job.options.batchSize).toBe(40);

    await user.click(screen.getByRole('button', { name: 'Add more from this channel' }));
    await user.click(screen.getByRole('combobox', { name: 'Batch size' }));
    await user.click(screen.getByRole('option', { name: 'Other…' }));
    const custom = screen.getByLabelText('Custom batch size');
    await user.clear(custom);
    await user.type(custom, '0');
    await user.tab();
    expect(custom).toHaveValue(1);
  });

  it('asks whether to add to or replace an existing backlog, and appends when asked to', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES, { existing: backlogState(['o1', 'o2', 'o3']) });
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('3 videos are still waiting in the backlog. Replacing it discards them.')).toBeInTheDocument();
    expect(window.electronAPI.addBacklogJob).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Add to the existing backlog' }));
    expect(await screen.findByText(/has started/)).toBeInTheDocument();
    expect(lastAddJobCall().mode).toBe('append');
  });

  it('replaces the existing backlog when asked to', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES, { existing: backlogState(['o1']) });
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1 video is still waiting in the backlog. Replacing it discards them.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Replace the backlog' }));
    expect(await screen.findByText(/has started/)).toBeInTheDocument();
    expect(lastAddJobCall().mode).toBe('replace');
  });

  it('Cancel in that dialog submits nothing and keeps the queue', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES, { existing: backlogState(['o1']) });
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.electronAPI.addBacklogJob).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add 1 video' })).toBeEnabled();
  });

  it('offers only Replace when the existing backlog belongs to another library folder', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES, { existing: backlogState(['o1', 'o2'], false) });
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/queued for a different library folder.*discards its 2 unprocessed videos/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add to the existing backlog' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Replace the backlog' }));
    expect(await screen.findByText(/has started/)).toBeInTheDocument();
    expect(lastAddJobCall().mode).toBe('replace');
  });

  it('falls back to offering Replace when an append is refused for a library-folder mismatch', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES);
    asMock(window.electronAPI.addBacklogJob).mockResolvedValueOnce({ success: false, reason: 'libraryDirMismatch', ...backlogState(['o1'], false) });
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/different library folder/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add to the existing backlog' })).not.toBeInTheDocument();
    // The queue is still there behind the dialog.
    expect(screen.getByRole('button', { name: 'Add 1 video', hidden: true })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Replace the backlog' }));
    expect(await screen.findByText(/has started/)).toBeInTheDocument();
    expect(lastAddJobCall().mode).toBe('replace');
  });

  it('shows why when the backlog refuses the videos for another reason, and keeps the queue', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES);
    asMock(window.electronAPI.addBacklogJob).mockResolvedValueOnce({ success: false, reason: 'noLibraryDir', ...backlogState() });
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));

    expect(await screen.findByText('Choose a library folder in Options before archiving a channel.')).toBeInTheDocument();
    expect(screen.queryByText(/has started/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 1 video' })).toBeEnabled();
  });

  it('the close control clears the scan and goes back to the Downloader', async () => {
    const user = userEvent.setup();
    await renderLoaded(ENTRIES);
    await user.click(screen.getByRole('button', { name: 'Close channel view' }));
    expect(screen.getByText('Downloader home')).toBeInTheDocument();
  });
});

describe('ChannelArchiveScreen: channel picture', () => {
  const withAvatar = (avatarUrl: string | null) => ({ scan: { channel: { id: null, title: 'Veritasium', url: `${CHANNEL_URL}/videos`, avatarUrl } } });

  it('shows the channel picture next to the title', async () => {
    await renderLoaded([entry('v1')], withAvatar('https://yt3.googleusercontent.com/avatar=s900'));
    const header = screen.getByRole('heading', { name: 'Veritasium' }).closest('div')!.parentElement!;
    const img = header.querySelector('img');
    expect(img).toHaveAttribute('src', 'https://yt3.googleusercontent.com/avatar=s900');
    expect(img).toHaveAttribute('alt', '');
  });

  it('falls back to the channel\'s initial when there is no picture', async () => {
    await renderLoaded([entry('v1')], withAvatar(null));
    const header = screen.getByRole('heading', { name: 'Veritasium' }).closest('div')!.parentElement!;
    expect(header.querySelector('img')).toBeNull();
    expect(within(header).getByText('V')).toBeInTheDocument();
  });

  it('does not render a picture URL that is not plain https', async () => {
    await renderLoaded([entry('v1')], withAvatar('http://example.com/a.jpg'));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('shows it on the confirmation too', async () => {
    const user = userEvent.setup();
    await renderLoaded([entry('v1')], withAvatar('https://yt3.googleusercontent.com/avatar=s900'));
    await queueVideos(user, ['v1']);
    await user.click(screen.getByRole('button', { name: 'Add 1 video' }));
    await screen.findByText(/has started/);
    expect(document.querySelector('img')).toHaveAttribute('src', 'https://yt3.googleusercontent.com/avatar=s900');
  });
});

describe('ChannelArchiveScreen: approximate-date notice', () => {
  it('explains why dates are approximate, and can be dismissed', async () => {
    const user = userEvent.setup();
    await renderLoaded([entry('v1')]);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent(/Dates here are approximate/);
    expect(notice).toHaveTextContent(/only gives each video's age/);
    expect(notice).toHaveTextContent(/older ones only the month or the year/);
    expect(notice).toHaveTextContent(/date filter works on these approximate dates/);
    expect(notice).toHaveTextContent(/exact upload date is saved once a video is added/);

    await user.click(within(notice).getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/Dates here are approximate/)).not.toBeInTheDocument();
  });
});

describe('ChannelArchiveScreen: download size estimate', () => {
  const HOUR_ENTRIES = [entry('v1', { durationSeconds: 3600 }), entry('v2', { durationSeconds: 7200 }), entry('v3', { durationSeconds: null })];

  it('is hidden while downloading is off or nothing is queued', async () => {
    const user = userEvent.setup();
    await renderLoaded(HOUR_ENTRIES);
    expect(screen.queryByText(/Estimated download size/)).not.toBeInTheDocument();

    await queueVideos(user, ['v1']);
    expect(screen.queryByText(/Estimated download size/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Also download each video' }));
    expect(screen.getByText(/Estimated download size/)).toBeInTheDocument();

    await user.click(queueTable().getByRole('checkbox', { name: 'Select Title v1' }));
    await user.click(screen.getByRole('button', { name: 'Remove selected (1)' }));
    expect(screen.queryByText(/Estimated download size/)).not.toBeInTheDocument();
  });

  it('adds up the queued videos at the chosen quality, says it is rough, and follows the quality and the queue', async () => {
    const user = userEvent.setup();
    await renderLoaded(HOUR_ENTRIES);
    await user.click(screen.getByRole('switch', { name: 'Also download each video' }));
    await queueVideos(user, ['v1']);
    // One hour at 720p's typical 2000 kbps = 900 MB (decimal) = 858 MiB.
    expect(screen.getByText('Estimated download size: about 860 MB (rough estimate)')).toBeInTheDocument();
    expect(screen.getByLabelText('About this estimate')).toBeInTheDocument();

    await queueVideos(user, ['v2']);
    expect(screen.getByText('Estimated download size: about 2.5 GB (rough estimate)')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Quality' }));
    await user.click(screen.getByRole('option', { name: '1080p' }));
    expect(screen.getByText('Estimated download size: about 5 GB (rough estimate)')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Quality' }));
    await user.click(screen.getByRole('option', { name: 'MP3' }));
    expect(screen.getByText('Estimated download size: about 250 MB (rough estimate)')).toBeInTheDocument();
  });

  it('says how many queued videos were left out for having no known length', async () => {
    const user = userEvent.setup();
    await renderLoaded(HOUR_ENTRIES);
    await user.click(screen.getByRole('switch', { name: 'Also download each video' }));
    await queueVideos(user, ['v1', 'v3']);
    expect(screen.getByText('Estimated download size: about 860 MB (rough estimate) · 1 video with unknown length not included')).toBeInTheDocument();
  });

  it('explains what the estimate assumes', async () => {
    const user = userEvent.setup();
    await renderLoaded(HOUR_ENTRIES);
    await user.click(screen.getByRole('switch', { name: 'Also download each video' }));
    await queueVideos(user, ['v1']);
    await user.hover(screen.getByLabelText('About this estimate'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(/typical bitrate for the chosen quality/);
    expect(tooltip).toHaveTextContent(/assumes every video is available at that quality/);
    expect(tooltip).toHaveTextContent(/real sizes vary/);
  });
});
