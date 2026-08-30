// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { BulkAddProvider, useBulkAddQueue, getRetryStage, type BulkAddItem } from './useBulkAddQueue';
import type { DownloadProgressMessage } from '../../types';

const ITEM_DELAY_MS = 2000;

// A real array, not a single slot -- the queue mounts one useDownloadVideo()
// instance per download slot (MAX_DOWNLOAD_SLOTS), each registering its own
// onProgressUpdate listener on this one shared channel, same as real
// Electron's ipcRenderer.on() supports several simultaneous listeners.
// Overwriting a single captured callback (as this used to) meant
// emitDownloadEvent below only ever reached whichever slot mounted last,
// never the one that actually started a real download.
let registeredDownloadCallbacks: ((msg: DownloadProgressMessage) => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  registeredDownloadCallbacks = [];

  window.electronAPI = {
    ...window.electronAPI,
    getVideoInfoPython: vi.fn(),
    enrichPlaylistEntry: vi.fn().mockResolvedValue({ success: true }),
    findLibraryVideo: vi.fn(),
    addLibraryEntry: vi.fn(),
    recordLibraryDownload: vi.fn().mockResolvedValue({ success: true }),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
  };
  // Cast needed at this boundary because electron-api.d.ts's onProgressUpdate
  // signature is typed with a loose, unbound `T` generic (a pre-existing
  // looseness in that file, not something worth fighting per test file).
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn((cb: (msg: DownloadProgressMessage) => void) => {
      registeredDownloadCallbacks.push(cb);
      return cb;
    }),
    removeProgressListener: vi.fn((cb: (msg: DownloadProgressMessage) => void) => {
      registeredDownloadCallbacks = registeredDownloadCallbacks.filter((l) => l !== cb);
    }),
    cancelDownload: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

// The requestId of the most recently started download -- generated
// internally by useDownloadVideo's startDownload (crypto.randomUUID()), not
// something a test can predict up front, so this reads it back off the
// startDownloadPython mock instead. Needed because useDownloadVideo (TD-008)
// filters every incoming message against its own in-flight requestId.
function getLastStartedRequestId(): string {
  const calls = (window.electronAPIPythonDownload.startDownloadPython as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0].requestId;
}

afterEach(() => {
  vi.useRealTimers();
});

function renderQueue() {
  return renderHook(() => useBulkAddQueue(), { wrapper: BulkAddProvider });
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function advancePastItemDelay() {
  await act(async () => { await vi.advanceTimersByTimeAsync(ITEM_DELAY_MS); });
}

function emitDownloadEvent(msg: Omit<DownloadProgressMessage, 'requestId'> & { requestId?: string }) {
  const fullMsg = { requestId: getLastStartedRequestId(), ...msg } as DownloadProgressMessage;
  act(() => registeredDownloadCallbacks.forEach((cb) => cb(fullMsg)));
}

describe('getRetryStage', () => {
  it('is "download" only when videoDir/epoch/resolution are all already known', () => {
    expect(getRetryStage({ videoDir: 'd', epoch: 'e', resolution: '720' } as BulkAddItem)).toBe('download');
  });

  it('is "fetch" when any of videoDir/epoch/resolution is missing', () => {
    expect(getRetryStage({} as BulkAddItem)).toBe('fetch');
    expect(getRetryStage({ videoDir: 'd', epoch: 'e' } as BulkAddItem)).toBe('fetch');
  });
});

describe('useBulkAddQueue: start()', () => {
  it('queues entries as pending, opens the panel, and immediately begins fetching the first one', () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderQueue();

    act(() => result.current.start([{ id: 'e1', title: 't', url: 'u1' }], { download: false, targetResolution: 'dflt' }));

    expect(result.current.panelOpen).toBe(true);
    expect(result.current.isRunning).toBe(true);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('fetching'); // synchronously reached before the first await
  });

  it('seeds an entry with videoDir/epoch/resolution straight into downloading, skipping fetch/dedup entirely', async () => {
    // Used by the Library tab's bulk-select "Download selected" action: the
    // video is already in the library, so start() should carry these
    // through onto the new item and let getRetryStage's existing
    // resume-at-download fast path take it straight to beginDownload.
    const { result } = renderQueue();

    act(() => result.current.start(
      [{ id: 'e1', title: 't', url: 'https://youtu.be/v1', videoId: 'v1', videoDir: '/lib/c/v1', epoch: '1', resolution: '1080', kind: 'video' }],
      { download: true, targetResolution: '1080' },
    ));
    await flushMicrotasks();

    expect(result.current.items[0].status).toBe('downloading');
    expect(result.current.items[0].videoDir).toBe('/lib/c/v1');
    expect(window.electronAPI.getVideoInfoPython).not.toHaveBeenCalled();
    expect(window.electronAPI.findLibraryVideo).not.toHaveBeenCalled();
    expect(window.electronAPI.addLibraryEntry).not.toHaveBeenCalled();
  });
});

describe('useBulkAddQueue: processItem happy paths', () => {
  it('marks an already-tracked video "skipped" without adding it again', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'Title', thumbnail: 'th.jpg' } },
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true });

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();

    expect(result.current.items[0].status).toBe('skipped');
    expect(window.electronAPI.addLibraryEntry).not.toHaveBeenCalled();

    await advancePastItemDelay();
    expect(result.current.isRunning).toBe(false); // queue empty, nothing else to do
  });

  it('metadata-only add ("done") when download was not requested', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'Title', thumbnail: 'th.jpg' } },
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ videoDir: '/lib/c/v1', epoch: '123' });

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();

    expect(result.current.items[0].status).toBe('done');
    expect(window.electronAPIPythonDownload.startDownloadPython).not.toHaveBeenCalled();
  });

  it('picks the closest resolution and starts a download at the deterministic library path', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '480' }, { resolution: '720' }, { resolution: '1080' }] } },
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ videoDir: '/lib/c/v1', epoch: '123' });

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: true, targetResolution: '720' }));
    await flushMicrotasks();

    expect(result.current.items[0].status).toBe('downloading');
    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: 'u1', outputPath: '/lib/c/v1/123/video', resolution: '720' }),
    );
  });

  it('routes mp3 target resolution to the audio slot', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '720' }] } },
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ videoDir: '/lib/c/v1', epoch: '123' });

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: true, targetResolution: 'mp3' }));
    await flushMicrotasks();

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: '/lib/c/v1/123/audio', resolution: 'mp3' }),
    );
  });

  it('completing a download records it in the library and marks the item done', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '720' }] } },
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ videoDir: '/lib/c/v1', epoch: '123' });

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: true, targetResolution: '720' }));
    await flushMicrotasks();
    expect(result.current.items[0].status).toBe('downloading');

    emitDownloadEvent({ type: 'done', payload: { filename: '/lib/c/v1/123/video.mp4' } as DownloadProgressMessage['payload'] });
    await flushMicrotasks();

    expect(window.electronAPI.recordLibraryDownload).toHaveBeenCalledWith(
      expect.objectContaining({ videoDir: '/lib/c/v1', epoch: '123', filePath: '/lib/c/v1/123/video.mp4', resolution: '720' }),
    );
    expect(result.current.items[0].status).toBe('done');
  });

  it('marks the item failed (without recording a download) if the download errors', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { response: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '720' }] } },
    });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (window.electronAPI.addLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ videoDir: '/lib/c/v1', epoch: '123' });

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: true, targetResolution: '720' }));
    await flushMicrotasks();

    emitDownloadEvent({ type: 'error', payload: { message: 'boom' } as unknown as DownloadProgressMessage['payload'] });
    await flushMicrotasks();

    expect(result.current.items[0].status).toBe('failed');
    expect(window.electronAPI.recordLibraryDownload).not.toHaveBeenCalled();
  });

  it('marks the item failed with the real error message when info-fetching itself rejects', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bot check'));

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();

    expect(result.current.items[0].status).toBe('failed');
    expect(result.current.items[0].error).toBe('bot check');
  });
});

describe('useBulkAddQueue: queue control', () => {
  async function startTwoItemsBothSkipped() {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: { response: { id: 'v1', fullTitle: 'One' } } })
      .mockResolvedValueOnce({ data: { response: { id: 'v2', fullTitle: 'Two' } } });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true });

    const rendered = renderQueue();
    act(() => rendered.result.current.start(
      [{ id: 'e1', title: null, url: 'u1' }, { id: 'e2', title: null, url: 'u2' }],
      { download: false, targetResolution: 'dflt' },
    ));
    await flushMicrotasks();
    return rendered;
  }

  it('stop() prevents the queue from picking up the next pending item', async () => {
    const { result } = await startTwoItemsBothSkipped();
    expect(result.current.items[0].status).toBe('skipped');

    act(() => result.current.stop());
    await advancePastItemDelay();

    expect(result.current.isRunning).toBe(false);
    expect(result.current.stopRequested).toBe(false); // reset once the loop actually stops
    expect(result.current.items[1].status).toBe('pending'); // never got processed
  });

  it('resume() continues processing items left pending after a stop', async () => {
    const { result } = await startTwoItemsBothSkipped();
    act(() => result.current.stop());
    await advancePastItemDelay();
    expect(result.current.items[1].status).toBe('pending');

    act(() => result.current.resume());
    await flushMicrotasks();
    await advancePastItemDelay();

    expect(result.current.items[1].status).toBe('skipped');
    expect(result.current.isRunning).toBe(false);
  });

  it('cancelAllPending marks every still-pending item cancelled', async () => {
    const { result } = await startTwoItemsBothSkipped();
    act(() => result.current.stop());
    await advancePastItemDelay();

    act(() => result.current.cancelAllPending());
    expect(result.current.items[1].status).toBe('cancelled');
    expect(result.current.items[0].status).toBe('skipped'); // untouched -- not pending
  });

  it('retryItem resets a failed item to pending and restarts the loop if idle', async () => {
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail once'));
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();
    await advancePastItemDelay();
    expect(result.current.items[0].status).toBe('failed');
    expect(result.current.isRunning).toBe(false);

    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { response: { id: 'v1', fullTitle: 'T' } } });
    (window.electronAPI.findLibraryVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ found: true });

    act(() => result.current.retryItem(result.current.items[0].id));
    expect(result.current.isRunning).toBe(true);
    await flushMicrotasks();
    expect(result.current.items[0].status).toBe('skipped');
  });

  it('removeItem drops the item from the list', async () => {
    const { result } = await startTwoItemsBothSkipped();
    const idToRemove = result.current.items[0].id;
    act(() => result.current.removeItem(idToRemove));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items.find((i) => i.id === idToRemove)).toBeUndefined();
  });

  it('clearFinished removes done/skipped/cancelled but keeps failed and pending', async () => {
    const { result } = await startTwoItemsBothSkipped(); // item0 skipped, item1 pending
    act(() => result.current.stop());
    await advancePastItemDelay();
    act(() => result.current.cancelAllPending()); // item1 -> cancelled

    act(() => result.current.clearFinished());
    expect(result.current.items).toHaveLength(0);
  });
});
