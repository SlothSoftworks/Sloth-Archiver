// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import BulkAddDialog from './BulkAddDialog';
import { BulkAddProvider, useBulkAddQueue } from '../hooks/useBulkAddQueue';
import { LibraryTagsProvider, useLibraryTags } from '../hooks/useLibraryTags';
import { ChannelArchiveProvider } from '../hooks/useChannelArchive';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    fetchPlaylistEntries: vi.fn(),
    getVideoInfoResult: vi.fn(() => new Promise<never>(() => {})),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [] }),
    getActiveLibraryTag: vi.fn().mockResolvedValue({ activeLibraryTag: 'DefaultLibrary', activeLibraryTagDir: '' }),
    setActiveLibraryTag: vi.fn().mockResolvedValue({ success: true, activeLibraryTag: 'DefaultLibrary' }),
    createLibraryTag: vi.fn().mockResolvedValue({ success: true, tag: { tagName: 'New', folderName: 'New', createdEpoch: 1 } }),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn(),
    removeProgressListener: vi.fn(),
    cancelDownload: vi.fn(),
  };
});

function renderDialog(onClose = vi.fn()) {
  const utils = render(
    <MemoryRouter><LibraryTagsProvider><BulkAddProvider><BulkAddDialog open onClose={onClose} /></BulkAddProvider></LibraryTagsProvider></MemoryRouter>,
  );
  return { ...utils, onClose };
}

// Regression harness for the sublibrary-selector staleness bug:
// BulkAddDialog stays permanently mounted (only its `open` prop toggles) in
// the real app, so this renders it alongside a sibling that can create a
// sublibrary "elsewhere" (same as LibraryScreen would) while the dialog
// stays mounted throughout, both sharing one LibraryTagsProvider -- exactly
// the scenario the old fetch-once-on-mount effect could never pick up.
function CreateTagButton() {
  const { createTag } = useLibraryTags();
  return <button onClick={() => createTag('Second')}>create sublibrary (test)</button>;
}

function SwitchTagButton({ tag }: { tag: string }) {
  const { switchTag } = useLibraryTags();
  return <button onClick={() => switchTag(tag)}>switch to {tag} (test)</button>;
}

// Toggling `open` locally (a real close/reopen), not remounting BulkAddDialog
// itself -- matches how BulkAddSidePanel actually drives it in the real app.
function ToggleableDialogWithCreateHarness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen((v) => !v)}>toggle dialog (test)</button>
      <CreateTagButton />
      <SwitchTagButton tag="Second" />
      <BulkAddDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function renderDialogWithCreateHarness() {
  return render(
    <MemoryRouter><LibraryTagsProvider><BulkAddProvider><ToggleableDialogWithCreateHarness /></BulkAddProvider></LibraryTagsProvider></MemoryRouter>,
  );
}

describe('BulkAddDialog', () => {
  it('shows a validation error and does not submit when a link is invalid', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), 'not a url, https://youtu.be/def');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText(/link\(s\) aren't valid URLs/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('submits a comma-separated list of valid links directly, without fetching a playlist', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), 'https://youtu.be/aaa, https://youtu.be/bbb');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(window.electronAPI.fetchPlaylistEntries).not.toHaveBeenCalled();
  });

  it('fetches and starts a playlist when the single input line is a playlist URL', async () => {
    const user = userEvent.setup();
    (window.electronAPI.fetchPlaylistEntries as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, playlistId: 'PL1', entries: [{ id: 'v1', title: 'One', url: 'https://youtu.be/v1', thumbnailUrl: 't', uploadDate: null }],
    });
    const { onClose } = renderDialog();

    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), 'https://www.youtube.com/playlist?list=PL1');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(window.electronAPI.fetchPlaylistEntries).toHaveBeenCalledWith('https://www.youtube.com/playlist?list=PL1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('expands a playlist line and keeps a plain video line standalone when both are pasted together', async () => {
    const user = userEvent.setup();
    (window.electronAPI.fetchPlaylistEntries as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, playlistId: 'PL1', entries: [{ id: 'v1', title: 'One', url: 'https://youtu.be/v1', thumbnailUrl: 't', uploadDate: null }],
    });
    const { onClose } = renderDialog();

    await user.type(
      screen.getByPlaceholderText(/youtube\.com\/playlist/),
      'https://www.youtube.com/watch?v=RrmWFjnAP2E&list=PL1{enter}https://www.youtube.com/watch?v=oiuyhxp4w9I&rco=1',
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(window.electronAPI.fetchPlaylistEntries).toHaveBeenCalledWith('https://www.youtube.com/watch?v=RrmWFjnAP2E&list=PL1'));
    // Only the playlist line is expanded via fetchPlaylistEntries -- the
    // plain video line is never passed to it.
    expect(window.electronAPI.fetchPlaylistEntries).not.toHaveBeenCalledWith(expect.stringContaining('oiuyhxp4w9I'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an error and stays open when fetching the playlist fails', async () => {
    const user = userEvent.setup();
    (window.electronAPI.fetchPlaylistEntries as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, message: 'blocked' });
    const { onClose } = renderDialog();

    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), 'https://www.youtube.com/playlist?list=PL1');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('blocked')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reveals the quality selector only once "also download" is toggled on', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('Cancel closes without submitting', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(window.electronAPI.fetchPlaylistEntries).not.toHaveBeenCalled();
  });

  describe('sublibrary selector staleness regression', () => {
    it('shows a sublibrary created elsewhere without remounting this permanently-mounted dialog', async () => {
      const user = userEvent.setup();
      (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
        tags: [{ tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: null }],
      });
      renderDialogWithCreateHarness();

      // Only one sublibrary so far -- the "Add to" selector isn't shown yet.
      await waitFor(() => expect(screen.queryByLabelText('Add to')).not.toBeInTheDocument());

      (window.electronAPI.createLibraryTag as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, tag: { tagName: 'Second', folderName: 'Second', createdEpoch: 1 },
      });
      (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
        tags: [
          { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: null },
          { tagName: 'Second', folderName: 'Second', createdEpoch: 1 },
        ],
      });
      // hidden: true -- MUI's Dialog marks everything outside itself
      // aria-hidden while open, including this sibling test-harness button,
      // which is otherwise perfectly real and clickable.
      await user.click(screen.getByRole('button', { name: 'create sublibrary (test)', hidden: true }));

      // The dialog never remounted (same instance throughout) but now shows
      // the selector at all -- it was absent above with only one sublibrary,
      // and appears once useLibraryTags' shared state picks up the second.
      await waitFor(() => expect(screen.getByLabelText('Add to')).toBeInTheDocument());
    });

    it('reseeds the default target to the current active tag every time the dialog reopens, not just its first mount', async () => {
      const user = userEvent.setup();
      (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
        tags: [
          { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: null },
          { tagName: 'Second', folderName: 'Second', createdEpoch: 1 },
        ],
      });
      renderDialogWithCreateHarness();
      await waitFor(() => expect(screen.getByLabelText('Add to')).toBeInTheDocument());
      expect(screen.getByLabelText('Add to')).toHaveTextContent('DefaultLibrary');

      // Close, then simulate the active sublibrary changing elsewhere while
      // closed (e.g. switched from LibraryScreen, sharing the same hook),
      // then reopen.
      (window.electronAPI.getActiveLibraryTag as ReturnType<typeof vi.fn>).mockResolvedValue({
        activeLibraryTag: 'Second', activeLibraryTagDir: '/lib/Second',
      });
      // hidden: true throughout -- MUI's Dialog exit transition keeps these
      // sibling test-harness buttons marked aria-hidden for a moment even
      // after `open` flips to false (see the comment on the other
      // regression test above for why they're aria-hidden at all).
      await user.click(screen.getByRole('button', { name: 'toggle dialog (test)', hidden: true })); // close
      await user.click(screen.getByRole('button', { name: 'switch to Second (test)', hidden: true }));
      await user.click(screen.getByRole('button', { name: 'toggle dialog (test)', hidden: true })); // reopen

      await waitFor(() => expect(screen.getByLabelText('Add to')).toHaveTextContent('Second'));
    });
  });
});

// As mounted in the real app: inside the channel-archive provider, with a
// route for the channel view to land on. The queue hook is read alongside
// so the tests can see what happened to the drawer and the queue.
function renderDialogInApp(onClose = vi.fn()) {
  let queue!: ReturnType<typeof useBulkAddQueue>;
  function QueueProbe() {
    queue = useBulkAddQueue();
    return null;
  }
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
  render(
    <MemoryRouter>
      <LibraryTagsProvider>
        <BulkAddProvider>
          <ChannelArchiveProvider>
            <QueueProbe />
            <BulkAddDialog open onClose={onClose} />
            <Routes>
              <Route path="/" element={<div>Home</div>} />
              <Route path="/channel-archive" element={<div>Channel archive view</div>} />
            </Routes>
          </ChannelArchiveProvider>
        </BulkAddProvider>
      </LibraryTagsProvider>
    </MemoryRouter>,
  );
  return { onClose, getQueue: () => queue };
}

describe('BulkAddDialog: channel links', () => {
  it('a single channel link closes the dialog and the drawer, starts a scan, and opens the channel view', async () => {
    const user = userEvent.setup();
    const { onClose, getQueue } = renderDialogInApp();
    act(() => getQueue().setPanelOpen(true));

    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), '  https://www.youtube.com/@veritasium  ');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Channel archive view')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getQueue().panelOpen).toBe(false);
    expect(window.electronAPI.scanChannel).toHaveBeenCalledWith(expect.any(String), 'https://www.youtube.com/@veritasium');
    expect(window.electronAPI.fetchPlaylistEntries).not.toHaveBeenCalled();
    expect(window.electronAPI.getVideoInfoResult).not.toHaveBeenCalled();
    expect(getQueue().items).toHaveLength(0);
  });

  it('rejects a channel link mixed with other links and submits nothing', async () => {
    const user = userEvent.setup();
    const { onClose, getQueue } = renderDialogInApp();

    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), 'https://youtu.be/aaa, https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA/videos, https://www.youtube.com/playlist?list=PL1');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Channel links need to be added on their own.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(window.electronAPI.scanChannel).not.toHaveBeenCalled();
    expect(window.electronAPI.fetchPlaylistEntries).not.toHaveBeenCalled();
    expect(getQueue().items).toHaveLength(0);
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('still queues plain links and expands a playlist with the provider present', async () => {
    const user = userEvent.setup();
    (window.electronAPI.fetchPlaylistEntries as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, playlistId: 'PL1', entries: [{ id: 'v1', title: 'One', url: 'https://youtu.be/v1', thumbnailUrl: 't', uploadDate: null }],
    });
    const { onClose, getQueue } = renderDialogInApp();

    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), 'https://www.youtube.com/playlist?list=PL1, https://youtu.be/bbb');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(window.electronAPI.fetchPlaylistEntries).toHaveBeenCalledWith('https://www.youtube.com/playlist?list=PL1');
    expect(getQueue().items.map((it) => it.sourceUrl)).toEqual(['https://youtu.be/v1', 'https://youtu.be/bbb']);
    expect(window.electronAPI.scanChannel).not.toHaveBeenCalled();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('says so instead of misfiling a channel link when there is no channel-archive provider', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.type(screen.getByPlaceholderText(/youtube\.com\/playlist/), 'https://www.youtube.com/@veritasium');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Channel links can\'t be added from here.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(window.electronAPI.fetchPlaylistEntries).not.toHaveBeenCalled();
  });
});
