// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import MainPage from './MainPage';
import { LibraryNotificationProvider, useLibraryNotification } from './hooks/useLibraryNotifications';
import { YtdlpUpdaterProvider } from './hooks/useYtdlpUpdater';
import { CookiesChangeProvider } from './hooks/useCookiesChange';
import { BackgroundPlayerProvider } from './hooks/useBackgroundPlayer';

// Each tab's screen is a large, independently-tested component (its own
// dedicated test file covers it) -- mocked out here so MainPage's tests stay
// scoped to its own tab-switching/notification-badge/About-dialog logic.
vi.mock('./screens/DownloaderScreen', () => ({ default: () => <div>Downloader Mock</div> }));
vi.mock('./screens/LibraryScreen', () => ({ default: () => <div>Library Mock</div> }));
vi.mock('./screens/OptionsScreen', () => ({ default: () => <div>Options Mock</div> }));
vi.mock('./components/YtdlpUpdateDialog', () => ({ default: () => <div>YtdlpUpdateDialog Mock</div> }));
vi.mock('./components/BulkAddSidePanel', () => ({
  default: () => <div>BulkAddSidePanel Mock</div>,
  BulkAddToggleButton: () => <button>Bulk add</button>,
}));

// MainPage itself (not a mocked-out screen) reads window.electronAPI directly
// for the top-bar version chip -- unlike App.tsx, nothing here falls back to
// electronAPIMock when it's missing, so this needs its own minimal stub.
beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getAppVersion: vi.fn().mockResolvedValue('0.0.0'),
    getFfmpegVersion: vi.fn().mockResolvedValue('7.0.2'),
    onYtdlpUpdateProgress: vi.fn(),
    removeYtdlpUpdateProgressListener: vi.fn(),
    getCookiesConfig: vi.fn().mockResolvedValue({ cookiesMode: 'file', cookiesBrowser: '', supportedBrowsers: [], cookiesPersistAcrossSessions: false }),
    getCookieStatus: vi.fn().mockResolvedValue({ loaded: false, cookieCount: 0 }),
  };
});

// The badge/reset count is only ever incremented from within DownloaderScreen
// (mocked out above), so this stands in for "some notification arrived" to
// exercise MainPage's own reset-on-tab-select behavior.
function IncrementButton() {
  const { increment } = useLibraryNotification();
  return <button onClick={increment}>increment (test)</button>;
}

function renderMainPage() {
  return render(
    <MemoryRouter>
      <YtdlpUpdaterProvider>
        <LibraryNotificationProvider>
          <CookiesChangeProvider>
            <BackgroundPlayerProvider>
              <IncrementButton />
              <MainPage />
            </BackgroundPlayerProvider>
          </CookiesChangeProvider>
        </LibraryNotificationProvider>
      </YtdlpUpdaterProvider>
    </MemoryRouter>,
  );
}

describe('MainPage', () => {
  it('shows the Downloader tab by default, with the other tabs unmounted', () => {
    renderMainPage();
    expect(screen.getByText('Downloader Mock')).toBeInTheDocument();
    expect(screen.queryByText('Library Mock')).not.toBeInTheDocument();
    expect(screen.queryByText('Options Mock')).not.toBeInTheDocument();
  });

  it('switches tabs, mounting only the selected screen', async () => {
    const user = userEvent.setup();
    renderMainPage();

    await user.click(screen.getByRole('tab', { name: /Library/ }));
    expect(screen.getByText('Library Mock')).toBeInTheDocument();
    expect(screen.queryByText('Downloader Mock')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Options' }));
    expect(screen.getByText('Options Mock')).toBeInTheDocument();
    expect(screen.queryByText('Library Mock')).not.toBeInTheDocument();
  });

  it('resets the library notification badge when the Library tab is selected', async () => {
    const user = userEvent.setup();
    renderMainPage();

    await user.click(screen.getByText('increment (test)'));
    await user.click(screen.getByText('increment (test)'));
    expect(screen.getByText('2')).toBeInTheDocument();

    // showZero is false, so the reset badgeContent=0 doesn't remove the node,
    // just hides it behind an "invisible" class -- queried directly rather
    // than by text, since whether MUI's badge still shows its last content
    // ("2") or the new one ("0") mid-transition is a cosmetic implementation
    // detail, not something this feature's actual contract (the count resets
    // and the badge hides) depends on.
    await user.click(screen.getByRole('tab', { name: /Library/ }));
    expect(document.querySelector('.MuiBadge-badge')).toHaveClass('MuiBadge-invisible');
  });

  it('opens and closes the About dialog', async () => {
    const user = userEvent.setup();
    renderMainPage();

    await user.click(screen.getByRole('button', { name: 'About' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('About')).toBeInTheDocument();
    expect(within(dialog).getByText(/under active construction/)).toBeInTheDocument();
    expect(within(dialog).getByText('v0.0.0')).toBeInTheDocument();
    expect(within(dialog).getByText('Dependencies')).toBeInTheDocument();
    expect(within(dialog).getByText('ffmpeg: 7.0.2')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /github\.com/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText(/under active construction/)).not.toBeInTheDocument());
  });

  describe('cookies header indicator', () => {
    it('is hidden when no cookies are configured', async () => {
      renderMainPage();
      await waitFor(() => expect(window.electronAPI.getCookiesConfig).toHaveBeenCalled());
      expect(screen.queryByLabelText('Cookies loaded')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Clear cookies')).not.toBeInTheDocument();
    });

    it('shows the indicator with a tooltip in file mode, and clicking clear calls deleteCookie', async () => {
      const user = userEvent.setup();
      window.electronAPI.getCookieStatus = vi.fn().mockResolvedValue({ loaded: true, cookieCount: 3 });
      window.electronAPI.deleteCookie = vi.fn().mockResolvedValue({ success: true });
      renderMainPage();

      const cookieIcon = await screen.findByLabelText('Cookies loaded');
      await user.hover(cookieIcon);
      expect(await screen.findByText('Cookies are loaded and being sent to yt-dlp')).toBeInTheDocument();

      // Re-mock to reflect the cleared state before the click resolves, so
      // the post-clear refetch shows the indicator disappearing.
      window.electronAPI.getCookieStatus = vi.fn().mockResolvedValue({ loaded: false, cookieCount: 0 });
      await user.click(screen.getByLabelText('Clear cookies'));

      expect(window.electronAPI.deleteCookie).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByLabelText('Cookies loaded')).not.toBeInTheDocument());
    });

    it('shows the indicator in browser mode, and clicking clear calls setCookiesConfig with an empty browser', async () => {
      const user = userEvent.setup();
      window.electronAPI.getCookiesConfig = vi.fn().mockResolvedValue({
        cookiesMode: 'browser', cookiesBrowser: 'chrome', supportedBrowsers: ['chrome'], cookiesPersistAcrossSessions: false,
      });
      window.electronAPI.setCookiesConfig = vi.fn().mockResolvedValue({ success: true, cookiesMode: 'browser', cookiesBrowser: '' });
      renderMainPage();

      await screen.findByLabelText('Cookies loaded');

      window.electronAPI.getCookiesConfig = vi.fn().mockResolvedValue({
        cookiesMode: 'browser', cookiesBrowser: '', supportedBrowsers: ['chrome'], cookiesPersistAcrossSessions: false,
      });
      await user.click(screen.getByLabelText('Clear cookies'));

      expect(window.electronAPI.setCookiesConfig).toHaveBeenCalledWith({ cookiesMode: 'browser', cookiesBrowser: '' });
      await waitFor(() => expect(screen.queryByLabelText('Cookies loaded')).not.toBeInTheDocument());
    });
  });
});
