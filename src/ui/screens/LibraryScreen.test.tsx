// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LibraryScreen from './LibraryScreen';

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
    refreshLibraryIndex: vi.fn().mockResolvedValue({ channels: makeChannels() }),
    refreshChannelIcon: vi.fn(),
    openDirectory: vi.fn(),
    onLibraryBackgroundUpdate: vi.fn(),
    removeLibraryBackgroundUpdateListener: vi.fn(),
  };
});

describe('LibraryScreen', () => {
  it('shows "no library folder" when none is configured', async () => {
    (window.electronAPI.getLibraryDir as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDir: '' });
    render(<LibraryScreen />);
    expect(await screen.findByText('No library folder set')).toBeInTheDocument();
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
});
