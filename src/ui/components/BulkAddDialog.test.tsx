// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BulkAddDialog from './BulkAddDialog';
import { BulkAddProvider } from '../hooks/useBulkAddQueue';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    fetchPlaylistEntries: vi.fn(),
    getVideoInfoPython: vi.fn(() => new Promise(() => {})),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
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
    <BulkAddProvider><BulkAddDialog open onClose={onClose} /></BulkAddProvider>,
  );
  return { ...utils, onClose };
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
});
