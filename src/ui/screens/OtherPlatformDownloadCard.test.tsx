// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OtherPlatformDownloadCard from './OtherPlatformDownloadCard';

const videoMetaData = {
  title: 'Team Fortress 2 OST Mannrobics',
  fullTitle: 'Team Fortress 2 OST Mannrobics',
  thumbnail: 'https://example.com/thumb.jpg',
  uploader: 'dj-fegit',
  durationString: '2:00',
  uploadDate: '20260101',
  description: 'a description',
  originalUrl: 'https://soundcloud.com/dj-fegit/team-fortress-2-ost-mannrobics',
};

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    saveVideoFile: vi.fn().mockResolvedValue({ canceled: false, filePath: '/x/Team Fortress 2 OST Mannrobics.mp4' }),
    checkFileExists: vi.fn().mockResolvedValue(false),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn(),
    removeProgressListener: vi.fn(),
    cancelDownload: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

describe('OtherPlatformDownloadCard', () => {
  it('passes metadataTags/thumbnailPath through so the download can be auto-embedded', async () => {
    const user = userEvent.setup();
    render(<OtherPlatformDownloadCard videoMetaData={videoMetaData} />);

    await user.click(screen.getByRole('button', { name: 'Download MP3' }));

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataTags: {
          title: videoMetaData.fullTitle,
          artist: videoMetaData.uploader,
          date: videoMetaData.uploadDate,
          description: videoMetaData.description,
        },
        thumbnailPath: videoMetaData.thumbnail,
      }),
    );
  });
});
