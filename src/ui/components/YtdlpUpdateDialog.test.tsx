// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import YtdlpUpdateDialog from './YtdlpUpdateDialog';
import { YtdlpUpdaterProvider } from '../hooks/useYtdlpUpdater';

let registeredCallback: ((data: { stage: string }) => void) | null = null;

beforeEach(() => {
  registeredCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    onYtdlpUpdateProgress: vi.fn((cb) => { registeredCallback = cb; }),
    removeYtdlpUpdateProgressListener: vi.fn(),
    checkForYtdlpUpdate: vi.fn(),
    startYtdlpUpdate: vi.fn(),
    quitApp: vi.fn(),
  };
});

function renderDialog() {
  return render(<YtdlpUpdaterProvider><YtdlpUpdateDialog /></YtdlpUpdaterProvider>);
}

describe('YtdlpUpdateDialog', () => {
  it('checks for an update automatically on mount and shows the choice dialog when one is available', async () => {
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.4', latest: '2026.7.5', updateAvailable: true,
    });
    renderDialog();

    await waitFor(() => expect(screen.getByText('yt-dlp update available')).toBeInTheDocument());
    expect(screen.getByText(/2026\.7\.4/)).toBeInTheDocument();
    expect(screen.getByText(/2026\.7\.5/)).toBeInTheDocument();
  });

  it('does not show the choice dialog when already up to date', async () => {
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.5', latest: '2026.7.5', updateAvailable: false,
    });
    renderDialog();

    await waitFor(() => expect(window.electronAPI.checkForYtdlpUpdate).toHaveBeenCalled());
    expect(screen.queryByText('yt-dlp update available')).not.toBeInTheDocument();
  });

  it('clicking Cancel quits the app', async () => {
    const user = userEvent.setup();
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.4', latest: '2026.7.5', updateAvailable: true,
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText('yt-dlp update available')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.electronAPI.quitApp).toHaveBeenCalled();
  });

  it('clicking Update starts the update and shows the in-progress overlay driven by real progress events', async () => {
    const user = userEvent.setup();
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.4', latest: '2026.7.5', updateAvailable: true,
    });
    (window.electronAPI.startYtdlpUpdate as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {})); // stays mid-update
    renderDialog();
    await waitFor(() => expect(screen.getByText('yt-dlp update available')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(screen.queryByText('yt-dlp update available')).not.toBeInTheDocument());

    act(() => registeredCallback?.({ stage: 'building' }));
    await waitFor(() => expect(screen.getByText('Building (this can take a minute)...')).toBeInTheDocument());
  });

  it('shows the failure overlay with Retry/Quit when the update fails', async () => {
    const user = userEvent.setup();
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.4', latest: '2026.7.5', updateAvailable: true,
    });
    // Mirrors main.mjs's real ytdlp:startUpdate handler, which always
    // broadcasts a stage:'error' progress event immediately before
    // rejecting -- useYtdlpUpdaterState's own catch block never resets
    // `stage` itself, so the failure overlay only actually appears because
    // of that paired broadcast, not the rejection alone.
    (window.electronAPI.startYtdlpUpdate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      registeredCallback?.({ stage: 'error' });
      throw new Error('build failed');
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText('yt-dlp update available')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(screen.getByText('Update failed')).toBeInTheDocument());
    expect(screen.getByText('build failed')).toBeInTheDocument();
    // MUI's Backdrop always sets aria-hidden="true" on itself unconditionally
    // (it's a decorative dimming layer by design) -- the Retry/Quit buttons
    // rendered inside it are therefore genuinely excluded from the default
    // accessibility tree, not just transiently during a transition. { hidden:
    // true } is Testing Library's documented escape hatch for querying real,
    // clickable elements that sit inside an aria-hidden ancestor like this.
    expect(screen.getByRole('button', { name: 'Retry', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quit', hidden: true })).toBeInTheDocument();
  });
});
