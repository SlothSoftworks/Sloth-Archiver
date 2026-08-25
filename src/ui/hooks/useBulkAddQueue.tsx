import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import useDownloadVideo from './useDownloadVideo.tsx';
import { MAX_SIMULTANEOUS_DOWNLOADS_CEILING } from '../../utils/constants.ts';

export type BulkAddStatus = 'pending' | 'fetching' | 'downloading' | 'done' | 'skipped' | 'failed' | 'cancelled';

// videoId is only known upfront for playlist-sourced entries (the flat
// listing already has real ids); undefined for the comma/newline-list case
// until that entry's own info gets fetched.
export type BulkAddEntry = {
  id: string; title: string | null; url: string; videoId?: string;
  // Already-known library location -- when all four are present, start()
  // seeds the new item with them directly so processItem's existing
  // getRetryStage fast path (below) resumes straight at download instead of
  // re-fetching/re-adding an entry that's already in the library. Used by
  // the Library tab's bulk-select "Download selected" action; the
  // URL/playlist-paste flow (BulkAddDialog) never sets these.
  videoDir?: string; epoch?: string; resolution?: string; kind?: 'video' | 'audio';
};

export type BulkAddItem = {
  id: string;
  sourceUrl: string;
  title: string | null;
  status: BulkAddStatus;
  error?: string;
  videoId?: string;
  thumbnailUrl?: string;
  // Set once this item's library entry exists on disk (add-to-library
  // succeeded) -- lets processItem/retry resume straight at the download
  // step instead of re-running fetch/dedup/add, which would otherwise see
  // the entry already exists and wrongly mark it "skipped".
  videoDir?: string;
  epoch?: string;
  resolution?: string;
  kind?: 'video' | 'audio';
  // Mirrors useDownloadVideo's own two-phase progress (raw download %, then
  // ffmpeg postprocess % once the download itself finishes) -- only
  // meaningful while status is 'downloading', not read/reset otherwise.
  downloadProgress?: number;
  postprocessProgress?: number;
};

// playlistId is set only when this batch came from a single playlist link
// (BulkAddDialog) -- lets processItem below patch that playlist's saved
// snapshot with each item's real info as it's fetched, instead of leaving it
// stuck with whatever the cheap flat-listing initially guessed.
type StartOptions = { download: boolean; targetResolution: string; playlistId?: string };

// Derived from the item's own stashed fields (not a separate flag, which
// could drift) -- 'download' means the library entry already exists and
// only the download needs retrying; 'fetch' means starting over.
export function getRetryStage(item: BulkAddItem): 'fetch' | 'download' {
  return item.videoDir && item.epoch && item.resolution ? 'download' : 'fetch';
}

// Deliberate, hardcoded gap between one slot finishing an item and picking
// up its next, so this loop's yt-dlp calls don't fire back-to-back in a
// burst. Per-slot, not global -- several items can still be in flight at
// once across slots.
const ITEM_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Hooks can't be called a variable number of times, so this is a fixed-size
// worker pool of useDownloadVideo() instances; the user's actual "max
// simultaneous downloads" setting (Options) just decides how many of these
// get handed an item at once. Shared with OptionsScreen.tsx's own ceiling
// (utils/constants.ts); main.mjs keeps its own copy of the same number,
// since main-process and renderer never cross-import in this codebase.
const MAX_DOWNLOAD_SLOTS = MAX_SIMULTANEOUS_DOWNLOADS_CEILING;

// Picks the closest available height to the requested ceiling, preferring
// not to exceed it (falls back to the closest above only if nothing at or
// under the target exists) -- run per-video since each one's own available
// resolutions can differ.
function pickClosestResolution(resolutions: { resolution: string }[], target: string): string | null {
  const heights = resolutions
    .map((r) => Number(r.resolution))
    .filter((n) => Number.isFinite(n));
  if (heights.length === 0) return null;
  const targetNum = Number(target);
  if (!Number.isFinite(targetNum)) return String(heights[0]);
  const notExceeding = heights.filter((h) => h <= targetNum);
  const pool = notExceeding.length > 0 ? notExceeding : heights;
  const best = pool.reduce((a, b) => (Math.abs(b - targetNum) < Math.abs(a - targetNum) ? b : a));
  return String(best);
}

// One concurrent "download worker" -- wraps a single useDownloadVideo()
// instance and reports back through onDone whenever THIS instance's own
// isDone/isError flips, tagged with its own slot index. onDone/onProgress
// are read from a ref so the effects below don't need to re-subscribe on
// every parent re-render.
function useDownloadSlot(
  slotIndex: number,
  onDone: (slotIndex: number, result: { isError: boolean; finalFilePath: string }) => void,
  onProgress: (slotIndex: number, progress: { downloadProgress: number; postprocessProgress: number }) => void,
) {
  const { finalFilePath, isDone, isError, downloadProgress, postprocessProgress, startDownload } = useDownloadVideo();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    if (!isDone && !isError) return;
    onDoneRef.current(slotIndex, { isError, finalFilePath });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDone, isError]);

  useEffect(() => {
    onProgressRef.current(slotIndex, { downloadProgress, postprocessProgress });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadProgress, postprocessProgress]);

  return { startDownload };
}

// Renderer-side queue, not a main-process job manager -- see
// futureSpecsFeedback.md's "Bulk add and playlist detection (no background
// worker)" assessment for why. Runs up to maxSimultaneousDownloads items at
// once (a user setting, Options tab) via a fixed pool of MAX_DOWNLOAD_SLOTS
// useDownloadVideo() instances (see useDownloadSlot above) -- this is what
// TD-008 (reports/TechnicalDebt.md) had to be fixed first for: each slot's
// progress is now tagged with its own request id and filtered independently,
// so several real downloads can be in flight without cross-talking.
function useBulkAddQueueState() {
  const [items, setItems] = useState<BulkAddItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  // Purely for rendering, so "Stop after current item" gives feedback before
  // the in-flight item actually finishes -- stopRequestedRef (below) stays
  // the loop's own source of truth.
  const [stopRequested, setStopRequested] = useState(false);

  // Mirrors `items` for the loop's own use: the loop is a plain recursive
  // set of async functions, not a React effect, so it needs a way to read
  // the *current* list without a stale closure over `items` state.
  const itemsRef = useRef<BulkAddItem[]>([]);
  const optionsRef = useRef<StartOptions & { maxSimultaneous: number }>({ download: false, targetResolution: 'dflt', maxSimultaneous: 1 });
  const stopRequestedRef = useRef(false);
  // slotItemRef[i]: itemId occupying slot i (fetch and download phases both),
  // or null while free -- what fillFreeSlots checks. slotDownloadMetaRef[i]:
  // what handleSlotDone needs to record a completed download, since
  // isDone/finalFilePath alone don't carry which item or where to record it.
  const slotItemRef = useRef<Array<string | null>>(new Array(MAX_DOWNLOAD_SLOTS).fill(null));
  const slotDownloadMetaRef = useRef<Array<{ videoDir: string; epoch: string; resolution: string; kind: 'video' | 'audio' } | null>>(new Array(MAX_DOWNLOAD_SLOTS).fill(null));

  const updateItem = (id: string, patch: Partial<BulkAddItem>) => {
    itemsRef.current = itemsRef.current.map((it) => (it.id === id ? { ...it, ...patch } : it));
    setItems(itemsRef.current);
  };

  const notifyQueueEmpty = () => {
    try {
      new Notification('Bulk add finished', { body: 'The queue is empty -- every item was processed, skipped, or failed.' });
    } catch {
      // Notification permission/support varies by platform -- never let this
      // block the queue from finishing.
    }
  };

  // Call after anything that might leave the queue with nothing left to do --
  // flips isRunning off once every slot is idle and no pending work remains,
  // or immediately once a stop was requested and the last in-flight slot
  // has settled.
  const maybeFinishRun = () => {
    const anySlotBusy = slotItemRef.current.some((id) => id !== null);
    if (anySlotBusy) return;
    if (stopRequestedRef.current) {
      setIsRunning(false);
      setStopRequested(false);
      return;
    }
    const anyPending = itemsRef.current.some((it) => it.status === 'pending');
    if (!anyPending) {
      setIsRunning(false);
      notifyQueueEmpty();
    }
  };

  // Fills every currently-free slot (up to maxSimultaneousDownloads) with
  // the next 'pending' item, if any. Safe to call liberally -- a no-op once
  // every allowed slot is busy or there's nothing left to hand out. Slots are
  // claimed synchronously in this one pass: processItem's first action is
  // always to flip the item's status away from 'pending' before its first
  // await, so the find() below never hands the same item to two slots.
  const fillFreeSlots = () => {
    // Must still reach maybeFinishRun even when stopped, or
    // isRunning/stopRequested never reset once the last in-flight slot
    // drains post-stop, leaving the UI stuck on "stop requested".
    if (stopRequestedRef.current) {
      maybeFinishRun();
      return;
    }
    const max = Math.min(optionsRef.current.maxSimultaneous, MAX_DOWNLOAD_SLOTS);
    for (let slot = 0; slot < max; slot++) {
      if (slotItemRef.current[slot]) continue;
      const next = itemsRef.current.find((it) => it.status === 'pending');
      if (!next) break;
      slotItemRef.current[slot] = next.id;
      processItem(next, slot);
    }
    maybeFinishRun();
  };

  // A slot's item has fully concluded (skipped/done/failed with no download,
  // or a download's own handleSlotDone already ran) -- free it and let
  // fillFreeSlots immediately try to hand it the next pending item.
  const freeSlot = (slot: number) => {
    slotItemRef.current[slot] = null;
    fillFreeSlots();
  };

  const beginDownload = (item: BulkAddItem, slot: number, videoDir: string, epoch: string, resolution: string, kind: 'video' | 'audio') => {
    slotDownloadMetaRef.current[slot] = { videoDir, epoch, resolution, kind };
    updateItem(item.id, { status: 'downloading', videoDir, epoch, resolution, kind, error: undefined, downloadProgress: 0, postprocessProgress: 0 });
    const outputPath = `${videoDir}/${epoch}/${kind === 'audio' ? 'audio' : 'video'}`;
    downloadSlots[slot].startDownload({ videoUrl: item.sourceUrl, outputPath, format: 'dflt', resolution });
    // Execution picks back up in handleSlotDone below once this specific
    // download actually finishes -- startDownload itself doesn't resolve on
    // completion (see useDownloadVideo.tsx), only its own scoped progress
    // events do.
  };

  const processItem = async (item: BulkAddItem, slot: number) => {
    // 'download' means the library entry already exists from an earlier
    // attempt (see getRetryStage) -- resume straight at downloading instead
    // of re-fetching info and re-running the dedup check.
    if (getRetryStage(item) === 'download') {
      beginDownload(item, slot, item.videoDir!, item.epoch!, item.resolution!, item.kind || 'video');
      return;
    }

    updateItem(item.id, { status: 'fetching', error: undefined });
    try {
      // getVideoInfoPython never resolves with { success: false } -- a
      // failure always rejects the promise (main.mjs), caught below.
      const info = await window.electronAPI.getVideoInfoPython(item.sourceUrl);
      const videoInfo = info.data.response;
      updateItem(item.id, {
        title: videoInfo.fullTitle || videoInfo.title || item.title,
        videoId: videoInfo.id,
        thumbnailUrl: videoInfo.thumbnail || item.thumbnailUrl,
      });

      // Captures the real title/date/thumbnail into the playlist's saved
      // snapshot now, so it survives even if this video later goes
      // unavailable. Best-effort: never lets a failure here interrupt the
      // actual bulk-add item.
      if (optionsRef.current.playlistId) {
        try {
          await window.electronAPI.enrichPlaylistEntry({
            playlistId: optionsRef.current.playlistId,
            videoId: videoInfo.id,
            title: videoInfo.fullTitle || videoInfo.title,
            uploadDate: videoInfo.uploadDate,
            thumbnailUrl: videoInfo.thumbnail,
          });
        } catch {
          // swallowed -- see comment above.
        }
      }

      const existing = await window.electronAPI.findLibraryVideo(videoInfo.id);
      if (existing.found) {
        updateItem(item.id, { status: 'skipped' });
        await sleep(ITEM_DELAY_MS);
        freeSlot(slot);
        return;
      }

      const added = await window.electronAPI.addLibraryEntry(videoInfo);

      if (!optionsRef.current.download) {
        updateItem(item.id, { status: 'done' });
        await sleep(ITEM_DELAY_MS);
        freeSlot(slot);
        return;
      }

      const target = optionsRef.current.targetResolution;
      const isMp3 = target.toLowerCase() === 'mp3';
      const resolution = isMp3 ? 'mp3' : pickClosestResolution(videoInfo.resolutions || [], target);
      if (!resolution) {
        // No downloadable resolution info on this entry -- metadata-only add
        // still counts as a real result, not a failure.
        updateItem(item.id, { status: 'done' });
        await sleep(ITEM_DELAY_MS);
        freeSlot(slot);
        return;
      }

      beginDownload(item, slot, added.videoDir, added.epoch, resolution, isMp3 ? 'audio' : 'video');
    } catch (err) {
      updateItem(item.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      await sleep(ITEM_DELAY_MS);
      freeSlot(slot);
    }
  };

  // Fired by whichever download slot's own isDone/isError just flipped (see
  // useDownloadSlot above) -- finishes recording that one item, independent
  // of the other slots.
  const handleSlotDone = async (slot: number, result: { isError: boolean; finalFilePath: string }) => {
    const itemId = slotItemRef.current[slot];
    const meta = slotDownloadMetaRef.current[slot];
    if (!itemId || !meta) return;
    slotDownloadMetaRef.current[slot] = null;
    if (result.isError) {
      updateItem(itemId, { status: 'failed', error: 'Download failed.' });
    } else {
      // recordLibraryDownload can reject -- an uncaught rejection here used
      // to skip freeSlot below and leave this slot permanently busy, wedging
      // the whole queue's stop/resume UI, not just this one item.
      try {
        await window.electronAPI.recordLibraryDownload({
          videoDir: meta.videoDir,
          epoch: meta.epoch,
          filePath: result.finalFilePath,
          resolution: meta.resolution,
          kind: meta.kind,
        });
        updateItem(itemId, { status: 'done' });
      } catch (err) {
        updateItem(itemId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }
    await sleep(ITEM_DELAY_MS);
    freeSlot(slot);
  };

  // Fired on every progress tick from any slot (including idle ones, at
  // their initial 0/0 values) -- only actually updates an item once the slot
  // has one assigned (slotItemRef.current[slot] set), a no-op otherwise.
  const handleSlotProgress = (slot: number, progress: { downloadProgress: number; postprocessProgress: number }) => {
    const itemId = slotItemRef.current[slot];
    if (!itemId) return;
    updateItem(itemId, progress);
  };

  // Five literal hook calls, not a loop over MAX_DOWNLOAD_SLOTS -- rules of
  // hooks require a fixed, static call count every render.
  const downloadSlots = [
    useDownloadSlot(0, handleSlotDone, handleSlotProgress),
    useDownloadSlot(1, handleSlotDone, handleSlotProgress),
    useDownloadSlot(2, handleSlotDone, handleSlotProgress),
    useDownloadSlot(3, handleSlotDone, handleSlotProgress),
    useDownloadSlot(4, handleSlotDone, handleSlotProgress),
  ];

  // Appends rather than replaces, so pasting a second batch while the first
  // is still running queues up after it instead of losing it.
  //
  // Deliberately not async: the panel and "fetching" status must appear in
  // the same tick as the click, not after an awaited settings fetch (an
  // earlier async version regressed exactly this). maxSimultaneous keeps
  // whatever value a previous run already resolved to; the current setting
  // is fetched in the background and applied once back, re-running
  // fillFreeSlots in case that unlocks more capacity.
  const start = (entries: BulkAddEntry[], options: StartOptions) => {
    optionsRef.current = { ...options, maxSimultaneous: optionsRef.current.maxSimultaneous };
    stopRequestedRef.current = false;
    setStopRequested(false);
    const newItems: BulkAddItem[] = entries.map((entry, idx) => ({
      id: `${entry.url}#${itemsRef.current.length + idx}`,
      sourceUrl: entry.url,
      title: entry.title,
      status: 'pending',
      videoId: entry.videoId,
      videoDir: entry.videoDir,
      epoch: entry.epoch,
      resolution: entry.resolution,
      kind: entry.kind,
      // YouTube's thumbnail CDN URL is a stable, public, unauthenticated
      // pattern keyed on videoId -- free to construct for playlist-sourced
      // entries with no extra fetch; list-sourced entries pick this up once
      // processItem fetches their info.
      thumbnailUrl: entry.videoId ? `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg` : undefined,
    }));
    itemsRef.current = [...itemsRef.current, ...newItems];
    setItems(itemsRef.current);
    setPanelOpen(true);
    setIsRunning(true);
    fillFreeSlots();

    window.electronAPI.getMaxSimultaneousDownloads().then(({ maxSimultaneousDownloads }) => {
      optionsRef.current.maxSimultaneous = maxSimultaneousDownloads;
      fillFreeSlots();
    });
  };

  // Lets every in-flight slot finish its current item (handleSlotDone
  // handles that) rather than killing anything -- no process-kill tracking
  // needed, unlike a true background worker.
  const stop = () => {
    stopRequestedRef.current = true;
    setStopRequested(true);
  };

  // Continues processing whatever's still 'pending' after a stop.
  const resume = () => {
    stopRequestedRef.current = false;
    setStopRequested(false);
    setIsRunning(true);
    fillFreeSlots();
  };

  // The bulk counterpart to resume: gives up on every 'pending' item in one
  // action, moving them to 'cancelled' so they read as a deliberate choice
  // (not a failure) and can be swept away by clearFinished below.
  const cancelAllPending = () => {
    itemsRef.current = itemsRef.current.map((it) => (it.status === 'pending' ? { ...it, status: 'cancelled' } : it));
    setItems(itemsRef.current);
    maybeFinishRun();
  };

  const retryItem = (id: string) => {
    updateItem(id, { status: 'pending', error: undefined });
    stopRequestedRef.current = false;
    setStopRequested(false);
    setIsRunning(true);
    fillFreeSlots();
  };

  const removeItem = (id: string) => {
    itemsRef.current = itemsRef.current.filter((it) => it.id !== id);
    setItems(itemsRef.current);
  };

  // "Finished" covers every non-actionable end state: done, skipped (already
  // in the library), and cancelled. failed is excluded -- it still needs a
  // retry or explicit removal.
  const clearFinished = () => {
    itemsRef.current = itemsRef.current.filter((it) => it.status !== 'done' && it.status !== 'skipped' && it.status !== 'cancelled');
    setItems(itemsRef.current);
  };

  return { items, isRunning, stopRequested, panelOpen, setPanelOpen, start, stop, resume, cancelAllPending, retryItem, removeItem, clearFinished };
}

type BulkAddQueueContextValue = ReturnType<typeof useBulkAddQueueState>;

const BulkAddQueueContext = createContext<BulkAddQueueContextValue | null>(null);

export function BulkAddProvider({ children }: { children: ReactNode }) {
  const value = useBulkAddQueueState();
  return (
    <BulkAddQueueContext.Provider value={value}>
      {children}
    </BulkAddQueueContext.Provider>
  );
}

export function useBulkAddQueue() {
  const ctx = useContext(BulkAddQueueContext);
  if (!ctx) {
    throw new Error('useBulkAddQueue must be used within a BulkAddProvider');
  }
  return ctx;
}
