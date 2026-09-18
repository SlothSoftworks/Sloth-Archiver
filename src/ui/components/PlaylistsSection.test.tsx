// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import PlaylistsSection from './PlaylistsSection';
import { BulkAddProvider } from '../hooks/useBulkAddQueue.tsx';
import { BackgroundPlayerProvider } from '../hooks/useBackgroundPlayer.tsx';

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter><BulkAddProvider><BackgroundPlayerProvider>{ui}</BackgroundPlayerProvider></BulkAddProvider></MemoryRouter>);
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
    refreshLibraryIndex: vi.fn().mockResolvedValue({ channels: [{ channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null, videos: [makeLibraryVideo()] }] }),
    deleteLibraryEntries: vi.fn().mockResolvedValue({ success: true, results: [] }),
    deleteLocalFiles: vi.fn().mockResolvedValue({ success: true, results: [] }),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
    listVideoTags: vi.fn().mockResolvedValue({ tags: {} }),
    tagVideos: vi.fn().mockResolvedValue({ success: true, tags: {} }),
    // Default: fails, same as a non-native file with nothing this app can
    // do for it -- individual "Add to queue" tests override this to
    // succeed where they specifically exercise the preview-generation
    // fallback.
    ensurePlayablePreview: vi.fn().mockResolvedValue({ success: false }),
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
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
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

describe('PlaylistsSection Add to queue', () => {
  it('"Play all" is disabled with no queueable entries, and hides "Add to queue" on rows with nothing downloaded', async () => {
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await userEvent.setup().click(await screen.findByText('My Playlist'));

    expect(await screen.findByRole('button', { name: 'Play all' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add to queue' })).not.toBeInTheDocument();
  });

  it('"Play all" enqueues every downloaded entry in order, skipping only ones with no library match at all', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [
          makeEntry({ videoId: 'vidA', title: 'Alpha Video' }),
          makeEntry({ videoId: 'vidB', title: 'Beta Video' }), // no library match at all
          makeEntry({ videoId: 'vidC', title: 'Gamma Video' }), // downloaded, MKV -- needs a preview
        ],
        localFiles: { vidA: '/lib/Channel A/vidA', vidB: null, vidC: '/lib/Channel A/vidC' },
      }),
    });
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [
          makeLibraryVideo({
            videoDir: '/lib/Channel A/vidA',
            epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080', channel: 'Channel A' } }],
          }),
          makeLibraryVideo({
            videoDir: '/lib/Channel A/vidC', metadata: { videoId: 'vidC', channel: 'Channel A', title: 'Gamma Video' },
            epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidC/1/video.mkv', downloadedResolution: '1080', channel: 'Channel A' } }],
          }),
        ],
      }],
    });
    (window.electronAPI.ensurePlayablePreview as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, previewPath: '/cache/vidC-preview.mp4' });
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));

    await user.click(await screen.findByRole('button', { name: 'Play all' }));

    // The first (native) item starts playing immediately -- confirmed via
    // the background player's own hidden <video> src, since there's no
    // other observable surface for the queue from this component.
    await waitFor(() => {
      expect(document.querySelector('video')?.getAttribute('src')).toContain('video.mp4');
    });
    // vidC (MKV) still made it into the queue, via the resolved preview --
    // only vidB (never downloaded at all) was skipped.
    await waitFor(() => expect(window.electronAPI.ensurePlayablePreview).toHaveBeenCalledWith({ filePath: '/lib/Channel A/vidC/1/video.mkv' }));
  });

  it('shows "Add to queue" on any downloaded entry (native or not), and enqueues it on click', async () => {
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [makeLibraryVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080', channel: 'Channel A' } }] })],
      }],
    });
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));

    await user.click(await screen.findByRole('button', { name: 'Add to queue' }));

    await waitFor(() => {
      expect(document.querySelector('video')?.getAttribute('src')).toContain('video.mp4');
    });
  });

  it('queues a non-native (MKV) entry via the on-the-fly preview generation, showing a loading spinner meanwhile', async () => {
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [makeLibraryVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mkv', downloadedResolution: '1080', channel: 'Channel A' } }] })],
      }],
    });
    let resolvePreview!: (value: { success: boolean; previewPath?: string }) => void;
    (window.electronAPI.ensurePlayablePreview as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolvePreview = resolve; }),
    );
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    const addButton = await screen.findByRole('button', { name: 'Add to queue' });

    await user.click(addButton);
    expect(addButton).toBeDisabled();

    resolvePreview({ success: true, previewPath: '/cache/vidA-preview.mp4' });

    await waitFor(() => {
      expect(document.querySelector('video')?.getAttribute('src')).toContain('vidA-preview.mp4');
    });
  });

  it('shows a toast and doesn\'t enqueue when preview generation fails for a non-native entry', async () => {
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [makeLibraryVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mkv', downloadedResolution: '1080', channel: 'Channel A' } }] })],
      }],
    });
    // Default beforeEach mock already resolves ensurePlayablePreview to failure.
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));

    await user.click(await screen.findByRole('button', { name: 'Add to queue' }));

    expect(await screen.findByText(/Couldn't prepare/)).toBeInTheDocument();
    expect(document.querySelector('video')).not.toHaveAttribute('src');
  });
});

describe('PlaylistsSection select all', () => {
  it('starts unchecked, and checking it selects every selectable entry', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByRole('checkbox', { name: 'Select Alpha Video' });

    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
    expect(selectAll).not.toBeChecked();

    await user.click(selectAll);

    expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Gamma Video' })).toBeChecked();
    expect(selectAll).toBeChecked();
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedCount: 2 }),
    ));
  });

  it('shows indeterminate once some but not all selectable entries are selected individually, then checked once all are', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByRole('checkbox', { name: 'Select Alpha Video' });

    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));

    // MUI's Checkbox never sets the native `input.indeterminate` IDL
    // property -- it only reflects the indeterminate prop via
    // `aria-checked="mixed"` (plus a `data-indeterminate` attribute used
    // purely for styling). Assert on the a11y state, not the DOM property.
    expect(selectAll).toHaveAttribute('aria-checked', 'mixed');
    expect(selectAll).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));

    expect(selectAll).not.toHaveAttribute('aria-checked', 'mixed');
    expect(selectAll).toBeChecked();
  });

  it('unchecking "Select all" clears the whole selection', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByRole('checkbox', { name: 'Select Alpha Video' });

    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
    await user.click(selectAll);
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedCount: 2 }),
    ));

    await user.click(selectAll);

    expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Gamma Video' })).not.toBeChecked();
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedCount: 0 }),
    ));
  });

  it('excludes unavailable entries from "select all"', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidB', title: 'Beta Video', unavailable: true })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidB: null },
      }),
    });
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByRole('checkbox', { name: 'Select Alpha Video' });

    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
    await user.click(selectAll);

    expect(screen.getByRole('checkbox', { name: 'Select Alpha Video' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Select Beta Video' })).not.toBeInTheDocument();
    // Only the one selectable entry counted -- an unavailable entry never
    // enters the selection even though it's nominally "visible".
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedCount: 1 }),
    ));
  });
});

describe('PlaylistsSection tag/system filter', () => {
  it('shows each entry\'s applied tags as chips', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      tags: { TVshows: ['vidA'] },
    });
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await userEvent.setup().click(await screen.findByText('My Playlist'));
    await screen.findByText('Alpha Video');

    expect(screen.getByText('TVshows')).toBeInTheDocument();
    // Gamma carries no tags -- no stray chip rendered for it.
    expect(await screen.findByText('Gamma Video')).toBeInTheDocument();
  });

  it('stays reachable even with zero visible entries, and narrows the list by tag (AND semantics)', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      tags: { TVshows: ['vidA'], games: ['vidC'] },
    });
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByText('Alpha Video');

    await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
    await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));

    expect(screen.getByText('Alpha Video')).toBeInTheDocument();
    expect(screen.queryByText('Gamma Video')).not.toBeInTheDocument();

    // AND semantics -- neither entry carries both tags, so this narrows to
    // nothing rather than widening.
    await user.click(screen.getByRole('checkbox', { name: 'games' }));
    expect(screen.queryByText('Alpha Video')).not.toBeInTheDocument();
    expect(screen.queryByText('Gamma Video')).not.toBeInTheDocument();
    expect(screen.getByText('No videos match your search or the selected filter.')).toBeInTheDocument();

    // Filter button/popover stay reachable with the list empty, so the
    // filter can still be cleared.
    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(await screen.findByText('Gamma Video')).toBeInTheDocument();
  });

  it('Downloaded / Not Downloaded narrow the list and compose with a tag filter', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: '/lib/Channel A/vidC' },
      }),
    });
    (window.electronAPI.refreshLibraryIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      channels: [{
        channelFolderName: 'Channel A', displayName: 'Channel A', channelIconPath: null,
        videos: [
          makeLibraryVideo({ epochs: [{ epoch: '1', metadata: { downloadedFilePath: '/lib/Channel A/vidA/1/video.mp4', downloadedResolution: '1080' } }] }),
          makeLibraryVideo({ videoFolderName: 'vidC', videoDir: '/lib/Channel A/vidC', metadata: { videoId: 'vidC', channelId: 'UC1', channel: 'Channel A', title: 'Gamma Video' } }),
        ],
      }],
    });
    (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      tags: { TVshows: ['vidA', 'vidC'] },
    });
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByText('Alpha Video');

    await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
    await user.click(screen.getByRole('checkbox', { name: 'Downloaded' }));

    expect(screen.getByText('Alpha Video')).toBeInTheDocument();
    expect(screen.queryByText('Gamma Video')).not.toBeInTheDocument();

    // Both carry TVshows -- combining with "Downloaded" should stay
    // narrowed to just Alpha (AND semantics).
    await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));
    expect(screen.getByText('Alpha Video')).toBeInTheDocument();
    expect(screen.queryByText('Gamma Video')).not.toBeInTheDocument();
  });

  it('a manually-selected entry that gets filtered out stays selected', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    (window.electronAPI.listVideoTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      tags: { TVshows: ['vidA'] },
    });
    const onBulkBarUpdate = vi.fn();
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={onBulkBarUpdate} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByText('Gamma Video');

    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedCount: 1 }),
    ));

    // Filtering Gamma out of view doesn't drop it from the selection --
    // bulk actions still target it.
    await user.click(screen.getByRole('button', { name: 'Filter by tag' }));
    await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));
    expect(screen.queryByText('Gamma Video')).not.toBeInTheDocument();
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedCount: 1 }),
    ));
  });
});

describe('PlaylistsSection bulk tag', () => {
  it('"Tag selected" is enabled only once an in-library entry is selected, and calls tagVideos with just that entry', async () => {
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
    await screen.findByRole('checkbox', { name: 'Select Alpha Video' });

    // Selecting only the not-yet-added entry -- nothing taggable yet.
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Video' }));
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ canTag: false }),
    ));

    // Adding the in-library entry makes it taggable.
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha Video' }));
    await waitFor(() => expect(onBulkBarUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ canTag: true }),
    ));

    const lastBar = onBulkBarUpdate.mock.calls[onBulkBarUpdate.mock.calls.length - 1][0];
    lastBar.onTagSelected();
    expect(await screen.findByText('Tag 1 selected video with an existing tag, or create a new one.')).toBeInTheDocument();

    await user.type(screen.getByRole('combobox'), 'TVshows');
    await user.click(screen.getByRole('button', { name: 'Tag' }));

    // Only the in-library entry (vidA) is passed -- vidC has nothing to tag yet.
    await waitFor(() => expect(window.electronAPI.tagVideos).toHaveBeenCalledWith(['vidA'], 'TVshows'));
  });
});

describe('PlaylistsSection entry search', () => {
  it('narrows the entry list to titles matching the query, and composes with the existing filters', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        entries: [makeEntry(), makeEntry({ videoId: 'vidB', title: 'Beta Video' })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidB: null },
      }),
    });
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByText('Beta Video');

    await user.type(screen.getByPlaceholderText('Search this playlist...'), 'alpha');

    await waitFor(() => {
      expect(screen.getByText('Alpha Video')).toBeInTheDocument();
      expect(screen.queryByText('Beta Video')).not.toBeInTheDocument();
    });
  });
});

describe('PlaylistsSection set playlist thumbnail', () => {
  it('shows the button only for available entries, sets the override on click, and reflects the active state', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      playlist: makePlaylist({
        manualThumbnailVideoId: null,
        entries: [makeEntry(), makeEntry({ videoId: 'vidC', title: 'Gamma Video', unavailable: true })],
        localFiles: { vidA: '/lib/Channel A/vidA', vidC: null },
      }),
    });
    window.electronAPI.setPlaylistManualThumbnail = vi.fn().mockResolvedValue({
      success: true, manualThumbnailVideoId: 'vidA', thumbnailUrl: 'https://example.com/a.jpg', thumbnailPath: null,
    });
    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByText('Alpha Video');

    // Only vidA (available) gets the button -- vidC (unavailable) gets none,
    // so there's exactly one "Set as playlist thumbnail" button on screen.
    const setButtons = screen.getAllByRole('button', { name: 'Set as playlist thumbnail' });
    expect(setButtons).toHaveLength(1);
    const [setButton] = setButtons;

    await user.click(setButton);

    expect(window.electronAPI.setPlaylistManualThumbnail).toHaveBeenCalledWith('pl1', 'vidA');
    // Now shows as active, with the "reset" affordance instead.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset to automatic thumbnail' })).toBeInTheDocument());

    window.electronAPI.setPlaylistManualThumbnail = vi.fn().mockResolvedValue({
      success: true, manualThumbnailVideoId: null, thumbnailUrl: null, thumbnailPath: null,
    });
    await user.click(screen.getByRole('button', { name: 'Reset to automatic thumbnail' }));

    expect(window.electronAPI.setPlaylistManualThumbnail).toHaveBeenCalledWith('pl1', null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set as playlist thumbnail' })).toBeInTheDocument());
  });
});

describe('PlaylistsSection refresh fetches full data for entries missing a library match', () => {
  it('feeds newly-added entries from a refresh into the bulk-add pipeline, metadata-only', async () => {
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ playlist: makePlaylist() });
    window.electronAPI.refreshPlaylist = vi.fn().mockResolvedValue({
      success: true, added: 1, removed: 0, updated: 0,
      missingFromLibraryEntries: [{ videoId: 'vidNew', title: 'New Video', url: 'https://youtube.com/watch?v=vidNew', thumbnailUrl: null, uploadDate: null }],
    });
    window.electronAPI.getVideoInfoPython = vi.fn().mockResolvedValue({
      data: { response: { id: 'vidNew', fullTitle: 'New Video', title: 'New Video', thumbnail: null, resolutions: [] } },
    });
    window.electronAPI.findLibraryVideo = vi.fn().mockResolvedValue({ found: false });
    window.electronAPI.addLibraryEntry = vi.fn().mockResolvedValue({ success: true, videoDir: '/lib/Channel B/vidNew' });
    window.electronAPI.enrichPlaylistEntry = vi.fn().mockResolvedValue({ success: true });

    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByText('Alpha Video');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    // Metadata-only: the new entry's real info gets fetched and written into
    // the library, but nothing is downloaded (no download-progress call).
    await waitFor(() => expect(window.electronAPI.getVideoInfoPython).toHaveBeenCalledWith('https://youtube.com/watch?v=vidNew'));
    await waitFor(() => expect(window.electronAPI.addLibraryEntry).toHaveBeenCalled());
  });

  it('also fetches an entry that was already in the playlist but still has no library match, not just newly-found ones', async () => {
    // Reported gap: an entry present since before this refresh (added
    // stays 0 -- reconcilePlaylistSnapshot doesn't consider it "new") but
    // still missing from the library must still be fetched.
    (window.electronAPI.getPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ playlist: makePlaylist() });
    window.electronAPI.refreshPlaylist = vi.fn().mockResolvedValue({
      success: true, added: 0, removed: 0, updated: 0,
      missingFromLibraryEntries: [{ videoId: 'vidA', title: 'Alpha Video', url: 'https://youtube.com/watch?v=vidA', thumbnailUrl: null, uploadDate: '20260101' }],
    });
    window.electronAPI.getVideoInfoPython = vi.fn().mockResolvedValue({
      data: { response: { id: 'vidA', fullTitle: 'Alpha Video', title: 'Alpha Video', thumbnail: null, resolutions: [] } },
    });
    window.electronAPI.findLibraryVideo = vi.fn().mockResolvedValue({ found: false });
    window.electronAPI.addLibraryEntry = vi.fn().mockResolvedValue({ success: true, videoDir: '/lib/Channel A/vidA' });
    window.electronAPI.enrichPlaylistEntry = vi.fn().mockResolvedValue({ success: true });

    const user = userEvent.setup();
    render(<PlaylistsSection onBulkBarUpdate={vi.fn()} />);
    await user.click(await screen.findByText('My Playlist'));
    await screen.findByText('Alpha Video');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(window.electronAPI.getVideoInfoPython).toHaveBeenCalledWith('https://youtube.com/watch?v=vidA'));
    await waitFor(() => expect(window.electronAPI.addLibraryEntry).toHaveBeenCalled());
  });
});
