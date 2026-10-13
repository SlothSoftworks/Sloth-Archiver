// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BulkAddSidePanel, { BulkAddToggleButton } from './BulkAddSidePanel';
import { BulkAddProvider, useBulkAddQueue } from '../hooks/useBulkAddQueue';
import { LibraryTagsProvider } from '../hooks/useLibraryTags';
import { MemoryRouter } from 'react-router';
import { ChannelArchiveProvider } from '../hooks/useChannelArchive';
import { describeBacklogError } from './ArchiveBacklogStatus';
import type { ArchiveBacklogItem, ArchiveBacklogJob, ArchiveBacklogState } from '../../types/electron-api';

// Real timers throughout this file, deliberately -- combining fake timers
// with @testing-library/user-event's click simulation turned out to hang
// indefinitely even with delay:null + advanceTimers wired up (some deeper
// interaction between user-event's internal waits and React 19's act()
// under fake timers, not resolved after several attempts). The only place
// that actually needs to get past the queue's real 2s inter-item delay uses
// waitFor's own polling with a longer timeout instead of advancing a fake
// clock -- slower (a couple of real seconds) but reliable.
beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getVideoInfoResult: vi.fn(),
    findLibraryVideo: vi.fn(),
    addLibraryEntry: vi.fn(),
    enrichPlaylistEntry: vi.fn().mockResolvedValue({ success: true }),
    recordLibraryDownload: vi.fn().mockResolvedValue({ success: true }),
    fetchPlaylistEntries: vi.fn(),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [] }),
    getActiveLibraryTag: vi.fn().mockResolvedValue({ activeLibraryTag: 'DefaultLibrary', activeLibraryTagDir: '' }),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn(),
    removeProgressListener: vi.fn(),
    cancelDownload: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

// A small helper component so tests can drive real queue state (via the
// actual hook, same integration style as useBulkAddQueue.test.tsx) and
// render the panel against it, rather than trying to fake the panel's props
// directly -- BulkAddSidePanel takes no props at all, it only reads context.
function Harness({ onReady }: { onReady: (queue: ReturnType<typeof useBulkAddQueue>) => void }) {
  const queue = useBulkAddQueue();
  onReady(queue);
  return (
    <>
      <BulkAddToggleButton />
      <BulkAddSidePanel />
    </>
  );
}

function renderPanel() {
  let queue!: ReturnType<typeof useBulkAddQueue>;
  const utils = render(
    <MemoryRouter><LibraryTagsProvider><BulkAddProvider><Harness onReady={(q) => { queue = q; }} /></BulkAddProvider></LibraryTagsProvider></MemoryRouter>,
  );
  return { ...utils, getQueue: () => queue };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe('BulkAddToggleButton', () => {
  it('toggles the panel open', async () => {
    const user = userEvent.setup();
    renderPanel();
    // MUI's Drawer doesn't render its children into the DOM at all while
    // closed (no keepMounted), so the panel's content genuinely isn't there yet.
    expect(screen.queryByText('Nothing queued yet -- hit the + button to add a playlist or a list of links.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Bulk add' }));
    expect(screen.getByText('Nothing queued yet -- hit the + button to add a playlist or a list of links.')).toBeVisible();
  });
});

describe('BulkAddSidePanel', () => {
  it('lists queued items with a status chip once items are added', async () => {
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'My Video' }, fromCache: false,
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true });

    const { getQueue } = renderPanel();
    act(() => getQueue().start([{ id: 'e1', title: null, url: 'https://youtu.be/v1' }], { download: false, targetResolution: 'dflt' }));
    await flush();

    expect(screen.getByText('My Video')).toBeInTheDocument();
    expect(screen.getByText('Already in library')).toBeInTheDocument();
  });

  it('shows "Stop after current item" while running, and it requests a stop', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {})); // stays "fetching"
    const { getQueue } = renderPanel();
    act(() => getQueue().start([{ id: 'e1', title: null, url: 'https://youtu.be/v1' }], { download: false, targetResolution: 'dflt' }));
    await flush();

    const stopButton = screen.getByRole('button', { name: 'Stop after current item' });
    await user.click(stopButton);
    expect(screen.getByText('Stopping after this item...')).toBeInTheDocument();
  });

  it('offers Resume and Cancel all pending once stopped with items still pending', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, videoInfo: { id: 'v1', fullTitle: 'One' }, fromCache: false });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true });

    const { getQueue } = renderPanel();
    act(() => getQueue().start(
      [{ id: 'e1', title: null, url: 'https://youtu.be/v1' }, { id: 'e2', title: null, url: 'https://youtu.be/v2' }],
      { download: false, targetResolution: 'dflt' },
    ));
    await flush();
    act(() => getQueue().stop());
    // Real ~2s wait for the queue's own ITEM_DELAY_MS sleep between items to
    // actually elapse -- waitFor polls rather than a single blind sleep.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument(), { timeout: 3000 });

    const cancelButton = screen.getByRole('button', { name: 'Cancel all pending' });
    await user.click(cancelButton);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  }, 10000);

  it('"Clear done" removes finished items from the list', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'My Video' }, fromCache: false,
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true });

    const { getQueue } = renderPanel();
    act(() => getQueue().start([{ id: 'e1', title: null, url: 'https://youtu.be/v1' }], { download: false, targetResolution: 'dflt' }));
    await flush();
    expect(screen.getByText('My Video')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear done' }));
    expect(screen.queryByText('My Video')).not.toBeInTheDocument();
  });

  it('opens the add dialog from the + button', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Bulk add' })); // open the panel first -- the + button only exists once it's open
    await user.click(screen.getByRole('button', { name: 'Add a playlist or list of links' }));
    // "Bulk add" itself renders twice once both the drawer and the dialog it
    // opens are on screen (the drawer's own h6 title + the dialog's title) --
    // asserting on the dialog's own descriptive body text avoids that ambiguity.
    expect(screen.getByText(/Paste a single YouTube playlist link/)).toBeInTheDocument();
  });
});

function backlogItem(videoId: string, overrides: Partial<ArchiveBacklogItem> = {}): ArchiveBacklogItem {
  return { videoId, title: `Title ${videoId}`, approxTimestamp: null, status: 'pending', attempts: 0, ...overrides };
}

function backlogJob(id: string, channelTitle: string, items: ArchiveBacklogItem[], targetLibraryTag = 'DefaultLibrary', doneCount = 0): ArchiveBacklogJob {
  return {
    id, channelId: null, channelTitle, channelUrl: null, createdAt: 1,
    options: { download: false, targetResolution: '720', targetLibraryTag, batchSize: 20 },
    totalCount: items.length + doneCount,
    doneCount,
    items,
  };
}

function backlogStateOf(jobs: ArchiveBacklogJob[], libraryDirMatches = true): ArchiveBacklogState {
  const items = jobs.flatMap((job) => job.items);
  return {
    backlog: { version: 1, libraryDir: jobs.length > 0 ? '/old-library' : null, completedJobs: { totalCount: 0, doneCount: 0 }, jobs },
    counts: {
      jobs: jobs.length,
      pending: items.filter((i) => i.status === 'pending').length,
      errors: items.filter((i) => i.status === 'error').length,
      total: jobs.reduce((sum, job) => sum + job.totalCount, 0),
      done: jobs.reduce((sum, job) => sum + job.doneCount, 0),
    },
    libraryDir: '/library',
    libraryDirMatches,
  };
}

const EMPTY_BACKLOG = backlogStateOf([]);

// The panel as App.tsx mounts it, with the channel-archive provider above
// it and the backlog IPC answering with the given state.
async function renderPanelWithBacklog(state: ArchiveBacklogState, { open = true }: { open?: boolean } = {}) {
  window.electronAPI = {
    ...window.electronAPI,
    getBacklog: vi.fn().mockResolvedValue({ success: true, ...state }),
    clearBacklog: vi.fn().mockResolvedValue({ success: true, ...EMPTY_BACKLOG }),
    retryBacklogErrors: vi.fn().mockResolvedValue({ success: true, retried: 0, ...state }),
    dismissBacklogErrors: vi.fn().mockResolvedValue({ success: true, dismissed: 0, ...state }),
    applyBacklogResults: vi.fn(),
    // Never answers, so a started run stays "running" on its first batch.
    lookupLibraryVideos: vi.fn(() => new Promise<never>(() => {})),
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [{ tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: 1 }] }),
  };
  let queue!: ReturnType<typeof useBulkAddQueue>;
  const utils = render(
    <MemoryRouter>
      <LibraryTagsProvider>
        <BulkAddProvider>
          <ChannelArchiveProvider>
            <Harness onReady={(q) => { queue = q; }} />
          </ChannelArchiveProvider>
        </BulkAddProvider>
      </LibraryTagsProvider>
    </MemoryRouter>,
  );
  await flush();
  if (open) act(() => queue.setPanelOpen(true));
  return { ...utils, getQueue: () => queue };
}

function backlogRegion() {
  return within(screen.getByRole('region', { name: 'Channel archive backlog' }));
}

describe('describeBacklogError', () => {
  it('gives a readable reason per kind, and the message for anything else', () => {
    expect(describeBacklogError({ errorKind: 'ageRestricted', errorMessage: 'x' })).toBe('Age-restricted');
    expect(describeBacklogError({ errorKind: 'unavailable', errorMessage: 'x' })).toBe('Private or unavailable');
    expect(describeBacklogError({ errorKind: 'loginRequired', errorMessage: 'x' })).toBe('Members-only or sign-in required');
    expect(describeBacklogError({ errorKind: 'geoBlocked', errorMessage: 'x' })).toBe('Not available in your region');
    expect(describeBacklogError({ errorKind: 'cancelled', errorMessage: 'Cancelled.' })).toBe('Cancelled');
    expect(describeBacklogError({ errorKind: 'unknown', errorMessage: 'HTTP Error 500' })).toBe('Failed: HTTP Error 500');
    expect(describeBacklogError({ errorKind: 'botBlock', errorMessage: '' })).toBe('Failed');
  });
});

describe('BulkAddSidePanel: channel backlog', () => {
  it('shows nothing about a backlog when there is no channel-archive provider', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Bulk add' }));
    expect(screen.queryByRole('region', { name: 'Channel archive backlog' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Backlog pending')).not.toBeInTheDocument();
  });

  it('shows nothing about a backlog when the backlog is empty', async () => {
    await renderPanelWithBacklog(EMPTY_BACKLOG);
    expect(screen.getByText('Nothing queued yet -- hit the + button to add a playlist or a list of links.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Channel archive backlog' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Backlog pending')).not.toBeInTheDocument();
  });

  it('puts a dot on the toggle while a backlog is waiting, alongside the queue count', async () => {
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const { getQueue } = await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1')])]), { open: false });
    expect(screen.getByLabelText('Backlog pending')).toBeInTheDocument();

    act(() => getQueue().start(
      [{ id: 'e1', title: null, url: 'https://youtu.be/a' }, { id: 'e2', title: null, url: 'https://youtu.be/b' }],
      { download: false, targetResolution: 'dflt' },
      { openPanel: false },
    ));
    const toggle = screen.getByRole('button', { name: 'Bulk add' });
    expect(within(toggle).getByText('2')).toBeInTheDocument();
    expect(within(toggle).getByLabelText('Backlog pending')).toBeInTheDocument();
  });

  it('summarises the backlog and offers Resume when nothing is running', async () => {
    await renderPanelWithBacklog(backlogStateOf([
      backlogJob('j1', 'Veritasium', [backlogItem('v1'), backlogItem('v2'), backlogItem('v3', { status: 'error', errorKind: 'unavailable', errorMessage: 'gone' })]),
      backlogJob('j2', 'Kurzgesagt', [backlogItem('v4')]),
    ]));
    const region = backlogRegion();
    expect(region.getByText('Channel backlog: Veritasium, Kurzgesagt')).toBeInTheDocument();
    expect(region.getByText('3 pending · 1 error')).toBeInTheDocument();
    expect(region.getByText('Not running')).toBeInTheDocument();
    expect(region.getByRole('button', { name: 'Resume backlog' })).toBeEnabled();
    expect(region.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(region.getByRole('button', { name: 'Retry errors' })).toBeInTheDocument();
    expect(region.getByRole('button', { name: 'Dismiss errors' })).toBeInTheDocument();
    expect(region.getByRole('button', { name: 'Remove backlog' })).toBeInTheDocument();
  });

  it('counts channels instead of naming them when there are more than two', async () => {
    await renderPanelWithBacklog(backlogStateOf([
      backlogJob('j1', 'A', [backlogItem('v1')]),
      backlogJob('j2', 'B', [backlogItem('v2')]),
      backlogJob('j3', 'C', [backlogItem('v3')]),
      backlogJob('j4', 'A', [backlogItem('v4')]),
    ]));
    expect(backlogRegion().getByText('Channel backlog: 3 channels')).toBeInTheDocument();
    expect(backlogRegion().getByText('4 pending · 0 errors')).toBeInTheDocument();
  });

  it('Resume starts the run; Pause then shows that it will stop after the batch', async () => {
    const user = userEvent.setup();
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1'), backlogItem('v2')])]));
    await user.click(backlogRegion().getByRole('button', { name: 'Resume backlog' }));

    expect(await backlogRegion().findByText('Running')).toBeInTheDocument();
    expect(window.electronAPI.lookupLibraryVideos).toHaveBeenCalledWith(['v1', 'v2'], 'DefaultLibrary');
    expect(backlogRegion().queryByRole('button', { name: 'Resume backlog' })).not.toBeInTheDocument();

    await user.click(backlogRegion().getByRole('button', { name: 'Pause' }));
    expect(backlogRegion().getByText('Pausing after this batch…')).toBeInTheDocument();
    expect(backlogRegion().getByRole('button', { name: 'Pause' })).toBeDisabled();
  });

  it('shows why a run paused, and offers Resume again', async () => {
    const user = userEvent.setup();
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1')])]));
    (window.electronAPI.lookupLibraryVideos as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk unplugged'));
    await user.click(backlogRegion().getByRole('button', { name: 'Resume backlog' }));

    expect(await backlogRegion().findByText('The backlog run stopped: disk unplugged')).toBeInTheDocument();
    expect(backlogRegion().getByRole('button', { name: 'Resume backlog' })).toBeEnabled();
  });

  it('disables Resume and says why when the backlog belongs to another library folder', async () => {
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1')])], false));
    expect(backlogRegion().getByRole('button', { name: 'Resume backlog' })).toBeDisabled();
    expect(backlogRegion().getByText(/queued for a different library folder \(\/old-library\)/)).toBeInTheDocument();
  });

  it('disables Resume and says why when the target sublibrary is gone', async () => {
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1')], 'Gone')]));
    expect(backlogRegion().getByRole('button', { name: 'Resume backlog' })).toBeDisabled();
    expect(backlogRegion().getByText(/The sublibrary "Gone" no longer exists/)).toBeInTheDocument();
  });

  it('Remove backlog confirms with the number of unprocessed videos before clearing', async () => {
    const user = userEvent.setup();
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [
      backlogItem('v1'), backlogItem('v2'), backlogItem('v3'), backlogItem('v4', { status: 'error', errorKind: 'unknown', errorMessage: 'x' }),
    ])]));
    await user.click(backlogRegion().getByRole('button', { name: 'Remove backlog' }));

    const dialog = screen.getByRole('dialog', { name: 'Remove backlog?' });
    expect(within(dialog).getByText(/4 unprocessed videos will be discarded/)).toBeInTheDocument();
    expect(window.electronAPI.clearBacklog).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove backlog?' })).not.toBeInTheDocument());
    expect(window.electronAPI.clearBacklog).not.toHaveBeenCalled();

    await user.click(backlogRegion().getByRole('button', { name: 'Remove backlog' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Remove backlog?' })).getByRole('button', { name: 'Remove backlog' }));
    await waitFor(() => expect(window.electronAPI.clearBacklog).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Channel archive backlog' })).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Backlog pending')).not.toBeInTheDocument();
  });

  it('lists the videos with errors on demand, with a reason each and a pointer to cookies where they help', async () => {
    const user = userEvent.setup();
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [
      backlogItem('v1', { status: 'error', errorKind: 'ageRestricted', errorMessage: 'Sign in to confirm your age' }),
      backlogItem('v2', { status: 'error', errorKind: 'unknown', errorMessage: 'HTTP Error 500' }),
    ])]));
    const region = backlogRegion();
    expect(region.getByText('0 pending · 2 errors')).toBeInTheDocument();
    expect(region.getByText('Finished with errors')).toBeInTheDocument();
    expect(region.queryByRole('button', { name: 'Resume backlog' })).not.toBeInTheDocument();
    expect(region.getByText(/Adding cookies from a signed-in account in Options/)).toBeInTheDocument();
    expect(region.queryByRole('list', { name: 'Videos with errors' })).not.toBeInTheDocument();

    await user.click(region.getByRole('button', { name: 'Show videos with errors' }));
    const list = within(region.getByRole('list', { name: 'Videos with errors' }));
    expect(list.getByText('Title v1')).toBeInTheDocument();
    expect(list.getByText('Age-restricted')).toBeInTheDocument();
    expect(list.getByText('Failed: HTTP Error 500')).toBeInTheDocument();
  });

  it('does not suggest cookies for errors they cannot fix', async () => {
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [
      backlogItem('v1', { status: 'error', errorKind: 'unavailable', errorMessage: 'gone' }),
    ])]));
    expect(backlogRegion().queryByText(/Adding cookies/)).not.toBeInTheDocument();
  });

  it('caps a long error list', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 130 }, (_, i) => backlogItem(`v${i}`, { status: 'error', errorKind: 'unavailable', errorMessage: 'gone' }));
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', items)]));
    await user.click(backlogRegion().getByRole('button', { name: 'Show videos with errors' }));
    expect(within(backlogRegion().getByRole('list', { name: 'Videos with errors' })).getAllByRole('listitem')).toHaveLength(100);
    expect(backlogRegion().getByText('and 30 more')).toBeInTheDocument();
  });

  it('Retry errors and Dismiss errors call through and show the updated backlog', async () => {
    const user = userEvent.setup();
    const errored = backlogJob('j1', 'Veritasium', [backlogItem('v1', { status: 'error', errorKind: 'unknown', errorMessage: 'x' }), backlogItem('v2')]);
    await renderPanelWithBacklog(backlogStateOf([errored]));

    (window.electronAPI.dismissBacklogErrors as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, dismissed: 1, ...backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v2')])]),
    });
    await user.click(backlogRegion().getByRole('button', { name: 'Dismiss errors' }));
    expect(window.electronAPI.dismissBacklogErrors).toHaveBeenCalledTimes(1);
    expect(await backlogRegion().findByText('1 pending · 0 errors')).toBeInTheDocument();
    expect(backlogRegion().queryByRole('button', { name: 'Retry errors' })).not.toBeInTheDocument();
  });

  it('Retry errors puts them back to pending and starts the run', async () => {
    const user = userEvent.setup();
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1', { status: 'error', errorKind: 'unknown', errorMessage: 'x' })])]));
    (window.electronAPI.retryBacklogErrors as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, retried: 1, ...backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1')])]),
    });
    await user.click(backlogRegion().getByRole('button', { name: 'Retry errors' }));

    expect(window.electronAPI.retryBacklogErrors).toHaveBeenCalledTimes(1);
    expect(await backlogRegion().findByText('1 pending · 0 errors')).toBeInTheDocument();
    expect(await backlogRegion().findByText('Running')).toBeInTheDocument();
  });
});

describe('BulkAddSidePanel: backlog progress', () => {
  it('shows how many of the backlog\'s videos are done, with a progress bar', async () => {
    await renderPanelWithBacklog(backlogStateOf([
      backlogJob('j1', 'Veritasium', [backlogItem('v1'), backlogItem('v2', { status: 'error', errorKind: 'unknown', errorMessage: 'x' })], 'DefaultLibrary', 6),
      backlogJob('j2', 'Kurzgesagt', [backlogItem('v3'), backlogItem('v4')]),
    ]));
    const region = backlogRegion();
    expect(region.getByText('6 of 10 done')).toBeInTheDocument();
    expect(region.getByText('3 pending · 1 error')).toBeInTheDocument();
    expect(region.getByRole('progressbar', { name: 'Backlog progress' })).toHaveAttribute('aria-valuenow', '60');
  });

  it('starts at zero for a backlog nothing has been done on', async () => {
    await renderPanelWithBacklog(backlogStateOf([backlogJob('j1', 'Veritasium', [backlogItem('v1'), backlogItem('v2')])]));
    expect(backlogRegion().getByText('0 of 2 done')).toBeInTheDocument();
    expect(backlogRegion().getByRole('progressbar', { name: 'Backlog progress' })).toHaveAttribute('aria-valuenow', '0');
  });
});

describe('BulkAddSidePanel: long lists', () => {
  // Entries that already carry a library location go straight to
  // "downloading", so a queue of any size can be put in a known state
  // without waiting on fetches.
  function startMany(queue: ReturnType<typeof useBulkAddQueue>, count: number, prefix: string) {
    queue.start(
      Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, title: `${prefix} ${i}`, url: `https://youtu.be/${prefix}${i}` })),
      { download: false, targetResolution: 'dflt' },
    );
  }

  it('shows every finished item up to the cap, with no "hidden" line', async () => {
    const { getQueue } = renderPanel();
    act(() => startMany(getQueue(), 5, 'item'));
    act(() => getQueue().stop());
    act(() => getQueue().cancelAllPending());
    await flush();
    expect(screen.getAllByText('Cancelled')).toHaveLength(4);
    expect(screen.queryByText(/earlier finished/)).not.toBeInTheDocument();
  });

  it('renders only the most recent 200 finished items, says how many are hidden, and still shows everything unfinished', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const { getQueue } = renderPanel();
    // 1 fetching + 230 that get cancelled, then 3 more left pending.
    act(() => startMany(getQueue(), 231, 'old'));
    act(() => getQueue().stop());
    act(() => getQueue().cancelAllPending());
    act(() => startMany(getQueue(), 3, 'new'));
    act(() => getQueue().stop());
    await flush();

    expect(getQueue().items).toHaveLength(234);
    expect(screen.getByText('30 earlier finished items hidden')).toBeInTheDocument();
    expect(screen.getAllByText('Cancelled')).toHaveLength(200);
    // The oldest finished ones are the hidden ones.
    expect(screen.queryByText('old 1')).not.toBeInTheDocument();
    expect(screen.queryByText('old 30')).not.toBeInTheDocument();
    expect(screen.getByText('old 31')).toBeInTheDocument();
    expect(screen.getByText('old 230')).toBeInTheDocument();
    // Unfinished items are never hidden, wherever they sit in the list.
    expect(screen.getByText('old 0')).toBeInTheDocument();
    expect(screen.getAllByText('Pending')).toHaveLength(3);

    // "Clear done" clears all of them, hidden ones included.
    await user.click(screen.getByRole('button', { name: 'Clear done' }));
    expect(getQueue().items).toHaveLength(4);
    expect(screen.queryByText(/earlier finished/)).not.toBeInTheDocument();
  }, 20000);
});
