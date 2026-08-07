// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OptionsScreen from './OptionsScreen';
import { YtdlpUpdaterProvider } from '../hooks/useYtdlpUpdater';
import { ThemeModeProvider } from '../hooks/useThemeMode';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getCookieStatus: vi.fn().mockResolvedValue({ loaded: false, cookieCount: 0 }),
    getCookiesConfig: vi.fn().mockResolvedValue({ cookiesMode: 'file', cookiesBrowser: '', supportedBrowsers: ['firefox', 'chrome'] }),
    getDownloadDir: vi.fn().mockResolvedValue({ downloadDir: '' }),
    getLibraryDir: vi.fn().mockResolvedValue({ libraryDir: '' }),
    getErrorLogInfo: vi.fn().mockResolvedValue({ exists: false, path: '/log' }),
    getCustomConvertFormats: vi.fn().mockResolvedValue({ customConvertFormats: [] }),
    setCustomConvertFormats: vi.fn().mockResolvedValue({ success: true, customConvertFormats: [] }),
    pickFolder: vi.fn(),
    setDownloadDir: vi.fn().mockResolvedValue({ success: true, downloadDir: '' }),
    setLibraryDir: vi.fn().mockResolvedValue({ success: true, libraryDir: '' }),
    saveCookie: vi.fn(),
    deleteCookie: vi.fn().mockResolvedValue({ success: true }),
    setCookiesConfig: vi.fn().mockResolvedValue({ success: true, cookiesMode: 'file', cookiesBrowser: '' }),
    openErrorLog: vi.fn(),
    checkForYtdlpUpdate: vi.fn().mockResolvedValue({ current: '2026.7.4', latest: '2026.7.4', updateAvailable: false }),
    startYtdlpUpdate: vi.fn(),
    quitApp: vi.fn(),
    onYtdlpUpdateProgress: vi.fn(),
    removeYtdlpUpdateProgressListener: vi.fn(),
    getThemeMode: vi.fn().mockResolvedValue({ themeMode: 'light' }),
    setThemeMode: vi.fn().mockResolvedValue({ success: true, themeMode: 'dark' }),
  };
});

function renderScreen() {
  return render(
    <YtdlpUpdaterProvider><ThemeModeProvider><OptionsScreen /></ThemeModeProvider></YtdlpUpdaterProvider>,
  );
}

describe('OptionsScreen', () => {
  it('groups sections under Media Options and General Options, loading persisted values on mount', async () => {
    (window.electronAPI.getDownloadDir as ReturnType<typeof vi.fn>).mockResolvedValue({ downloadDir: '/downloads' });
    (window.electronAPI.getLibraryDir as ReturnType<typeof vi.fn>).mockResolvedValue({ libraryDir: '/library' });
    renderScreen();

    expect(screen.getByText('Media Options')).toBeInTheDocument();
    expect(screen.getByText('General Options')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('/downloads')).toBeInTheDocument());
    expect(screen.getByText('/library')).toBeInTheDocument();
  });

  it('switching the theme toggle persists the new mode', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(window.electronAPI.setThemeMode).toHaveBeenCalledWith('dark');
  });

  it('choosing a download folder persists the picked path and updates the display', async () => {
    const user = userEvent.setup();
    (window.electronAPI.pickFolder as ReturnType<typeof vi.fn>).mockResolvedValue({ canceled: false, filePaths: ['/new-downloads'] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Using system default')).toBeInTheDocument());
    // The picked path only shows up because handleChooseDownloadDir re-fetches
    // getDownloadDir() after setDownloadDir succeeds -- the mock has to reflect
    // the new value for that refetch, same as the real main process would.
    (window.electronAPI.getDownloadDir as ReturnType<typeof vi.fn>).mockResolvedValue({ downloadDir: '/new-downloads' });

    const buttons = screen.getAllByRole('button', { name: 'Choose folder' });
    await user.click(buttons[0]); // Default Download Folder is the first "Choose folder" button

    await waitFor(() => expect(window.electronAPI.setDownloadDir).toHaveBeenCalledWith('/new-downloads'));
    expect(await screen.findByText('/new-downloads')).toBeInTheDocument();
  });

  it('does not persist anything when the folder picker is cancelled', async () => {
    const user = userEvent.setup();
    (window.electronAPI.pickFolder as ReturnType<typeof vi.fn>).mockResolvedValue({ canceled: true, filePaths: [] });
    renderScreen();

    const buttons = screen.getAllByRole('button', { name: 'Choose folder' });
    await user.click(buttons[1]); // Library Folder

    expect(window.electronAPI.setLibraryDir).not.toHaveBeenCalled();
  });

  it('saves a pasted cookie and reflects the loaded status', async () => {
    const user = userEvent.setup();
    (window.electronAPI.saveCookie as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, cookieCount: 3, skipped: 0 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('No cookie loaded')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Load personal cookie' }));
    await user.type(screen.getByPlaceholderText(/Netscape HTTP Cookie File/), 'CONSENT=YES+1');
    (window.electronAPI.getCookieStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ loaded: true, cookieCount: 3 });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(window.electronAPI.saveCookie).toHaveBeenCalledWith('CONSENT=YES+1');
    expect(await screen.findByText('Saved 3 cookie(s).')).toBeInTheDocument();
    expect(await screen.findByText('Cookie loaded (3)')).toBeInTheDocument();
  });

  it('deleting a loaded cookie clears the loaded status', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getCookieStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ loaded: true, cookieCount: 2 });
    renderScreen();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete cookie' })).toBeEnabled());

    (window.electronAPI.getCookieStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ loaded: false, cookieCount: 0 });
    await user.click(screen.getByRole('button', { name: 'Delete cookie' }));

    expect(window.electronAPI.deleteCookie).toHaveBeenCalled();
    expect(await screen.findByText('No cookie loaded')).toBeInTheDocument();
  });

  it('switching to browser-based cookies reveals the browser picker and persists the choice', async () => {
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(window.electronAPI.getCookiesConfig).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Pull from browser' }));
    expect(screen.getByText('No browser selected')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Browser'));
    await user.click(await screen.findByRole('option', { name: 'Firefox' }));

    expect(window.electronAPI.setCookiesConfig).toHaveBeenCalledWith({ cookiesMode: 'browser', cookiesBrowser: 'firefox' });
    expect(await screen.findByText('Using Firefox')).toBeInTheDocument();
  });

  it('checking for a yt-dlp update shows the available version and lets the user start it', async () => {
    const user = userEvent.setup();
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.4', latest: '2026.7.5', updateAvailable: true,
    });
    renderScreen();

    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByRole('button', { name: 'Update to 2026.7.5' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update to 2026.7.5' }));
    expect(window.electronAPI.startYtdlpUpdate).toHaveBeenCalled();
  });

  it('the error log button is disabled until an error has actually been logged', async () => {
    const user = userEvent.setup();
    (window.electronAPI.getErrorLogInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ exists: true, path: '/log' });
    renderScreen();

    const openLogButton = await screen.findByRole('button', { name: 'Open error log' });
    await waitFor(() => expect(openLogButton).toBeEnabled());
    await user.click(openLogButton);
    expect(window.electronAPI.openErrorLog).toHaveBeenCalled();
  });
});
