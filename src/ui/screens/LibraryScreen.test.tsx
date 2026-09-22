// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import LibraryScreen from './LibraryScreen';
import { BulkAddProvider, useBulkAddQueue, type BulkAddItem } from '../hooks/useBulkAddQueue.tsx';
import { LibraryTagsProvider } from '../hooks/useLibraryTags.tsx';
import { BackgroundPlayerProvider } from '../hooks/useBackgroundPlayer.tsx';

// LibraryScreen reads/matches deep-link routes (useMatch/useNavigate, for
// /library/video/:videoId) -- needs a real Router context, same reason
// App.test.tsx already wraps with one. BulkAddProvider is needed too, now
// that the bulk-select "Download selected" action calls useBulkAddQueue()
// directly -- without it every render throws ("must be used within a
// BulkAddProvider"). LibraryTagsProvider likewise, now that libraryTags/
// activeLibraryTag come from the shared hook instead of this screen's own
// local state. BackgroundPlayerProvider is needed too, now that every
// VideoCard's own "Add to queue" hover button calls useBackgroundPlayer().
function render(ui: ReactElement) {
  return rtlRender(
    <MemoryRouter><LibraryTagsProvider><BulkAddProvider><BackgroundPlayerProvider>{ui}</BackgroundPlayerProvider></BulkAddProvider></LibraryTagsProvider></MemoryRouter>,
  );
}

// For the deep-link (?tag=) tests below -- same wrapper as render() but
// starting on a specific route instead of the default "/".
function renderAt(path: string, ui: ReactElement) {
  return rtlRender(
    <MemoryRouter initialEntries={[path]}>
      <LibraryTagsProvider><BulkAddProvider><BackgroundPlayerProvider>{ui}</BackgroundPlayerProvider></BulkAddProvider></LibraryTagsProvider>
    </MemoryRouter>,
  );
}

// LibraryVideoDetail is the biggest, most complex file in the app (its own
// dedicated test file covers it) -- mocked out here so LibraryScreen's tests
// stay scoped to its own navigation/state logic, and to confirm the props it
// wires through (video, onBack, onDeleted, onVersionsChanged) are correct.
vi.mock('./LibraryVideoDetail', () => ({
  default: ({ video, onBack, onDeleted, onVersionsChanged }: {
    video: { videoFolderName: string };
    onBack: () => void;
    onDeleted: () => void;
    onVersionsChanged: () => void;
  }) => (
    <div>
      <div>Detail: {video.videoFolderName}</div>
      <button onClick={onBack}>mock-back</button>
      <button onClick={onDeleted}>mock-deleted</button>
      <button onClick={onVersionsChanged}>mock-versions-changed</button>
    </div>
  ),
}));

function makeVideo(overrides: Record<string, unknown> = {}) {
  return {
    videoFolderName: 'vidA',
    videoDir: '/lib/Channel A/vidA',
    latestEpoch: '1',
    metadata: {
      videoId: 'vidA', channelId: 'UC1', channel: 'Channel A', title: 'Alpha Video', fullTitle: 'Alpha Video',
      description: null, thumbnail: null, originalUrl: null, durationString: null, uploadDate: '20260101',
      downloadedFilePath: null, downloadedResolution: null, downloadedFormat: null, downloadedAudioFilePath: null,
    },
    epochs: [{ epoch: '1', metadata: {} }],
    thumbnailPath: null,
    clipCount: 0,
    ...overrides,
  };
}

function makeChannels() {
  return [
    {
      channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
      videos: [makeVideo()],
    },
    {
      channelFolderName: 'Channel B', displayName: 'Channel B', channelIconPath: null,
      videos: [makeVideo({
        videoFolderName: 'vidB', videoDir: '/lib/Channel B/vidB',
        metadata: { ...makeVideo().metadata, videoId: 'vidB', channel: 'Channel B', title: 'Beta Video' },
      })],
    },
  ];
}

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getLibraryDir: vi.fn().mockResolvedValue({ libraryDir: '/lib' }),
    getLibraryIndex: vi.fn().mockResolvedValue({ channels: makeChannels() }),
    getLibraryViewMode: vi.fn().mockResolvedValue({ libraryViewMode: 'channel' }),
    setLibraryViewMode: vi.fn().mockResolvedValue({ success: true, libraryViewMode: 'video' }),
    getLibrarySort: vi.fn().mockResolvedValue({ sortField: 'title', sortDirection: 'asc' }),
    setLibrarySort: vi.fn().mockResolvedValue({ success: true, sortField: 'title', sortDirection: 'asc' }),
    getLibraryDisplayMode: vi.fn().mockResolvedValue({ libraryDisplayMode: 'grid' }),
    setLibraryDisplayMode: vi.fn().mockResolvedValue({ success: true, libraryDisplayMode: 'list' }),
    getLibraryListColumns: vi.fn().mockResolvedValue({ libraryListColumns: 1 }),
    setLibraryListColumns: vi.fn().mockResolvedValue({ success: true, libraryListColumns: 2 }),
    getThumbnailSize: vi.fn().mockResolvedValue({ thumbnailSize: 220 }),
    setThumbnailSize: vi.fn().mockResolvedValue({ success: true, thumbnailSize: 220 }),
    refreshLibraryIndex: vi.fn().mockResolvedValue({ channels: makeChannels() }),
    refreshChannelIcon: vi.fn(),
    openDirectory: vi.fn(),
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [{ tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: 1 }] }),
    createLibraryTag: vi.fn().mockResolvedValue({ success: true, tag: { tagName: 'Music', folderName: 'Music', createdEpoch: 2 } }),
    getActiveLibraryTag: vi.fn().mockResolvedValue({ activeLibraryTag: 'DefaultLibrary', activeLibraryTagDir: '/lib/DefaultLibrary' }),
    setActiveLibraryTag: vi.fn().mockResolvedValue({ success: true, activeLibraryTag: 'DefaultLibrary' }),
    findLibraryVideo: vi.fn().mockResolvedValue({ found: false }),
    onLibraryBackgroundUpdate: vi.fn(),
    removeLibraryBackgroundUpdateListener: vi.fn(),
    deleteLibraryEntries: vi.fn().mockResolvedValue({ success: true, results: [] }),
    moveLibraryEntries: vi.fn().mockResolvedValue({ success: true, results: [] }),
    deleteLocalFiles: vi.fn().mockResolvedValue({ success: true, results: [] }),
    listVideoTags: vi.fn().mockResolvedValue({ tags: {} }),
    setVideoTag: vi.fn().mockResolvedValue({ success: true, tags: {} }),
    tagVideos: vi.fn().mockResolvedValue({ success: true, tags: {} }),
    // useBulkAddQueue's start() (fired by "Download selected") unconditionally
    // calls this -- stubbed so bulk-select's download tests don't hit an
    // unmocked IPC call, even though they don't assert on its result.
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
  };
  // BulkAddProvider (now wrapping every render() call, see the helper above)
  // mounts one useDownloadVideo() instance per download slot, each of which
  // registers an onProgressUpdate listener in a useEffect on mount --
  // without this, every test in this file would throw on render, not just
  // the bulk-select ones.
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn(),
    removeProgressListener: vi.fn(),
    cancelDownload: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

describe('LibraryScreen', () => {
  it('shows "no library folder" when none is configured', async () => {
    (window.electronAPI.getLibraryDir as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDir: '' });
    render(<LibraryScreen />);
    expect(await screen.findByText('No library folder set')).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Thumbnail size' })).not.toBeInTheDocument();
  });

  it('shows the channel list by default, with a video count per channel', async () => {
    render(<LibraryScreen />);
    expect(await screen.findByText('Channel A')).toBeInTheDocument();
    expect(screen.getByText('Channel B')).toBeInTheDocument();
    expect(screen.getAllByText('1 video')).toHaveLength(2);
  });

  it('shows a "N clips" badge on a video card only when it has saved clips', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [makeVideo({ clipCount: 3 })],
      }],
    });
    render(<LibraryScreen />);
    await user.click(await screen.findByText('Channel A'));
    expect(screen.getByText('3 clips')).toBeInTheDocument();
  });

  it('shows a tag chip on a video card only for tags actually applied to that video', async () => {
    (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
    (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidA'], games: ['vidB'] } });
    render(<LibraryScreen />);
    await screen.findByText('Alpha Video');

    expect(screen.getByText('TVshows')).toBeInTheDocument();
    expect(screen.getByText('games')).toBeInTheDocument();
    // Alpha Video only carries TVshows -- games (Beta Video's own tag)
    // shouldn't also render on Alpha's card.
    const alphaCard = screen.getByText('Alpha Video').closest('.MuiCard-root');
    expect(alphaCard).not.toBeNull();
    expect(alphaCard && within(alphaCard as HTMLElement).queryByText('games')).toBeNull();
  });

  it('drills into a channel, shows its videos, and back returns to the channel list', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await user.click(await screen.findByText('Channel A'));

    expect(screen.getByText('Alpha Video')).toBeInTheDocument();
    expect(screen.queryByText('Channel B')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to channels' }));
    expect(await screen.findByText('Channel A')).toBeInTheDocument();
    expect(screen.getByText('Channel B')).toBeInTheDocument();
  });

  it('selecting a video renders the (mocked) detail view with the right video, and back returns to the channel grid', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await user.click(await screen.findByText('Channel A'));
    await user.click(screen.getByText('Alpha Video'));

    expect(screen.getByText('Detail: vidA')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'mock-back' }));
    expect(await screen.findByText('Alpha Video')).toBeInTheDocument(); // back in the channel's video grid, not the root channel list
  });

  it('switches to the flat by-video list, sorted alphabetically and tagged with channel name', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await screen.findByText('Channel A');

    await user.click(screen.getByRole('button', { name: 'By video' }));

    expect(window.electronAPI.setLibraryViewMode).toHaveBeenCalledWith('video');
    const titles = screen.getAllByText(/Video$/).map((el) => el.textContent);
    expect(titles).toEqual(['Alpha Video', 'Beta Video']); // alphabetical
  });

  it('loads directly into the flat view when that is the persisted mode', async () => {
    (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
    render(<LibraryScreen />);
    expect(await screen.findByText('Alpha Video')).toBeInTheDocument();
    expect(screen.getByText('Beta Video')).toBeInTheDocument();
    expect(screen.queryByText('1 video')).not.toBeInTheDocument(); // never showed the channel list at all
  });

  it('selecting a video from the flat list goes straight to the detail view, and back returns to the flat list', async () => {
    (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await user.click(await screen.findByText('Alpha Video'));

    expect(screen.getByText('Detail: vidA')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'mock-back' }));

    expect(await screen.findByText('Alpha Video')).toBeInTheDocument();
    expect(screen.getByText('Beta Video')).toBeInTheDocument(); // the flat list, not a channel grid
  });

  it('deleting a video bounces all the way back to the root, whichever view was active', async () => {
    (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await user.click(await screen.findByText('Alpha Video'));
    await user.click(screen.getByRole('button', { name: 'mock-deleted' }));

    expect(await screen.findByText('Beta Video')).toBeInTheDocument(); // back at the flat root list
  });

  it('manual refresh re-fetches the index', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await screen.findByText('Channel A');

    await user.click(screen.getByRole('button', { name: 'Refresh library' }));
    await waitFor(() => expect(window.electronAPI.refreshLibraryIndex).toHaveBeenCalled());
  });

  it('opening the library folder calls openDirectory with the active sublibrary\'s resolved path', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await screen.findByText('Channel A');

    await user.click(screen.getByRole('button', { name: 'Open library folder' }));
    expect(window.electronAPI.openDirectory).toHaveBeenCalledWith('/lib/DefaultLibrary');
  });

  it('refreshing a channel icon calls refreshChannelIcon with the channel folder/id', async () => {
    (window.electronAPI.refreshChannelIcon as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannels() });
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await user.click(await screen.findByText('Channel A'));

    await user.click(screen.getByRole('button', { name: 'Refresh channel icon' }));
    await waitFor(() => expect(window.electronAPI.refreshChannelIcon).toHaveBeenCalledWith({ channelFolderName: 'Channel A', channelId: 'UC1' }));
  });

  it('shows the thumbnail-size bar only while a video-thumbnail grid is on screen', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);

    // Root channel list -- out of scope for the slider, bar hidden.
    await screen.findByText('Channel A');
    expect(screen.queryByRole('slider', { name: 'Thumbnail size' })).not.toBeInTheDocument();

    // Drilled into a channel's video grid -- bar shown.
    await user.click(screen.getByText('Channel A'));
    expect(screen.getByRole('slider', { name: 'Thumbnail size' })).toBeInTheDocument();

    // Video detail view -- bar hidden.
    await user.click(screen.getByText('Alpha Video'));
    expect(screen.queryByRole('slider', { name: 'Thumbnail size' })).not.toBeInTheDocument();

    // Back to the channel's video grid -- bar shown again.
    await user.click(screen.getByRole('button', { name: 'mock-back' }));
    expect(screen.getByRole('slider', { name: 'Thumbnail size' })).toBeInTheDocument();
  });

  it('shows the thumbnail-size bar in the flat by-video list', async () => {
    (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
    render(<LibraryScreen />);
    await screen.findByText('Alpha Video');
    expect(screen.getByRole('slider', { name: 'Thumbnail size' })).toBeInTheDocument();
  });

  it('committing a thumbnail-size change persists it via setThumbnailSize', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await user.click(await screen.findByText('Channel A'));

    const slider = screen.getByRole('slider', { name: 'Thumbnail size' });
    slider.focus();
    await user.keyboard('{ArrowRight}');

    expect(window.electronAPI.setThumbnailSize).toHaveBeenCalled();
  });

  describe('grid/list display mode', () => {
    it('shows the grid/list toggle only on the flat by-video list, not a single channel\'s own video grid', async () => {
      const user = userEvent.setup();
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));

      // Channel drill-down (VideoGrid) shares LibraryBottomBar's render call
      // site with the flat video view, but has no list layout of its own --
      // the thumbnail slider still shows, the display-mode toggle doesn't.
      expect(screen.getByRole('slider', { name: 'Thumbnail size' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'List view' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Grid view' })).not.toBeInTheDocument();
    });

    it('shows the grid/list toggle on the flat by-video list, defaulting to grid (VideoCard)', async () => {
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      expect(screen.getByRole('button', { name: 'Grid view' })).toBeInTheDocument();
      expect(screen.getByText('Alpha Video').closest('.MuiCard-root')).not.toBeNull();
    });

    it('switching to list view renders compact rows instead of cards, and persists the choice', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'List view' }));

      expect(window.electronAPI.setLibraryDisplayMode).toHaveBeenCalledWith('list');
      expect(screen.getByText('Alpha Video').closest('.MuiCard-root')).toBeNull();
      expect(screen.getByText('Alpha Video').closest('.MuiListItem-root')).not.toBeNull();
    });

    it('loads directly into list mode when that is the persisted setting, and shows the key fields per row', async () => {
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryDisplayMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDisplayMode: 'list' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
      const row = screen.getByText('Alpha Video').closest('.MuiListItem-root');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText('Not downloaded')).toBeInTheDocument();
      expect(within(row as HTMLElement).getByText(/2026/)).toBeInTheDocument();
    });

    it('selection and "Add to queue" still work identically in list mode', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryDisplayMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDisplayMode: 'list' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{
          channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
          videos: [makeVideo({ metadata: { ...makeVideo().metadata, downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4' } })],
        }],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      expect(screen.getByText('1 item selected')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));
      expect(screen.queryByText('Detail: vidA')).not.toBeInTheDocument();
    });

    // Regression test: the thumbnail-size slider does nothing useful once
    // list mode is active (there's no grid to size) -- it swaps for a
    // discrete 1/2/3 "list columns" slider in the same bottom-bar slot
    // instead, defaulting to 1 column.
    it('swaps the thumbnail-size slider for a discrete 1/2/3 list-columns slider once list mode is active', async () => {
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryDisplayMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDisplayMode: 'grid' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      expect(screen.getByRole('slider', { name: 'Thumbnail size' })).toBeInTheDocument();
      expect(screen.queryByRole('slider', { name: 'List columns' })).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'List view' }));

      expect(screen.queryByRole('slider', { name: 'Thumbnail size' })).not.toBeInTheDocument();
      const columnsSlider = screen.getByRole('slider', { name: 'List columns' });
      expect(columnsSlider).toBeInTheDocument();
      expect(columnsSlider).toHaveAttribute('aria-valuenow', '1');
      expect(columnsSlider).toHaveAttribute('aria-valuemin', '1');
      expect(columnsSlider).toHaveAttribute('aria-valuemax', '3');
    });

    it('changing the list-columns slider persists the choice and lays the rows out in that many columns', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryDisplayMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDisplayMode: 'list' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      const columnsSlider = screen.getByRole('slider', { name: 'List columns' });
      columnsSlider.focus();
      await user.keyboard('{ArrowRight}');

      expect(window.electronAPI.setLibraryListColumns).toHaveBeenCalledWith(2);
      const list = screen.getByText('Alpha Video').closest('.MuiList-root') as HTMLElement;
      expect(list).toHaveStyle({ gridTemplateColumns: 'repeat(2, 1fr)' });
    });

    it('loads directly into the persisted column count', async () => {
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryDisplayMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDisplayMode: 'list' });
      (window.electronAPI.getLibraryListColumns as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryListColumns: 3 });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      expect(screen.getByRole('slider', { name: 'List columns' })).toHaveAttribute('aria-valuenow', '3');
      const list = screen.getByText('Alpha Video').closest('.MuiList-root') as HTMLElement;
      expect(list).toHaveStyle({ gridTemplateColumns: 'repeat(3, 1fr)' });
    });
  });

  describe('Add to queue (video card)', () => {
    it('is hidden when the video has no downloaded file at all', async () => {
      const user = userEvent.setup();
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));

      expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
    });

    it('enqueues the video without navigating into its detail view, when a natively-playable file is downloaded', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{
          channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
          videos: [makeVideo({ metadata: { ...makeVideo().metadata, downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4' } })],
        }],
      });
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));

      expect(screen.queryByText('Detail: vidA')).not.toBeInTheDocument();
    });

    it('shows the button for a non-native (MKV) download too, resolving it via the same on-the-fly preview generation the video view uses', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{
          channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
          videos: [makeVideo({ metadata: { ...makeVideo().metadata, downloadedFilePath: '/lib/Channel A/vidA/1/video.mkv' } })],
        }],
      });
      window.electronAPI.ensurePlayablePreview = vi.fn().mockResolvedValue({ success: true, previewPath: '/cache/vidA-preview.mp4' });
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));

      await waitFor(() => expect(window.electronAPI.ensurePlayablePreview).toHaveBeenCalledWith({ filePath: '/lib/Channel A/vidA/1/video.mkv' }));
      expect(screen.queryByText('Detail: vidA')).not.toBeInTheDocument();
    });

    it('shows a toast and stays put when preview generation fails for a non-native download', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{
          channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
          videos: [makeVideo({ metadata: { ...makeVideo().metadata, downloadedFilePath: '/lib/Channel A/vidA/1/video.mkv' } })],
        }],
      });
      window.electronAPI.ensurePlayablePreview = vi.fn().mockResolvedValue({ success: false });
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));

      expect(await screen.findByText(/Couldn't prepare/)).toBeInTheDocument();
    });
  });

  describe('bulk select', () => {
    it('selecting a checkbox does not navigate into the video detail view', async () => {
      const user = userEvent.setup();
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));

      expect(screen.queryByText('Detail: vidA')).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).toBeChecked();
    });

    it('shows a live "N items selected" label with correct pluralization', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      expect(screen.getByText('1 item selected')).toBeInTheDocument();

      await user.click(screen.getByRole('checkbox', { name: 'Select Beta Video' }));
      expect(screen.getByText('2 items selected')).toBeInTheDocument();
    });

    it('gates "Download selected" on whether every selected video is undownloaded', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [
          {
            channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
            videos: [
              makeVideo(),
              makeVideo({
                videoFolderName: 'vidC', videoDir: '/lib/Channel A/vidC',
                metadata: { ...makeVideo().metadata, videoId: 'vidC', title: 'Gamma Video' },
                // getBestDownloadedQuality reads each epoch's own metadata,
                // not the video's top-level metadata -- that's what actually
                // drives the "Not downloaded" chip/bulk-download gating.
                epochs: [{
                  epoch: '1',
                  metadata: { downloadedFilePath: '/lib/Channel A/vidC/1/video.mp4', downloadedResolution: '1080' },
                }],
              }),
            ],
          },
        ],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      // All selected are undownloaded -- both buttons show.
      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      expect(screen.getByRole('button', { name: /Download selected/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Delete from library/ })).toBeInTheDocument();

      // Adding an already-downloaded video to the selection hides Download,
      // keeps Delete.
      await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));
      expect(screen.queryByRole('button', { name: /Download selected/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Delete from library/ })).toBeInTheDocument();
    });

    it('gates "Delete local files" on whether every selected video is downloaded, mirroring Download selected', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [
          {
            channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
            videos: [
              makeVideo({
                epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080' } }],
              }),
              makeVideo({ videoFolderName: 'vidC', videoDir: '/lib/Channel A/vidC', metadata: { ...makeVideo().metadata, videoId: 'vidC', title: 'Gamma Video' } }),
            ],
          },
        ],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      // Only the downloaded video selected -- "Delete local files" shows.
      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      expect(screen.getByRole('button', { name: /Delete local files/ })).toBeInTheDocument();

      // Adding the undownloaded one hides it (all-or-nothing).
      await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));
      expect(screen.queryByRole('button', { name: /Delete local files/ })).not.toBeInTheDocument();
    });

    it('deletes local files via the confirm dialog, keeping the library entry', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{
          channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
          videos: [makeVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080' } }] })],
        }],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('button', { name: /Delete local files/ }));

      expect(await screen.findByText('Delete local files for 1 video?')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(window.electronAPI.deleteLocalFiles).toHaveBeenCalledWith(['/lib/Channel A/vidA']));
      expect(screen.queryByText('Delete local files for 1 video?')).not.toBeInTheDocument();
    });

    it('deletes the selection via the confirm dialog and clears it on success', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{ channelFolderName: 'Channel B', displayName: 'Channel B', channelIconPath: null, videos: [makeVideo({ videoFolderName: 'vidB', videoDir: '/lib/Channel B/vidB', metadata: { ...makeVideo().metadata, videoId: 'vidB', channel: 'Channel B', title: 'Beta Video' } })] }],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('button', { name: /Delete from library/ }));

      expect(await screen.findByText('Delete 1 video?')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(window.electronAPI.deleteLibraryEntries).toHaveBeenCalledWith(['/lib/Channel A/vidA']));
      expect(screen.queryByText('Delete 1 video?')).not.toBeInTheDocument();
      expect(await screen.findByText('Beta Video')).toBeInTheDocument();
      expect(screen.queryByText('Alpha Video')).not.toBeInTheDocument();
    });

    it('a partial bulk-delete failure keeps only the failed items selected', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.deleteLibraryEntries as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        results: [
          { videoDir: '/lib/Channel A/vidA', success: true },
          { videoDir: '/lib/Channel B/vidB', success: false, error: 'boom' },
        ],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Beta Video' }));
      await user.click(screen.getByRole('button', { name: /Delete from library/ }));
      await user.click(await screen.findByRole('button', { name: 'Delete' }));

      // Dialog stays open on failure (MUI marks the rest of the page
      // aria-hidden while it's open, so the count label -- read from inside
      // the still-mounted tree -- is the reliable way to confirm only the
      // failed item stayed selected, rather than querying a checkbox behind
      // the modal).
      expect(await screen.findByText(/couldn't be deleted/)).toBeInTheDocument();
      expect(screen.getByText('1 item selected')).toBeInTheDocument();
    });

    it('opens the quality-picker dialog and clears the selection on confirm', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{
          channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
          videos: [makeVideo({ metadata: { ...makeVideo().metadata, originalUrl: 'https://youtube.com/watch?v=vidA' } })],
        }],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('button', { name: /Download selected/ }));

      expect(await screen.findByText('Download 1 selected video')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Queue Download' }));

      expect(screen.queryByText('Download 1 selected video')).not.toBeInTheDocument();
      expect(screen.queryByText('1 item selected')).not.toBeInTheDocument();
    });

    // Regression test: bulk-downloading an already-in-library video (this
    // exact flow -- select it, then "Download selected") built its queue
    // entry with no thumbnailUrl at all, so BulkAddSidePanel's item preview
    // (which only renders an <img> when thumbnailUrl is truthy) fell back to
    // its plain placeholder -- unlike a fresh bulk-add paste, which always
    // has one. The already-in-library video's local thumbnailPath should be
    // preferred as the source, since it's normally already cached by the
    // time this flow is even reachable.
    it('carries the already-cached local thumbnail into the queued entry for "Download selected"', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        channels: [{
          channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
          videos: [makeVideo({
            thumbnailPath: '/lib/Channel A/vidA/video-thumbnail.jpg',
            metadata: { ...makeVideo().metadata, originalUrl: 'https://youtube.com/watch?v=vidA' },
          })],
        }],
      });
      let queuedItems: BulkAddItem[] = [];
      function QueueProbe() {
        queuedItems = useBulkAddQueue().items;
        return null;
      }
      rtlRender(
        <MemoryRouter>
          <LibraryTagsProvider>
            <BulkAddProvider>
              <BackgroundPlayerProvider>
                <LibraryScreen />
                <QueueProbe />
              </BackgroundPlayerProvider>
            </BulkAddProvider>
          </LibraryTagsProvider>
        </MemoryRouter>,
      );
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('button', { name: /Download selected/ }));
      await screen.findByText('Download 1 selected video');
      await user.click(screen.getByRole('button', { name: 'Queue Download' }));

      await waitFor(() => expect(queuedItems).toHaveLength(1));
      expect(queuedItems[0].thumbnailUrl).toBe(`app-video://local/${encodeURIComponent('/lib/Channel A/vidA/video-thumbnail.jpg')}?v=0`);
    });

    it('hides "Move selected" when only one sublibrary exists', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));

      expect(screen.queryByRole('button', { name: /Move selected/ })).not.toBeInTheDocument();
    });

    it('moves the selection to the chosen sublibrary and clears it on confirm', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
        tags: [
          { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: 1 },
          { tagName: 'Music', folderName: 'Music', createdEpoch: 2 },
        ],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('button', { name: /Move selected/ }));

      expect(await screen.findByText(/Move 1 selected video/)).toBeInTheDocument();
      // Only "Music" is offered -- DefaultLibrary is the currently-active
      // tag, filtered out since there's nowhere to move a video *to* the
      // sublibrary it's already in.
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(window.electronAPI.moveLibraryEntries).toHaveBeenCalledWith(['/lib/Channel A/vidA'], 'Music'));
      expect(screen.queryByText(/Move 1 selected video/)).not.toBeInTheDocument();
      expect(screen.queryByText('1 item selected')).not.toBeInTheDocument();
    });

    it('a partial move failure keeps only the failed items selected', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
        tags: [
          { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: 1 },
          { tagName: 'Music', folderName: 'Music', createdEpoch: 2 },
        ],
      });
      (window.electronAPI.moveLibraryEntries as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        results: [
          { videoDir: '/lib/Channel A/vidA', success: true },
          { videoDir: '/lib/Channel B/vidB', success: false, error: 'boom' },
        ],
      });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Beta Video' }));
      await user.click(screen.getByRole('button', { name: /Move selected/ }));
      await user.click(await screen.findByRole('button', { name: 'Move' }));

      expect(await screen.findByText(/couldn't be moved/)).toBeInTheDocument();
      expect(screen.getByText('1 item selected')).toBeInTheDocument();
    });

    it('"Tag selected" is offered whenever anything is selected, unlike Move\'s multi-sublibrary gate', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));

      expect(screen.getByRole('button', { name: /Tag selected/ })).toBeInTheDocument();
    });

    it('tags the selection with a picked existing tag and clears the selection on confirm', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidC'] } });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('button', { name: /Tag selected/ }));

      expect(await screen.findByText(/Tag 1 selected video/)).toBeInTheDocument();
      await user.type(screen.getByRole('combobox'), 'TVshows');
      await user.click(screen.getByRole('button', { name: 'Tag' }));

      await waitFor(() => expect(window.electronAPI.tagVideos).toHaveBeenCalledWith(['vidA'], 'TVshows'));
      expect(screen.queryByText(/Tag 1 selected video/)).not.toBeInTheDocument();
      expect(screen.queryByText('1 item selected')).not.toBeInTheDocument();
    });

    it('tags the selection with a brand-new, freely typed tag', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      await user.click(screen.getByRole('button', { name: /Tag selected/ }));
      await user.type(screen.getByRole('combobox'), 'brandNewTag');
      await user.click(await screen.findByRole('button', { name: 'Tag' }));

      await waitFor(() => expect(window.electronAPI.tagVideos).toHaveBeenCalledWith(['vidA'], 'brandNewTag'));
    });

    it('resets the selection when navigating back to the channel list', async () => {
      const user = userEvent.setup();
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));
      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
      expect(screen.getByText('1 item selected')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back to channels' }));
      await user.click(await screen.findByText('Channel A'));

      expect(screen.queryByText(/item.*selected/)).not.toBeInTheDocument();
    });
  });

  describe('tag filter', () => {
    it('shows the filter popover with a checkbox per known tag', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidA'], games: ['vidB'] } });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));

      expect(screen.getByRole('checkbox', { name: 'TVshows' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'games' })).toBeInTheDocument();
    });

    it('filters to only videos carrying every selected tag (AND, not ANY)', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidA'], games: ['vidB'] } });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));

      // Only Alpha (TVshows) matches -- Beta (games only) is filtered out.
      expect(screen.getByText('Alpha Video')).toBeInTheDocument();
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();

      // Selecting a second tag neither video carries both of -- AND
      // semantics means the result narrows to nothing, not widens.
      await user.click(screen.getByRole('checkbox', { name: 'games' }));
      expect(screen.queryByText('Alpha Video')).not.toBeInTheDocument();
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();
      expect(screen.getByText('No videos match the selected filter.')).toBeInTheDocument();
    });

    it('the tag filter composes with search, narrowing within the already-filtered set', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidA', 'vidB'] } });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));
      expect(screen.getByText('Alpha Video')).toBeInTheDocument();
      expect(screen.getByText('Beta Video')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      await user.type(screen.getByPlaceholderText('Search videos...'), 'Alpha');

      await waitFor(() => expect(screen.queryByText('Beta Video')).not.toBeInTheDocument());
      expect(screen.getByText('Alpha Video')).toBeInTheDocument();
    });

    it('"Clear filter" resets the selection and shows every video again', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidA'] } });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Clear filter' }));
      expect(await screen.findByText('Beta Video')).toBeInTheDocument();
    });
  });

  describe('system filter (downloaded / not downloaded)', () => {
    function makeChannelsWithOneDownloaded() {
      const channels = makeChannels();
      channels[0].videos[0].epochs = [{
        epoch: '1',
        metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080' },
      }];
      return channels;
    }

    it('shows Downloaded and Not Downloaded checkboxes in the filter popover', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));

      expect(screen.getByRole('checkbox', { name: 'Downloaded' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Not Downloaded' })).toBeInTheDocument();
    });

    it('"Downloaded" narrows to only videos with a downloaded file', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithOneDownloaded() });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'Downloaded' }));

      expect(screen.getByText('Alpha Video')).toBeInTheDocument();
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();
    });

    it('"Not Downloaded" narrows to only videos without a downloaded file', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithOneDownloaded() });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'Not Downloaded' }));

      expect(screen.queryByText('Alpha Video')).not.toBeInTheDocument();
      expect(screen.getByText('Beta Video')).toBeInTheDocument();
    });

    it('composes with a tag filter (AND semantics)', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithOneDownloaded() });
      (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidA', 'vidB'] } });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));
      // Both carry the tag -- narrowing further by "Not Downloaded" should
      // drop Alpha (downloaded), leaving only Beta.
      await user.click(screen.getByRole('checkbox', { name: 'Not Downloaded' }));

      expect(screen.queryByText('Alpha Video')).not.toBeInTheDocument();
      expect(screen.getByText('Beta Video')).toBeInTheDocument();
    });
  });

  describe('system filter (non-YouTube)', () => {
    function makeChannelsWithOneNonYoutube() {
      const channels = makeChannels();
      return [
        {
          ...channels[0],
          videos: [{ ...channels[0].videos[0], metadata: { ...channels[0].videos[0].metadata, platform: 'soundcloud' } }],
        },
        {
          ...channels[1],
          videos: [{ ...channels[1].videos[0], metadata: { ...channels[1].videos[0].metadata, platform: 'youtube' } }],
        },
      ];
    }

    it('shows a "Non-YouTube" checkbox in the filter popover', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));

      expect(screen.getByRole('checkbox', { name: 'Non-YouTube' })).toBeInTheDocument();
    });

    it('narrows to only videos whose platform is set and not youtube', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithOneNonYoutube() });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'Non-YouTube' }));

      expect(screen.getByText('Alpha Video')).toBeInTheDocument();
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();
    });

    it('excludes videos with no platform at all (plain YouTube backward-compat case)', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      // Default makeChannels() fixtures carry no `platform` field at all.
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'Non-YouTube' }));

      expect(screen.queryByText('Alpha Video')).not.toBeInTheDocument();
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();
    });

    // Regression test: the platform label was only shown on the video's own
    // detail page at first -- it needs to show up on the card itself too,
    // both in the flat "all videos" list (viewMode 'video', exercised here)
    // and the per-channel grid (VideoCard is shared by both, so this covers
    // both call sites without a second test).
    it('shows a platform chip on the video card itself, in the row below the title (not next to it)', async () => {
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithOneNonYoutube() });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      expect(screen.getByText('soundcloud')).toBeInTheDocument();
      // Beta Video's platform is explicitly 'youtube' -- no chip for it.
      const betaCard = screen.getByText('Beta Video').closest('.MuiCard-root') as HTMLElement;
      expect(within(betaCard).queryByText('youtube')).not.toBeInTheDocument();
    });

    // Regression test: the platform name used to show up twice on a generic
    // entry's card -- once as the new platform chip, once as the plain-text
    // channel-name caption underneath (which, for a platform-grouped entry,
    // is that same platform string). The channel-name caption is only
    // meaningful for a real YouTube channel; a generic entry should show it
    // nowhere near the card, not even duplicated.
    it('hides the plain-text channel name for a generic entry (avoiding duplicating the platform chip), but keeps it for a real YouTube channel', async () => {
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithOneNonYoutube() });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      const alphaCard = screen.getByText('Alpha Video').closest('.MuiCard-root') as HTMLElement;
      expect(within(alphaCard).queryByText('Channel A')).not.toBeInTheDocument();

      const betaCard = screen.getByText('Beta Video').closest('.MuiCard-root') as HTMLElement;
      expect(within(betaCard).getByText('Channel B')).toBeInTheDocument();
    });
  });

  describe('platform-group channel (non-YouTube)', () => {
    function makeChannelsWithPlatformGroup() {
      const channels = makeChannels();
      return [
        {
          channelFolderName: 'NonYT/soundcloud', displayName: 'soundcloud', channelIconPath: null,
          isPlatformGroup: true, platform: 'soundcloud',
          videos: [makeVideo({
            videoFolderName: 'vidC', videoDir: '/lib/NonYT/soundcloud/vidC',
            metadata: { ...makeVideo().metadata, videoId: 'vidC', channel: 'Some Uploader', title: 'Gamma Track', platform: 'soundcloud' },
          })],
        },
        ...channels,
      ];
    }

    it('renders the platform icon for an isPlatformGroup channel, not an Avatar or the plain FolderIcon fallback', async () => {
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithPlatformGroup() });
      render(<LibraryScreen />);
      await screen.findByText('soundcloud');

      const card = screen.getByText('soundcloud').closest('.MuiCard-root');
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByTestId('AudiotrackIcon')).toBeInTheDocument();
      expect(within(card as HTMLElement).queryByTestId('FolderIcon')).not.toBeInTheDocument();
      expect(within(card as HTMLElement).queryByRole('img')).not.toBeInTheDocument(); // no Avatar

      // A real per-uploader channel (channelIconPath: null) is unaffected --
      // still falls back to the plain folder icon, not a platform icon.
      const channelACard = screen.getByText('Channel A').closest('.MuiCard-root');
      expect(channelACard).not.toBeNull();
      expect(within(channelACard as HTMLElement).getByTestId('FolderIcon')).toBeInTheDocument();
    });

    it('shows the platform icon in the video grid header and hides "Refresh channel icon" for a platform-group channel', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: makeChannelsWithPlatformGroup() });
      render(<LibraryScreen />);
      await user.click(await screen.findByText('soundcloud'));

      expect(await screen.findByText('Gamma Track')).toBeInTheDocument();
      expect(screen.getByTestId('AudiotrackIcon')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Refresh channel icon' })).not.toBeInTheDocument();
    });

    it('a real channel still shows its "Refresh channel icon" button in the video grid, unaffected', async () => {
      const user = userEvent.setup();
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));

      expect(screen.getByRole('button', { name: 'Refresh channel icon' })).toBeInTheDocument();
      expect(screen.queryByTestId('AudiotrackIcon')).not.toBeInTheDocument();
    });
  });

  describe('select all (flat video list)', () => {
    it('starts unchecked, and checking it selects every currently visible video', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
      expect(selectAll).not.toBeChecked();

      await user.click(selectAll);

      expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Select Beta Video' })).toBeChecked();
      expect(screen.getByText('2 items selected')).toBeInTheDocument();
      expect(selectAll).toBeChecked();
    });

    it('shows indeterminate once some but not all visible videos are selected individually, then checked once all are', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
      await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));

      // MUI's Checkbox never sets the native `input.indeterminate` IDL
      // property -- it only reflects the indeterminate prop via
      // `aria-checked="mixed"` (plus a `data-indeterminate` attribute used
      // purely for styling). Assert on the a11y state, not the DOM property.
      expect(selectAll).toHaveAttribute('aria-checked', 'mixed');
      expect(selectAll).not.toBeChecked();

      await user.click(screen.getByRole('checkbox', { name: 'Select Beta Video' }));

      expect(selectAll).not.toHaveAttribute('aria-checked', 'mixed');
      expect(selectAll).toBeChecked();
    });

    it('unchecking "Select all" clears the whole selection', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
      await user.click(selectAll);
      expect(screen.getByText('2 items selected')).toBeInTheDocument();

      await user.click(selectAll);

      expect(screen.queryByText(/item.*selected/)).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).not.toBeChecked();
    });

    it('selects only the currently tag-filtered set, not the whole library', async () => {
      const user = userEvent.setup();
      (window.electronAPI.getLibraryViewMode as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryViewMode: 'video' });
      (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({ tags: { TVshows: ['vidA'] } });
      render(<LibraryScreen />);
      await screen.findByText('Alpha Video');

      await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
      await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));
      await user.keyboard('{Escape}');
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();

      await user.click(screen.getByRole('checkbox', { name: 'Select all' }));

      expect(screen.getByText('1 item selected')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).toBeChecked();
    });
  });

  describe('select all (channel video grid)', () => {
    it('selects every video within the currently open channel only', async () => {
      const user = userEvent.setup();
      render(<LibraryScreen />);
      await user.click(await screen.findByText('Channel A'));
      await screen.findByText('Alpha Video');

      const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
      expect(selectAll).not.toBeChecked();

      await user.click(selectAll);

      expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).toBeChecked();
      expect(screen.getByText('1 item selected')).toBeInTheDocument();
    });
  });

  describe('deep link with ?tag=', () => {
    it('switches to the linked sublibrary before resolving the video, when it differs from the active one', async () => {
      (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
        tags: [
          { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: 1 },
          { tagName: 'Music', folderName: 'Music', createdEpoch: 2 },
        ],
      });
      (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({
        found: true, videoDir: '/lib/Channel A/vidA',
      });

      renderAt('/library/video/vidA?tag=Music', <LibraryScreen />);

      await waitFor(() => expect(window.electronAPI.setActiveLibraryTag).toHaveBeenCalledWith('Music'));
      // The lookup itself is scoped to the linked tag too -- not whatever
      // was active when the link was clicked.
      expect(window.electronAPI.findLibraryVideo).toHaveBeenCalledWith('vidA', 'Music');
      expect(await screen.findByText('Detail: vidA')).toBeInTheDocument();
    });

    it('does not switch when the linked tag is already the active one', async () => {
      (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({
        found: true, videoDir: '/lib/Channel A/vidA',
      });

      renderAt('/library/video/vidA?tag=DefaultLibrary', <LibraryScreen />);

      expect(await screen.findByText('Detail: vidA')).toBeInTheDocument();
      expect(window.electronAPI.setActiveLibraryTag).not.toHaveBeenCalled();
    });
  });
});
