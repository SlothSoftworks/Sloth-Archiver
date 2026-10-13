// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import { BulkAddProvider, useBulkAddQueue, useBulkAddActions, getRetryStage, diffItemTransitions, type BulkAddItem, type BulkAddTransition } from './useBulkAddQueue';
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
    getVideoInfoResult: vi.fn(),
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
// startDownloadPython mock instead. Needed because useDownloadVideo filters
// every incoming message against its own in-flight requestId.
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
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {})); // never resolves
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
    expect(window.electronAPI.getVideoInfoResult).not.toHaveBeenCalled();
    expect(window.electronAPI.findLibraryVideo).not.toHaveBeenCalled();
    expect(window.electronAPI.addLibraryEntry).not.toHaveBeenCalled();
  });
});

describe('useBulkAddQueue: processItem happy paths', () => {
  it('marks an already-tracked video "skipped" without adding it again', async () => {
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'Title', thumbnail: 'th.jpg' }, fromCache: false,
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
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'Title', thumbnail: 'th.jpg' }, fromCache: false,
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
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '480' }, { resolution: '720' }, { resolution: '1080' }] }, fromCache: false,
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
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '720' }] }, fromCache: false,
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
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '720' }] }, fromCache: false,
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
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, videoInfo: { id: 'v1', fullTitle: 'Title', resolutions: [{ resolution: '720' }] }, fromCache: false,
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

  it('marks the item failed with the real error message when info-fetching fails', async () => {
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, kind: 'botBlock', message: 'bot check' });

    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();

    expect(result.current.items[0].status).toBe('failed');
    expect(result.current.items[0].error).toBe('bot check');
  });
});

describe('useBulkAddQueue: queue control', () => {
  async function startTwoItemsBothSkipped() {
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, videoInfo: { id: 'v1', fullTitle: 'One' }, fromCache: false })
      .mockResolvedValueOnce({ success: true, videoInfo: { id: 'v2', fullTitle: 'Two' }, fromCache: false });
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
    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, kind: 'botBlock', message: 'fail once' });
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();
    await advancePastItemDelay();
    expect(result.current.items[0].status).toBe('failed');
    expect(result.current.isRunning).toBe(false);

    (window.electronAPI.getVideoInfoResult as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, videoInfo: { id: 'v1', fullTitle: 'T' }, fromCache: false });
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

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const last = <V,>(values: V[]) => values[values.length - 1];

function infoFor(id: string, extra: Record<string, unknown> = {}) {
  return { success: true, videoInfo: { id, fullTitle: `Title ${id}`, ...extra }, fromCache: false };
}

// getVideoInfoResult answers by URL ("u1" -> video id "v1"), so tests with
// several items don't depend on the order the queue happens to fetch them in.
function mockInfoByUrl(overrides: Record<string, unknown> = {}) {
  asMock(window.electronAPI.getVideoInfoResult).mockImplementation(async (url: string) => (
    url in overrides ? overrides[url] : infoFor(url.replace('u', 'v'), { resolutions: [{ resolution: '720' }] })
  ));
  asMock(window.electronAPI.findLibraryVideo).mockResolvedValue({ found: false });
  asMock(window.electronAPI.addLibraryEntry).mockImplementation(async (videoInfo: { id: string }) => ({ videoDir: `/lib/c/${videoInfo.id}`, epoch: '1' }));
}

function collectTransitions(result: { current: ReturnType<typeof useBulkAddQueue> }) {
  const transitions: BulkAddTransition[] = [];
  const unsubscribe = result.current.subscribeTransitions((t) => transitions.push(t));
  const summary = () => transitions.map((t) => `${t.sourceUrl}:${t.previousStatus}>${t.status}`);
  return { transitions, summary, unsubscribe };
}

describe('useBulkAddQueue: per-item options', () => {
  it('a later start() with different options does not change how earlier pending items are processed', async () => {
    mockInfoByUrl();
    const { result } = renderQueue();

    act(() => result.current.start(
      [{ id: 'e1', title: null, url: 'u1' }, { id: 'e2', title: null, url: 'u2' }],
      { download: false, targetResolution: 'dflt', targetLibraryTag: 'Music' },
    ));
    // u2 is still pending behind u1 when the second batch arrives.
    act(() => result.current.start([{ id: 'e3', title: null, url: 'u3' }], { download: true, targetResolution: '720', targetLibraryTag: 'Films' }));
    expect(result.current.items.map((it) => [it.download, it.targetResolution, it.targetLibraryTag])).toEqual([
      [false, 'dflt', 'Music'], [false, 'dflt', 'Music'], [true, '720', 'Films'],
    ]);

    await flushMicrotasks();
    await advancePastItemDelay();
    await flushMicrotasks();
    expect(result.current.items[1].status).toBe('done');
    expect(asMock(window.electronAPI.addLibraryEntry).mock.calls[1]).toEqual([expect.objectContaining({ id: 'v2' }), 'Music']);
    expect(window.electronAPIPythonDownload.startDownloadPython).not.toHaveBeenCalled();

    await advancePastItemDelay();
    await flushMicrotasks();
    expect(result.current.items[2].status).toBe('downloading');
    expect(asMock(window.electronAPI.addLibraryEntry).mock.calls[2]).toEqual([expect.objectContaining({ id: 'v3' }), 'Films']);
    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: 'u3', resolution: '720' }));
  });

  it('checks for a duplicate in the item\'s own target sublibrary', async () => {
    mockInfoByUrl();
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt', targetLibraryTag: 'Music' }));
    await flushMicrotasks();
    expect(window.electronAPI.findLibraryVideo).toHaveBeenCalledWith('v1', 'Music');
  });

  it('leaves an omitted target sublibrary undefined, for the active one to be resolved at processing time', async () => {
    mockInfoByUrl();
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    expect(result.current.items[0].targetLibraryTag).toBeUndefined();
    await flushMicrotasks();
    expect(window.electronAPI.findLibraryVideo).toHaveBeenCalledWith('v1', undefined);
    expect(window.electronAPI.addLibraryEntry).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }), undefined);
  });

  it('carries an entry\'s tag onto its item', () => {
    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    const { result } = renderQueue();
    act(() => result.current.start(
      [{ id: 'e1', title: null, url: 'u1', tag: 'batch-1' }, { id: 'e2', title: null, url: 'u2' }],
      { download: false, targetResolution: 'dflt' },
    ));
    expect(result.current.items.map((it) => it.tag)).toEqual(['batch-1', undefined]);
  });
});

describe('useBulkAddQueue: item ids', () => {
  it('never reuses an id after items were removed', () => {
    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    const { result } = renderQueue();
    const options = { download: false, targetResolution: 'dflt' };

    act(() => result.current.start([{ id: 'a', title: null, url: 'u1' }, { id: 'b', title: null, url: 'u2' }], options));
    const keptId = result.current.items[1].id;
    act(() => result.current.removeItem(result.current.items[0].id));
    // With ids derived from the list length this would mint "u2#1" again.
    act(() => result.current.start([{ id: 'c', title: null, url: 'u2' }], options));

    const ids = result.current.items.map((it) => it.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(keptId);
  });
});

describe('useBulkAddQueue: errorKind', () => {
  it('is the classified kind for an info-fetch failure', async () => {
    asMock(window.electronAPI.getVideoInfoResult).mockResolvedValue({ success: false, kind: 'ageRestricted', message: 'This video is age-restricted.' });
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();
    expect(result.current.items[0]).toMatchObject({ status: 'failed', error: 'This video is age-restricted.', errorKind: 'ageRestricted' });
  });

  it('is the payload kind for a download failure, and unknown when the payload has none', async () => {
    mockInfoByUrl();
    const { result } = renderQueue();
    act(() => result.current.start(
      [{ id: 'e1', title: null, url: 'u1' }, { id: 'e2', title: null, url: 'u2' }],
      { download: true, targetResolution: '720' },
    ));
    await flushMicrotasks();
    emitDownloadEvent({ type: 'error', payload: { message: 'HTTP Error 429', kind: 'rateLimit' } as unknown as DownloadProgressMessage['payload'] });
    await flushMicrotasks();
    expect(result.current.items[0]).toMatchObject({ status: 'failed', error: 'HTTP Error 429', errorKind: 'rateLimit' });

    await advancePastItemDelay();
    await flushMicrotasks();
    emitDownloadEvent({ type: 'error', payload: { message: 'boom' } as unknown as DownloadProgressMessage['payload'] });
    await flushMicrotasks();
    expect(result.current.items[1]).toMatchObject({ status: 'failed', errorKind: 'unknown' });
  });

  it('is unknown for an exception thrown elsewhere while processing, and cleared by a retry', async () => {
    mockInfoByUrl();
    asMock(window.electronAPI.addLibraryEntry).mockRejectedValue(new Error('disk says no'));
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();
    expect(result.current.items[0]).toMatchObject({ status: 'failed', error: 'disk says no', errorKind: 'unknown' });

    await advancePastItemDelay();
    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    act(() => result.current.retryItem(result.current.items[0].id));
    expect(result.current.items[0].errorKind).toBeUndefined();
    expect(result.current.items[0].error).toBeUndefined();
  });
});

describe('useBulkAddQueue: transitions', () => {
  it('reports normal progress through to done, with the item\'s tag and video id', async () => {
    mockInfoByUrl();
    const { result } = renderQueue();
    const { transitions, summary } = collectTransitions(result);

    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1', tag: 'batch-1' }], { download: true, targetResolution: '720' }));
    await flushMicrotasks();
    emitDownloadEvent({ type: 'done', payload: { filename: '/lib/c/v1/1/video.mp4' } as DownloadProgressMessage['payload'] });
    await flushMicrotasks();

    expect(summary()).toEqual(['u1:pending>fetching', 'u1:fetching>downloading', 'u1:downloading>done']);
    expect(last(transitions)).toEqual({
      id: result.current.items[0].id, tag: 'batch-1', videoId: 'v1', sourceUrl: 'u1',
      previousStatus: 'downloading', status: 'done', errorKind: undefined, error: undefined,
    });
  });

  it('does not report progress ticks that leave the status unchanged', async () => {
    mockInfoByUrl();
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: true, targetResolution: '720' }));
    await flushMicrotasks();
    const { summary } = collectTransitions(result);
    emitDownloadEvent({ type: 'progress', payload: { percent: '40%' } as unknown as DownloadProgressMessage['payload'] });
    await flushMicrotasks();
    expect(result.current.items[0].downloadProgress).toBe(40);
    expect(summary()).toEqual([]);
  });

  it('reports a failure with its kind and message, then the retry back to pending', async () => {
    asMock(window.electronAPI.getVideoInfoResult).mockResolvedValue({ success: false, kind: 'botBlock', message: 'bot check' });
    const { result } = renderQueue();
    const { transitions, summary } = collectTransitions(result);
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();
    expect(last(transitions)).toMatchObject({ previousStatus: 'fetching', status: 'failed', errorKind: 'botBlock', error: 'bot check' });

    await advancePastItemDelay();
    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    act(() => result.current.retryItem(result.current.items[0].id));
    expect(summary().slice(-2)).toEqual(['u1:failed>pending', 'u1:pending>fetching']);
    expect(transitions[transitions.length - 2]).toMatchObject({ errorKind: undefined, error: undefined });
  });

  it('reports cancelItem on an active download as downloading>cancelled', async () => {
    mockInfoByUrl();
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: true, targetResolution: '720' }));
    await flushMicrotasks();
    const { summary } = collectTransitions(result);

    act(() => result.current.cancelItem(result.current.items[0].id));
    expect(window.electronAPIPythonDownload.cancelDownload).toHaveBeenCalled();
    emitDownloadEvent({ type: 'error', payload: { message: 'Cancelled.', kind: 'cancelled' } as unknown as DownloadProgressMessage['payload'] });
    await flushMicrotasks();
    expect(summary()).toEqual(['u1:downloading>cancelled']);
  });

  it('reports cancelAllPending, removeItem and clearFinished', async () => {
    asMock(window.electronAPI.getVideoInfoResult).mockResolvedValue({ success: false, kind: 'unavailable', message: 'gone' });
    const { result } = renderQueue();
    act(() => result.current.start(
      [{ id: 'e1', title: null, url: 'u1' }, { id: 'e2', title: null, url: 'u2' }, { id: 'e3', title: null, url: 'u3' }],
      { download: false, targetResolution: 'dflt' },
    ));
    await flushMicrotasks();
    act(() => result.current.stop());
    await advancePastItemDelay();
    const { transitions, summary } = collectTransitions(result);

    act(() => result.current.cancelAllPending());
    expect(summary()).toEqual(['u2:pending>cancelled', 'u3:pending>cancelled']);

    act(() => result.current.removeItem(result.current.items[0].id));
    expect(last(summary())).toBe('u1:failed>removed');
    expect(last(transitions)).toMatchObject({ errorKind: 'unavailable', error: 'gone' });

    act(() => result.current.clearFinished());
    expect(summary().slice(-2)).toEqual(['u2:cancelled>removed', 'u3:cancelled>removed']);
    expect(result.current.items).toHaveLength(0);
  });

  it('stops reporting after unsubscribe, and an unsubscribe during delivery is safe', () => {
    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    const { result } = renderQueue();
    const seen: string[] = [];
    const unsubscribeFirst = result.current.subscribeTransitions((t) => { seen.push(`first:${t.status}`); unsubscribeFirst(); });
    result.current.subscribeTransitions((t) => seen.push(`second:${t.status}`));

    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    act(() => result.current.removeItem(result.current.items[0].id));
    expect(seen).toEqual(['first:fetching', 'second:fetching', 'second:removed']);
  });

  it('delivers a transition only after getItems() already reflects it', () => {
    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    const { result } = renderQueue();
    const statusesAtDelivery: string[] = [];
    result.current.subscribeTransitions((t) => {
      statusesAtDelivery.push(`${t.status}/${result.current.getItems().find((it) => it.id === t.id)?.status}`);
    });
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    expect(statusesAtDelivery).toEqual(['fetching/fetching']);
  });
});

describe('diffItemTransitions', () => {
  const item = (id: string, status: BulkAddItem['status']) => ({ id, sourceUrl: id, title: null, status, download: false, targetResolution: '' }) as BulkAddItem;

  it('reports status changes and removals, and ignores additions and unchanged items', () => {
    const previous = [item('a', 'pending'), item('b', 'fetching'), item('c', 'done')];
    const next = [item('b', 'failed'), item('c', 'done'), item('d', 'pending')];
    expect(diffItemTransitions(previous, next).map((t) => `${t.id}:${t.previousStatus}>${t.status}`)).toEqual(['a:pending>removed', 'b:fetching>failed']);
    expect(diffItemTransitions(previous, previous)).toEqual([]);
    expect(diffItemTransitions([], next)).toEqual([]);
  });
});

describe('useBulkAddQueue: removeByTag', () => {
  it('removes the tag\'s waiting and finished items but leaves the active one and other tags alone', async () => {
    mockInfoByUrl({ u1: { success: false, kind: 'unavailable', message: 'gone' } });
    const { result } = renderQueue();
    act(() => result.current.start(
      [
        { id: 'e1', title: null, url: 'u1', tag: 'batch-1' },
        { id: 'e2', title: null, url: 'u2', tag: 'batch-1' },
        { id: 'e3', title: null, url: 'u3', tag: 'batch-1' },
        { id: 'e4', title: null, url: 'u4', tag: 'batch-2' },
        { id: 'e5', title: null, url: 'u5' },
      ],
      { download: true, targetResolution: '720' },
    ));
    await flushMicrotasks();
    await advancePastItemDelay();
    await flushMicrotasks();
    expect(result.current.items.map((it) => it.status)).toEqual(['failed', 'downloading', 'pending', 'pending', 'pending']);
    const { summary } = collectTransitions(result);

    act(() => result.current.removeByTag('batch-1'));
    expect(result.current.items.map((it) => [it.sourceUrl, it.status])).toEqual([['u2', 'downloading'], ['u4', 'pending'], ['u5', 'pending']]);
    expect(summary()).toEqual(['u1:failed>removed', 'u3:pending>removed']);

    // The download that was left running still completes normally.
    emitDownloadEvent({ type: 'done', payload: { filename: '/lib/c/v2/1/video.mp4' } as DownloadProgressMessage['payload'] });
    await flushMicrotasks();
    expect(result.current.items[0].status).toBe('done');
  });

  it('with keepDone, leaves the tag\'s done and skipped items as well as the active one', async () => {
    mockInfoByUrl({ u2: { success: false, kind: 'unavailable', message: 'gone' } });
    asMock(window.electronAPI.findLibraryVideo).mockImplementation(async (videoId: string) => ({ found: videoId === 'v3' }));
    const { result } = renderQueue();
    act(() => result.current.start(
      ['u1', 'u2', 'u3', 'u4', 'u5'].map((url) => ({ id: url, title: null, url, tag: 'batch-1' })),
      { download: false, targetResolution: 'dflt' },
    ));
    for (let i = 0; i < 3; i++) {
      await flushMicrotasks();
      await advancePastItemDelay();
    }
    await flushMicrotasks();
    act(() => result.current.stop());
    expect(result.current.items.map((it) => it.status)).toEqual(['done', 'failed', 'skipped', 'done', 'pending']);
    const { summary } = collectTransitions(result);

    act(() => result.current.removeByTag('batch-1', { keepDone: true }));
    expect(result.current.items.map((it) => [it.sourceUrl, it.status])).toEqual([['u1', 'done'], ['u3', 'skipped'], ['u4', 'done']]);
    expect(summary()).toEqual(['u2:failed>removed', 'u5:pending>removed']);
  });

  it('lets the run finish when it removed the last pending items', async () => {
    mockInfoByUrl({ u1: { success: false, kind: 'unavailable', message: 'gone' } });
    const { result } = renderQueue();
    act(() => result.current.start(
      [{ id: 'e1', title: null, url: 'u1', tag: 't' }, { id: 'e2', title: null, url: 'u2', tag: 't' }],
      { download: false, targetResolution: 'dflt' },
    ));
    await flushMicrotasks();
    act(() => result.current.stop());
    await advancePastItemDelay();
    act(() => result.current.resume());
    act(() => result.current.stop());
    expect(result.current.isRunning).toBe(true);
    await flushMicrotasks();
    await advancePastItemDelay();
    expect(result.current.isRunning).toBe(false);
    act(() => result.current.removeByTag('t'));
    expect(result.current.items).toHaveLength(0);
  });
});

describe('useBulkAddQueue: start() openPanel', () => {
  it('leaves the panel closed with openPanel: false, and opens it by default', () => {
    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    const { result } = renderQueue();
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }, { openPanel: false }));
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.isRunning).toBe(true);
    expect(result.current.items[0].status).toBe('fetching');

    act(() => result.current.start([{ id: 'e2', title: null, url: 'u2' }], { download: false, targetResolution: 'dflt' }));
    expect(result.current.panelOpen).toBe(true);
  });
});

describe('useBulkAddQueue: queue-empty notification', () => {
  let NotificationMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    NotificationMock = vi.fn();
    vi.stubGlobal('Notification', NotificationMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runOneSkippedItem(result: { current: ReturnType<typeof useBulkAddQueue> }) {
    asMock(window.electronAPI.getVideoInfoResult).mockResolvedValue(infoFor('v1'));
    asMock(window.electronAPI.findLibraryVideo).mockResolvedValue({ found: true });
    act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();
    await advancePastItemDelay();
  }

  it('notifies when the queue empties', async () => {
    const { result } = renderQueue();
    await runOneSkippedItem(result);
    expect(result.current.isRunning).toBe(false);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith('Bulk add finished', expect.anything());
  });

  it('still finishes the run but does not notify while suppressed, and notifies again once restored', async () => {
    const { result } = renderQueue();
    act(() => result.current.setQueueEmptyNotificationSuppressed(true));
    await runOneSkippedItem(result);
    expect(result.current.isRunning).toBe(false);
    expect(NotificationMock).not.toHaveBeenCalled();

    act(() => result.current.setQueueEmptyNotificationSuppressed(false));
    await runOneSkippedItem(result);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });
});

describe('useBulkAddQueue: queue-empty notification restored mid wind-down', () => {
  it('stays quiet for a run whose last item finished while suppressed, then notifies for the next run', async () => {
    const NotificationMock = vi.fn();
    vi.stubGlobal('Notification', NotificationMock);
    try {
      asMock(window.electronAPI.getVideoInfoResult).mockResolvedValue(infoFor('v1'));
      asMock(window.electronAPI.findLibraryVideo).mockResolvedValue({ found: true });
      const { result } = renderQueue();
      act(() => result.current.setQueueEmptyNotificationSuppressed(true));
      act(() => result.current.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
      await flushMicrotasks();
      expect(result.current.items[0].status).toBe('skipped');

      // The item is finished, but its slot is still inside the 2 s gap.
      act(() => result.current.setQueueEmptyNotificationSuppressed(false));
      await advancePastItemDelay();
      expect(result.current.isRunning).toBe(false);
      expect(NotificationMock).not.toHaveBeenCalled();

      act(() => result.current.start([{ id: 'e2', title: null, url: 'u2' }], { download: false, targetResolution: 'dflt' }));
      await flushMicrotasks();
      await advancePastItemDelay();
      expect(NotificationMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('useBulkAddActions', () => {
  function renderBoth() {
    return renderHook(() => ({ actions: useBulkAddActions(), queue: useBulkAddQueue() }), { wrapper: BulkAddProvider });
  }

  it('keeps one identity across item updates and reads the latest items on demand', async () => {
    mockInfoByUrl();
    const { result } = renderBoth();
    const initialActions = result.current.actions;
    expect(initialActions.getItems()).toEqual([]);

    act(() => initialActions.start([{ id: 'e1', title: null, url: 'u1', tag: 't' }], { download: true, targetResolution: '720' }, { openPanel: false }));
    await flushMicrotasks();
    emitDownloadEvent({ type: 'progress', payload: { percent: '40%' } as unknown as DownloadProgressMessage['payload'] });
    await flushMicrotasks();

    expect(result.current.queue.items[0].status).toBe('downloading');
    expect(result.current.actions).toBe(initialActions);
    expect(initialActions.getItems()).toBe(result.current.queue.items);
    expect(result.current.queue.panelOpen).toBe(false);
  });

  it('does not re-render a component that only uses the actions when items change', async () => {
    mockInfoByUrl();
    let actionsOnlyRenders = 0;
    let actions!: ReturnType<typeof useBulkAddActions>;
    function ActionsOnly() {
      actions = useBulkAddActions();
      actionsOnlyRenders++;
      return null;
    }
    render(<BulkAddProvider><ActionsOnly /></BulkAddProvider>);
    const rendersBefore = actionsOnlyRenders;

    act(() => actions.start([{ id: 'e1', title: null, url: 'u1' }], { download: true, targetResolution: '720' }));
    await flushMicrotasks();
    emitDownloadEvent({ type: 'progress', payload: { percent: '40%' } as unknown as DownloadProgressMessage['payload'] });
    await flushMicrotasks();

    expect(actions.getItems()[0]).toMatchObject({ status: 'downloading', downloadProgress: 40 });
    expect(actionsOnlyRenders).toBe(rendersBefore);
  });

  it('forwards retryItem and removeItem too, for list rows that must not re-render on every tick', async () => {
    asMock(window.electronAPI.getVideoInfoResult).mockResolvedValue({ success: false, kind: 'unavailable', message: 'gone' });
    const { result } = renderBoth();
    const { actions } = result.current;
    act(() => actions.start([{ id: 'e1', title: null, url: 'u1' }], { download: false, targetResolution: 'dflt' }));
    await flushMicrotasks();
    await advancePastItemDelay();
    expect(actions.getItems()[0].status).toBe('failed');

    asMock(window.electronAPI.getVideoInfoResult).mockReturnValue(new Promise(() => {}));
    act(() => actions.retryItem(actions.getItems()[0].id));
    expect(actions.getItems()[0].status).toBe('fetching');
    act(() => actions.removeItem(actions.getItems()[0].id));
    expect(actions.getItems()).toHaveLength(0);
  });

  it('forwards stop/resume/removeByTag/setPanelOpen/isStopRequested to the live queue', async () => {
    mockInfoByUrl({ u1: new Promise(() => {}) });
    const { result } = renderBoth();
    const { actions } = result.current;
    act(() => actions.start([{ id: 'e1', title: null, url: 'u1', tag: 't' }, { id: 'e2', title: null, url: 'u2', tag: 't' }], { download: false, targetResolution: 'dflt' }));

    act(() => actions.stop());
    expect(actions.isStopRequested()).toBe(true);
    expect(result.current.queue.stopRequested).toBe(true);
    act(() => actions.resume());
    expect(actions.isStopRequested()).toBe(false);

    act(() => actions.setPanelOpen(false));
    expect(result.current.queue.panelOpen).toBe(false);

    act(() => actions.removeByTag('t'));
    expect(actions.getItems().map((it) => it.sourceUrl)).toEqual(['u1']);
  });

  it('throws outside a BulkAddProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useBulkAddActions())).toThrow(/BulkAddProvider/);
    consoleError.mockRestore();
  });
});
