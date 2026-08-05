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

// Gap between the end of one item's processing and the start of the next --
// a deliberate, hardcoded default (no settings UI for v1) to spread out the
// per-video yt-dlp calls this loop makes, rather than firing them back to
// back like a burst.
const ITEM_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Renderer-side queue, not a main-process job manager -- see
// futureSpecsFeedback.md's "Bulk add and playlist detection (no background
// worker)" assessment for why: this is sequential by construction (one
// useDownloadVideo() call in flight at a time), which is also what keeps it
// clear of TD-008 (reports/TechnicalDebt.md, the untagged shared progress
// channel that only bites two *simultaneous* downloads).
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
  // async function, not a React effect, so it needs a way to read the
  // *current* list without falling prey to stale closures over the `items`
  // state captured at whatever render it happened to be defined in.
  const itemsRef = useRef<BulkAddItem[]>([]);
  const optionsRef = useRef<StartOptions>({ download: false, targetResolution: 'dflt' });
  const stopRequestedRef = useRef(false);
  // Set only while a real file download is in flight for a specific item --
  // holds exactly what the isDone effect below needs to finish recording it,
  // since finalFilePath/isDone alone don't carry which item or where.
  const activeDownloadRef = useRef<{ itemId: string; videoDir: string; epoch: string; resolution: string; kind: 'video' | 'audio' } | null>(null);

  const { finalFilePath, isDone, isError, startDownload } = useDownloadVideo();

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

  const runNext = async () => {
    if (stopRequestedRef.current) {
      setIsRunning(false);
      setStopRequested(false);
      return;
    }
    const next = itemsRef.current.find((it) => it.status === 'pending');
    if (!next) {
      setIsRunning(false);
      notifyQueueEmpty();
      return;
    }
    await processItem(next);
  };

  const beginDownload = (item: BulkAddItem, videoDir: string, epoch: string, resolution: string, kind: 'video' | 'audio') => {
    activeDownloadRef.current = { itemId: item.id, videoDir, epoch, resolution, kind };
    updateItem(item.id, { status: 'downloading', videoDir, epoch, resolution, kind, error: undefined });
    const outputPath = `${videoDir}/${epoch}/${kind === 'audio' ? 'audio' : 'video'}`;
    startDownload({ videoUrl: item.sourceUrl, outputPath, format: 'dflt', resolution });
    // Execution picks back up in the isDone effect below once this specific
    // download actually finishes -- startDownload itself doesn't resolve on
    // completion (see useDownloadVideo.tsx), only its 'progressUpdate'
    // broadcast does.
  };

  const processItem = async (item: BulkAddItem) => {
    // getRetryStage === 'download' means the library entry already exists
    // from an earlier attempt (see its docstring) -- resume straight at
    // downloading with everything already known, instead of re-fetching
    // info and re-running the dedup check (which would just see the entry
    // already exists and mark it "skipped" again).
    if (getRetryStage(item) === 'download') {
      beginDownload(item, item.videoDir!, item.epoch!, item.resolution!, item.kind || 'video');
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
        await runNext();
        return;
      }

      const added = await window.electronAPI.addLibraryEntry(videoInfo);

      if (!optionsRef.current.download) {
        updateItem(item.id, { status: 'done' });
        await sleep(ITEM_DELAY_MS);
        await runNext();
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
        await runNext();
        return;
      }

      beginDownload(item, added.videoDir, added.epoch, resolution, isMp3 ? 'audio' : 'video');
    } catch (err) {
      updateItem(item.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      await sleep(ITEM_DELAY_MS);
      await runNext();
    }
  };

  useEffect(() => {
    if (!isDone && !isError) return;
    const active = activeDownloadRef.current;
    if (!active) return;
    activeDownloadRef.current = null;
    (async () => {
      if (isError) {
        updateItem(active.itemId, { status: 'failed', error: 'Download failed.' });
      } else {
        await window.electronAPI.recordLibraryDownload({
          videoDir: active.videoDir,
          epoch: active.epoch,
          filePath: finalFilePath,
          resolution: active.resolution,
          kind: active.kind,
        });
        updateItem(active.itemId, { status: 'done' });
      }
      await sleep(ITEM_DELAY_MS);
      await runNext();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDone, isError]);

  // Appends rather than replaces -- pasting a second batch while the first
  // is still running (or sitting finished in the list) queues up after it
  // instead of losing it.
  const start = (entries: BulkAddEntry[], options: StartOptions) => {
    optionsRef.current = options;
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
    if (!isRunning) {
      setIsRunning(true);
      runNext();
    }
  };

  // Lets the in-flight item finish (its own promise chain / the isDone
  // effect above already handles that) rather than killing anything --
  // no process-kill tracking needed, unlike a true background worker.
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
    runNext();
  };

  // The bulk counterpart to resume -- instead of continuing, gives up on
  // every item still 'pending' after a stop in one action, moving them to
  // their own 'cancelled' status so they read as a deliberate choice (not a
  // failure) and can then be swept away together by clearFinished below.
  const cancelAllPending = () => {
    itemsRef.current = itemsRef.current.map((it) => (it.status === 'pending' ? { ...it, status: 'cancelled' } : it));
    setItems(itemsRef.current);
  };

  const retryItem = (id: string) => {
    updateItem(id, { status: 'pending', error: undefined });
    if (!isRunning) {
      stopRequestedRef.current = false;
      setStopRequested(false);
      setIsRunning(true);
      runNext();
    }
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
