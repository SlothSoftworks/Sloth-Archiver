import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { buildAppVideoUrl } from '../../utils/utils.ts';

export type BackgroundPlayerVideo = {
  videoId: string;
  title: string | null;
  channel: string | null;
  thumbnailPath: string | null;
  sourcePath: string;
  mimeType: string;
  // Set only when this entry came from the Clip Collection player -- lets
  // MiniPlayerBar.tsx deep-link back into that video's Clip Collection view
  // instead of its plain detail view.
  clipId?: string | null;
};

// Mirrors useBulkAddQueue.tsx's provider pattern -- a single instance lives
// at the app root (mounted in App.tsx, outside every CustomTabPanel) so
// playback survives switching tabs/screens, same reason BulkAddSidePanel
// itself survives navigation. Deliberately a *second*, independent player
// from the one LibraryVideoPlayer.tsx renders in the video detail view --
// that one, its clip-marking, and its playback-position autosave are
// untouched by this; this hook exists purely for "keep playing while I go
// do something else," a single now-playing slot, no queue (yet).
function useBackgroundPlayerState() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [current, setCurrent] = useState<BackgroundPlayerVideo | null>(null);
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // .catch(() => {}) on every play() call -- an interrupted/rejected play
  // promise (e.g. a pause() racing it) is expected, routine behavior for a
  // <video> element, not a real error; same convention LibraryVideoPlayer.tsx's
  // own safePlay already follows.
  const play = (video: BackgroundPlayerVideo) => {
    setCurrent(video);
    setCurrentTime(0);
    setDuration(0);
    const el = videoRef.current;
    if (!el) return;
    el.src = buildAppVideoUrl(video.sourcePath);
    el.play().catch(() => {});
  };

  const pause = () => videoRef.current?.pause();
  const resume = () => { videoRef.current?.play().catch(() => {}); };
  const seek = (seconds: number) => {
    if (videoRef.current) videoRef.current.currentTime = seconds;
  };
  // Clears `current` (hiding the mini-bar) rather than just pausing --
  // explicit "I'm done with this," distinct from pause/resume.
  const stop = () => {
    const el = videoRef.current;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    setCurrent(null);
    setPaused(true);
    setCurrentTime(0);
    setDuration(0);
  };

  return {
    videoRef, current, paused, currentTime, duration,
    play, pause, resume, seek, stop,
    // Wired to the <video> element's own events by the Provider below --
    // exposed here so that single element (mounted once, for the app's
    // whole lifetime) is the one source of truth for paused/currentTime/
    // duration, rather than this hook guessing at them independently.
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onTimeUpdate: () => setCurrentTime(videoRef.current?.currentTime ?? 0),
    onLoadedMetadata: () => setDuration(videoRef.current?.duration ?? 0),
  };
}

type BackgroundPlayerContextValue = ReturnType<typeof useBackgroundPlayerState>;

const BackgroundPlayerContext = createContext<BackgroundPlayerContextValue | null>(null);

export function BackgroundPlayerProvider({ children }: { children: ReactNode }) {
  const value = useBackgroundPlayerState();
  return (
    <BackgroundPlayerContext.Provider value={value}>
      {children}
      {/* Mounted once, for the app's whole lifetime, regardless of which tab
          or screen is currently showing -- this is what actually makes
          playback survive navigation. display: none since minimized
          playback never shows a live frame, only the mini-bar's static
          thumbnail (see MiniPlayerBar.tsx). */}
      <video
        ref={value.videoRef}
        data-testid="background-player-video"
        style={{ display: 'none' }}
        onPlay={value.onPlay}
        onPause={value.onPause}
        onTimeUpdate={value.onTimeUpdate}
        onLoadedMetadata={value.onLoadedMetadata}
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
