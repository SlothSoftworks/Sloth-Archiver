import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Snackbar } from '@mui/material';
import { buildAppVideoUrl } from '../../utils/utils.ts';

export type BackgroundPlayerVideo = {
  videoId: string;
  title: string | null;
  channel: string | null;
  thumbnailPath: string | null;
  sourcePath: string;
  mimeType: string;
  // Set only when this entry came from the Clip Collection player -- lets
  // videoDetailPathFor (below) deep-link back into that video's Clip
  // Collection view instead of its plain detail view.
  clipId?: string | null;
};

// The clip-aware deep link into a queued video's own library entry -- shared
// by MiniPlayerBar.tsx (the currently-playing item) and QueueDrawer.tsx
// (every item in the full queue view) so this ternary lives in one place.
export function videoDetailPathFor(video: BackgroundPlayerVideo): string {
  return video.clipId
    ? `/library/video/${video.videoId}?view=clips&clip=${video.clipId}`
    : `/library/video/${video.videoId}`;
}

// m:ss formatting for the seek bars both MiniPlayerBar.tsx and
// QueueDrawer.tsx render (the latter's own audio-mode transport controls
// mirror the former's, per your own request).
export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Only mp4/webm play reliably in a plain <video> element -- same
// reasoning/set as LibraryVideoPlayer.tsx's own (private) playability
// check, duplicated in miniature here rather than shared across that
// component and LibraryScreen.tsx's VideoCard. The synchronous fast path
// resolvePlayableSource (below) always tries first -- this alone doesn't
// know about the MKV-preview-generation fallback.
export function nativelyPlayableSource(filePath: string | null | undefined): { sourcePath: string; mimeType: 'video/mp4' | 'video/webm' } | null {
  if (!filePath) return null;
  const lastDot = filePath.lastIndexOf('.');
  const ext = lastDot === -1 ? '' : filePath.slice(lastDot + 1).toLowerCase();
  if (ext !== 'mp4' && ext !== 'webm') return null;
  return { sourcePath: filePath, mimeType: ext === 'webm' ? 'video/webm' : 'video/mp4' };
}

// The "Add to queue" entry points that don't already have a live player
// resolving a source for them (LibraryScreen.tsx's VideoCard,
// PlaylistsSection.tsx's rows/"Play all") need this: LibraryVideoPlayer.tsx
// itself never needed an equivalent, since its own state machine already
// runs this exact fallback (ensurePlayablePreview) before it ever reaches
// 'ready', so its own handleAddToQueue's state.sourcePath is already a
// genuinely playable path regardless of the original container. A native
// mp4/webm resolves instantly (no IPC round trip); anything else (most
// commonly MKV, yt-dlp's own default merge container) asks the backend for
// the same cached-or-freshly-generated playable derivative the video view
// itself plays. Returns null only when neither path works (e.g. an
// audio-only download, or the preview generation itself failed).
export async function resolvePlayableSource(filePath: string | null | undefined): Promise<{ sourcePath: string; mimeType: 'video/mp4' | 'video/webm' } | null> {
  const native = nativelyPlayableSource(filePath);
  if (native) return native;
  if (!filePath) return null;
  const result = await window.electronAPI.ensurePlayablePreview({ filePath });
  return result.success && result.previewPath ? { sourcePath: result.previewPath, mimeType: 'video/mp4' } : null;
}

// Mirrors useBulkAddQueue.tsx's provider pattern -- a single instance lives
// at the app root (mounted in App.tsx, outside every CustomTabPanel) so
// playback survives switching tabs/screens, same reason BulkAddSidePanel
// itself survives navigation. Deliberately a *second*, independent player
// from the one LibraryVideoPlayer.tsx renders in the video detail view --
// that one, its clip-marking, and its playback-position autosave are
// untouched by this; this hook exists purely for "keep playing while I go
// do something else," with a real ordered queue (see enqueue/next/previous
// below) that plays items back-to-back, no separate autoplay toggle.
function useBackgroundPlayerState() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [queue, setQueue] = useState<BackgroundPlayerVideo[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Mirrors queue/currentIndex, always updated in the very same statement as
  // their setState calls (see setQueueAuthoritative/setCurrentIndexAuthoritative
  // below) -- every mutator below (enqueue/next/previous/playAt/removeAt)
  // reads these refs, never the queue/currentIndex state variables above,
  // to decide anything. React batches state updates and only applies them
  // on the next render; two of these mutators can legitimately fire back to
  // back before that render happens (e.g. clicking "Add to queue" on two
  // different videos in quick succession), and each one's own closure over
  // `queue`/`currentIndex` would still see the pre-update values in that
  // case -- both would then think the queue is still empty and both call
  // loadAndPlay, with the second call's el.src/play() silently winning over
  // the first while `currentIndex` (state) still points at the first item.
  // The ref is updated synchronously, at the moment of the call, so the
  // second mutator always sees what the first one just did.
  const queueRef = useRef<BackgroundPlayerVideo[]>([]);
  const currentIndexRef = useRef(0);
  const setQueueAuthoritative = (next: BackgroundPlayerVideo[]) => {
    queueRef.current = next;
    setQueue(next);
  };
  const setCurrentIndexAuthoritative = (next: number) => {
    currentIndexRef.current = next;
    setCurrentIndex(next);
  };
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Set by QueueDrawer.tsx while it's open -- see the Provider below, which
  // manually reparents (via a raw DOM appendChild, not React reconciliation)
  // the one real <video> element into this container instead of its default
  // hidden one, so the same continuously-playing element (position,
  // buffered data, audio all intact) becomes visible with native controls
  // rather than being torn down and recreated.
  const [visibleContainer, setVisibleContainer] = useState<HTMLElement | null>(null);
  // A general-purpose one-line toast -- set by enqueue() when it refuses a
  // duplicate, and by any "Add to queue" entry point that needs to report a
  // resolvePlayableSource() failure (couldn't prepare the file for
  // playback). Read by the Provider below to show a single shared Snackbar,
  // rather than each caller needing its own. Not "per message" state, just
  // the latest text to show; a second toast while one's already showing
  // just replaces it.
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = (message: string) => setToastMessage(message);
  const current = queue[currentIndex] ?? null;

  // Points the hidden <video> at a queue entry and starts playback --
  // shared by enqueue (first item), next, and previous, all of which swap
  // the source and reset position/duration the same way.
  const loadAndPlay = (video: BackgroundPlayerVideo) => {
    setCurrentTime(0);
    setDuration(0);
    const el = videoRef.current;
    if (!el) return;
    el.src = buildAppVideoUrl(video.sourcePath);
    // .catch(() => {}) -- an interrupted/rejected play promise (e.g. a
    // pause() racing it) is expected, routine behavior for a <video>
    // element, not a real error; same convention LibraryVideoPlayer.tsx's
    // own safePlay already follows.
    el.play().catch(() => {});
  };

  // Appends to the end of the queue. An empty queue starts playing this
  // item immediately (today's single-slot "play in background" behavior);
  // a non-empty one just grows the queue without disturbing what's
  // currently playing. Refuses an exact repeat (same videoId, and same
  // clipId when either entry has one) rather than queueing it twice.
  //
  // Reads/writes go through queueRef/currentIndexRef (see their declaration
  // above), not the queue/currentIndex state variables directly, and
  // loadAndPlay is called as plain code here, never from inside a
  // setState(prev => ...) updater. Two bugs, now both fixed, made this
  // matter:
  // (1) React (in StrictMode, which this app renders under -- see
  //     main.tsx) invokes a functional updater twice to check it's pure.
  //     A side effect living inside one -- mutating the real <video>
  //     element's `src` and calling `.play()` -- then fired twice for a
  //     single enqueue() call, and the second `.play()` could abort the
  //     first one's still-pending load, silently (via the routine
  //     .catch(() => {}) every play() call here already carries for an
  //     ordinary interrupted-by-pause()).
  // (2) Even with side effects moved out of the updater, reading plain
  //     `queue`/`currentIndex` (this render's own closure) was still
  //     wrong across two enqueue() calls fired back to back -- e.g.
  //     clicking "Add to queue" on two different videos in quick
  //     succession, before React had re-rendered either -- because both
  //     calls' closures still saw the *same*, pre-update queue, so both
  //     concluded "the queue is empty" and both called loadAndPlay: the
  //     second one's el.src/play() silently won over the first's, while
  //     currentIndex (state) kept pointing at the first item, which
  //     never actually started playing.
  // Both together are the intermittent "added item stays gray, doesn't
  // play" symptom -- it depended on exact click/render timing, so it
  // didn't reproduce every time.
  const enqueue = (video: BackgroundPlayerVideo) => {
    const isDuplicate = queueRef.current.some((v) => v.videoId === video.videoId && (v.clipId ?? null) === (video.clipId ?? null));
    if (isDuplicate) {
      showToast(`"${video.title || video.videoId}" is already in the queue`);
      return;
    }
    const wasEmpty = queueRef.current.length === 0;
    setQueueAuthoritative([...queueRef.current, video]);
    if (wasEmpty) {
      setCurrentIndexAuthoritative(0);
      loadAndPlay(video);
    }
  };

  const next = () => {
    const nextIndex = currentIndexRef.current + 1;
    if (nextIndex >= queueRef.current.length) return;
    loadAndPlay(queueRef.current[nextIndex]);
    setCurrentIndexAuthoritative(nextIndex);
  };

  const previous = () => {
    const prevIndex = currentIndexRef.current - 1;
    if (prevIndex < 0) return;
    loadAndPlay(queueRef.current[prevIndex]);
    setCurrentIndexAuthoritative(prevIndex);
  };

  // Jumps straight to an arbitrary queue entry -- QueueDrawer.tsx's own
  // "click a row to play it" gesture. A no-op on the already-current item,
  // so re-clicking what's already playing doesn't restart it from 0.
  const playAt = (index: number) => {
    if (index < 0 || index >= queueRef.current.length || index === currentIndexRef.current) return;
    loadAndPlay(queueRef.current[index]);
    setCurrentIndexAuthoritative(index);
  };

  // Stops the underlying element entirely -- shared by stop() (clearing the
  // whole queue) and removeAt() (when removing the last remaining item
  // leaves nothing to play).
  const haltPlayback = () => {
    const el = videoRef.current;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    setPaused(true);
    setCurrentTime(0);
    setDuration(0);
  };

  // QueueDrawer.tsx's own per-row remove button. Removing the currently-
  // playing item plays whatever now sits in its place (the next item
  // shifted down, or the new last item if it was the tail); removing an
  // earlier item just shifts currentIndex down to keep pointing at the
  // same still-playing entry; removing a later item doesn't need to touch
  // currentIndex at all.
  const removeAt = (index: number) => {
    if (index < 0 || index >= queueRef.current.length) return;
    const removingCurrent = index === currentIndexRef.current;
    const nextQueue = queueRef.current.filter((_, i) => i !== index);
    setQueueAuthoritative(nextQueue);
    if (nextQueue.length === 0) {
      haltPlayback();
      setCurrentIndexAuthoritative(0);
    } else if (removingCurrent) {
      const newIndex = Math.min(index, nextQueue.length - 1);
      loadAndPlay(nextQueue[newIndex]);
      setCurrentIndexAuthoritative(newIndex);
    } else if (index < currentIndexRef.current) {
      setCurrentIndexAuthoritative(currentIndexRef.current - 1);
    }
  };

  // Auto-advances when the currently-playing item finishes -- this is the
  // queue's only playback mode ("plays items back-to-back"), not an
  // opt-in toggle. Explicitly sets `paused` rather than relying on a
  // native 'pause' event also firing: jsdom's play/pause stubs (see
  // vitest.setup.ts) never fire one for real, so tests need this to be
  // deterministic, not just a real-browser nicety.
  const onEnded = () => {
    if (currentIndexRef.current + 1 < queueRef.current.length) {
      next();
    } else {
      setPaused(true);
    }
  };

  const pause = () => videoRef.current?.pause();
  const resume = () => { videoRef.current?.play().catch(() => {}); };
  const seek = (seconds: number) => {
    if (videoRef.current) videoRef.current.currentTime = seconds;
  };
  // Clears the whole queue (hiding the mini-bar) rather than just pausing
  // -- explicit "I'm done with this," distinct from pause/resume.
  const stop = () => {
    haltPlayback();
    setQueueAuthoritative([]);
    setCurrentIndexAuthoritative(0);
  };

  return {
    videoRef, queue, currentIndex, current, paused, currentTime, duration,
    visibleContainer, setVisibleContainer,
    toastMessage, showToast, dismissToast: () => setToastMessage(null),
    enqueue, next, previous, playAt, removeAt, pause, resume, seek, stop,
    // Wired to the <video> element's own events by the Provider below --
    // exposed here so that single element (mounted once, for the app's
    // whole lifetime) is the one source of truth for paused/currentTime/
    // duration, rather than this hook guessing at them independently.
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onTimeUpdate: () => setCurrentTime(videoRef.current?.currentTime ?? 0),
    onLoadedMetadata: () => setDuration(videoRef.current?.duration ?? 0),
    onEnded,
  };
}

type BackgroundPlayerContextValue = ReturnType<typeof useBackgroundPlayerState>;

const BackgroundPlayerContext = createContext<BackgroundPlayerContextValue | null>(null);

export function BackgroundPlayerProvider({ children }: { children: ReactNode }) {
  const value = useBackgroundPlayerState();
  const homeRef = useRef<HTMLDivElement>(null);

  // The <video> element's JSX position is always the same static child of
  // homeRef's div -- React itself never moves it. This effect is the only
  // thing that ever changes its real parent, via a raw appendChild rather
  // than through React reconciliation: React's own diffing, given a
  // changed target container, would unmount and recreate the element
  // (verified directly -- it does not preserve DOM identity across a
  // Portal's container prop changing), resetting playback to 0. A plain
  // DOM appendChild move doesn't reload a <video> at all, which is exactly
  // what lets the live background track keep playing, uninterrupted, while
  // QueueDrawer.tsx shows/hides it. controls/style are set imperatively
  // here too, not as JSX props, so React's own frequent re-renders (e.g.
  // every currentTime update) never fight this and reset them back.
  useEffect(() => {
    const video = value.videoRef.current;
    const home = homeRef.current;
    if (!video || !home) return;
    const target = value.visibleContainer ?? home;
    if (video.parentElement !== target) target.appendChild(video);
    video.controls = !!value.visibleContainer;
    video.style.display = value.visibleContainer ? 'block' : 'none';
    video.style.width = value.visibleContainer ? '100%' : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.visibleContainer]);

  return (
    <BackgroundPlayerContext.Provider value={value}>
      {children}
      {/* Mounted once, for the app's whole lifetime, regardless of which
          tab or screen is currently showing -- this is what actually makes
          playback survive navigation. This div is the <video>'s permanent
          home in React's own tree; the effect above is what actually moves
          the element in and out of it. */}
      <div ref={homeRef} style={{ display: 'none' }}>
        <video
          ref={value.videoRef}
          data-testid="background-player-video"
          onPlay={value.onPlay}
          onPause={value.onPause}
          onTimeUpdate={value.onTimeUpdate}
          onLoadedMetadata={value.onLoadedMetadata}
          onEnded={value.onEnded}
        />
      </div>
      {/* One shared toast -- enqueue()'s own duplicate-prevention message,
          and any "Add to queue" entry point's resolvePlayableSource()
          failure, both go through showToast() rather than each caller
          needing its own Snackbar. */}
      <Snackbar
        open={!!value.toastMessage}
        autoHideDuration={4000}
        onClose={value.dismissToast}
        message={value.toastMessage}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </BackgroundPlayerContext.Provider>
  );
}

export function useBackgroundPlayer() {
  const ctx = useContext(BackgroundPlayerContext);
  if (!ctx) {
    throw new Error('useBackgroundPlayer must be used within a BackgroundPlayerProvider');
  }
  return ctx;
}
