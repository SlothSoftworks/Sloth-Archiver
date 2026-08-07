// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useDownloadVideo from './useDownloadVideo';
import type { DownloadProgressMessage } from '../../types';

let registeredCallback: ((msg: DownloadProgressMessage) => void) | null = null;

beforeEach(() => {
  registeredCallback = null;
  // Cast needed at this boundary because electron-api.d.ts's onProgressUpdate
  // signature is typed with a loose, unbound `T` generic (a pre-existing
  // looseness in that file, not something worth fighting per test file).
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn((cb: (msg: DownloadProgressMessage) => void) => { registeredCallback = cb; }),
    removeProgressListener: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

function emit(msg: DownloadProgressMessage) {
  act(() => registeredCallback?.(msg));
}

describe('useDownloadVideo', () => {
  it('resets state and forwards params to startDownloadPython on startDownload', () => {
    const { result } = renderHook(() => useDownloadVideo());

    act(() => result.current.startDownload({ videoUrl: 'u', outputPath: 'o', resolution: '720' }));

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith({
      videoUrl: 'u', outputPath: 'o', format: undefined, resolution: '720', overwriteMode: undefined, additionalOptions: undefined,
    });
    expect(result.current.downloadProgress).toBe(0);
    expect(result.current.isDone).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('never lets download progress decrease within one download (per-stream reporting)', () => {
    const { result } = renderHook(() => useDownloadVideo());

    emit({ type: 'progress', payload: { percent: '80%' } as DownloadProgressMessage['payload'] });
    expect(result.current.downloadProgress).toBe(80);

    // A second stream (e.g. audio, after video) restarts its own 0-100% sequence.
    emit({ type: 'progress', payload: { percent: '10%' } as DownloadProgressMessage['payload'] });
    expect(result.current.downloadProgress).toBe(80);

    emit({ type: 'progress', payload: { percent: '95%' } as DownloadProgressMessage['payload'] });
    expect(result.current.downloadProgress).toBe(95);
  });

  it('sets status to "Downloading..." on a downloading event', () => {
    const { result } = renderHook(() => useDownloadVideo());
    emit({ type: 'downloading', payload: {} as DownloadProgressMessage['payload'] });
    expect(result.current.downloadStatus).toBe('Downloading...');
  });

  it('uses the real postprocessPercent when present, without clamping it non-decreasing', () => {
    const { result } = renderHook(() => useDownloadVideo());
    emit({ type: 'postprocessing', payload: { postprocessPercent: 90 } as DownloadProgressMessage['payload'] });
    expect(result.current.postprocessProgress).toBe(90);
    // Real ffmpeg progress restarting near 0 (e.g. a second postprocess step) must not get stuck at a prior high value.
    emit({ type: 'postprocessing', payload: { postprocessPercent: 5 } as DownloadProgressMessage['payload'] });
    expect(result.current.postprocessProgress).toBe(5);
  });

  it('falls back to the 50/100 approximation when no real postprocessPercent is given', () => {
    const { result } = renderHook(() => useDownloadVideo());
    emit({ type: 'postprocessing', payload: { stage: 'start' } as DownloadProgressMessage['payload'] });
    expect(result.current.postprocessProgress).toBe(50);
    emit({ type: 'postprocessing', payload: { stage: 'finished' } as DownloadProgressMessage['payload'] });
    expect(result.current.postprocessProgress).toBe(100);
  });

  it('sets isError and downloadError on an error event', () => {
    const { result } = renderHook(() => useDownloadVideo());
    const errorMsg = { type: 'error', payload: { message: 'boom' } as unknown as DownloadProgressMessage['payload'] };
    emit(errorMsg as DownloadProgressMessage);
    expect(result.current.isError).toBe(true);
    expect(result.current.downloadError).toEqual(errorMsg);
  });

  it('marks downloadDone with full download progress', () => {
    const { result } = renderHook(() => useDownloadVideo());
    emit({ type: 'downloadDone', payload: {} as DownloadProgressMessage['payload'] });
    expect(result.current.downloadStatus).toBe('downloadDone');
    expect(result.current.downloadProgress).toBe(100);
  });

  it('marks done with the final file path and full progress on both bars', () => {
    const { result } = renderHook(() => useDownloadVideo());
    emit({ type: 'done', payload: { filename: '/x/video.mp4' } as DownloadProgressMessage['payload'] });
    expect(result.current.downloadStatus).toBe('Done');
    expect(result.current.finalFilePath).toBe('/x/video.mp4');
    expect(result.current.downloadProgress).toBe(100);
    expect(result.current.postprocessProgress).toBe(100);
    expect(result.current.isDone).toBe(true);
  });

  it('removes the progress listener on unmount', () => {
    const { unmount } = renderHook(() => useDownloadVideo());
    unmount();
    expect(window.electronAPIPythonDownload.removeProgressListener).toHaveBeenCalled();
  });
});
