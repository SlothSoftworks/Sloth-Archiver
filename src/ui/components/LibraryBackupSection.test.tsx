// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LibraryBackupSection from './LibraryBackupSection';

const plan = {
  sublibrariesCreated: 1,
  videosAdded: 3,
  versionsAdded: 5,
  videosAlreadyPresent: 2,
  localFilesSkipped: 1,
  invalidSkipped: 0,
  playlistsAdded: 1,
  playlistsAlreadyPresent: 0,
  labelsApplied: 0,
};
const nothingNew = { ...plan, sublibrariesCreated: 0, videosAdded: 0, versionsAdded: 0, playlistsAdded: 0, localFilesSkipped: 0, videosAlreadyPresent: 6 };

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    exportLibrary: vi.fn(),
    previewLibraryImport: vi.fn(),
    applyLibraryImport: vi.fn(),
  };
});

describe('LibraryBackupSection', () => {
  it('disables both actions until a library folder is configured', () => {
    render(<LibraryBackupSection libraryConfigured={false} />);
    expect(screen.getByRole('button', { name: 'Export library' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import library' })).toBeDisabled();
    expect(screen.getByText('Choose a library folder first.')).toBeInTheDocument();
  });

  it('reports what an export wrote, and stays quiet when the save dialog is cancelled', async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.exportLibrary)
      .mockResolvedValueOnce({ success: false, canceled: true })
      .mockResolvedValueOnce({ success: true, filePath: '/x.json', counts: { sublibraries: 2, videos: 10, versions: 12, playlists: 1 } });
    render(<LibraryBackupSection libraryConfigured />);

    await user.click(screen.getByRole('button', { name: 'Export library' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export library' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Export library' }));
    expect(await screen.findByText('Exported 10 videos from 2 sublibraries and 1 playlist.')).toBeInTheDocument();
  });

  it('shows an export failure message', async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.exportLibrary).mockResolvedValue({ success: false, message: 'Disk full' });
    render(<LibraryBackupSection libraryConfigured />);
    await user.click(screen.getByRole('button', { name: 'Export library' }));
    expect(await screen.findByText('Disk full')).toBeInTheDocument();
  });

  it('previews an import, then applies it with the preview token on confirm', async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.previewLibraryImport).mockResolvedValue({
      success: true, token: 'tok-1', fileName: 'backup.json', exportedAt: null, counts: { sublibraries: 2, videos: 6, versions: 8, playlists: 1 }, plan,
    });
    vi.mocked(window.electronAPI.applyLibraryImport).mockResolvedValue({ success: true, summary: plan });
    render(<LibraryBackupSection libraryConfigured />);

    await user.click(screen.getByRole('button', { name: 'Import library' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('backup.json');
    expect(dialog).toHaveTextContent('3 new videos');
    expect(dialog).toHaveTextContent('2 additional versions of videos');
    expect(dialog).toHaveTextContent('1 new sublibrary');
    expect(dialog).toHaveTextContent('1 local-file entry skipped');
    expect(dialog).toHaveTextContent('2 videos already in your library (left as is)');

    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(window.electronAPI.applyLibraryImport).toHaveBeenCalledWith('tok-1');
    expect(await screen.findByText(/^Imported: 3 new videos/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not offer to import a file that adds nothing', async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.previewLibraryImport).mockResolvedValue({
      success: true, token: 'tok-2', fileName: 'same.json', exportedAt: null, counts: { sublibraries: 1, videos: 6, versions: 6, playlists: 0 }, plan: nothingNew,
    });
    render(<LibraryBackupSection libraryConfigured />);
    await user.click(screen.getByRole('button', { name: 'Import library' }));
    expect(await screen.findByText(/nothing new to import/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.electronAPI.applyLibraryImport).not.toHaveBeenCalled();
  });

  it('shows why a chosen file could not be read', async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.previewLibraryImport).mockResolvedValue({ success: false, message: 'That file isn\'t a SlothArchiver library export.' });
    render(<LibraryBackupSection libraryConfigured />);
    await user.click(screen.getByRole('button', { name: 'Import library' }));
    expect(await screen.findByText('That file isn\'t a SlothArchiver library export.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
