// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DownloaderScreen from './DownloaderScreen';
import { LibraryNotificationProvider } from '../hooks/useLibraryNotifications';

// Real timers throughout -- useDebounce's default 500ms delay is real, and
// combining fake timers with userEvent's click/type simulation proved
// unreliable elsewhere in this suite (see BulkAddSidePanel.test.tsx). All
// waitFor calls below use a timeout comfortably above 500ms.
const videoResponse = {
  id: 'vid1',
  fullTitle: 'My Great Video',
  description: 'a description',
  thumbnail: 'https://example.com/thumb.jpg',
  resolutions: [{ resolution: '720', filesizeMb: '10' }],
  originalUrl: 'https://youtube.com/watch?v=vid1',
  durationString: '2:00',
  uploadDate: '20260115',
};

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getVideoInfoPython: vi.fn(),
    addLibraryEntry: vi.fn(),
    findLibraryVideo: vi.fn(),
    overrideLibraryEntry: vi.fn(),
    addLibraryVersion: vi.fn(),
    deleteVideoInfoCacheEntry: vi.fn().mockResolvedValue({ success: true, existed: true }),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn(),
    removeProgressListener: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

function renderScreen() {
  return render(<LibraryNotificationProvider><DownloaderScreen /></LibraryNotificationProvider>);
}

describe('DownloaderScreen', () => {
  it('shows an error for an invalid URL without fetching', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('URL'), 'not a url');

    await waitFor(() => expect(screen.getByText('Invalid URL')).toBeInTheDocument(), { timeout: 2000 });
    expect(window.electronAPI.getVideoInfoPython).not.toHaveBeenCalled();
  });

  it('fetches and displays the video once a valid URL settles', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: false },
    });
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);

    await waitFor(() => expect(window.electronAPI.getVideoInfoPython).toHaveBeenCalledWith(videoResponse.originalUrl), { timeout: 2000 });
    expect(await screen.findByRole('link', { name: 'My Great Video' })).toBeInTheDocument();
  });

  it('shows a fetch error message instead of a card when the lookup fails', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bot check'));
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);

    expect(await screen.findByText('bot check', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'My Great Video' })).not.toBeInTheDocument();
  });

  it('shows a "loaded from cache" chip, and deleting the cache entry hides it', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: true },
    });
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);

    await waitFor(() => expect(screen.getByText('Loaded from cache')).toBeInTheDocument(), { timeout: 2000 });
    await user.click(screen.getByLabelText('Delete this entry from the cache (testing)'));

    expect(window.electronAPI.deleteVideoInfoCacheEntry).toHaveBeenCalledWith(videoResponse.originalUrl);
    expect(screen.queryByText('Loaded from cache')).not.toBeInTheDocument();
  });

  async function loadVideo(user: ReturnType<typeof userEvent.setup>) {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: videoResponse, fromCache: false },
    });
    renderScreen();
    await user.type(screen.getByLabelText('URL'), videoResponse.originalUrl);
    await screen.findByRole('link', { name: 'My Great Video' }, { timeout: 2000 });
  }

  it('adds a new (not-yet-tracked) video to the library and resets the form', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, videoDir: '/d', epoch: '1' });

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));

    await waitFor(() => expect(screen.getByText('Added to library')).toBeInTheDocument());
    expect(window.electronAPI.addLibraryEntry).toHaveBeenCalledWith(videoResponse);
    expect(screen.queryByRole('link', { name: 'My Great Video' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('URL')).toHaveValue('');
  });

  it('offers Override/Add as new version when the video is already tracked', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true, channelDisplayName: 'Some Channel', videoDir: '/d/v1' });

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));
    expect(await screen.findByText('Already in your library')).toBeInTheDocument();
    expect(screen.getByText(/under "Some Channel"/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Override' }));
    expect(window.electronAPI.overrideLibraryEntry).toHaveBeenCalledWith(videoResponse, '/d/v1');
  });

  it('"Add as new version" calls addLibraryVersion instead of overriding', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true, channelDisplayName: null, videoDir: '/d/v1' });

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));
    await screen.findByText('Already in your library');
    await user.click(screen.getByRole('button', { name: 'Add as new version' }));

    expect(window.electronAPI.addLibraryVersion).toHaveBeenCalledWith(videoResponse, '/d/v1');
    expect(window.electronAPI.overrideLibraryEntry).not.toHaveBeenCalled();
  });

  it('shows an error dialog when adding to the library fails', async () => {
    const user = userEvent.setup();
    await loadVideo(user);
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

    await user.click(within(screen.getByLabelText('Add to library')).getByRole('button'));

    expect(await screen.findByText("Couldn't add to library")).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });
});
