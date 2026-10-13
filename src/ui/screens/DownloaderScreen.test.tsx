// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import DownloaderScreen from './DownloaderScreen';
import { LibraryNotificationProvider } from '../hooks/useLibraryNotifications';
import { LibraryTagsProvider } from '../hooks/useLibraryTags';
import { BulkAddProvider } from '../hooks/useBulkAddQueue';
import { ChannelArchiveProvider } from '../hooks/useChannelArchive';

// Real timers throughout -- useDebounce's default 500ms delay is real, and
// combining fake timers with userEvent's click/type simulation proved
// unreliable elsewhere in this suite (see BulkAddSidePanel.test.tsx). All
// waitFor calls below use a timeout comfortably above 500ms.
const videoResponse = {
  id: 'vid1',
  fullTitle: 'My Great Video',
  description: 'a description',
  thumbnail: 'https://example.com/thumb.jpg',
  resolutions: [{ resolution: '720', filesizeMb: '10' }],
  originalUrl: 'https://youtube.com/watch?v=vid1',
  durationString: '2:00',
  uploadDate: '20260115',
};

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getVideoInfoPython: vi.fn(),
    addLibraryEntry: vi.fn(),
    findLibraryVideo: vi.fn(),
    overrideLibraryEntry: vi.fn(),
    addLibraryVersion: vi.fn(),
    deleteVideoInfoCacheEntry: vi.fn().mockResolvedValue({ success: true, existed: true }),
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

function renderScreen() {
  return render(
    <MemoryRouter>
      <LibraryTagsProvider><LibraryNotificationProvider><DownloaderScreen /></LibraryNotificationProvider></LibraryTagsProvider>
    </MemoryRouter>,
  );
}

describe('DownloaderScreen', () => {
  it('shows an error for an invalid URL without fetching', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('URL'), 'not a url');

    await waitFor(() => expect(screen.getByText('Invalid URL')).toBeInTheDocument(), { timeout: 2000 });
    expect(window.electronAPI.getVideoInfoPython).not.toHaveBeenCalled();
  });

  it('fetches and displays the video once a valid URL settles', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: false },
    });
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);

    await waitFor(() => expect(window.electronAPI.getVideoInfoPython).toHaveBeenCalledWith(videoResponse.originalUrl), { timeout: 2000 });
    expect(await screen.findByRole('link', { name: 'My Great Video' })).toBeInTheDocument();
  });

  it('clears the loaded video when the URL is deleted, instead of misrendering it as another platform', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: false },
    });
    renderScreen();
    const urlField = screen.getByLabelText('URL');
    await user.type(urlField, videoResponse.originalUrl);
    expect(await screen.findByRole('link', { name: 'My Great Video' })).toBeInTheDocument();

    await user.clear(urlField);

    await waitFor(() => expect(screen.queryByRole('link', { name: 'My Great Video' })).not.toBeInTheDocument(), { timeout: 2000 });
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('shows a fetch error message instead of a card when the lookup fails', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bot check'));
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);

    expect(await screen.findByText('bot check', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'My Great Video' })).not.toBeInTheDocument();
  });

  it('shows a "loaded from cache" chip, and deleting the cache entry hides it', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: true },
    });
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);

    await waitFor(() => expect(screen.getByText('Loaded from cache')).toBeInTheDocument(), { timeout: 2000 });
    await user.click(screen.getByLabelText('Delete this entry from the cache (testing)'));

    expect(window.electronAPI.deleteVideoInfoCacheEntry).toHaveBeenCalledWith(videoResponse.originalUrl);
    expect(screen.queryByText('Loaded from cache')).not.toBeInTheDocument();
  });

  async function loadVideo(user: ReturnType<typeof userEvent.setup>) {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: false },
    });
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);
    await screen.findByRole('link', { name: 'My Great Video' }, { timeout: 2000 });
  }

  it('adds a new (not-yet-tracked) video to the library and resets the form', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, videoDir: '/d', epoch: '1' });

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));

    await waitFor(() => expect(screen.getByText('Added to library')).toBeInTheDocument());
    expect(window.electronAPI.addLibraryEntry).toHaveBeenCalledWith(videoResponse, 'DefaultLibrary');
    expect(screen.queryByRole('link', { name: 'My Great Video' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('URL')).toHaveValue('');
  });

  it('allows adding a non-YouTube video to the library too', async () => {
    const user = userEvent.setup();
    const nonYoutubeResponse = { ...videoResponse, originalUrl: 'https://www.dailymotion.com/video/xbafapm' };
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: nonYoutubeResponse, fromCache: false },
    });
    renderScreen();
    await user.type(screen.getByLabelText('URL'), nonYoutubeResponse.originalUrl);
    await screen.findByRole('link', { name: 'My Great Video' }, { timeout: 2000 });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, videoDir: '/d', epoch: '1' });

    const addButton = within(screen.getByLabelText('Add to library')).getByRole('button');
    expect(addButton).not.toBeDisabled();
    await user.click(addButton);

    await waitFor(() => expect(screen.getByText('Added to library')).toBeInTheDocument());
    expect(window.electronAPI.addLibraryEntry).toHaveBeenCalledWith(nonYoutubeResponse, 'DefaultLibrary');
  });

  it('offers Override/Add as new version when the video is already tracked', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true, channelDisplayName: 'Some Channel', videoDir: '/d/v1' });

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));
    expect(await screen.findByText('Already in your library')).toBeInTheDocument();
    expect(screen.getByText(/under "Some Channel"/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Override' }));
    expect(window.electronAPI.overrideLibraryEntry).toHaveBeenCalledWith(videoResponse, '/d/v1', 'DefaultLibrary');
  });

  it('"Add as new version" calls addLibraryVersion instead of overriding', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true, channelDisplayName: null, videoDir: '/d/v1' });

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));
    await screen.findByText('Already in your library');
    await user.click(screen.getByRole('button', { name: 'Add as new version' }));

    expect(window.electronAPI.addLibraryVersion).toHaveBeenCalledWith(videoResponse, '/d/v1');
    expect(window.electronAPI.overrideLibraryEntry).not.toHaveBeenCalled();
  });

  it('scopes the duplicate check and the add itself to the picked target sublibrary, and links "View" to it', async () => {
    (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      tags: [
        { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: 1 },
        { tagName: 'Music', folderName: 'Music', createdEpoch: 2 },
      ],
    });
    const user = userEvent.setup();
    await loadVideo(user);
    await screen.findByRole('combobox', { name: 'Add to' });

    await user.click(screen.getByRole('combobox', { name: 'Add to' }));
    await user.click(await screen.findByRole('option', { name: 'Music' }));

    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, videoDir: '/d', epoch: '1' });

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));

    await waitFor(() => expect(screen.getByText('Added to library')).toBeInTheDocument());
    // The duplicate check (before the add) and the add itself must both be
    // scoped to the sublibrary actually picked, not whatever's active --
    // otherwise a video only present in a different sublibrary would wrongly
    // look like a duplicate, or land in the wrong place.
    expect(window.electronAPI.findLibraryVideo).toHaveBeenCalledWith(videoResponse.id, 'Music');
    expect(window.electronAPI.addLibraryEntry).toHaveBeenCalledWith(videoResponse, 'Music');
    // The "View" link must carry the same tag, or LibraryScreen's deep link
    // (scoped to whatever's currently active there) would never find it.
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', expect.stringContaining('tag=Music'));
  });

  it('shows an error dialog when adding to the library fails', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));

    expect(await screen.findByText("Couldn't add to library")).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });
});

// The channel entry point needs what App.tsx gives the real screen: the
// queue and channel-archive providers above it, and a route to land on.
function renderScreenInApp() {
  return render(
    <MemoryRouter>
      <LibraryTagsProvider>
        <LibraryNotificationProvider>
          <BulkAddProvider>
            <ChannelArchiveProvider>
              <Routes>
                <Route path="/" element={<DownloaderScreen />} />
                <Route path="/channel-archive" element={<div>Channel archive view</div>} />
              </Routes>
            </ChannelArchiveProvider>
          </BulkAddProvider>
        </LibraryNotificationProvider>
      </LibraryTagsProvider>
    </MemoryRouter>,
  );
}

describe('DownloaderScreen: channel links', () => {
  beforeEach(() => {
    window.electronAPI = {
      ...window.electronAPI,
      scanChannel: vi.fn(() => new Promise<never>(() => {})),
      cancelChannelScan: vi.fn().mockResolvedValue({ cancelled: true }),
      onChannelScanProgress: vi.fn(() => () => {}),
      removeChannelScanProgressListener: vi.fn(),
      getBacklog: vi.fn().mockResolvedValue({
        success: true,
        backlog: { version: 1, libraryDir: null, completedJobs: { totalCount: 0, doneCount: 0 }, jobs: [] },
        counts: { jobs: 0, pending: 0, errors: 0, total: 0, done: 0 },
        libraryDir: '',
        libraryDirMatches: true,
      }),
    };
  });

  it('starts a channel scan and opens the channel view instead of fetching video info', async () => {
    const user = userEvent.setup();
    renderScreenInApp();
    await user.type(screen.getByLabelText('URL'), 'https://www.youtube.com/@veritasium/shorts');

    expect(await screen.findByText('Channel archive view', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(window.electronAPI.scanChannel).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.scanChannel).toHaveBeenCalledWith(expect.any(String), 'https://www.youtube.com/@veritasium/shorts');
    expect(window.electronAPI.getVideoInfoPython).not.toHaveBeenCalled();
  });

  it('still fetches video info for an ordinary video link with the providers present', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: false },
    });
    renderScreenInApp();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);

    await waitFor(() => expect(window.electronAPI.getVideoInfoPython).toHaveBeenCalledWith(videoResponse.originalUrl), { timeout: 2000 });
    expect(window.electronAPI.scanChannel).not.toHaveBeenCalled();
    expect(screen.queryByText('Channel archive view')).not.toBeInTheDocument();
  });
});
