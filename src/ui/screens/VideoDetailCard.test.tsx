// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VideoDetailCard from './VideoDetailCard';
import type { DownloadProgressMessage } from '../../types';

let registeredCallback: ((msg: DownloadProgressMessage) => void) | null = null;

const videoMetaData = {
  id: 'vid1',
  fullTitle: 'My Great Video',
  description: 'a description with a link https://example.com/x here',
  thumbnail: 'https://example.com/thumb.jpg',
  resolutions: [
    { resolution: '720', filesizeMb: '10' },
    { resolution: 'MP3', filesizeMb: '5' },
  ],
  originalUrl: 'https://youtube.com/watch?v=vid1',
  durationString: '2:00',
  uploadDate: '20260115',
};

beforeEach(() => {
  registeredCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    saveVideoFile: vi.fn(),
    checkFileExists: vi.fn(),
    openFileInDirectory: vi.fn(),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn((cb: (msg: DownloadProgressMessage) => void) => { registeredCallback = cb; }),
    removeProgressListener: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

function emit(msg: DownloadProgressMessage) {
  registeredCallback?.(msg);
}

describe('VideoDetailCard', () => {
  it('renders the title as a link to the original URL and the formatted upload date', () => {
    render(<VideoDetailCard videoMetaData={videoMetaData} />);
    const link = screen.getByRole('link', { name: 'My Great Video' });
    expect(link).toHaveAttribute('href', 'https://youtube.com/watch?v=vid1');
    expect(screen.getByText('2026 / Jan / 15')).toBeInTheDocument();
  });

  it('renders one button per resolution, showing size and a "p" suffix except for MP3', () => {
    render(<VideoDetailCard videoMetaData={videoMetaData} />);
    expect(screen.getByRole('button', { name: /720p/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^MP3/ })).toBeInTheDocument();
  });

  it('toggles the description via the expand/collapse icon', async () => {
    const user = userEvent.setup();
    render(<VideoDetailCard videoMetaData={videoMetaData} />);
    expect(screen.getByRole('button', { name: 'Collapse description' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse description' }));
    expect(screen.getByRole('button', { name: 'Expand description' })).toBeInTheDocument();
  });

  it('starts a download directly when the save location has no existing file', async () => {
    const user = userEvent.setup();
    (window.electronAPI.saveVideoFile as ReturnType<typeof vi.fn>).mockResolvedValue({ canceled: false, filePath: '/x/video.mp4' });
    (window.electronAPI.checkFileExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    render(<VideoDetailCard videoMetaData={videoMetaData} />);

    await user.click(screen.getByRole('button', { name: /720p/ }));

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: videoMetaData.originalUrl, outputPath: '/x/video.mp4', resolution: '720', overwriteMode: undefined }),
    );
    expect(screen.getByText(/Downloading \(720p\)/)).toBeInTheDocument();
  });

  it('does not start a download when the save dialog is cancelled', async () => {
    const user = userEvent.setup();
    (window.electronAPI.saveVideoFile as ReturnType<typeof vi.fn>).mockResolvedValue({ canceled: true });
    render(<VideoDetailCard videoMetaData={videoMetaData} />);

    await user.click(screen.getByRole('button', { name: /720p/ }));

    expect(window.electronAPI.checkFileExists).not.toHaveBeenCalled();
    expect(window.electronAPIPythonDownload.startDownloadPython).not.toHaveBeenCalled();
  });

  it('asks to resume or overwrite when a file already exists, and forwards the choice', async () => {
    const user = userEvent.setup();
    (window.electronAPI.saveVideoFile as ReturnType<typeof vi.fn>).mockResolvedValue({ canceled: false, filePath: '/x/video.mp4' });
    (window.electronAPI.checkFileExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    render(<VideoDetailCard videoMetaData={videoMetaData} />);

    await user.click(screen.getByRole('button', { name: /720p/ }));
    expect(screen.getByText('File already exists')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: '/x/video.mp4', resolution: '720', overwriteMode: 'overwrite' }),
    );
  });

  it('shows postprocessing/downloaded status and an "open file location" action once done', async () => {
    const user = userEvent.setup();
    (window.electronAPI.saveVideoFile as ReturnType<typeof vi.fn>).mockResolvedValue({ canceled: false, filePath: '/x/video.mp4' });
    (window.electronAPI.checkFileExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    render(<VideoDetailCard videoMetaData={videoMetaData} />);
    await user.click(screen.getByRole('button', { name: /720p/ }));

    emit({ type: 'postprocessing', payload: { stage: 'start' } as DownloadProgressMessage['payload'] });
    expect(await screen.findByText(/Postprocessing \(720p\)/)).toBeInTheDocument();

    emit({ type: 'done', payload: { filename: '/x/video.mp4' } as DownloadProgressMessage['payload'] });
    expect(await screen.findByText(/Downloaded \(720p\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open file location' }));
    expect(window.electronAPI.openFileInDirectory).toHaveBeenCalledWith('/x/video.mp4');
  });

  it('shows a failure state with bug-report details on a download error', async () => {
    const user = userEvent.setup();
    (window.electronAPI.saveVideoFile as ReturnType<typeof vi.fn>).mockResolvedValue({ canceled: false, filePath: '/x/video.mp4' });
    (window.electronAPI.checkFileExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    render(<VideoDetailCard videoMetaData={videoMetaData} />);
    await user.click(screen.getByRole('button', { name: /720p/ }));

    emit({ type: 'error', payload: { message: 'network gone' } as unknown as DownloadProgressMessage['payload'] });
    expect(await screen.findByText('Download failed')).toBeInTheDocument();

    const detailsButton = screen.getByRole('button', { name: /Details/ });
    await user.click(detailsButton);
    expect(screen.getByText('A bug has been encountered')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Bug trace')).toHaveValue(JSON.stringify({ type: 'error', payload: { message: 'network gone' } }));
  });
});
