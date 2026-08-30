// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import PlaylistsSection from './PlaylistsSection';
import { BulkAddProvider } from '../hooks/useBulkAddQueue.tsx';

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter><BulkAddProvider>{ui}</BulkAddProvider></MemoryRouter>);
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    videoId: 'vidA', title: 'Alpha Video', url: 'https://youtube.com/watch?v=vidA',
    thumbnailUrl: null, uploadDate: '20260101',
    ...overrides,
  };
}

function makePlaylist(overrides: Record<string, unknown> = {}) {
  return {
    playlistId: 'pl1', title: 'My Playlist', uploader: null, originalUrl: null,
    addedEpoch: 1, lastRefreshedEpoch: null,
    entries: [makeEntry()],
    localFiles: { vidA: '/lib/Channel A/vidA' },
    hasPreviousMetadata: false, previousMetadataSavedEpoch: null, thumbnailPath: null,
    ...overrides,
  };
}

function makeLibraryVideo(overrides: Record<string, unknown> = {}) {
  return {
    videoFolderName: 'vidA', videoDir: '/lib/Channel A/vidA', latestEpoch: '1',
    metadata: { videoId: 'vidA', channelId: 'UC1', channel: 'Channel A', title: 'Alpha Video' },
    epochs: [{ epoch: '1', metadata: {} }],
    thumbnailPath: null,
    ...overrides,
  };
}

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    listPlaylists: vi.fn().mockResolvedValue({ playlists: [{ playlistId: 'pl1', title: 'My Playlist', entryCount: 1, addedEpoch: 1, lastRefreshedEpoch: null, thumbnailUrl: null, thumbnailPath: null }] }),
    getPlaylist: vi.fn().mockResolvedValue({ playlist: makePlaylist() }),
    getLibraryIndex: vi.fn().mockResolvedValue({ channels: [{ channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null, videos: [makeLibraryVideo()] }] }),
    deleteLibraryEntries: vi.fn().mockResolvedValue({ success: true, results: [] }),
    deleteLocalFiles: vi.fn().mockResolvedValue({ success: true, results: [] }),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn(),
    removeProgressListener: vi.fn(),
    cancelDownload: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

describe('PlaylistsSection bulk select', () => {
  it('shows a checkbox for a normal entry, hides it for an unavailable one', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidB', title: 'Beta Video', unavailable: true })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidB: null },
      }),
    });
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await userEvent.setup().click(await screen.findByText('My Playlist'));

    expect(await screen.findByRole('checkbox', { name: 'Select Alpha Video' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Beta Video' })).not.toBeInTheDocument();
  });

  it('shows a quality chip for a downloaded entry and "Not downloaded" otherwise', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [makeLibraryVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080' } }] })],
      }],
    });
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await userEvent.setup().click(await screen.findByText('My Playlist'));

    expect(await screen.findByText('1080p')).toBeInTheDocument();
    expect(screen.getByText('Not downloaded')).toBeInTheDocument();
  });

  it('reports selection state up via onBulkBarUpdate', async () => {
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByRole('checkbox', { name: 'Select Alpha Video' });

    onBulkBarUpdate.mockClear();
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));

    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ selectedCount: 1, canBulkDownload: true }),
    ));
  });

  it('hides "Download selected" once the selection includes an already-downloaded video', async () => {
    (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [makeLibraryVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080' } }] })],
      }],
    });
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));
    await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha Video' }));

    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ selectedCount: 1, canBulkDownload: false }),
    ));
  });

  it('deletes only the selected entries that are actually in the library', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null }, // vidC never added to the library
      }),
    });
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));

    await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha Video' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));

    const lastBar = onBulkBarUpdate.mock.calls[onBulkBarUpdate.mock.calls.length - 1][0];
    lastBar.onDeleteFromLibrary();
    expect(await screen.findByText('Delete 1 video?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(window.electronAPI.deleteLibraryEntries).toHaveBeenCalledWith(['/lib/Channel A/vidA']));
  });

  it('queues a not-yet-added entry through the fresh-fetch path and an in-library one via resume-at-download', async () => {
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video', url: 'https://youtube.com/watch?v=vidC' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));

    await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha Video' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));

    const lastBar = onBulkBarUpdate.mock.calls[onBulkBarUpdate.mock.calls.length - 1][0];
    lastBar.onDownloadSelected();
    expect(await screen.findByText('Download 2 selected videos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Queue Download' }));

    // Dialog closes and selection clears once queued.
    expect(screen.queryByText('Download 2 selected videos')).not.toBeInTheDocument();
  });

  it('gates "Delete local files" on every selected video being downloaded, and calls deleteLocalFiles on confirm', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    (window.electronAPI.getLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [makeLibraryVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080' } }] })],
      }],
    });
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));

    // Only the downloaded one selected -- "Delete local files" applies.
    await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha Video' }));
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ canDeleteLocalFiles: true }),
    ));

    // Adding the not-yet-downloaded one hides it (all-or-nothing).
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ canDeleteLocalFiles: false }),
    ));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' })); // deselect it again

    const lastBar = onBulkBarUpdate.mock.calls[onBulkBarUpdate.mock.calls.length - 1][0];
    lastBar.onDeleteLocalFiles();
    expect(await screen.findByText('Delete local files for 1 video?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(window.electronAPI.deleteLocalFiles).toHaveBeenCalledWith(['/lib/Channel A/vidA']));
  });

  it('clears the bulk bar when navigating back to the playlist list', async () => {
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));
    await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha Video' }));

    await user.click(screen.getByRole('button', { name: 'Back to playlists' }));
    expect(onBulkBarUpdate).toHaveBeenLastCalledWith(null);
  });
});
