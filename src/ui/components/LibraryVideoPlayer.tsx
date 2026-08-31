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

// getCurrentTime/getDuration return null (not a misleading 0) when no local
// video is mounted right now.
export type LibraryVideoPlayerHandle = {
  getCurrentTime: () => number | null;
  getDuration: () => number | null;
  seekTo: (seconds: number) => void;
  play: () => void;
  pause: () => void;
};

// undefined here means "don't render these at all" -- how ClipCollectionView's
// player stays unaffected, since clip creation doesn't apply to a clip.
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

// Only mp4/webm play reliably in Chromium's <video> element -- other
// containers (e.g. MKV) are a parsing limitation no delivery mechanism can
// work around. This component quietly falls back to the static thumbnail
// rather than attempting a player known to fail; "open in default player"
// exists in LibraryVideoDetail for exactly this case.
const PLAYABLE_VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot === -1 ? '' : filePath.slice(lastDot + 1).toLowerCase();
}

// Vidstack's own src-type auto-detection doesn't recognize the app's custom
// app-video:// scheme and silently falls back to treating it as a YouTube
// embed (an empty iframe, no error) -- an explicit type sidesteps that
// detection entirely.
function mimeTypeForExtension(ext: string): 'video/webm' | 'video/mp4' {
  return ext === 'webm' ? 'video/webm' : 'video/mp4';
}

// A native-playable extension goes straight to 'ready'. A non-native
// extension (e.g. MKV) starts in 'preparingPreview' while a playable
// derivative is generated, landing on 'ready' or 'previewFailed'.
// 'runtimeFailed' is reachable from either path -- a file that *should* play
// can still fail at actual decode time. computeInitialState below always
// resolves synchronously to preparingPreview/ready on the very first render,
// so there's never a frame where the wrong fallback caption flashes before
// the mount effect corrects it.
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
  return { kind: 'preparingPreview', percent: 0 };
}

const containerSx = { borderRadius: 2 };
const fillSx = { width: '100%', height: '100%', display: 'block' };

// This component only ever renders the video slot: YouTube embed, local
// playback, or a static thumbnail fallback.
const LibraryVideoPlayer = forwardRef<LibraryVideoPlayerHandle, {
  metadata: LibraryVideoMetadata;
  thumbnailPath?: string | null;
  cacheBustKey?: number;
  // Clip Collection's own player points at a clip's file directly, bypassing
  // metadata.downloadedFilePath -- takes priority when present, and never
  // falls back to a YouTube embed, since a clip has no remote-video identity.
  overrideFilePath?: string;
  clipMarkers?: ClipMarkersControl;
}>(function LibraryVideoPlayer({ metadata, thumbnailPath, cacheBustKey = 0, overrideFilePath, clipMarkers }, ref) {
  const { thumbnail, videoId } = metadata;
  const filePath = overrideFilePath ?? metadata.downloadedFilePath;
  const [state, setState] = useState<PlaybackState>(() => computeInitialState(filePath));
  // One-time "you can start playback here" affordance -- gone for good once
  // playback has ever started (native controls take over from there).
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const playerRef = useRef<MediaPlayerInstance>(null);

  const ext = filePath ? getExtension(filePath) : '';
  const isNativePlayable = filePath ? PLAYABLE_VIDEO_EXTENSIONS.has(ext) : false;

  // Extension alone says Chromium's demuxer can attempt this container, not
  // that this exact file will decode -- an unusual codec or a truncated file
  // can still fail at runtime. Caught via the player's error event, degrading
  // to the same fallback as a known-unplayable extension instead of a
  // silently-broken black player.
  useEffect(() => {
    setHasStartedPlayback(false);
    if (!filePath) return;

    if (isNativePlayable) {
      setState({ kind: 'ready', sourcePath: filePath, mimeType: mimeTypeForExtension(ext) });
      return;
    }

    // Non-native extension (e.g. MKV): ask the backend for a cached or
    // freshly-generated playback-only derivative before giving up on this
    // file entirely.
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
  // slow-loading source has actually buffered enough to start. Silently
  // ignoring the rejection is correct since there's nothing more useful to
  // do than "wait and try again," which the player's own UI already invites.
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
  // YouTube URL -- that URL is the fallback while the background fetch
  // hasn't landed yet.
  const posterSrc = thumbnailPath ? buildAppVideoUrl(thumbnailPath) : (thumbnail || undefined);

  if (!filePath) {
    if (overrideFilePath !== undefined) {
      // Clip context: if there's genuinely nothing to play, there's nothing to show.
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
            {/* Click-anywhere-on-the-video-to-toggle. Deliberately NOT
                Vidstack's own <Gesture> primitive: it unconditionally waits
                250ms before firing (to disambiguate from a double-tap
                gesture), overhead that buys nothing here since this player
                has no double-tap gesture registered. A plain onClick has
                zero such delay. Placed before the controls in DOM order so a
                real control click still lands on the control, not this. */}
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
              throws at render time, so it can never be used for a local
              thumbnail file here. A plain <img>, painted only until
              playback starts, does the same job without going through
              Vidstack's media-loading pipeline at all. */}
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

  // Names the actual extension rather than a generic "can't be played" --
  // the Downloader tab lets users deliberately choose mkv/3gp as a
  // conversion target, so landing here isn't necessarily a bug.
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
