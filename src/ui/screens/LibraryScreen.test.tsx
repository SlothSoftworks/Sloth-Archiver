// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import LibraryScreen from './LibraryScreen';
import { BulkAddProvider } from '../hooks/useBulkAddQueue.tsx';

// LibraryScreen reads/matches deep-link routes (useMatch/useNavigate, for
// /library/video/:videoId) -- needs a real Router context, same reason
// App.test.tsx already wraps with one. BulkAddProvider is needed too, now
// that the bulk-select "Download selected" action calls useBulkAddQueue()
// directly -- without it every render throws ("must be used within a
// BulkAddProvider").
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter><BulkAddProvider>{ui}</BulkAddProvider></MemoryRouter>);
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
    getThumbnailSize: vi.fn().mockResolvedValue({ thumbnailSize: 220 }),
    setThumbnailSize: vi.fn().mockResolvedValue({ success: true, thumbnailSize: 220 }),
    refreshLibraryIndex: vi.fn().mockResolvedValue({ channels: makeChannels() }),
    refreshChannelIcon: vi.fn(),
    openDirectory: vi.fn(),
    onLibraryBackgroundUpdate: vi.fn(),
    removeLibraryBackgroundUpdateListener: vi.fn(),
    deleteLibraryEntries: vi.fn().mockResolvedValue({ success: true, results: [] }),
    deleteLocalFiles: vi.fn().mockResolvedValue({ success: true, results: [] }),
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

  it('opening the library folder calls openDirectory with the configured path', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen />);
    await screen.findByText('Channel A');

    await user.click(screen.getByRole('button', { name: 'Open library folder' }));
    expect(window.electronAPI.openDirectory).toHaveBeenCalledWith('/lib');
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
});
