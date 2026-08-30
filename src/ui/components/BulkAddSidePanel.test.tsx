// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BulkAddSidePanel, { BulkAddToggleButton } from './BulkAddSidePanel';
import { BulkAddProvider, useBulkAddQueue } from '../hooks/useBulkAddQueue';

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
    getVideoInfoPython: vi.fn(),
    findLibraryVideo: vi.fn(),
    addLibraryEntry: vi.fn(),
    enrichPlaylistEntry: vi.fn().mockResolvedValue({ success: true }),
    recordLibraryDownload: vi.fn().mockResolvedValue({ success: true }),
    fetchPlaylistEntries: vi.fn(),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
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
    <BulkAddProvider><Harness onReady={(q) => { queue = q; }} /></BulkAddProvider>,
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
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'My Video' } },
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
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {})); // stays "fetching"
    const { getQueue } = renderPanel();
    act(() => getQueue().start([{ id: 'e1', title: null, url: 'https://youtu.be/v1' }], { download: false, targetResolution: 'dflt' }));
    await flush();

    const stopButton = screen.getByRole('button', { name: 'Stop after current item' });
    await user.click(stopButton);
    expect(screen.getByText('Stopping after this item...')).toBeInTheDocument();
  });

  it('offers Resume and Cancel all pending once stopped with items still pending', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: { response: { id: 'v1', fullTitle: 'One' } } });
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
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'My Video' } },
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
