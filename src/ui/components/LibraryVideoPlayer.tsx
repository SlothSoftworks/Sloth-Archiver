import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Box, CardMedia, IconButton, Typography } from '@mui/material';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from '@vidstack/react';
import '@vidstack/react/player/styles/base.css';
import type { LibraryVideoMetadata } from '../../types';
import YouTubeEmbed from './YouTubeEmbed';
import ResizableMediaContainer from './ResizableMediaContainer';
import LibraryVideoPlayerControls from './LibraryVideoPlayerControls';
import LinearProgressWithLabel from './LinearProgressWithLabel';
import { buildAppVideoUrl } from '../../utils/utils.ts';

// Exposed so LibraryVideoDetail.tsx's clip tool can grab "wherever playback
// currently is" for its "Set as start"/"Set as end" buttons -- the player
// only exists inside this component. getCurrentTime/getDuration return null
// (not a misleading 0) when no local video is mounted right now. seekTo/play/
// pause are unused by either current call site -- added so a future clip-
// range-selection or Playlist-mode feature can drive this player externally
// without another ref-API rework.
export type LibraryVideoPlayerHandle = {
  getCurrentTime: () => number | null;
  getDuration: () => number | null;
  seekTo: (seconds: number) => void;
  play: () => void;
  pause: () => void;
};

// Embeds the clip Start/End/Clip/Clear controls (LibraryVideoPlayerControls.tsx)
// directly in the player chrome, driven entirely by LibraryVideoDetail.tsx's own
// clipStart/clipEnd state -- undefined here means "don't render these at all",
// which is how ClipCollectionView's player (clip creation doesn't apply to a clip)
// stays completely unaffected without needing any changes of its own.
export type ClipMarkersControl = {
  startSeconds: number | null;
  endSeconds: number | null;
  onSetStart: () => void;
  onSetEnd: () => void;
  onStartSecondsChange: (seconds: number) => void;
  onEndSecondsChange: (seconds: number) => void;
  onSave: () => void;
  saveDisabled: boolean;
  onClear: () => void;
  clearDisabled: boolean;
};

// Only mp4/webm play reliably in Chromium's <video> element -- MKV is a
// container-parsing limitation no delivery mechanism can work around, and
// could still land here from a download made before buildDownloadArgs
// (main.mjs) started forcing --merge-output-format mp4. This component
// quietly falls back to the static thumbnail rather than attempting a
// player known to fail; "open in default player" exists in
// LibraryVideoDetail for exactly this case.
const PLAYABLE_VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot === -1 ? '' : filePath.slice(lastDot + 1).toLowerCase();
}

// Vidstack's own src-type auto-detection doesn't recognize the app's custom
// app-video:// scheme and silently falls back to treating it as a YouTube
// embed (an empty iframe, no error) -- an explicit type sidesteps that
// detection entirely. Only ever called for an extension already confirmed
// to be in PLAYABLE_VIDEO_EXTENSIONS above, or for a generated preview
// (always .mp4 -- see previewCache.mjs).
function mimeTypeForExtension(ext: string): 'video/webm' | 'video/mp4' {
  return ext === 'webm' ? 'video/webm' : 'video/mp4';
}

// A native-playable extension goes straight to 'ready' with the file's own
// path, no backend call needed. A non-native extension (e.g. MKV) instead
// starts in 'preparingPreview': ensurePlayablePreview (main.mjs) is called
// once per [filePath, cacheBustKey] change, and its result (or failure)
// drives whether that becomes 'ready' (pointed at the generated preview
// path instead) or 'previewFailed'. 'runtimeFailed' is reachable from either
// path -- a file that *should* play can still fail at actual decode time.
// computeInitialState below always resolves synchronously to one of
// preparingPreview/ready on the very first render (no separate "idle"/
// unknown state), so there's never a frame where the wrong fallback caption
// flashes before the mount effect corrects it.
type PlaybackState =
  | { kind: 'preparingPreview'; percent: number }
  | { kind: 'previewFailed'; message?: string }
  | { kind: 'ready'; sourcePath: string; mimeType: 'video/mp4' | 'video/webm' }
  | { kind: 'runtimeFailed' };

function computeInitialState(filePath: string | null): PlaybackState {
  if (filePath) {
    const ext = getExtension(filePath);
    if (PLAYABLE_VIDEO_EXTENSIONS.has(ext)) {
      return { kind: 'ready', sourcePath: filePath, mimeType: mimeTypeForExtension(ext) };
    }
  }
  // Either no file yet (irrelevant -- the component returns before this
  // state is ever rendered in that case) or a non-native extension, which
  // always starts a real preview-generation attempt.
  return { kind: 'preparingPreview', percent: 0 };
}

const containerSx = { borderRadius: 2 };
const fillSx = { width: '100%', height: '100%', display: 'block' };

// MP3 playback lives in the instrument panel (LibraryVideoDetail.tsx),
// alongside its own download/re-download controls -- not here. This
// component only ever renders the video slot: YouTube embed, local
// playback, or a static thumbnail fallback.
const LibraryVideoPlayer = forwardRef<LibraryVideoPlayerHandle, {
  metadata: LibraryVideoMetadata;
  thumbnailPath?: string | null;
  cacheBustKey?: number;
  // Clip Collection's own player points at a clip's file directly, bypassing
  // metadata.downloadedFilePath entirely -- takes priority when present, and
  // (unlike the normal video path) never falls back to a YouTube embed, since
  // a clip has no meaningful remote-video identity to embed.
  overrideFilePath?: string;
  // Only ever passed by the main video detail view -- ClipCollectionView never
  // sets this, so its player never renders the embedded clip controls.
  clipMarkers?: ClipMarkersControl;
}>(function LibraryVideoPlayer({ metadata, thumbnailPath, cacheBustKey = 0, overrideFilePath, clipMarkers }, ref) {
  const { thumbnail, videoId } = metadata;
  const filePath = overrideFilePath ?? metadata.downloadedFilePath;
  const [state, setState] = useState<PlaybackState>(() => computeInitialState(filePath));
  // One-time "you can start playback here" affordance, not a persistent
  // pause indicator -- gone for good once playback has ever started (native
  // controls take over from there). Resets whenever the file changes.
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const playerRef = useRef<MediaPlayerInstance>(null);

  const ext = filePath ? getExtension(filePath) : '';
  const isNativePlayable = filePath ? PLAYABLE_VIDEO_EXTENSIONS.has(ext) : false;

  // Extension alone says Chromium's demuxer can attempt this container, not
  // that this exact file will decode -- an unusual codec or a truncated file
  // can still fail at runtime, same for a generated preview. Catches that via
  // the player's error event, degrading to the same fallback as a
  // known-unplayable extension instead of a silently-broken black player.
  useEffect(() => {
    setHasStartedPlayback(false);
    if (!filePath) return;

    if (isNativePlayable) {
      setState({ kind: 'ready', sourcePath: filePath, mimeType: mimeTypeForExtension(ext) });
      return;
    }

    // Non-native extension (e.g. MKV): ask the backend for a cached or
    // freshly-generated playback-only derivative (previewCache.mjs) before
    // giving up on this file entirely -- the previous "can't be played here"
    // fallback is now reserved for when this itself fails.
    let cancelled = false;
    setState({ kind: 'preparingPreview', percent: 0 });
    window.electronAPI.onPreviewGenerationProgress(({ percent }) => {
      if (cancelled) return;
      setState((prev) => (prev.kind === 'preparingPreview' ? { kind: 'preparingPreview', percent } : prev));
    });
    window.electronAPI.ensurePlayablePreview({ filePath }).then((result) => {
      if (cancelled) return;
      if (result.success && result.previewPath) {
        setState({ kind: 'ready', sourcePath: result.previewPath, mimeType: 'video/mp4' });
      } else {
        setState({ kind: 'previewFailed', message: result.message });
      }
    });
    return () => {
      cancelled = true;
      window.electronAPI.removePreviewGenerationProgressListener();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ext/isNativePlayable are pure derivations of filePath, not independent inputs.
  }, [filePath, cacheBustKey]);

  // Unlike a native <video>'s play()/pause(), Vidstack's own throw/reject if
  // called before it considers the media genuinely ready -- a real
  // possibility, not just a test artifact: a user can click Play before a
  // slow-loading source has actually buffered enough to start. An unhandled
  // rejection here would otherwise surface as a spurious error via App.tsx's
  // own window 'unhandledrejection' reporter; silently ignoring it is
  // correct since there's nothing more useful to do than "wait and try
  // again," which the player's own UI already invites.
  const safePlay = () => { playerRef.current?.play().catch(() => {}); };
  const safePause = () => { playerRef.current?.pause().catch(() => {}); };

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => (playerRef.current ? playerRef.current.currentTime : null),
    getDuration: () => (playerRef.current ? playerRef.current.duration : null),
    seekTo: (seconds) => {
      if (playerRef.current) playerRef.current.currentTime = seconds;
    },
    play: safePlay,
    pause: safePause,
  }), []);

  // Prefer the locally-cached, offline-capable thumbnail over the hotlinked
  // YouTube URL -- that URL is the fallback for entries added before this
  // feature existed, or while the background fetch hasn't landed yet.
  const posterSrc = thumbnailPath ? buildAppVideoUrl(thumbnailPath) : (thumbnail || undefined);

  if (!filePath) {
    if (overrideFilePath !== undefined) {
      // Clip context: never fall back to a YouTube embed for a derived clip
      // file -- if there's genuinely nothing to play, there's nothing to show.
      return null;
    }
    return (
      <ResizableMediaContainer sx={containerSx}>
        <YouTubeEmbed videoId={videoId} sx={fillSx} />
      </ResizableMediaContainer>
    );
  }

  if (state.kind === 'ready') {
    return (
      <ResizableMediaContainer sx={containerSx}>
        <Box sx={{ ...fillSx, position: 'relative' }}>
          <MediaPlayer
            ref={playerRef}
            title={metadata.fullTitle || metadata.title || undefined}
            src={{ src: buildAppVideoUrl(state.sourcePath, cacheBustKey), type: state.mimeType }}
            style={{ width: '100%', height: '100%', backgroundColor: 'black' }}
            onError={() => setState({ kind: 'runtimeFailed' })}
            onPlay={() => setHasStartedPlayback(true)}
          >
            <MediaProvider />
            {/* Click-anywhere-on-the-video-to-toggle, like every other
                player. Deliberately NOT Vidstack's own <Gesture> primitive:
                for any non-"dbl"-prefixed event it unconditionally waits
                250ms before firing (source: vidstack's Gesture#acceptEvent),
                purely to disambiguate from a double-tap gesture -- overhead
                that buys nothing here since this player has no double-tap
                gesture registered. A plain onClick calling the player
                directly has zero such delay. Placed before the controls in
                DOM order so a real control click still lands on the
                control, not this. */}
            <Box
              onClick={() => {
                if (playerRef.current?.paused) safePlay();
                else safePause();
              }}
              sx={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
            />
            <LibraryVideoPlayerControls clipMarkers={clipMarkers} />
          </MediaPlayer>
          {/* Vidstack's own <Poster> component hard-rejects any src scheme
              outside http/https/data/blob -- our custom app-video:// scheme
              throws at render time ("MediaImage src can only be of
              http/https/data/blob scheme"), so it can never be used for a
              local thumbnail file here. A plain <img>, painted only until
              playback starts, does the same job without going through
              Vidstack's media-loading pipeline at all -- exactly what the
              native <video poster> attribute did before the Vidstack swap. */}
          {!hasStartedPlayback && posterSrc &&
            <Box
              component="img"
              src={posterSrc}
              alt=""
              sx={{ ...fillSx, position: 'absolute', top: 0, left: 0, objectFit: 'cover', pointerEvents: 'none' }}
            />}
          {!hasStartedPlayback &&
            <IconButton
              onClick={safePlay}
              aria-label="Play"
              sx={{
                position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                color: 'common.white', backgroundColor: 'rgba(0, 0, 0, 0.4)',
                '&:hover': { backgroundColor: 'rgba(0, 0, 0, 0.6)' },
              }}
            >
              <PlayCircleOutlineIcon sx={{ fontSize: 64 }} />
            </IconButton>}
        </Box>
      </ResizableMediaContainer>
    );
  }

  // Every remaining state (preparingPreview/previewFailed/runtimeFailed) is a
  // variant of the same static-poster layout -- a progress bar while a
  // preview is being generated, one of three explanatory captions once it
  // isn't going to play. Names the actual extension rather than a generic
  // "can't be played" -- the Downloader tab lets users deliberately choose
  // mkv/3gp as a conversion target, so landing here isn't necessarily a bug.
  return (
    <ResizableMediaContainer sx={containerSx}>
      <Box sx={{ ...fillSx, position: 'relative' }}>
        <CardMedia
          component="div"
          image={posterSrc}
          sx={{ ...fillSx, backgroundColor: 'grey.800', backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
        {state.kind === 'preparingPreview' &&
          <Box sx={{ position: 'absolute', bottom: 8, left: 8, right: 8 }}>
            <Typography variant="caption" sx={{ color: 'common.white' }}>Preparing preview...</Typography>
            <LinearProgressWithLabel value={state.percent} valueBuffer={state.percent} />
          </Box>}
        {state.kind !== 'preparingPreview' &&
          <Typography
            variant="caption"
            sx={{
              position: 'absolute', bottom: 8, left: 8, right: 8,
              color: 'common.white', bgcolor: 'rgba(0, 0, 0, 0.6)',
              px: 1, py: 0.5, borderRadius: 1,
            }}
          >
            {state.kind === 'runtimeFailed' && `This .${ext} file couldn't be played here -- use the "Open externally" option.`}
            {state.kind === 'previewFailed' && `Couldn't prepare a playable preview for this .${ext} file -- use the "Open externally" option.`}
          </Typography>}
      </Box>
    </ResizableMediaContainer>
  );
});

export default LibraryVideoPlayer;
