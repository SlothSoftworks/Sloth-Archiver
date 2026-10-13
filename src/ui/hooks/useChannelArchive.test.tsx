// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { BulkAddProvider, useBulkAddQueue, type BulkAddStatus } from './useBulkAddQueue';
import { LibraryTagsProvider } from './useLibraryTags';
import {
  ChannelArchiveProvider,
  useChannelArchiveStatus,
  useChannelArchiveView,
  useBeginChannelScan,
  mapOutcome,
  toBacklogResult,
  pickBatchItems,
  planBatch,
  describePauseReason,
  getResumeBlockedReason,
  watchUrlFor,
  type ArchivePauseKind,
} from './useChannelArchive';
import type { DownloadProgressMessage } from '../../types';
import type {
  ArchiveBacklogItem,
  ArchiveBacklogJob,
  ArchiveBacklogState,
  BacklogBatchResult,
  ChannelScanEntry,
  ChannelScanProgress,
  ChannelScanResult,
  LibraryVideoLookup,
  VideoInfoResult,
} from '../../types/electron-api';

const ITEM_DELAY_MS = 2000;
const LIBRARY_DIR = '/library';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function makeItem(videoId: string, overrides: Partial<ArchiveBacklogItem> = {}): ArchiveBacklogItem {
  return { videoId, title: `Title ${videoId}`, approxTimestamp: null, status: 'pending', attempts: 0, ...overrides };
}

function makeJob(id: string, videoIds: string[], options: Partial<ArchiveBacklogJob['options']> = {}): ArchiveBacklogJob {
  return {
    id,
    channelId: null,
    channelTitle: 'Channel',
    channelUrl: 'https://www.youtube.com/@channel/videos',
    createdAt: 1,
    options: { download: false, targetResolution: '720', targetLibraryTag: 'DefaultLibrary', batchSize: 2, ...options },
    totalCount: videoIds.length,
    doneCount: 0,
    items: videoIds.map((videoId) => makeItem(videoId)),
  };
}

function deferred<V>() {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((res) => { resolve = res; });
  return { promise, resolve };
}

// An in-memory stand-in for archiveBacklog.mjs behind the backlog IPC calls,
// answering with the same shapes and the same item bookkeeping.
function createFakeBacklog(jobs: ArchiveBacklogJob[] = [], { libraryDirMatches = true }: { libraryDirMatches?: boolean } = {}) {
  let current = structuredClone(jobs);
  let nextJobNumber = 1;
  let addJobRefusal: 'libraryDirMismatch' | null = null;
  let completed = { totalCount: 0, doneCount: 0 };

  const state = (): ArchiveBacklogState => {
    const items = current.flatMap((job) => job.items);
    return {
      backlog: { version: 1, libraryDir: current.length > 0 ? LIBRARY_DIR : null, completedJobs: { ...completed }, jobs: structuredClone(current) },
      counts: {
        jobs: current.length,
        pending: items.filter((i) => i.status === 'pending').length,
        errors: items.filter((i) => i.status === 'error').length,
        total: current.length === 0 ? 0 : completed.totalCount + current.reduce((sum, job) => sum + job.totalCount, 0),
        done: current.length === 0 ? 0 : completed.doneCount + current.reduce((sum, job) => sum + job.doneCount, 0),
      },
      libraryDir: LIBRARY_DIR,
      libraryDirMatches,
    };
  };
  const dropEmptyJobs = () => {
    for (const job of current.filter((j) => j.items.length === 0)) {
      completed.totalCount += job.totalCount;
      completed.doneCount += job.doneCount;
    }
    current = current.filter((job) => job.items.length > 0);
    if (current.length === 0) completed = { totalCount: 0, doneCount: 0 };
  };

  const api = {
    getBacklog: vi.fn(async () => ({ success: true as const, ...state() })),
    addBacklogJob: vi.fn(async ({ job, mode }: Parameters<typeof window.electronAPI.addBacklogJob>[0]) => {
      if (addJobRefusal) return { success: false as const, reason: addJobRefusal, ...state() };
      if (mode === 'replace') {
        current = [];
        completed = { totalCount: 0, doneCount: 0 };
      }
      const jobId = `job-${nextJobNumber++}`;
      current.push({
        id: jobId,
        channelId: job.channelId,
        channelTitle: job.channelTitle || '',
        channelUrl: job.channelUrl,
        createdAt: 1,
        options: job.options,
        totalCount: job.items.length,
        doneCount: 0,
        items: job.items.map((item) => makeItem(item.videoId, { title: item.title || '', approxTimestamp: item.approxTimestamp })),
      });
      return { success: true as const, jobId, added: job.items.length, duplicatesSkipped: 0, invalidSkipped: 0, ...state() };
    }),
    applyBacklogResults: vi.fn(async (jobId: string, results: BacklogBatchResult[]) => {
      const job = current.find((j) => j.id === jobId);
      let applied = 0;
      for (const result of results) {
        const item = job?.items.find((i) => i.videoId === result.videoId);
        if (!job || !item) continue;
        applied++;
        if (result.outcome === 'done') {
          job.items = job.items.filter((i) => i !== item);
          job.doneCount += 1;
        } else if (result.outcome === 'pending') {
          item.attempts += 1;
        } else {
          item.status = 'error';
          item.errorKind = result.errorKind;
          item.errorMessage = result.errorMessage;
        }
      }
      dropEmptyJobs();
      return { success: true as const, applied, ...state() };
    }),
    retryBacklogErrors: vi.fn(async () => {
      let retried = 0;
      for (const item of current.flatMap((job) => job.items)) {
        if (item.status !== 'error') continue;
        item.status = 'pending';
        item.attempts = 0;
        delete item.errorKind;
        delete item.errorMessage;
        retried++;
      }
      return { success: true as const, retried, ...state() };
    }),
    dismissBacklogErrors: vi.fn(async () => {
      let dismissed = 0;
      for (const job of current) {
        dismissed += job.items.filter((i) => i.status === 'error').length;
        job.totalCount -= job.items.filter((i) => i.status === 'error').length;
        job.items = job.items.filter((i) => i.status !== 'error');
      }
      dropEmptyJobs();
      return { success: true as const, dismissed, ...state() };
    }),
    clearBacklog: vi.fn(async () => {
      current = [];
      completed = { totalCount: 0, doneCount: 0 };
      return { success: true as const, ...state() };
    }),
  };

  return {
    api,
    state,
    items: () => current.flatMap((job) => job.items),
    refuseAddJob: (reason: 'libraryDirMismatch') => { addJobRefusal = reason; },
  };
}

let registeredDownloadCallbacks: ((msg: DownloadProgressMessage) => void)[] = [];
// How getVideoInfoResult answers for each video id; anything not listed
// resolves as a normal, addable video.
let infoBehaviour: Record<string, VideoInfoResult | Promise<VideoInfoResult>> = {};
let libraryLookup: LibraryVideoLookup = {};
let scanProgressListeners: ((progress: ChannelScanProgress) => void)[] = [];
let NotificationMock: ReturnType<typeof vi.fn>;

function okInfo(videoId: string): VideoInfoResult {
  return { success: true, videoInfo: { id: videoId, fullTitle: `Title ${videoId}`, resolutions: [{ resolution: '720' }] }, fromCache: false };
}

function failInfo(kind: string, message = `failed: ${kind}`): VideoInfoResult {
  return { success: false, kind, message };
}

function installElectronAPI(backlog: ReturnType<typeof createFakeBacklog>) {
  window.electronAPI = {
    ...window.electronAPI,
    ...backlog.api,
    getVideoInfoResult: vi.fn(async (url: string) => {
      const videoId = new URL(url).searchParams.get('v') || '';
      return videoId in infoBehaviour ? infoBehaviour[videoId] : okInfo(videoId);
    }),
    enrichPlaylistEntry: vi.fn().mockResolvedValue({ success: true }),
    findLibraryVideo: vi.fn().mockResolvedValue({ found: false }),
    addLibraryEntry: vi.fn(async (videoInfo: { id: string }) => ({ success: true, videoDir: `/library/c/${videoInfo.id}`, epoch: '1' })),
    recordLibraryDownload: vi.fn().mockResolvedValue({ success: true }),
    getMaxSimultaneousDownloads: vi.fn().mockResolvedValue({ maxSimultaneousDownloads: 1 }),
    lookupLibraryVideos: vi.fn(async (videoIds: string[]) => Object.fromEntries(Object.entries(libraryLookup).filter(([id]) => videoIds.includes(id)))),
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [
      { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: 1 },
      { tagName: 'Music', folderName: 'Music', createdEpoch: 2 },
    ] }),
    getActiveLibraryTag: vi.fn().mockResolvedValue({ activeLibraryTag: 'DefaultLibrary', activeLibraryTagDir: '/library/DefaultLibrary' }),
    scanChannel: vi.fn(),
    cancelChannelScan: vi.fn().mockResolvedValue({ cancelled: true }),
    onChannelScanProgress: vi.fn((callback: (progress: ChannelScanProgress) => void) => {
      scanProgressListeners.push(callback);
      return callback;
    }),
    removeChannelScanProgressListener: vi.fn((listener: unknown) => {
      scanProgressListeners = scanProgressListeners.filter((l) => l !== listener);
    }),
  } as unknown as typeof window.electronAPI;
}

beforeEach(() => {
  vi.useFakeTimers();
  registeredDownloadCallbacks = [];
  infoBehaviour = {};
  libraryLookup = {};
  scanProgressListeners = [];
  NotificationMock = vi.fn();
  vi.stubGlobal('Notification', NotificationMock);
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <LibraryTagsProvider>
      <BulkAddProvider>
        <ChannelArchiveProvider>{children}</ChannelArchiveProvider>
      </BulkAddProvider>
    </LibraryTagsProvider>
  );
}

async function flushMicrotasks(times = 12) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function advancePastItemDelay() {
  await act(async () => { await vi.advanceTimersByTimeAsync(ITEM_DELAY_MS); });
  await flushMicrotasks();
}

async function renderArchive(jobs: ArchiveBacklogJob[] = [], backlogOptions: { libraryDirMatches?: boolean } = {}) {
  const backlog = createFakeBacklog(jobs, backlogOptions);
  installElectronAPI(backlog);
  const rendered = renderHook(() => ({ status: useChannelArchiveStatus(), view: useChannelArchiveView(), queue: useBulkAddQueue() }), { wrapper: Providers });
  await flushMicrotasks();
  return { ...rendered, backlog };
}

type Rendered = Awaited<ReturnType<typeof renderArchive>>;

// Lets the single download slot work through its items (one item, then the
// queue's own 2 s gap) until the condition holds.
async function runUntil(condition: () => boolean, maxItems = 20) {
  for (let i = 0; i < maxItems && !condition(); i++) {
    await advancePastItemDelay();
  }
  expect(condition()).toBe(true);
}

function appliedResults() {
  return asMock(window.electronAPI.applyBacklogResults).mock.calls.map(([jobId, results]) => [jobId, results]);
}

function fetchedVideoIds() {
  return asMock(window.electronAPI.getVideoInfoResult).mock.calls.map(([url]) => new URL(url).searchParams.get('v'));
}

function queueSnapshot(rendered: Rendered) {
  return rendered.result.current.queue.items.map((it) => `${it.videoId}:${it.status}`);
}

function emitDownloadEvent(msg: Omit<DownloadProgressMessage, 'requestId'>) {
  const calls = asMock(window.electronAPIPythonDownload.startDownloadPython).mock.calls;
  const fullMsg = { requestId: calls[calls.length - 1][0].requestId, ...msg } as DownloadProgressMessage;
  act(() => registeredDownloadCallbacks.forEach((cb) => cb(fullMsg)));
}

const FAILED_KINDS_THAT_PAUSE = ['botBlock', 'rateLimit', 'network', 'chunkTransferFailure', 'stalled', 'outOfDiskSpace', 'missingDependency'];
const FAILED_KINDS_THAT_ERROR = ['ageRestricted', 'geoBlocked', 'loginRequired', 'unavailable', 'unknown', 'cancelled'];

describe('mapOutcome', () => {
  it('covers every error kind the main process can report', () => {
    // downloadErrors.mjs's ERROR_KINDS, spelled out: the renderer never
    // imports main-process modules.
    expect([...FAILED_KINDS_THAT_PAUSE, ...FAILED_KINDS_THAT_ERROR].sort()).toEqual([
      'ageRestricted', 'botBlock', 'cancelled', 'chunkTransferFailure', 'geoBlocked', 'loginRequired', 'missingDependency',
      'network', 'outOfDiskSpace', 'rateLimit', 'stalled', 'unavailable', 'unknown',
    ]);
  });

  it.each(['done', 'skipped'] as const)('treats %s as done', (status) => {
    expect(mapOutcome({ status, previousStatus: 'fetching' })).toEqual({ outcome: 'done', pause: false, attempted: true });
  });

  it.each(FAILED_KINDS_THAT_PAUSE)('keeps a %s failure pending and pauses the run', (errorKind) => {
    expect(mapOutcome({ status: 'failed', previousStatus: 'fetching', errorKind, error: 'msg' })).toEqual({
      outcome: 'pending', pause: true, attempted: true, errorKind, errorMessage: 'msg',
    });
  });

  it.each(FAILED_KINDS_THAT_ERROR)('records a %s failure as an error without pausing', (errorKind) => {
    expect(mapOutcome({ status: 'failed', previousStatus: 'downloading', errorKind, error: 'msg' })).toEqual({
      outcome: 'error', pause: false, attempted: true, errorKind, errorMessage: 'msg',
    });
  });

  it('records an unrecognised or missing kind as an unknown-style error', () => {
    expect(mapOutcome({ status: 'failed', previousStatus: 'fetching', errorKind: 'somethingNew', error: 'msg' })).toMatchObject({ outcome: 'error', pause: false, errorKind: 'somethingNew' });
    expect(mapOutcome({ status: 'failed', previousStatus: 'fetching' })).toEqual({ outcome: 'error', pause: false, attempted: true, errorKind: 'unknown', errorMessage: '' });
  });

  it.each([
    ['cancelled', 'downloading'], ['cancelled', 'fetching'], ['removed', 'downloading'], ['removed', 'fetching'],
  ] as const)('records %s from %s as a cancelled error', (status, previousStatus) => {
    expect(mapOutcome({ status, previousStatus })).toEqual({ outcome: 'error', pause: false, attempted: true, errorKind: 'cancelled', errorMessage: 'Cancelled.' });
  });

  it.each([
    ['cancelled', 'pending'], ['removed', 'pending'], ['removed', 'failed'], ['removed', 'done'],
  ] as const)('keeps %s from %s pending, unattempted, and pauses', (status, previousStatus) => {
    expect(mapOutcome({ status, previousStatus })).toEqual({ outcome: 'pending', pause: true, attempted: false, errorKind: 'cancelled' });
  });

  it.each(['pending', 'fetching', 'downloading'] as const)('treats the unfinished status %s as nothing to record', (status: BulkAddStatus) => {
    expect(mapOutcome({ status, previousStatus: 'pending' })).toEqual({ outcome: 'pending', pause: false, attempted: false });
  });
});

describe('toBacklogResult', () => {
  it('writes done and error outcomes as they are', () => {
    expect(toBacklogResult(makeItem('v1'), { outcome: 'done', pause: false, attempted: true })).toEqual({ videoId: 'v1', outcome: 'done' });
    expect(toBacklogResult(makeItem('v1'), { outcome: 'error', pause: false, attempted: true, errorKind: 'unavailable', errorMessage: 'gone' }))
      .toEqual({ videoId: 'v1', outcome: 'error', errorKind: 'unavailable', errorMessage: 'gone' });
  });

  it('records nothing for a video that was never tried', () => {
    expect(toBacklogResult(makeItem('v1', { attempts: 2 }), { outcome: 'pending', pause: true, attempted: false, errorKind: 'cancelled' })).toBeNull();
  });

  it('keeps a tried video pending until its third attempt, which becomes an error', () => {
    const decision = { outcome: 'pending' as const, pause: true, attempted: true, errorKind: 'botBlock', errorMessage: 'bot check' };
    expect(toBacklogResult(makeItem('v1', { attempts: 0 }), decision)).toEqual({ videoId: 'v1', outcome: 'pending' });
    expect(toBacklogResult(makeItem('v1', { attempts: 1 }), decision)).toEqual({ videoId: 'v1', outcome: 'pending' });
    expect(toBacklogResult(makeItem('v1', { attempts: 2 }), decision)).toEqual({ videoId: 'v1', outcome: 'error', errorKind: 'botBlock', errorMessage: 'bot check' });
  });
});

describe('pickBatchItems / planBatch', () => {
  it('takes the first batchSize pending items, skipping errors', () => {
    const job = makeJob('j', ['v1', 'v2', 'v3', 'v4']);
    job.items[1].status = 'error';
    expect(pickBatchItems(job).map((i) => i.videoId)).toEqual(['v1', 'v3']);
  });

  const inLibrary = (overrides: Partial<LibraryVideoLookup[string]> = {}) => ({ videoDir: '/library/c/x', latestEpoch: '5', hasVideoFile: false, hasAudioFile: false, ...overrides });

  it('sends a video that is not in the library through the normal fetch path', () => {
    const job = makeJob('j', ['v1']);
    job.items[0].title = '';
    expect(planBatch(job, job.items, {}, 'tag-1')).toEqual({
      satisfied: [],
      entries: [{ id: 'v1', title: null, url: 'https://www.youtube.com/watch?v=v1', videoId: 'v1', tag: 'tag-1' }],
    });
  });

  it('treats a video already in the library as done when the job does not download', () => {
    const job = makeJob('j', ['v1', 'v2']);
    expect(planBatch(job, job.items, { v1: inLibrary(), v2: inLibrary({ hasVideoFile: true }) }, 't')).toEqual({ satisfied: ['v1', 'v2'], entries: [] });
  });

  it('for a download job: done when the wanted file exists, straight to download when it does not', () => {
    const job = makeJob('j', ['v1', 'v2', 'v3'], { download: true, targetResolution: '1080' });
    const plan = planBatch(job, job.items, {
      v1: inLibrary({ hasVideoFile: true }),
      v2: inLibrary({ videoDir: '/library/c/v2', latestEpoch: '7', hasAudioFile: true }),
      v3: inLibrary({ latestEpoch: null }),
    }, 't');
    expect(plan.satisfied).toEqual(['v1', 'v3']);
    expect(plan.entries).toEqual([{
      id: '/library/c/v2', title: 'Title v2', url: 'https://www.youtube.com/watch?v=v2', videoId: 'v2',
      videoDir: '/library/c/v2', epoch: '7', resolution: '1080', kind: 'video', tag: 't',
    }]);
  });

  it('for an MP3 job: looks at the audio file and downloads as audio', () => {
    const job = makeJob('j', ['v1', 'v2'], { download: true, targetResolution: 'MP3' });
    const plan = planBatch(job, job.items, {
      v1: inLibrary({ hasAudioFile: true }),
      v2: inLibrary({ videoDir: '/library/c/v2', hasVideoFile: true }),
    }, 't');
    expect(plan.satisfied).toEqual(['v1']);
    expect(plan.entries).toEqual([expect.objectContaining({ videoDir: '/library/c/v2', epoch: '5', resolution: 'mp3', kind: 'audio' })]);
  });

  it('does not mistake an inherited property name for a library entry', () => {
    const job = makeJob('j', ['constructor']);
    expect(planBatch(job, job.items, {}, 't').entries).toHaveLength(1);
  });
});

describe('getResumeBlockedReason / describePauseReason', () => {
  const stateFor = (job: ArchiveBacklogJob, libraryDirMatches = true): ArchiveBacklogState => ({
    backlog: { version: 1, libraryDir: '/old-library', completedJobs: { totalCount: 0, doneCount: 0 }, jobs: [job] },
    counts: { jobs: 1, pending: job.items.filter((i) => i.status === 'pending').length, errors: 0, total: job.totalCount, done: job.doneCount },
    libraryDir: LIBRARY_DIR,
    libraryDirMatches,
  });

  it('allows a backlog whose folder matches and whose sublibraries exist', () => {
    expect(getResumeBlockedReason(stateFor(makeJob('j', ['v1'], { targetLibraryTag: 'Music' })), ['Music'], 'DefaultLibrary')).toBeNull();
    // The default sublibrary has no folder until something is written to it.
    expect(getResumeBlockedReason(stateFor(makeJob('j', ['v1'])), [], 'DefaultLibrary')).toBeNull();
  });

  it('blocks a different library folder, a missing sublibrary, and sublibraries that have not loaded', () => {
    expect(getResumeBlockedReason(stateFor(makeJob('j', ['v1']), false), ['DefaultLibrary'], 'DefaultLibrary')).toMatch(/different library folder \(\/old-library\)/);
    expect(getResumeBlockedReason(stateFor(makeJob('j', ['v1'], { targetLibraryTag: 'Gone' })), ['Music'], 'DefaultLibrary')).toMatch(/"Gone" no longer exists/);
    expect(getResumeBlockedReason(stateFor(makeJob('j', ['v1'])), [], '')).toMatch(/still loading/);
  });

  it('ignores a missing sublibrary that only error items point at', () => {
    const job = makeJob('j', ['v1'], { targetLibraryTag: 'Gone' });
    job.items[0].status = 'error';
    expect(getResumeBlockedReason(stateFor(job, false), ['Music'], 'DefaultLibrary')).toBeNull();
  });

  it('has a sentence for every pause kind', () => {
    const kinds: ArchivePauseKind[] = ['botBlock', 'rateLimit', 'network', 'chunkTransferFailure', 'stalled', 'outOfDiskSpace', 'missingDependency', 'cancelled', 'consecutiveFailures', 'manual', 'queueStopped', 'failure'];
    for (const kind of kinds) expect(describePauseReason(kind)).toMatch(/\w.*\./);
    expect(describePauseReason('botBlock')).toMatch(/cookies in Options/);
    expect(describePauseReason('network')).toMatch(/connection/);
    expect(describePauseReason('outOfDiskSpace')).toMatch(/space/);
    expect(describePauseReason('failure', 'EACCES')).toMatch(/EACCES/);
  });
});

describe('without a provider', () => {
  it('useChannelArchiveStatus returns an inert default and useChannelArchiveView throws', async () => {
    const { result } = renderHook(() => useChannelArchiveStatus());
    expect(result.current).toMatchObject({
      backlogState: null, counts: { jobs: 0, pending: 0, errors: 0 }, progress: { done: 0, total: 0, pending: 0 }, runState: 'idle', pauseReason: null, pauseKind: null,
      canResume: false, resumeBlockedReason: null, scan: { status: 'idle', found: 0, total: null, message: null, errorKind: null },
    });
    result.current.resumeBacklog();
    result.current.pauseBacklog();
    await expect(Promise.all([result.current.removeBacklog(), result.current.retryErrors(), result.current.dismissErrors(), result.current.refreshBacklog()])).resolves.toBeDefined();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useChannelArchiveView())).toThrow(/ChannelArchiveProvider/);
    expect(renderHook(() => useBeginChannelScan()).result.current).toBeNull();
    consoleError.mockRestore();
  });
});

describe('backlog status on mount', () => {
  it('loads the backlog but never starts running it', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'])]);
    await advancePastItemDelay();
    const { status } = rendered.result.current;
    expect(window.electronAPI.getBacklog).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ runState: 'idle', counts: { jobs: 1, pending: 3, errors: 0 }, canResume: true, resumeBlockedReason: null });
    expect(status.backlogState?.backlog.jobs[0].id).toBe('job-a');
    expect(window.electronAPI.lookupLibraryVideos).not.toHaveBeenCalled();
    expect(window.electronAPI.getVideoInfoResult).not.toHaveBeenCalled();
    expect(rendered.result.current.queue.items).toHaveLength(0);
  });

  it('cannot resume a backlog queued for another library folder', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1'])], { libraryDirMatches: false });
    expect(rendered.result.current.status.canResume).toBe(false);
    expect(rendered.result.current.status.resumeBlockedReason).toMatch(/different library folder/);

    act(() => rendered.result.current.status.resumeBacklog());
    await advancePastItemDelay();
    expect(rendered.result.current.status.runState).toBe('idle');
    expect(window.electronAPI.lookupLibraryVideos).not.toHaveBeenCalled();
  });

  it('cannot resume when a pending job targets a sublibrary that no longer exists', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1'], { targetLibraryTag: 'Gone' })]);
    expect(rendered.result.current.status.canResume).toBe(false);
    expect(rendered.result.current.status.resumeBlockedReason).toMatch(/"Gone" no longer exists/);
  });
});

describe('runner', () => {
  it('works through the backlog batch by batch and reports each batch to the backlog', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3']), makeJob('job-b', ['v4'], { targetLibraryTag: 'Music' })]);

    act(() => rendered.result.current.status.resumeBacklog());
    expect(rendered.result.current.status.runState).toBe('running');
    expect(rendered.result.current.status.canResume).toBe(false);
    await flushMicrotasks();
    expect(queueSnapshot(rendered)).toEqual(['v1:done', 'v2:pending']);
    expect(rendered.result.current.queue.items.every((it) => it.targetLibraryTag === 'DefaultLibrary' && it.download === false)).toBe(true);
    expect(rendered.result.current.queue.panelOpen).toBe(false);

    await runUntil(() => rendered.result.current.status.runState === 'idle');

    expect(appliedResults()).toEqual([
      ['job-a', [{ videoId: 'v1', outcome: 'done' }, { videoId: 'v2', outcome: 'done' }]],
      ['job-a', [{ videoId: 'v3', outcome: 'done' }]],
      ['job-b', [{ videoId: 'v4', outcome: 'done' }]],
    ]);
    expect(asMock(window.electronAPI.lookupLibraryVideos).mock.calls).toEqual([
      [['v1', 'v2'], 'DefaultLibrary'], [['v3'], 'DefaultLibrary'], [['v4'], 'Music'],
    ]);
    expect(asMock(window.electronAPI.addLibraryEntry).mock.calls.map(([info, tag]) => [info.id, tag])).toEqual([
      ['v1', 'DefaultLibrary'], ['v2', 'DefaultLibrary'], ['v3', 'DefaultLibrary'], ['v4', 'Music'],
    ]);
    expect(rendered.result.current.status).toMatchObject({ runState: 'idle', counts: { jobs: 0, pending: 0, errors: 0 }, pauseReason: null });
    // Everything that was added stays in the panel as the record of the run.
    expect(queueSnapshot(rendered)).toEqual(['v1:done', 'v2:done', 'v3:done', 'v4:done']);
  });

  it('reports how much of the backlog is done as batches are recorded', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3']), makeJob('job-b', ['v4'])]);
    expect(rendered.result.current.status.counts).toMatchObject({ total: 4, done: 0 });
    expect(rendered.result.current.status.progress).toEqual({ done: 0, total: 4, pending: 4 });
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    // The first video of the batch is done, but the batch is not recorded
    // yet: the live progress already counts it, the backlog's own counts do not.
    expect(queueSnapshot(rendered)).toEqual(['v1:done', 'v2:pending']);
    expect(rendered.result.current.status.counts).toMatchObject({ done: 0, pending: 4 });
    expect(rendered.result.current.status.progress).toEqual({ done: 1, total: 4, pending: 3 });
    await runUntil(() => asMock(window.electronAPI.applyBacklogResults).mock.calls.length === 1);
    expect(rendered.result.current.status.counts).toMatchObject({ total: 4, done: 2, pending: 2 });
    expect(rendered.result.current.status.progress.done).toBeGreaterThanOrEqual(2);
    await runUntil(() => asMock(window.electronAPI.applyBacklogResults).mock.calls.length === 2);
    // job-a is finished and gone from the list; its videos still count.
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 1, total: 4, done: 3, pending: 1 });
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(rendered.result.current.status.progress).toEqual({ done: 0, total: 0, pending: 0 });
  });

  it('keeps done items in the panel but takes failed ones out, since those live in the backlog\'s error list', async () => {
    infoBehaviour.v2 = failInfo('unavailable');
    libraryLookup = { v4: { videoDir: '/library/c/v4', latestEpoch: '1', hasVideoFile: false, hasAudioFile: false } };
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3', 'v4'], { batchSize: 4 })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');

    expect(queueSnapshot(rendered)).toEqual(['v1:done', 'v3:done']);
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 1, pending: 0, errors: 1, total: 4, done: 3 });
  });

  it('is not disturbed when the user clears or removes kept items while a later batch is running', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.v3 = slow.promise;
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3', 'v4', 'v5'])]);
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => queueSnapshot(rendered).includes('v3:fetching'));
    expect(queueSnapshot(rendered)).toEqual(['v1:done', 'v2:done', 'v3:fetching', 'v4:pending']);
    expect(appliedResults()).toHaveLength(1);

    act(() => rendered.result.current.queue.removeItem(rendered.result.current.queue.items[0].id));
    act(() => rendered.result.current.queue.clearFinished());
    expect(queueSnapshot(rendered)).toEqual(['v3:fetching', 'v4:pending']);
    await flushMicrotasks();
    expect(rendered.result.current.status.runState).toBe('running');
    expect(appliedResults()).toHaveLength(1);

    await act(async () => { slow.resolve(okInfo('v3')); });
    await flushMicrotasks();
    // Clearing a finished item of the batch that is still running is fine too.
    act(() => rendered.result.current.queue.clearFinished());
    expect(queueSnapshot(rendered)).toEqual(['v4:pending']);
    await runUntil(() => rendered.result.current.status.runState === 'idle');

    expect(appliedResults()).toEqual([
      ['job-a', [{ videoId: 'v1', outcome: 'done' }, { videoId: 'v2', outcome: 'done' }]],
      ['job-a', [{ videoId: 'v3', outcome: 'done' }, { videoId: 'v4', outcome: 'done' }]],
      ['job-a', [{ videoId: 'v5', outcome: 'done' }]],
    ]);
    expect(queueSnapshot(rendered)).toEqual(['v4:done', 'v5:done']);
  });

  it('sends one notification for the whole run instead of the queue\'s own after every batch', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'], { batchSize: 1 })]);
    infoBehaviour.v3 = failInfo('unavailable');
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');

    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith('Channel archive finished', { body: expect.stringContaining('1 video could not be added') });
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 1, pending: 0, errors: 1 });

    // Nothing more once the last item's slot winds down...
    await advancePastItemDelay();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    // ...and the queue's own notification is back for ordinary bulk adds.
    act(() => rendered.result.current.queue.start([{ id: 'x', title: null, url: watchUrlFor('v9') }], { download: false, targetResolution: 'dflt' }));
    await advancePastItemDelay();
    expect(NotificationMock).toHaveBeenCalledTimes(2);
    expect(NotificationMock).toHaveBeenLastCalledWith('Bulk add finished', expect.anything());
  });

  it('marks videos already in the target sublibrary done without fetching them', async () => {
    libraryLookup = { v1: { videoDir: '/library/c/v1', latestEpoch: '1', hasVideoFile: false, hasAudioFile: false } };
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2'])]);
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');

    expect(fetchedVideoIds()).toEqual(['v2']);
    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'done' }, { videoId: 'v2', outcome: 'done' }]]]);
  });

  it('finishes a batch that is entirely in the library without touching the queue', async () => {
    libraryLookup = {
      v1: { videoDir: '/library/c/v1', latestEpoch: '1', hasVideoFile: true, hasAudioFile: false },
      v2: { videoDir: '/library/c/v2', latestEpoch: '1', hasVideoFile: true, hasAudioFile: false },
    };
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2'], { download: true })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();

    expect(rendered.result.current.status.runState).toBe('idle');
    expect(window.electronAPI.getVideoInfoResult).not.toHaveBeenCalled();
    expect(window.electronAPIPythonDownload.startDownloadPython).not.toHaveBeenCalled();
    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'done' }, { videoId: 'v2', outcome: 'done' }]]]);
  });

  it('downloads straight into the existing entry for a video that is in the library but not downloaded', async () => {
    libraryLookup = { v1: { videoDir: '/library/c/v1', latestEpoch: '42', hasVideoFile: false, hasAudioFile: false } };
    const rendered = await renderArchive([makeJob('job-a', ['v1'], { download: true, targetResolution: '1080' })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();

    expect(queueSnapshot(rendered)).toEqual(['v1:downloading']);
    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: 'https://www.youtube.com/watch?v=v1', outputPath: '/library/c/v1/42/video', resolution: '1080' }),
    );
    expect(window.electronAPI.getVideoInfoResult).not.toHaveBeenCalled();
    expect(window.electronAPI.addLibraryEntry).not.toHaveBeenCalled();

    emitDownloadEvent({ type: 'done', payload: { filename: '/library/c/v1/42/video.mp4' } as DownloadProgressMessage['payload'] });
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'done' }]]]);
  });

  it('pauses on a bot check, pulls the rest of the batch back, and counts no attempt for videos that never ran', async () => {
    infoBehaviour.v1 = failInfo('botBlock', 'Sign in to confirm you are not a bot');
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3', 'v4'], { batchSize: 3 })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();

    expect(rendered.result.current.status).toMatchObject({ runState: 'paused', pauseKind: 'botBlock', canResume: true });
    expect(rendered.result.current.status.pauseReason).toMatch(/cookies in Options/);
    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'pending' }]]]);
    expect(rendered.backlog.items().map((i) => [i.videoId, i.status, i.attempts])).toEqual([
      ['v1', 'pending', 1], ['v2', 'pending', 0], ['v3', 'pending', 0], ['v4', 'pending', 0],
    ]);
    expect(rendered.result.current.queue.items).toHaveLength(0);

    await advancePastItemDelay();
    await advancePastItemDelay();
    expect(fetchedVideoIds()).toEqual(['v1']);
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('lets a download that is already running finish before it pauses', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.v1 = slow.promise;
    infoBehaviour.v2 = failInfo('rateLimit');
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'], { batchSize: 3 })]);
    asMock(window.electronAPI.getMaxSimultaneousDownloads).mockResolvedValue({ maxSimultaneousDownloads: 2 });
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();

    // v2 failed in the second slot; v3 was pulled back; v1 is still fetching.
    expect(queueSnapshot(rendered)).toEqual(['v1:fetching']);
    expect(rendered.result.current.status.runState).toBe('running');
    expect(appliedResults()).toEqual([]);

    await act(async () => { slow.resolve(okInfo('v1')); });
    await flushMicrotasks();
    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'done' }, { videoId: 'v2', outcome: 'pending' }]]]);
    expect(rendered.result.current.status).toMatchObject({ runState: 'paused', pauseKind: 'rateLimit' });
    expect(rendered.backlog.items().map((i) => [i.videoId, i.attempts])).toEqual([['v2', 1], ['v3', 0]]);
  });

  it('pauses after three failures in a row of any kind', async () => {
    infoBehaviour = { v1: failInfo('unavailable'), v2: failInfo('unknown'), v3: failInfo('ageRestricted') };
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3', 'v4', 'v5'], { batchSize: 4 })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'paused');

    expect(rendered.result.current.status.pauseKind).toBe('consecutiveFailures');
    expect(rendered.result.current.status.pauseReason).toMatch(/failed in a row/);
    expect(appliedResults()).toEqual([['job-a', [
      { videoId: 'v1', outcome: 'error', errorKind: 'unavailable', errorMessage: 'failed: unavailable' },
      { videoId: 'v2', outcome: 'error', errorKind: 'unknown', errorMessage: 'failed: unknown' },
      { videoId: 'v3', outcome: 'error', errorKind: 'ageRestricted', errorMessage: 'failed: ageRestricted' },
    ]]]);
    expect(fetchedVideoIds()).toEqual(['v1', 'v2', 'v3']);
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 1, pending: 2, errors: 3 });
  });

  it('counts failures across batches, and a success in between resets the count', async () => {
    infoBehaviour = { v1: failInfo('unavailable'), v2: failInfo('unavailable'), v4: failInfo('unavailable'), v5: failInfo('unavailable'), v6: failInfo('unavailable') };
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'], { batchSize: 2 })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'paused');

    // v1, v2 fail; v3 succeeds and resets; v4 (batch 2), v5, v6 (batch 3) fail.
    expect(rendered.result.current.status.pauseKind).toBe('consecutiveFailures');
    expect(fetchedVideoIds()).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 1, pending: 1, errors: 5 });
  });

  it('turns a video into an error on its third paused attempt', async () => {
    infoBehaviour.v1 = failInfo('botBlock', 'bot check');
    const job = makeJob('job-a', ['v1', 'v2']);
    job.items[0].attempts = 2;
    const rendered = await renderArchive([job]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();

    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'error', errorKind: 'botBlock', errorMessage: 'bot check' }]]]);
    expect(rendered.result.current.status).toMatchObject({ runState: 'paused', pauseKind: 'botBlock', counts: { jobs: 1, pending: 1, errors: 1 } });
  });

  it('does not close a batch early when a failed video is retried from the panel', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour = { v1: failInfo('unavailable'), v2: slow.promise };
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'])]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    await advancePastItemDelay();
    expect(queueSnapshot(rendered)).toEqual(['v1:failed', 'v2:fetching']);

    delete infoBehaviour.v1;
    act(() => rendered.result.current.queue.retryItem(rendered.result.current.queue.items[0].id));
    expect(queueSnapshot(rendered)).toEqual(['v1:pending', 'v2:fetching']);

    // v2 finishing leaves v1 unfinished, so the batch must stay open.
    await act(async () => { slow.resolve(okInfo('v2')); });
    await flushMicrotasks();
    expect(queueSnapshot(rendered)).toEqual(['v1:pending', 'v2:done']);
    expect(appliedResults()).toEqual([]);
    expect(rendered.result.current.status.runState).toBe('running');

    await advancePastItemDelay();
    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'done' }, { videoId: 'v2', outcome: 'done' }]]]);
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 0, pending: 0, errors: 0 });
  });

  it('"Cancel all pending" pauses the run and leaves those videos pending instead of marking errors', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.v1 = slow.promise;
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'], { batchSize: 3 })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    expect(queueSnapshot(rendered)).toEqual(['v1:fetching', 'v2:pending', 'v3:pending']);

    act(() => rendered.result.current.queue.cancelAllPending());
    await flushMicrotasks();
    expect(appliedResults()).toEqual([]);

    await act(async () => { slow.resolve(okInfo('v1')); });
    await flushMicrotasks();
    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'done' }]]]);
    expect(rendered.result.current.status).toMatchObject({ runState: 'paused', pauseKind: 'cancelled', counts: { jobs: 1, pending: 2, errors: 0 } });
    expect(rendered.backlog.items().map((i) => [i.videoId, i.status, i.attempts])).toEqual([['v2', 'pending', 0], ['v3', 'pending', 0]]);
    // The cancelled ones are taken out of the panel (they are still pending
    // in the backlog); the one that was added stays.
    expect(queueSnapshot(rendered)).toEqual(['v1:done']);
  });

  it('records a video the user cancelled mid-download as a cancelled error and carries on', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2'], { download: true })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    expect(queueSnapshot(rendered)).toEqual(['v1:downloading', 'v2:pending']);

    act(() => rendered.result.current.queue.cancelItem(rendered.result.current.queue.items[0].id));
    emitDownloadEvent({ type: 'error', payload: { message: 'Cancelled.', kind: 'cancelled' } as unknown as DownloadProgressMessage['payload'] });
    await advancePastItemDelay();
    expect(queueSnapshot(rendered)).toEqual(['v1:cancelled', 'v2:downloading']);
    expect(rendered.result.current.status.runState).toBe('running');

    emitDownloadEvent({ type: 'done', payload: { filename: '/library/c/v2/1/video.mp4' } as DownloadProgressMessage['payload'] });
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(appliedResults()).toEqual([['job-a', [
      { videoId: 'v1', outcome: 'error', errorKind: 'cancelled', errorMessage: 'Cancelled.' },
      { videoId: 'v2', outcome: 'done' },
    ]]]);
  });

  it('does not submit another batch while the user\'s Stop leaves the current one unfinished', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.v1 = slow.promise;
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3', 'v4'])]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();

    act(() => rendered.result.current.queue.stop());
    await act(async () => { slow.resolve(okInfo('v1')); });
    for (let i = 0; i < 5; i++) await advancePastItemDelay();

    expect(queueSnapshot(rendered)).toEqual(['v1:done', 'v2:pending']);
    expect(rendered.result.current.queue.isRunning).toBe(false);
    expect(rendered.result.current.status.runState).toBe('running');
    expect(appliedResults()).toEqual([]);
    expect(window.electronAPI.lookupLibraryVideos).toHaveBeenCalledTimes(1);
    expect(fetchedVideoIds()).toEqual(['v1']);

    // Resume backlog also un-stops the queue, since the run is stuck behind it.
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(appliedResults().map(([, results]) => results.map((r: BacklogBatchResult) => r.videoId))).toEqual([['v1', 'v2'], ['v3', 'v4']]);
  });

  it('pauses rather than clearing the user\'s Stop when a batch ends while the queue is stopped', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.v1 = slow.promise;
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2'], { batchSize: 1 })]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    act(() => rendered.result.current.queue.stop());
    await act(async () => { slow.resolve(okInfo('v1')); });
    await advancePastItemDelay();

    expect(appliedResults()).toEqual([['job-a', [{ videoId: 'v1', outcome: 'done' }]]]);
    expect(rendered.result.current.status).toMatchObject({ runState: 'paused', pauseKind: 'queueStopped' });
    expect(fetchedVideoIds()).toEqual(['v1']);

    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(fetchedVideoIds()).toEqual(['v1', 'v2']);
  });

  it('runs a single loop when Resume is pressed twice', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'])]);
    act(() => {
      rendered.result.current.status.resumeBacklog();
      rendered.result.current.status.resumeBacklog();
    });
    await flushMicrotasks();
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');

    expect(fetchedVideoIds()).toEqual(['v1', 'v2', 'v3']);
    expect(window.electronAPI.lookupLibraryVideos).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.applyBacklogResults).toHaveBeenCalledTimes(2);
  });

  it('pauseBacklog stops after the batch in progress, and Resume picks up from there', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'])]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    expect(rendered.result.current.status.pauseRequested).toBe(false);
    act(() => rendered.result.current.status.pauseBacklog());
    expect(rendered.result.current.status).toMatchObject({ runState: 'running', pauseRequested: true });
    await runUntil(() => rendered.result.current.status.runState === 'paused');
    expect(rendered.result.current.status.pauseRequested).toBe(false);

    expect(rendered.result.current.status).toMatchObject({ pauseKind: 'manual', pauseReason: 'Paused by you.', counts: { pending: 1 }, canResume: true });
    expect(fetchedVideoIds()).toEqual(['v1', 'v2']);

    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(fetchedVideoIds()).toEqual(['v1', 'v2', 'v3']);
  });

  it('removeBacklog clears the backlog, stops the run, and pulls the waiting batch out of the queue', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.v1 = slow.promise;
    const rendered = await renderArchive([makeJob('job-a', ['v1', 'v2', 'v3'])]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();

    await act(async () => { await rendered.result.current.status.removeBacklog(); });
    expect(window.electronAPI.clearBacklog).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.status).toMatchObject({ runState: 'idle', counts: { jobs: 0, pending: 0, errors: 0 } });
    expect(queueSnapshot(rendered)).toEqual(['v1:fetching']);

    await act(async () => { slow.resolve(okInfo('v1')); });
    for (let i = 0; i < 3; i++) await advancePastItemDelay();
    expect(appliedResults()).toEqual([]);
    expect(fetchedVideoIds()).toEqual(['v1']);
    expect(rendered.result.current.status.runState).toBe('idle');
  });

  it('pauses with the reason when the backlog cannot be read or written mid-run', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1'])]);
    asMock(window.electronAPI.lookupLibraryVideos).mockRejectedValue(new Error("Error invoking remote method 'library:lookupVideos': Error: disk unplugged"));
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    expect(rendered.result.current.status).toMatchObject({ runState: 'paused', pauseKind: 'failure', pauseReason: 'The backlog run stopped: disk unplugged' });
  });

  it('retryErrors puts errors back and starts the run; dismissErrors drops them', async () => {
    const job = makeJob('job-a', ['v1', 'v2']);
    job.items[0] = makeItem('v1', { status: 'error', errorKind: 'unavailable', errorMessage: 'gone', attempts: 1 });
    job.items[1] = makeItem('v2', { status: 'error', errorKind: 'unknown', errorMessage: 'x' });
    const rendered = await renderArchive([job]);
    expect(rendered.result.current.status).toMatchObject({ counts: { pending: 0, errors: 2 }, canResume: false });

    await act(async () => { await rendered.result.current.status.retryErrors(); });
    expect(rendered.result.current.status.runState).toBe('running');
    infoBehaviour.v2 = failInfo('unavailable');
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 1, pending: 0, errors: 1 });

    await act(async () => { await rendered.result.current.status.dismissErrors(); });
    expect(rendered.result.current.status.counts).toMatchObject({ jobs: 0, pending: 0, errors: 0 });
  });

  it('refreshBacklog re-reads the backlog', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1'])]);
    await act(async () => { await window.electronAPI.clearBacklog(); });
    expect(rendered.result.current.status.counts.pending).toBe(1);
    await act(async () => { await rendered.result.current.status.refreshBacklog(); });
    expect(rendered.result.current.status.counts.pending).toBe(0);
  });
});

function scanEntry(videoId: string): ChannelScanEntry {
  return { videoId, title: `Title ${videoId}`, durationSeconds: 60, approxTimestamp: 1790000000, membersOnly: false };
}

function scanSuccess(videoIds: string[], title = 'Veritasium'): ChannelScanResult {
  return {
    success: true,
    channel: { id: 'UCHnyfMqiRRG1u-2MsSQLbXA', title, url: 'https://www.youtube.com/@veritasium/videos', avatarUrl: null },
    total: videoIds.length,
    entries: videoIds.map(scanEntry),
    truncated: false,
  };
}

async function renderWithScan(videoIds: string[], jobs: ArchiveBacklogJob[] = []) {
  const rendered = await renderArchive(jobs);
  asMock(window.electronAPI.scanChannel).mockResolvedValue(scanSuccess(videoIds));
  await act(async () => { await rendered.result.current.view.beginScan('https://www.youtube.com/@veritasium'); });
  await flushMicrotasks();
  return rendered;
}

describe('scan', () => {
  it('follows progress events, then exposes the result and removes its listener', async () => {
    const rendered = await renderArchive();
    const pending = deferred<ChannelScanResult>();
    asMock(window.electronAPI.scanChannel).mockReturnValue(pending.promise);

    act(() => { rendered.result.current.view.beginScan('https://www.youtube.com/@veritasium'); });
    const [scanId, url] = asMock(window.electronAPI.scanChannel).mock.calls[0];
    expect(url).toBe('https://www.youtube.com/@veritasium');
    expect(rendered.result.current.status.scan).toEqual({ status: 'resolving', found: 0, total: null, message: null, errorKind: null });
    expect(scanProgressListeners).toHaveLength(1);

    act(() => scanProgressListeners[0]({ scanId, stage: 'counting', found: 0, total: null }));
    expect(rendered.result.current.status.scan.status).toBe('counting');
    act(() => scanProgressListeners[0]({ scanId, stage: 'listing', found: 120, total: 450 }));
    expect(rendered.result.current.status.scan).toEqual({ status: 'listing', found: 120, total: 450, message: null, errorKind: null });
    act(() => scanProgressListeners[0]({ scanId: 'someone-else', stage: 'listing', found: 999, total: 999 }));
    expect(rendered.result.current.status.scan.found).toBe(120);

    await act(async () => { pending.resolve(scanSuccess(['v1', 'v2'])); });
    expect(rendered.result.current.status.scan).toEqual({ status: 'done', found: 2, total: 2, message: null, errorKind: null });
    expect(rendered.result.current.view).toMatchObject({ channel: { title: 'Veritasium' }, total: 2, truncated: false });
    expect(rendered.result.current.view.entries.map((e) => e.videoId)).toEqual(['v1', 'v2']);
    expect(scanProgressListeners).toHaveLength(0);
    expect(window.electronAPI.removeChannelScanProgressListener).toHaveBeenCalledTimes(1);
  });

  it('reports a failed scan with its message', async () => {
    const rendered = await renderArchive();
    asMock(window.electronAPI.scanChannel).mockResolvedValue({ success: false, kind: 'botBlock', message: 'Sign in to confirm', cancelled: false });
    await act(async () => { await rendered.result.current.view.beginScan('https://www.youtube.com/@x'); });
    expect(rendered.result.current.status.scan).toMatchObject({ status: 'error', message: 'Sign in to confirm', errorKind: 'botBlock' });
    expect(rendered.result.current.view.scanUrl).toBe('https://www.youtube.com/@x');
    expect(rendered.result.current.view.entries).toEqual([]);
    expect(scanProgressListeners).toHaveLength(0);
  });

  it('reports a rejected scan call as an error too', async () => {
    const rendered = await renderArchive();
    asMock(window.electronAPI.scanChannel).mockRejectedValue(new Error('ipc broke'));
    await act(async () => { await rendered.result.current.view.beginScan('https://www.youtube.com/@x'); });
    expect(rendered.result.current.status.scan).toMatchObject({ status: 'error', message: 'ipc broke' });
    expect(scanProgressListeners).toHaveLength(0);
  });

  it('cancelScan cancels the running scan, which then ends as cancelled', async () => {
    const rendered = await renderArchive();
    const pending = deferred<ChannelScanResult>();
    asMock(window.electronAPI.scanChannel).mockReturnValue(pending.promise);
    act(() => { rendered.result.current.view.beginScan('https://www.youtube.com/@x'); });
    const [scanId] = asMock(window.electronAPI.scanChannel).mock.calls[0];
    act(() => scanProgressListeners[0]({ scanId, stage: 'listing', found: 30, total: 450 }));

    act(() => rendered.result.current.view.cancelScan());
    expect(window.electronAPI.cancelChannelScan).toHaveBeenCalledWith(scanId);
    await act(async () => { pending.resolve({ success: false, kind: 'cancelled', message: 'Channel scan cancelled.', cancelled: true }); });
    expect(rendered.result.current.status.scan).toEqual({ status: 'cancelled', found: 30, total: 450, message: null, errorKind: null });
    expect(scanProgressListeners).toHaveLength(0);
  });

  it('ignores the result and progress of a scan that a newer one replaced', async () => {
    const rendered = await renderArchive();
    const first = deferred<ChannelScanResult>();
    const second = deferred<ChannelScanResult>();
    asMock(window.electronAPI.scanChannel).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    act(() => { rendered.result.current.view.beginScan('https://www.youtube.com/@first'); });
    const firstListener = scanProgressListeners[0];
    const [firstId] = asMock(window.electronAPI.scanChannel).mock.calls[0];
    act(() => { rendered.result.current.view.beginScan('https://www.youtube.com/@second'); });
    const [secondId] = asMock(window.electronAPI.scanChannel).mock.calls[1];
    expect(secondId).not.toBe(firstId);
    expect(window.electronAPI.cancelChannelScan).toHaveBeenCalledWith(firstId);

    act(() => firstListener({ scanId: firstId, stage: 'listing', found: 77, total: 80 }));
    expect(rendered.result.current.status.scan).toEqual({ status: 'resolving', found: 0, total: null, message: null, errorKind: null });
    await act(async () => { first.resolve(scanSuccess(['old1'], 'First')); });
    expect(rendered.result.current.view.entries).toEqual([]);
    expect(rendered.result.current.status.scan.status).toBe('resolving');

    await act(async () => { second.resolve(scanSuccess(['new1'], 'Second')); });
    expect(rendered.result.current.view.channel?.title).toBe('Second');
    expect(rendered.result.current.view.entries.map((e) => e.videoId)).toEqual(['new1']);
    expect(scanProgressListeners).toHaveLength(0);
  });

  it('resetScan clears the result and the queue', async () => {
    const rendered = await renderWithScan(['v1', 'v2']);
    act(() => rendered.result.current.view.addToQueue(['v1']));
    act(() => rendered.result.current.view.resetScan());
    expect(rendered.result.current.view).toMatchObject({ channel: null, entries: [], queueIds: [] });
    expect(rendered.result.current.status.scan.status).toBe('idle');
  });
});

describe('view store', () => {
  it('starts with the form defaults and the active sublibrary as the target', async () => {
    const rendered = await renderArchive();
    expect(rendered.result.current.view).toMatchObject({ download: false, targetResolution: '720', targetLibraryTag: 'DefaultLibrary', batchSize: 20, queueIds: [] });
  });

  it('keeps the queue ordered and free of duplicates', async () => {
    const rendered = await renderWithScan(['v1', 'v2', 'v3']);
    act(() => rendered.result.current.view.addToQueue(['v2', 'v1']));
    act(() => rendered.result.current.view.addToQueue(['v1', 'v3', 'v3']));
    expect(rendered.result.current.view.queueIds).toEqual(['v2', 'v1', 'v3']);
    act(() => rendered.result.current.view.removeFromQueue(['v1', 'nope']));
    expect(rendered.result.current.view.queueIds).toEqual(['v2', 'v3']);
  });

  it('marks scanned videos already in the target sublibrary, and looks again when the target changes', async () => {
    libraryLookup = { v2: { videoDir: '/library/c/v2', latestEpoch: '1', hasVideoFile: false, hasAudioFile: false } };
    const rendered = await renderWithScan(['v1', 'v2', 'constructor']);
    expect(window.electronAPI.lookupLibraryVideos).toHaveBeenLastCalledWith(['v1', 'v2', 'constructor'], 'DefaultLibrary');
    expect([...rendered.result.current.view.inLibraryIds]).toEqual(['v2']);

    libraryLookup = { v1: { videoDir: '/library/m/v1', latestEpoch: '1', hasVideoFile: true, hasAudioFile: false } };
    act(() => rendered.result.current.view.setTargetLibraryTag('Music'));
    // The previous sublibrary's answer is not shown for the new one.
    expect([...rendered.result.current.view.inLibraryIds]).toEqual([]);
    await flushMicrotasks();
    expect(window.electronAPI.lookupLibraryVideos).toHaveBeenLastCalledWith(['v1', 'v2', 'constructor'], 'Music');
    expect([...rendered.result.current.view.inLibraryIds]).toEqual(['v1']);
  });

  it('submit sends the queued videos with the form options, then clears the queue, opens the panel and starts the run', async () => {
    const rendered = await renderWithScan(['v1', 'v2', 'v3']);
    act(() => {
      rendered.result.current.view.addToQueue(['v3', 'v1']);
      rendered.result.current.view.setDownload(true);
      rendered.result.current.view.setTargetResolution('1080');
      rendered.result.current.view.setTargetLibraryTag('Music');
      rendered.result.current.view.setBatchSize(10);
    });

    let submitted: Awaited<ReturnType<typeof rendered.result.current.view.submit>> = null;
    await act(async () => { submitted = await rendered.result.current.view.submit(); });
    await flushMicrotasks();

    expect(window.electronAPI.addBacklogJob).toHaveBeenCalledWith({
      mode: 'append',
      job: {
        channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
        channelTitle: 'Veritasium',
        channelUrl: 'https://www.youtube.com/@veritasium/videos',
        options: { download: true, targetResolution: '1080', targetLibraryTag: 'Music', batchSize: 10 },
        items: [
          { videoId: 'v3', title: 'Title v3', approxTimestamp: 1790000000 },
          { videoId: 'v1', title: 'Title v1', approxTimestamp: 1790000000 },
        ],
      },
    });
    expect(submitted).toMatchObject({ success: true, added: 2 });
    expect(rendered.result.current.view.queueIds).toEqual([]);
    expect(rendered.result.current.queue.panelOpen).toBe(true);
    expect(rendered.result.current.status).toMatchObject({ runState: 'running', counts: { jobs: 1, pending: 2 } });
    expect(queueSnapshot(rendered)).toEqual(['v3:downloading', 'v1:pending']);
    expect(window.electronAPI.lookupLibraryVideos).toHaveBeenCalledWith(['v3', 'v1'], 'Music');
  });

  it('refreshes the in-library marks when a run ends, since its videos are in the library by then', async () => {
    const rendered = await renderWithScan(['v1', 'v2']);
    expect([...rendered.result.current.view.inLibraryIds]).toEqual([]);
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.v1 = slow.promise;
    act(() => rendered.result.current.view.addToQueue(['v1']));
    await act(async () => { await rendered.result.current.view.submit(); });
    expect(rendered.result.current.status.runState).toBe('running');
    libraryLookup = { v1: { videoDir: '/library/c/v1', latestEpoch: '1', hasVideoFile: false, hasAudioFile: false } };
    await act(async () => { slow.resolve(okInfo('v1')); });
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    await flushMicrotasks();
    expect([...rendered.result.current.view.inLibraryIds]).toEqual(['v1']);
  });

  it('submit returns a refusal as it is and leaves the queue and the run alone', async () => {
    const rendered = await renderWithScan(['v1', 'v2'], [makeJob('job-old', ['o1'])]);
    rendered.backlog.refuseAddJob('libraryDirMismatch');
    act(() => rendered.result.current.view.addToQueue(['v1']));

    let submitted: Awaited<ReturnType<typeof rendered.result.current.view.submit>> = null;
    await act(async () => { submitted = await rendered.result.current.view.submit('append'); });
    await flushMicrotasks();

    expect(submitted).toMatchObject({ success: false, reason: 'libraryDirMismatch' });
    expect(rendered.result.current.view.queueIds).toEqual(['v1']);
    expect(rendered.result.current.status.runState).toBe('idle');
    expect(rendered.result.current.queue.items).toHaveLength(0);
  });

  it('submit("replace") drops a run in progress and starts over with the new job', async () => {
    const slow = deferred<VideoInfoResult>();
    infoBehaviour.o1 = slow.promise;
    const rendered = await renderWithScan(['v1', 'v2'], [makeJob('job-old', ['o1', 'o2'])]);
    act(() => rendered.result.current.status.resumeBacklog());
    await flushMicrotasks();
    expect(queueSnapshot(rendered)).toEqual(['o1:fetching', 'o2:pending']);

    act(() => rendered.result.current.view.addToQueue(['v1']));
    await act(async () => { await rendered.result.current.view.submit('replace'); });
    await flushMicrotasks();

    expect(asMock(window.electronAPI.addBacklogJob).mock.calls[0][0].mode).toBe('replace');
    expect(rendered.result.current.status).toMatchObject({ runState: 'running', counts: { jobs: 1, pending: 1 } });
    expect(rendered.result.current.status.backlogState?.backlog.jobs.map((j) => j.items.map((i) => i.videoId))).toEqual([['v1']]);
    // o2 was pulled back; o1 is still occupying the one slot.
    expect(queueSnapshot(rendered)).toEqual(['o1:fetching', 'v1:pending']);

    await act(async () => { slow.resolve(okInfo('o1')); });
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(appliedResults().map(([jobId]) => jobId)).toEqual(['job-1']);
  });

  it('submit does nothing without a scan or with an empty queue', async () => {
    const rendered = await renderArchive();
    let submitted: unknown = 'unset';
    await act(async () => { submitted = await rendered.result.current.view.submit(); });
    expect(submitted).toBeNull();
    expect(window.electronAPI.addBacklogJob).not.toHaveBeenCalled();
  });
});

describe('context identity', () => {
  it('the status value keeps its identity when only view-store state changes', async () => {
    const rendered = await renderWithScan(['v1', 'v2']);
    const statusBefore = rendered.result.current.status;
    const viewBefore = rendered.result.current.view;

    act(() => rendered.result.current.view.addToQueue(['v1']));
    act(() => rendered.result.current.view.setBatchSize(50));
    act(() => rendered.result.current.view.setDownload(true));
    act(() => rendered.result.current.view.setTargetLibraryTag('Music'));
    await flushMicrotasks();

    expect(rendered.result.current.view).not.toBe(viewBefore);
    expect(rendered.result.current.view.queueIds).toEqual(['v1']);
    expect(rendered.result.current.status).toBe(statusBefore);
  });

  it('the view value keeps its identity when only run status changes', async () => {
    const rendered = await renderArchive([makeJob('job-a', ['v1'])]);
    const viewBefore = rendered.result.current.view;
    act(() => rendered.result.current.status.resumeBacklog());
    await runUntil(() => rendered.result.current.status.runState === 'idle');
    expect(rendered.result.current.view).toBe(viewBefore);
  });
});
