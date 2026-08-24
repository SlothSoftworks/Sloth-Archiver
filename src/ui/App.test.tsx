// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import App from './App';
import { electronAPIMock, electronAPIPythonDownloadMock } from '../../testing/mockData/electronAPIMocks.ts';

// MainPage is a large, independently-tested component (its own dedicated
// test file covers it) -- mocked out here so App's tests stay scoped to its
// own responsibilities: the electronAPI mock fallback and renderer error
// forwarding.
vi.mock('./MainPage', () => ({ default: () => <div>MainPage Mock</div> }));

function renderApp(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).electronAPI;
  delete (window as unknown as Record<string, unknown>).electronAPIPythonDownload;
  delete (window as unknown as Record<string, unknown>).mockingElectron;
});

// AppContent wraps MainPage in ThemeModeProvider/YtdlpUpdaterProvider/
// BulkAddProvider -- all real (not mocked, only MainPage's own screens are),
// so they need a full, working electronAPI/electronAPIPythonDownload bridge
// on window before mount, same as the real preload would provide.
function stubRealBridge(overrides: Partial<typeof electronAPIMock> = {}) {
  window.electronAPI = { ...electronAPIMock, ...overrides } as unknown as typeof window.electronAPI;
  window.electronAPIPythonDownload = electronAPIPythonDownloadMock as unknown as typeof window.electronAPIPythonDownload;
}

// App.tsx sets window.mockingElectron without a global type declaration for
// it (see its own pre-existing tsc baseline error) -- same cast needed here.
function getMockingElectronFlag(): unknown {
  return (window as unknown as { mockingElectron?: unknown }).mockingElectron;
}

describe('App', () => {
  it('renders MainPage at the root route', () => {
    stubRealBridge();
    renderApp('/');
    expect(screen.getByText('MainPage Mock')).toBeInTheDocument();
  });

  it('falls back to the mock electronAPI when no preload bridge is present', () => {
    renderApp('/');
    expect(getMockingElectronFlag()).toBe('yes');
    expect(window.electronAPI).toBeDefined();
    expect(window.electronAPIPythonDownload).toBeDefined();
  });

  it('does not override a real electronAPI bridge when one is already present', () => {
    stubRealBridge();
    const realApi = window.electronAPI;
    renderApp('/');
    expect(getMockingElectronFlag()).toBeUndefined();
    expect(window.electronAPI).toBe(realApi);
  });

  it('forwards an uncaught renderer error to electronAPI.reportRendererError', () => {
    const reportRendererError = vi.fn();
    stubRealBridge({ reportRendererError });
    renderApp('/');

    const error = new Error('boom');
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'app.js', lineno: 1, colno: 2, error }));

    expect(reportRendererError).toHaveBeenCalledWith({ message: 'boom', stack: error.stack });
  });

  it('forwards an unhandled promise rejection to electronAPI.reportRendererError', () => {
    const reportRendererError = vi.fn();
    stubRealBridge({ reportRendererError });
    renderApp('/');

    const reason = new Error('rejected');
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);

    expect(reportRendererError).toHaveBeenCalledWith({ message: 'rejected', stack: reason.stack });
  });
});
