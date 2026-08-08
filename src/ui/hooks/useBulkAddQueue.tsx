import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import useDownloadVideo from './useDownloadVideo.tsx';

export type BulkAddStatus = 'pending' | 'fetching' | 'downloading' | 'done' | 'skipped' | 'failed' | 'cancelled';

// videoId is only known upfront for playlist-sourced entries (the flat
// listing already has real ids) -- undefined for the comma/newline-list
// case until that entry's own info gets fetched.
export type BulkAddEntry = { id: string; title: string | null; url: string; videoId?: string };

export type BulkAddItem = {
  id: string;
  sourceUrl: string;
  title: string | null;
  status: BulkAddStatus;
  error?: string;
  videoId?: string;
  thumbnailUrl?: string;
  // Set once this item's library entry actually exists on disk (the
  // add-to-library step succeeded) -- lets processItem/retry resume
  // straight at the download step instead of re-running the whole
  // fetch/dedup/add pipeline, which would otherwise see the entry already
  // exists and wrongly mark it "skipped" rather than retrying the part
  // that actually failed.
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
// snapshot with each item's real info as it's fetched, instead of leaving
// it stuck with whatever the cheap flat-listing initially guessed.
type StartOptions = { download: boolean; targetResolution: string; playlistId?: string };

// The "indicator" retry needs: whether this item still has to go all the
// way back to fetching its info (nothing persisted yet, or the add itself
// never succeeded), or whether the library entry already exists and only
// the download actually needs retrying. Derived from the item's own stashed
// fields rather than a separate flag that could drift out of sync with them.
export function getRetryStage(item: BulkAddItem): 'fetch' | 'download' {
  return item.videoDir && item.epoch && item.resolution ? 'download' : 'fetch';
}

// Gap between one slot finishing an item and it picking up its next one --
// a deliberate, hardcoded default (no settings UI for v1) to spread out the
// per-video yt-dlp calls this loop makes, rather than firing them back to
// back like a burst. Applies per-slot, not globally -- with several slots
// running at once (see maxSimultaneousDownloads, Options) this still means
// several items can be genuinely in flight at the same time; it just keeps
// any *one* slot from immediately re-firing the instant its item finishes.
const ITEM_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Matches main.js's MAX_SIMULTANEOUS_DOWNLOADS_CEILING and
// OptionsScreen.tsx's MAX_SIMULTANEOUS_DOWNLOADS_OPTIONS -- the fixed number
// of useDownloadVideo() instances this hook keeps ready. Hooks can't be
// called a variable number of times, so this is a fixed-size worker pool;
// the user's actual "max simultaneous downloads" setting (1-5) just decides
// how many of these MAX_DOWNLOAD_SLOTS get handed an item at once, the rest
// simply sit unused.
const MAX_DOWNLOAD_SLOTS = 5;

// Picks the closest available height to the requested ceiling, preferring
// not to exceed it (falls back to the closest above only if nothing at or
// under the target exists) -- same "sort + pick closest" idea already
// scoped for the Robust-library-detection spec, applied per-video here since
// each video's own available resolutions can differ.
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
// isDone/isError flips, tagged with its own slot index so the caller knows
// which concurrently-running item just finished. onDone is read from a ref
// (not a direct dependency) so the effect doesn't need to re-subscribe every
// time the parent re-renders with a new closure.
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
  // Purely for rendering -- "Stop after current item" otherwise gives no
  // feedback at all until the in-flight item actually finishes, which can
  // take a while. This is a plain, non-authoritative mirror of
  // stopRequestedRef (below), which stays the loop's own source of truth.
  const [stopRequested, setStopRequested] = useState(false);

  // Mirrors `items` for the loop's own use -- the loop is a plain recursive
  // set of async functions, not a React effect, so it needs a way to read
  // the *current* list without falling prey to stale closures over the
  // `items` state captured at whatever render it happened to be defined in.
  const itemsRef = useRef<BulkAddItem[]>([]);
  const optionsRef = useRef<StartOptions & { maxSimultaneous: number }>({ download: false, targetResolution: 'dflt', maxSimultaneous: 1 });
  const stopRequestedRef = useRef(false);
  // slotItemRef[i] holds the itemId currently occupying slot i (through both
  // its fetch *and* download phases), or null while that slot is free --
  // this is what fillFreeSlots checks to decide how many new items it can
  // hand out. slotDownloadMetaRef[i] holds exactly what handleSlotDone needs
  // to finish recording a completed download, since isDone/finalFilePath
  // alone don't carry which item or where it should be recorded.
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

  // Call after anything that might leave the queue with nothing left to do
  // (a slot freeing up with no pending work to hand it, cancelling every
  // pending item, etc.) -- flips isRunning off once every slot is idle and
  // there's no pending work left, or immediately once a stop was requested
  // and the last in-flight slot has settled.
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
  // the next 'pending' item, if any. Safe to call liberally -- it's a no-op
  // once every allowed slot is busy or there's nothing left to hand out.
  // Slots are claimed synchronously in this one pass: processItem's first
  // action is always to flip the item's status away from 'pending' before
  // its first await, so the itemsRef.current.find() below never hands the
  // same item to two slots in the same call.
  const fillFreeSlots = () => {
    if (stopRequestedRef.current) return;
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
    // getRetryStage === 'download' means the library entry already exists
    // from an earlier attempt (see its docstring) -- resume straight at
    // downloading with everything already known, instead of re-fetching
    // info and re-running the dedup check (which would just see the entry
    // already exists and mark it "skipped" again).
    if (getRetryStage(item) === 'download') {
      beginDownload(item, slot, item.videoDir!, item.epoch!, item.resolution!, item.kind || 'video');
      return;
    }

    updateItem(item.id, { status: 'fetching', error: undefined });
    try {
      // getVideoInfoPython never resolves with { success: false } -- a
      // failure always rejects the promise (main.js), caught below.
      const info = await window.electronAPI.getVideoInfoPython(item.sourceUrl);
      const videoInfo = info.data.response;
      updateItem(item.id, {
        title: videoInfo.fullTitle || videoInfo.title || item.title,
        videoId: videoInfo.id,
        thumbnailUrl: videoInfo.thumbnail || item.thumbnailUrl,
      });

      // This is the real, authoritative data the spec cares about -- if this
      // item's playlist ever sees this video go unavailable later, its
      // saved snapshot already has the real title/date/thumbnail captured
      // now rather than whatever the cheap flat-listing guessed. Best-effort:
      // never lets a failure here interrupt the actual bulk-add item.
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
  // of whatever the other slots are doing.
  const handleSlotDone = async (slot: number, result: { isError: boolean; finalFilePath: string }) => {
    const itemId = slotItemRef.current[slot];
    const meta = slotDownloadMetaRef.current[slot];
    if (!itemId || !meta) return;
    slotDownloadMetaRef.current[slot] = null;
    if (result.isError) {
      updateItem(itemId, { status: 'failed', error: 'Download failed.' });
    } else {
      await window.electronAPI.recordLibraryDownload({
        videoDir: meta.videoDir,
        epoch: meta.epoch,
        filePath: result.finalFilePath,
        resolution: meta.resolution,
        kind: meta.kind,
      });
      updateItem(itemId, { status: 'done' });
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

  // MAX_DOWNLOAD_SLOTS is a fixed, hardcoded constant (not a variable), so
  // this is exactly five literal hook calls every render, not a loop or
  // dynamic count -- rules-of-hooks compliant.
  const downloadSlots = [
    useDownloadSlot(0, handleSlotDone, handleSlotProgress),
    useDownloadSlot(1, handleSlotDone, handleSlotProgress),
    useDownloadSlot(2, handleSlotDone, handleSlotProgress),
    useDownloadSlot(3, handleSlotDone, handleSlotProgress),
    useDownloadSlot(4, handleSlotDone, handleSlotProgress),
  ];

  // Appends rather than replaces -- pasting a second batch while the first
  // is still running (or sitting finished in the list) queues up after it
  // instead of losing it.
  const start = async (entries: BulkAddEntry[], options: StartOptions) => {
    const { maxSimultaneousDownloads } = await window.electronAPI.getMaxSimultaneousDownloads();
    optionsRef.current = { ...options, maxSimultaneous: maxSimultaneousDownloads };
    stopRequestedRef.current = false;
    setStopRequested(false);
    const newItems: BulkAddItem[] = entries.map((entry, idx) => ({
      id: `${entry.url}#${itemsRef.current.length + idx}`,
      sourceUrl: entry.url,
      title: entry.title,
      status: 'pending',
      videoId: entry.videoId,
      // YouTube's thumbnail CDN URL is a stable, public, unauthenticated
      // pattern keyed purely on videoId -- free to construct directly for
      // playlist-sourced entries (real id known upfront) with no extra
      // fetch; list-sourced entries pick this up once their info is fetched
      // (see processItem), same pattern already used elsewhere in this app
      // for hotlinked thumbnails.
      thumbnailUrl: entry.videoId ? `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg` : undefined,
    }));
    itemsRef.current = [...itemsRef.current, ...newItems];
    setItems(itemsRef.current);
    setPanelOpen(true);
    setIsRunning(true);
    fillFreeSlots();
  };

  // Lets every in-flight slot finish its current item (their own promise
  // chains / handleSlotDone already handle that) rather than killing
  // anything -- no process-kill tracking needed, unlike a true background
  // worker.
  const stop = () => {
    stopRequestedRef.current = true;
    setStopRequested(true);
  };

  // Continues processing whatever's still 'pending' after a stop -- without
  // this, a stopped queue had no way back except retrying/removing every
  // remaining item one at a time (retry only ever applied to 'failed' items
  // anyway, not 'pending' ones sitting frozen after a stop).
  const resume = () => {
    stopRequestedRef.current = false;
    setStopRequested(false);
    setIsRunning(true);
    fillFreeSlots();
  };

  // The bulk counterpart to resume -- instead of continuing, gives up on
  // every item still 'pending' after a stop in one action, moving them to
  // their own 'cancelled' status so they read as a deliberate choice (not a
  // failure) and can then be swept away together by clearFinished below.
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

  // "Finished" covers every end state that isn't actionable anymore -- done
  // (downloaded/added), skipped (already in the library, so there was never
  // anything to do), and cancelled (explicitly given up on via
  // cancelAllPending). failed is deliberately excluded: it still needs a
  // retry or an explicit individual removal.
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
