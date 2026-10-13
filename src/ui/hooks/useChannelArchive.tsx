import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBulkAddActions, type BulkAddEntry, type BulkAddStatus, type BulkAddTransition } from './useBulkAddQueue.tsx';
import { useLibraryTags } from './useLibraryTags.tsx';
import { cleanElectronErrorMessage } from '../../utils/utils.ts';
import type {
  ArchiveBacklogAddJobResult,
  ArchiveBacklogCounts,
  ArchiveBacklogItem,
  ArchiveBacklogJob,
  ArchiveBacklogQuality,
  ArchiveBacklogState,
  BacklogBatchResult,
  ChannelScanChannel,
  ChannelScanEntry,
  ChannelScanResult,
  LibraryVideoLookup,
} from '../../types/electron-api';

// An item that keeps hitting a "wait and try again" failure becomes an error
// on this attempt, so one stubborn video cannot hold the backlog up forever.
export const MAX_PENDING_ATTEMPTS = 3;
// A wave of blocks often surfaces as unrelated-looking failures rather than
// a clean bot-check error, so any run of failures this long pauses the run.
export const MAX_CONSECUTIVE_FAILURES = 3;
const TAG_PREFIX = 'channel-archive:';

export type ArchivePauseKind =
  | 'botBlock' | 'rateLimit' | 'network' | 'chunkTransferFailure' | 'stalled' | 'outOfDiskSpace' | 'missingDependency'
  | 'cancelled' | 'consecutiveFailures' | 'manual' | 'queueStopped' | 'failure';

export type ArchiveOutcome = {
  outcome: 'done' | 'pending' | 'error';
  pause: boolean;
  // False when the video was never actually tried (cancelled or removed
  // while still waiting): nothing is recorded against it.
  attempted: boolean;
  errorKind?: string;
  errorMessage?: string;
};

type OutcomeInput = {
  status: BulkAddStatus | 'removed';
  previousStatus: BulkAddStatus;
  errorKind?: string;
  error?: string;
};

function failedOutcome(errorKind: string | undefined, error: string | undefined): ArchiveOutcome {
  switch (errorKind) {
    case 'botBlock':
    case 'rateLimit':
    case 'network':
    case 'chunkTransferFailure':
    case 'stalled':
    case 'outOfDiskSpace':
    case 'missingDependency':
      return { outcome: 'pending', pause: true, attempted: true, errorKind, errorMessage: error || '' };
    default:
      // ageRestricted, loginRequired, geoBlocked, unavailable, unknown, and
      // any kind this list has not caught up with: a fact about the video,
      // which waiting will not change.
      return { outcome: 'error', pause: false, attempted: true, errorKind: errorKind || 'unknown', errorMessage: error || '' };
  }
}

// What one queue item's final state means for its backlog entry. Statuses
// that are not final (pending, fetching, downloading) map to "still pending,
// nothing recorded" so the switch stays total.
export function mapOutcome({ status, previousStatus, errorKind, error }: OutcomeInput): ArchiveOutcome {
  switch (status) {
    case 'done':
    case 'skipped':
      return { outcome: 'done', pause: false, attempted: true };
    case 'failed':
      return failedOutcome(errorKind, error);
    case 'cancelled':
    case 'removed':
      // Stopped by the user mid-download: recorded, so it is not silently
      // retried, but never a reason to hold everything else up.
      if (previousStatus === 'fetching' || previousStatus === 'downloading') {
        return { outcome: 'error', pause: false, attempted: true, errorKind: 'cancelled', errorMessage: 'Cancelled.' };
      }
      // Given up on before it ever ran ("Cancel all pending", or removed
      // from the list): the user wants the run to stop, not these videos
      // marked as failed.
      return { outcome: 'pending', pause: true, attempted: false, errorKind: 'cancelled' };
    case 'pending':
    case 'fetching':
    case 'downloading':
      return { outcome: 'pending', pause: false, attempted: false };
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

// The backlog write for one item, or null when there is nothing to record.
export function toBacklogResult(item: ArchiveBacklogItem, decision: ArchiveOutcome): BacklogBatchResult | null {
  if (decision.outcome === 'done') return { videoId: item.videoId, outcome: 'done' };
  if (decision.outcome === 'error') {
    return { videoId: item.videoId, outcome: 'error', errorKind: decision.errorKind || 'unknown', errorMessage: decision.errorMessage || '' };
  }
  if (!decision.attempted) return null;
  if (item.attempts + 1 >= MAX_PENDING_ATTEMPTS) {
    return { videoId: item.videoId, outcome: 'error', errorKind: decision.errorKind || 'unknown', errorMessage: decision.errorMessage || '' };
  }
  return { videoId: item.videoId, outcome: 'pending' };
}

export function watchUrlFor(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function pickBatchItems(job: ArchiveBacklogJob): ArchiveBacklogItem[] {
  return job.items.filter((item) => item.status === 'pending').slice(0, job.options.batchSize);
}

// A plain property read on the lookup would also "find" inherited names
// such as "constructor", which is a syntactically valid video id.
function lookupEntry(lookup: LibraryVideoLookup, videoId: string) {
  return Object.prototype.hasOwnProperty.call(lookup, videoId) ? lookup[videoId] : null;
}

export type ArchiveBatchPlan = {
  // Video ids that need nothing done.
  satisfied: string[];
  entries: BulkAddEntry[];
};

// Splits one batch three ways: videos the target sublibrary already has
// everything for (done, nothing submitted), videos that are in the library
// but still need their file (straight to download, the same entry shape as
// LibraryScreen's "Download selected"), and the rest (normal fetch-and-add).
export function planBatch(job: ArchiveBacklogJob, batchItems: ArchiveBacklogItem[], lookup: LibraryVideoLookup, tag: string): ArchiveBatchPlan {
  const { download, targetResolution } = job.options;
  const isMp3 = targetResolution === 'MP3';
  const satisfied: string[] = [];
  const entries: BulkAddEntry[] = [];
  for (const item of batchItems) {
    const found = lookupEntry(lookup, item.videoId);
    const url = watchUrlFor(item.videoId);
    const title = item.title || null;
    if (!found) {
      entries.push({ id: item.videoId, title, url, videoId: item.videoId, tag });
    } else if (!download || (isMp3 ? found.hasAudioFile : found.hasVideoFile) || !found.latestEpoch) {
      // No latestEpoch means there is no version folder to download into;
      // the video is in the library, which is all a re-add would find too.
      satisfied.push(item.videoId);
    } else {
      entries.push({
        id: found.videoDir,
        title,
        url,
        videoId: item.videoId,
        videoDir: found.videoDir,
        epoch: found.latestEpoch,
        resolution: isMp3 ? 'mp3' : targetResolution,
        kind: isMp3 ? 'audio' : 'video',
        tag,
      });
    }
  }
  return { satisfied, entries };
}

export function describePauseReason(kind: ArchivePauseKind, detail?: string): string {
  switch (kind) {
    case 'botBlock':
      return 'YouTube asked to confirm you are not a bot. Add cookies in Options or wait a while, then resume.';
    case 'rateLimit':
      return 'YouTube is limiting requests right now. Wait a while, or add cookies in Options, then resume.';
    case 'network':
    case 'chunkTransferFailure':
    case 'stalled':
      return 'The connection dropped. Check your internet connection, then resume.';
    case 'outOfDiskSpace':
      return 'The disk is full. Free up some space, then resume.';
    case 'missingDependency':
      return 'yt-dlp could not be started. Restart the app, then resume.';
    case 'cancelled':
      return 'Paused because you cancelled videos that were waiting. They are still in the backlog.';
    case 'consecutiveFailures':
      return 'Several videos failed in a row, so the run was paused. Check the errors, then resume.';
    case 'manual':
      return 'Paused by you.';
    case 'queueStopped':
      return 'Paused because the bulk-add queue was stopped.';
    case 'failure':
      return detail ? `The backlog run stopped: ${detail}` : 'The backlog run stopped unexpectedly.';
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

// Why the pending videos cannot be run right now, or null when they can.
// activeLibraryTag counts as an existing sublibrary even when it is not in
// the list: the default one has no folder until its first video is written.
export function getResumeBlockedReason(state: ArchiveBacklogState, libraryTagFolders: string[], activeLibraryTag: string): string | null {
  if (state.counts.pending === 0) return null;
  if (!state.libraryDirMatches) {
    return `This backlog was queued for a different library folder (${state.backlog.libraryDir}). Switch back to that folder to resume, or remove the backlog.`;
  }
  if (!activeLibraryTag) return 'Your sublibraries are still loading.';
  const known = new Set([...libraryTagFolders, activeLibraryTag]);
  const missing = state.backlog.jobs
    .filter((job) => job.items.some((item) => item.status === 'pending'))
    .map((job) => job.options.targetLibraryTag)
    .find((tag) => !known.has(tag));
  return missing ? `The sublibrary "${missing}" no longer exists. Remove the backlog to continue.` : null;
}

const PAUSE_KINDS_FROM_ERRORS: ReadonlySet<string> = new Set(['botBlock', 'rateLimit', 'network', 'chunkTransferFailure', 'stalled', 'outOfDiskSpace', 'missingDependency', 'cancelled']);

function isPauseKind(kind: string | undefined): kind is ArchivePauseKind {
  return !!kind && PAUSE_KINDS_FROM_ERRORS.has(kind);
}

function isFinalStatus(status: BulkAddStatus | 'removed') {
  return status === 'done' || status === 'skipped' || status === 'failed' || status === 'cancelled' || status === 'removed';
}

function stateOf(result: ArchiveBacklogState): ArchiveBacklogState {
  return { backlog: result.backlog, counts: result.counts, libraryDir: result.libraryDir, libraryDirMatches: result.libraryDirMatches };
}

export type ChannelScanStatus = {
  status: 'idle' | 'resolving' | 'counting' | 'listing' | 'done' | 'error' | 'cancelled';
  found: number;
  total: number | null;
  message: string | null;
  // The classified kind behind `message` when status is 'error'.
  errorKind: string | null;
};

export type ChannelArchiveRunState = 'idle' | 'running' | 'paused';

export type ChannelArchiveStatus = {
  // null until the first getBacklog() answers.
  backlogState: ArchiveBacklogState | null;
  counts: ArchiveBacklogCounts;
  // Like counts, but also counting the videos the batch in flight has
  // already finished: the backlog itself is only updated once per batch,
  // which would leave a progress display standing still for a whole batch.
  progress: { done: number; total: number; pending: number };
  runState: ChannelArchiveRunState;
  // pauseBacklog() was called and the run is finishing its current batch.
  pauseRequested: boolean;
  pauseReason: string | null;
  pauseKind: ArchivePauseKind | null;
  canResume: boolean;
  resumeBlockedReason: string | null;
  scan: ChannelScanStatus;
  resumeBacklog: () => void;
  pauseBacklog: () => void;
  removeBacklog: () => Promise<void>;
  retryErrors: () => Promise<void>;
  dismissErrors: () => Promise<void>;
  refreshBacklog: () => Promise<void>;
};

export type ChannelArchiveView = {
  channel: ChannelScanChannel | null;
  entries: ChannelScanEntry[];
  total: number | null;
  truncated: boolean;
  // The link the current (or last) scan was started with, for "Try again".
  scanUrl: string | null;
  beginScan: (url: string) => Promise<void>;
  cancelScan: () => void;
  resetScan: () => void;
  // Video ids chosen to be added, in the order they were chosen.
  queueIds: string[];
  addToQueue: (videoIds: string[]) => void;
  removeFromQueue: (videoIds: string[]) => void;
  download: boolean;
  setDownload: (download: boolean) => void;
  targetResolution: ArchiveBacklogQuality;
  setTargetResolution: (targetResolution: ArchiveBacklogQuality) => void;
  // The active sublibrary until the user picks another one.
  targetLibraryTag: string;
  setTargetLibraryTag: (targetLibraryTag: string) => void;
  batchSize: number;
  setBatchSize: (batchSize: number) => void;
  // Scanned videos already present in the target sublibrary.
  inLibraryIds: ReadonlySet<string>;
  // null when there is nothing to submit (no scan, or an empty queue).
  submit: (mode?: 'append' | 'replace') => Promise<ArchiveBacklogAddJobResult | null>;
};

const EMPTY_COUNTS: ArchiveBacklogCounts = { jobs: 0, pending: 0, errors: 0, total: 0, done: 0 };
const IDLE_SCAN: ChannelScanStatus = { status: 'idle', found: 0, total: null, message: null, errorKind: null };
const NO_IDS: ReadonlySet<string> = new Set();
const NO_ENTRIES: ChannelScanEntry[] = [];
const noop = () => {};
const asyncNoop = async () => {};

// What useChannelArchiveStatus() returns with no provider above it: several
// test wrappers render the side panel on its own, and "no backlog, nothing
// running" is the right thing for it to show there.
const INERT_STATUS: ChannelArchiveStatus = {
  backlogState: null,
  counts: EMPTY_COUNTS,
  progress: { done: 0, total: 0, pending: 0 },
  runState: 'idle',
  pauseRequested: false,
  pauseReason: null,
  pauseKind: null,
  canResume: false,
  resumeBlockedReason: null,
  scan: IDLE_SCAN,
  resumeBacklog: noop,
  pauseBacklog: noop,
  removeBacklog: asyncNoop,
  retryErrors: asyncNoop,
  dismissErrors: asyncNoop,
  refreshBacklog: asyncNoop,
};

type RunStatus = { runState: ChannelArchiveRunState; pauseKind: ArchivePauseKind | null; pauseReason: string | null };
const IDLE_RUN: RunStatus = { runState: 'idle', pauseKind: null, pauseReason: null };

type ScanData = { channel: ChannelScanChannel; entries: ChannelScanEntry[]; total: number | null; truncated: boolean };

type BatchRecord = { status: BulkAddStatus | 'removed'; previousStatus: BulkAddStatus; errorKind?: string; error?: string; gone: boolean };
type BatchOutcome = { records: Map<string, BatchRecord>; pauseKind: ArchivePauseKind | null; aborted: boolean };

function notifyRunFinished(errors: number) {
  try {
    new Notification('Channel archive finished', {
      body: errors > 0
        ? `The backlog is done -- ${errors} ${errors === 1 ? 'video' : 'videos'} could not be added.`
        : 'The backlog is empty -- every queued video was processed.',
    });
  } catch {
    // Notification permission/support varies by platform -- never let this
    // affect the run itself.
  }
}

function useChannelArchiveState() {
  const actions = useBulkAddActions();
  const { libraryTags, activeLibraryTag } = useLibraryTags();

  const [backlogState, setBacklogStateRaw] = useState<ArchiveBacklogState | null>(null);
  const [run, setRun] = useState<RunStatus>(IDLE_RUN);
  const [scan, setScan] = useState<ChannelScanStatus>(IDLE_SCAN);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [batchDoneCount, setBatchDoneCount] = useState(0);

  const [scanData, setScanData] = useState<ScanData | null>(null);
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [download, setDownload] = useState(false);
  const [targetResolution, setTargetResolution] = useState<ArchiveBacklogQuality>('720');
  const [chosenLibraryTag, setTargetLibraryTag] = useState<string | null>(null);
  const [batchSize, setBatchSize] = useState(20);
  const [inLibrary, setInLibrary] = useState<{ key: ScanData | null; tag: string; ids: ReadonlySet<string> }>({ key: null, tag: '', ids: NO_IDS });

  const targetLibraryTag = chosenLibraryTag ?? activeLibraryTag;

  // The run loop is a plain async function that outlives any one render, so
  // everything it reads between awaits comes from refs, not from state.
  const backlogRef = useRef<ArchiveBacklogState | null>(null);
  const loopPromiseRef = useRef<Promise<void> | null>(null);
  const manualPauseRef = useRef(false);
  const abortRef = useRef(false);
  const batchNumberRef = useRef(0);
  const currentBatchRef = useRef<{ tag: string; abort: () => void } | null>(null);
  const activeScanIdRef = useRef<string | null>(null);

  const setBacklogState = (next: ArchiveBacklogState) => {
    backlogRef.current = next;
    setBacklogStateRaw(next);
  };

  // Submits one batch and resolves once every item in it is finished or
  // gone at the same moment. Latest status wins, so a failed item the user
  // retries from the panel holds the batch open again until it settles.
  const runBatch = (tag: string, entries: BulkAddEntry[], job: ArchiveBacklogJob, failureStreak: { count: number }) => new Promise<BatchOutcome>((resolve) => {
    const records = new Map<string, BatchRecord>(entries.map((entry) => [entry.url, { status: 'pending', previousStatus: 'pending', gone: false }]));
    let pauseKind: ArchivePauseKind | null = null;
    let finished = false;

    const finish = (aborted: boolean) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      currentBatchRef.current = null;
      resolve({ records, pauseKind, aborted });
    };

    const triggerPause = (kind: ArchivePauseKind) => {
      if (pauseKind) return;
      pauseKind = kind;
      // Pulls back the batch's videos that have not started; whatever is
      // mid-download is left to finish. Deferred because this runs inside
      // the queue's own delivery of the transition that caused it.
      queueMicrotask(() => {
        if (!finished) actions.removeByTag(tag, { keepDone: true });
      });
    };

    const onTransition = (transition: BulkAddTransition) => {
      if (transition.tag !== tag) return;
      const record = records.get(transition.sourceUrl);
      if (!record || finished) return;
      // An item that already finished and is only now being swept out of
      // the list has had its say; counting it again would double a failure.
      const alreadyCounted = transition.status === 'removed' && isFinalStatus(record.status);
      if (transition.status === 'removed') {
        if (!isFinalStatus(record.status)) {
          record.status = isFinalStatus(transition.previousStatus) ? transition.previousStatus : 'removed';
          record.previousStatus = transition.previousStatus;
          record.errorKind = transition.errorKind;
          record.error = transition.error;
        }
        record.gone = true;
      } else {
        record.status = transition.status;
        record.previousStatus = transition.previousStatus;
        record.errorKind = transition.errorKind;
        record.error = transition.error;
      }

      if (!alreadyCounted && isFinalStatus(record.status)) {
        if (record.status === 'failed') failureStreak.count++;
        else if (record.status === 'done' || record.status === 'skipped') failureStreak.count = 0;
        const decision = mapOutcome(record);
        if (decision.pause && isPauseKind(decision.errorKind)) triggerPause(decision.errorKind);
        else if (failureStreak.count >= MAX_CONSECUTIVE_FAILURES) triggerPause('consecutiveFailures');
      }

      setBatchDoneCount([...records.values()].filter((r) => r.status === 'done' || r.status === 'skipped').length);
      if ([...records.values()].every((r) => r.gone || isFinalStatus(r.status))) finish(false);
    };

    const unsubscribe = actions.subscribeTransitions(onTransition);
    currentBatchRef.current = { tag, abort: () => finish(true) };
    const { download: jobDownload, targetResolution: jobResolution, targetLibraryTag: jobTag } = job.options;
    actions.start(entries, { download: jobDownload, targetResolution: jobResolution, targetLibraryTag: jobTag }, { openPanel: false });
  });

  const runLoop = async () => {
    manualPauseRef.current = false;
    abortRef.current = false;
    const failureStreak = { count: 0 };
    let pause: { kind: ArchivePauseKind; detail?: string } | null = null;
    setRun({ runState: 'running', pauseKind: null, pauseReason: null });
    // One notification for the whole run (below) instead of the queue's own
    // "Bulk add finished" after every batch.
    actions.setQueueEmptyNotificationSuppressed(true);
    // Every way into this function is the user asking for the run to go
    // (Resume, Retry errors, Add): that outranks an earlier Stop on the
    // queue, which the check inside the loop would otherwise pause on again.
    if (actions.isStopRequested()) actions.resume();
    try {
      while (!pause && !abortRef.current) {
        if (manualPauseRef.current) {
          pause = { kind: 'manual' };
          break;
        }
        const job = backlogRef.current?.backlog.jobs.find((j) => j.items.some((item) => item.status === 'pending'));
        if (!job) break;
        // start() would clear the user's own Stop on the queue.
        if (actions.isStopRequested()) {
          pause = { kind: 'queueStopped' };
          break;
        }

        const batchItems = pickBatchItems(job);
        const lookup = await window.electronAPI.lookupLibraryVideos(batchItems.map((item) => item.videoId), job.options.targetLibraryTag);
        if (abortRef.current) break;

        const tag = `${TAG_PREFIX}${job.id}:${++batchNumberRef.current}`;
        const { satisfied, entries } = planBatch(job, batchItems, lookup, tag);
        const results: BacklogBatchResult[] = satisfied.map((videoId) => ({ videoId, outcome: 'done' }));

        let batchPauseKind: ArchivePauseKind | null = null;
        if (entries.length > 0) {
          const outcome = await runBatch(tag, entries, job, failureStreak);
          if (outcome.aborted) break;
          batchPauseKind = outcome.pauseKind;
          for (const item of batchItems) {
            const record = outcome.records.get(watchUrlFor(item.videoId));
            const result = record ? toBacklogResult(item, mapOutcome(record)) : null;
            if (result) results.push(result);
          }
        }

        if (results.length > 0) {
          const applied = await window.electronAPI.applyBacklogResults(job.id, results);
          setBacklogState(stateOf(applied));
          setBatchDoneCount(0);
          if (!applied.success) {
            pause = { kind: 'failure', detail: applied.message };
          }
        }
        // Done items stay in the panel as the record of what was added.
        // Failed and cancelled ones go: they are in the backlog's own error
        // list now, and a Retry from the panel would bypass the backlog.
        actions.removeByTag(tag, { keepDone: true });
        if (batchPauseKind) pause = { kind: batchPauseKind };
        // Nothing recorded and no reason to pause would mean the same batch
        // again, forever.
        else if (results.length === 0 && !pause) pause = { kind: 'failure' };
      }
    } catch (err) {
      pause = { kind: 'failure', detail: err instanceof Error ? cleanElectronErrorMessage(err.message) : String(err) };
    }

    actions.setQueueEmptyNotificationSuppressed(false);
    setPauseRequested(false);
    setBatchDoneCount(0);
    if (abortRef.current) {
      setRun(IDLE_RUN);
    } else if (pause) {
      setRun({ runState: 'paused', pauseKind: pause.kind, pauseReason: describePauseReason(pause.kind, pause.detail) });
    } else {
      setRun(IDLE_RUN);
      notifyRunFinished(backlogRef.current?.counts.errors ?? 0);
    }
  };

  // The ref is the guard against two loops (a double click on Resume, or
  // Resume racing a submit): the second call finds the first still there.
  const startRun = () => {
    if (loopPromiseRef.current) return;
    const state = backlogRef.current;
    if (!state || state.counts.pending === 0 || getResumeBlockedReason(state, libraryTags.map((tag) => tag.folderName), activeLibraryTag)) return;
    // Cleared in a continuation rather than at the end of runLoop: a loop
    // that ends without ever awaiting would otherwise clear the ref before
    // this assignment sets it, and leave it set for good.
    const loop: Promise<void> = runLoop().finally(() => {
      if (loopPromiseRef.current === loop) loopPromiseRef.current = null;
    });
    loopPromiseRef.current = loop;
  };

  const stopRun = async () => {
    const running = loopPromiseRef.current;
    abortRef.current = true;
    const batch = currentBatchRef.current;
    if (batch) {
      batch.abort();
      actions.removeByTag(batch.tag, { keepDone: true });
    }
    if (running) await running;
    setRun(IDLE_RUN);
  };

  const refreshBacklog = async () => {
    setBacklogState(stateOf(await window.electronAPI.getBacklog()));
  };

  useEffect(() => {
    // Loads what a previous session left behind. Deliberately does not start
    // the run: resuming is always the user's call.
    refreshBacklog().catch(noop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resumeBacklog = () => {
    // The run can be alive but stuck behind the user's own Stop on the
    // queue, with this run's videos still waiting in it.
    if (loopPromiseRef.current && actions.isStopRequested()) actions.resume();
    startRun();
  };

  const pauseBacklog = () => {
    if (!loopPromiseRef.current) return;
    manualPauseRef.current = true;
    setPauseRequested(true);
  };

  const removeBacklog = async () => {
    await stopRun();
    setBacklogState(stateOf(await window.electronAPI.clearBacklog()));
  };

  const retryErrors = async () => {
    setBacklogState(stateOf(await window.electronAPI.retryBacklogErrors()));
    startRun();
  };

  const dismissErrors = async () => {
    setBacklogState(stateOf(await window.electronAPI.dismissBacklogErrors()));
  };

  const finishScan = (scanId: string, result: ChannelScanResult) => {
    if (activeScanIdRef.current !== scanId) return;
    activeScanIdRef.current = null;
    if (result.success) {
      setScanData({ channel: result.channel, entries: result.entries, total: result.total, truncated: result.truncated });
      setScan({ status: 'done', found: result.entries.length, total: result.total, message: null, errorKind: null });
    } else {
      setScan((previous) => ({
        status: result.cancelled ? 'cancelled' : 'error',
        found: previous.found,
        total: previous.total,
        message: result.cancelled ? null : result.message,
        errorKind: result.cancelled ? null : result.kind,
      }));
    }
  };

  const beginScan = async (url: string) => {
    const superseded = activeScanIdRef.current;
    if (superseded) window.electronAPI.cancelChannelScan(superseded).catch(noop);
    const scanId = crypto.randomUUID();
    activeScanIdRef.current = scanId;
    setScanData(null);
    setQueueIds([]);
    setScanUrl(url);
    setScan({ status: 'resolving', found: 0, total: null, message: null, errorKind: null });
    const listener = window.electronAPI.onChannelScanProgress((progress) => {
      if (progress.scanId !== scanId || activeScanIdRef.current !== scanId) return;
      setScan({ status: progress.stage, found: progress.found, total: progress.total, message: null, errorKind: null });
    });
    try {
      finishScan(scanId, await window.electronAPI.scanChannel(scanId, url));
    } catch (err) {
      finishScan(scanId, { success: false, kind: 'unknown', message: err instanceof Error ? cleanElectronErrorMessage(err.message) : String(err), cancelled: false });
    } finally {
      window.electronAPI.removeChannelScanProgressListener(listener);
    }
  };

  const cancelScan = () => {
    const scanId = activeScanIdRef.current;
    if (scanId) window.electronAPI.cancelChannelScan(scanId).catch(noop);
  };

  const resetScan = () => {
    cancelScan();
    activeScanIdRef.current = null;
    setScanData(null);
    setScanUrl(null);
    setQueueIds([]);
    setScan(IDLE_SCAN);
  };

  const addToQueue = (videoIds: string[]) => {
    setQueueIds((previous) => {
      const added = [...new Set(videoIds)].filter((id) => !previous.includes(id));
      return added.length > 0 ? [...previous, ...added] : previous;
    });
  };

  const removeFromQueue = (videoIds: string[]) => {
    const removed = new Set(videoIds);
    setQueueIds((previous) => previous.filter((id) => !removed.has(id)));
  };

  const submit = async (mode: 'append' | 'replace' = 'append') => {
    if (!scanData || queueIds.length === 0) return null;
    const entriesById = new Map(scanData.entries.map((entry) => [entry.videoId, entry]));
    const items = queueIds.flatMap((videoId) => {
      const entry = entriesById.get(videoId);
      return entry ? [{ videoId, title: entry.title, approxTimestamp: entry.approxTimestamp }] : [];
    });
    // Replacing throws the current backlog away, including the batch a
    // running loop is in the middle of.
    if (mode === 'replace') await stopRun();
    const result = await window.electronAPI.addBacklogJob({
      job: {
        channelId: scanData.channel.id,
        channelTitle: scanData.channel.title,
        channelUrl: scanData.channel.url,
        options: { download, targetResolution, targetLibraryTag, batchSize },
        items,
      },
      mode,
    });
    setBacklogState(stateOf(result));
    if (result.success) {
      setQueueIds([]);
      actions.setPanelOpen(true);
      startRun();
    }
    return result;
  };

  useEffect(() => {
    if (!scanData || !targetLibraryTag) return;
    let stale = false;
    window.electronAPI.lookupLibraryVideos(scanData.entries.map((entry) => entry.videoId), targetLibraryTag)
      .then((lookup) => {
        if (!stale) setInLibrary({ key: scanData, tag: targetLibraryTag, ids: new Set(Object.keys(lookup)) });
      })
      .catch(noop);
    return () => { stale = true; };
    // run.runState is here so the marks are refreshed when a run starts,
    // pauses or ends: videos it just added are in the library now.
  }, [scanData, targetLibraryTag, run.runState]);
  // A lookup that was for another scan or another sublibrary says nothing
  // about this one.
  const inLibraryIds = inLibrary.key === scanData && inLibrary.tag === targetLibraryTag ? inLibrary.ids : NO_IDS;

  const resumeBlockedReason = backlogState ? getResumeBlockedReason(backlogState, libraryTags.map((tag) => tag.folderName), activeLibraryTag) : null;
  const canResume = !!backlogState && backlogState.counts.pending > 0 && run.runState !== 'running' && !resumeBlockedReason;

  // Both context values are built from functions that are recreated every
  // render, so each exposes one fixed set of forwarders instead: the status
  // value then only changes when status data does, and never because the
  // screen's own view state changed.
  const latest = { resumeBacklog, pauseBacklog, removeBacklog, retryErrors, dismissErrors, refreshBacklog, beginScan, cancelScan, resetScan, addToQueue, removeFromQueue, submit };
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const [stable] = useState(() => ({
    resumeBacklog: () => latestRef.current.resumeBacklog(),
    pauseBacklog: () => latestRef.current.pauseBacklog(),
    removeBacklog: () => latestRef.current.removeBacklog(),
    retryErrors: () => latestRef.current.retryErrors(),
    dismissErrors: () => latestRef.current.dismissErrors(),
    refreshBacklog: () => latestRef.current.refreshBacklog(),
    beginScan: (url: string) => latestRef.current.beginScan(url),
    cancelScan: () => latestRef.current.cancelScan(),
    resetScan: () => latestRef.current.resetScan(),
    addToQueue: (videoIds: string[]) => latestRef.current.addToQueue(videoIds),
    removeFromQueue: (videoIds: string[]) => latestRef.current.removeFromQueue(videoIds),
    submit: (mode?: 'append' | 'replace') => latestRef.current.submit(mode),
  }));

  const status: ChannelArchiveStatus = useMemo(() => ({
    backlogState,
    counts: backlogState?.counts ?? EMPTY_COUNTS,
    progress: {
      done: (backlogState?.counts.done ?? 0) + batchDoneCount,
      total: backlogState?.counts.total ?? 0,
      pending: Math.max(0, (backlogState?.counts.pending ?? 0) - batchDoneCount),
    },
    runState: run.runState,
    pauseRequested,
    pauseReason: run.pauseReason,
    pauseKind: run.pauseKind,
    canResume,
    resumeBlockedReason,
    scan,
    resumeBacklog: stable.resumeBacklog,
    pauseBacklog: stable.pauseBacklog,
    removeBacklog: stable.removeBacklog,
    retryErrors: stable.retryErrors,
    dismissErrors: stable.dismissErrors,
    refreshBacklog: stable.refreshBacklog,
  }), [backlogState, batchDoneCount, run, pauseRequested, canResume, resumeBlockedReason, scan, stable]);

  const view: ChannelArchiveView = useMemo(() => ({
    channel: scanData?.channel ?? null,
    entries: scanData?.entries ?? NO_ENTRIES,
    total: scanData?.total ?? null,
    truncated: scanData?.truncated ?? false,
    scanUrl,
    beginScan: stable.beginScan,
    cancelScan: stable.cancelScan,
    resetScan: stable.resetScan,
    queueIds,
    addToQueue: stable.addToQueue,
    removeFromQueue: stable.removeFromQueue,
    download,
    setDownload,
    targetResolution,
    setTargetResolution,
    targetLibraryTag,
    setTargetLibraryTag,
    batchSize,
    setBatchSize,
    inLibraryIds,
    submit: stable.submit,
  }), [scanData, scanUrl, queueIds, download, targetResolution, targetLibraryTag, batchSize, inLibraryIds, stable]);

  return { status, view };
}

const ChannelArchiveStatusContext = createContext<ChannelArchiveStatus | null>(null);
const ChannelArchiveViewContext = createContext<ChannelArchiveView | null>(null);

// Must sit inside BulkAddProvider and LibraryTagsProvider. Two contexts from
// one provider so the screen's large state (the scanned list, the queue)
// never re-renders the header toggle or the side panel, which only read
// the status.
export function ChannelArchiveProvider({ children }: { children: ReactNode }) {
  const { status, view } = useChannelArchiveState();
  return (
    <ChannelArchiveStatusContext.Provider value={status}>
      <ChannelArchiveViewContext.Provider value={view}>
        {children}
      </ChannelArchiveViewContext.Provider>
    </ChannelArchiveStatusContext.Provider>
  );
}

export function useChannelArchiveStatus(): ChannelArchiveStatus {
  return useContext(ChannelArchiveStatusContext) ?? INERT_STATUS;
}

// For the two places a channel link can be pasted (the Downloader tab and
// the bulk-add dialog). Null with no provider above, so those components
// keep rendering in the many test wrappers that mount them on their own;
// they then simply have no channel handling.
export function useBeginChannelScan(): ((url: string) => void) | null {
  const view = useContext(ChannelArchiveViewContext);
  return view ? view.beginScan : null;
}

export function useChannelArchiveView(): ChannelArchiveView {
  const ctx = useContext(ChannelArchiveViewContext);
  if (!ctx) {
    throw new Error('useChannelArchiveView must be used within a ChannelArchiveProvider');
  }
  return ctx;
}
