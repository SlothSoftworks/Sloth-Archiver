// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { YtdlpUpdaterProvider, useYtdlpUpdater, type YtdlpUpdateStage } from './useYtdlpUpdater';

let registeredCallback: ((data: { stage: YtdlpUpdateStage; verificationFailure?: boolean }) => void) | null = null;

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

function renderUpdater() {
  return renderHook(() => useYtdlpUpdater(), { wrapper: YtdlpUpdaterProvider });
}

describe('useYtdlpUpdater', () => {
  it('throws when used outside a YtdlpUpdaterProvider', () => {
    expect(() => renderHook(() => useYtdlpUpdater())).toThrow(/must be used within a YtdlpUpdaterProvider/);
  });

  it('updates stage (and its label) when the main process reports progress', () => {
    const { result } = renderUpdater();
    act(() => registeredCallback?.({ stage: 'installing' }));
    expect(result.current.stage).toBe('installing');
    expect(result.current.stageLabel).toBe('Installing...');
  });

  it('sets verificationFailure from an error-stage broadcast that carries it, and clears it on the next startUpdate', async () => {
    (window.electronAPI.startYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, version: '2026.7.5' });
    const { result } = renderUpdater();

    act(() => registeredCallback?.({ stage: 'error', verificationFailure: true }));
    expect(result.current.verificationFailure).toBe(true);

    await act(async () => { await result.current.startUpdate(); });
    expect(result.current.verificationFailure).toBe(false);
  });

  it('does not set verificationFailure for an error-stage broadcast that omits it', () => {
    const { result } = renderUpdater();
    act(() => registeredCallback?.({ stage: 'error' }));
    expect(result.current.verificationFailure).toBe(false);
  });

  it('checkForUpdate populates version info and toggles checking', async () => {
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.4', latest: '2026.7.5', updateAvailable: true,
    });
    const { result } = renderUpdater();

    let promise: Promise<unknown>;
    act(() => { promise = result.current.checkForUpdate(); });
    expect(result.current.checking).toBe(true);
    await act(async () => { await promise; });

    expect(result.current.checking).toBe(false);
    expect(result.current.currentVersion).toBe('2026.7.4');
    expect(result.current.latestVersion).toBe('2026.7.5');
    expect(result.current.updateAvailable).toBe(true);
    expect(result.current.checkError).toBeNull();
  });

  it('checkForUpdate still shows the current version and surfaces an error when the latest release could not be resolved (e.g. offline)', async () => {
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '2026.7.4', latest: null, updateAvailable: false,
    });
    const { result } = renderUpdater();

    await act(async () => { await result.current.checkForUpdate(); });

    expect(result.current.currentVersion).toBe('2026.7.4');
    expect(result.current.latestVersion).toBe('');
    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.checkError).toBe('Could not check for the latest version.');
  });

  it('checkForUpdate sets checkError and clears checking on failure', async () => {
    (window.electronAPI.checkForYtdlpUpdate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    const { result } = renderUpdater();

    await act(async () => { await result.current.checkForUpdate(); });

    expect(result.current.checking).toBe(false);
    expect(result.current.checkError).toBe('network down');
  });

  it('startUpdate resolves back to idle and clears updateAvailable on success', async () => {
    (window.electronAPI.startYtdlpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, version: '2026.7.5' });
    const { result } = renderUpdater();

    await act(async () => { await result.current.startUpdate(); });

    expect(result.current.stage).toBe('idle');
    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.updateError).toBeNull();
  });

  it('startUpdate sets updateError on failure and leaves stage as-is', async () => {
    (window.electronAPI.startYtdlpUpdate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('build failed'));
    const { result } = renderUpdater();

    await act(async () => { await result.current.startUpdate(); });

    expect(result.current.updateError).toBe('build failed');
  });

  it('quit calls electronAPI.quitApp', () => {
    const { result } = renderUpdater();
    act(() => result.current.quit());
    expect(window.electronAPI.quitApp).toHaveBeenCalled();
  });

  it('removes the progress listener on unmount', () => {
    const { unmount } = renderUpdater();
    unmount();
    expect(window.electronAPI.removeYtdlpUpdateProgressListener).toHaveBeenCalled();
  });
});
