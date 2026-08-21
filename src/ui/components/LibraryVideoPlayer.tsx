import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Box, CardMedia, IconButton, Typography } from '@mui/material';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import type { LibraryVideoMetadata } from '../screens/LibraryVideoDetail';
import YouTubeEmbed from './YouTubeEmbed';
import ResizableMediaContainer from './ResizableMediaContainer';
import { buildAppVideoUrl } from '../../utils/utils.ts';

// Exposed so LibraryVideoDetail.tsx's clip tool can grab "wherever playback
// currently is" for its "Set as start"/"Set as end" buttons -- the <video>
// element only exists inside this component. Returns null (not a misleading
// 0) when no local video element is mounted right now.
export type LibraryVideoPlayerHandle = {
  getCurrentTime: () => number | null;
};

// Only mp4/webm play reliably in Chromium's <video> element -- MKV is a
// container-parsing limitation no delivery mechanism can work around, and
// could still land here from a download made before buildDownloadArgs
// (main.js) started forcing --merge-output-format mp4. This component
// quietly falls back to the static thumbnail rather than attempting a
// player known to fail; "open in default player" exists in
// LibraryVideoDetail for exactly this case.
const PLAYABLE_VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot === -1 ? '' : filePath.slice(lastDot + 1).toLowerCase();
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
}>(function LibraryVideoPlayer({ metadata, thumbnailPath, cacheBustKey = 0 }, ref) {
  const { downloadedFilePath, thumbnail, videoId } = metadata;
  // Extension alone says Chromium's demuxer can attempt this container, not
  // that this exact file will decode -- an unusual codec or a truncated file
  // can still fail at runtime. Catches that via the <video> element's error
  // event, degrading to the same fallback as a known-unplayable extension
  // instead of a silently-broken black player.
  const [playbackFailed, setPlaybackFailed] = useState(false);
  // One-time "you can start playback here" affordance, not a persistent
  // pause indicator -- gone for good once playback has ever started (native
  // controls take over from there). Resets alongside playbackFailed when the
  // file changes.
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    setPlaybackFailed(false);
    setHasStartedPlayback(false);
  }, [downloadedFilePath, cacheBustKey]);

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => (videoRef.current ? videoRef.current.currentTime : null),
  }), []);

  // Prefer the locally-cached, offline-capable thumbnail over the hotlinked
  // YouTube URL -- that URL is the fallback for entries added before this
  // feature existed, or while the background fetch hasn't landed yet.
  const posterSrc = thumbnailPath ? buildAppVideoUrl(thumbnailPath) : (thumbnail || undefined);

  if (!downloadedFilePath) {
    return (
      <ResizableMediaContainer sx={containerSx}>
        <YouTubeEmbed videoId={videoId} sx={fillSx} />
      </ResizableMediaContainer>
    );
  }

  const ext = getExtension(downloadedFilePath);
  const isKnownUnplayable = !PLAYABLE_VIDEO_EXTENSIONS.has(ext);

  if (!isKnownUnplayable && !playbackFailed) {
    return (
      <ResizableMediaContainer sx={containerSx}>
        <Box sx={{ ...fillSx, position: 'relative' }}>
          <Box
            component="video"
            ref={videoRef}
            controls
            // Chromium's native controls menu offers a Download entry by
            // default -- redundant and confusing here since the file is
            // already on disk with its own "Open" controls nearby.
            controlsList="nodownload"
            poster={posterSrc}
            src={buildAppVideoUrl(downloadedFilePath, cacheBustKey)}
            onError={() => setPlaybackFailed(true)}
            onPlay={() => setHasStartedPlayback(true)}
            sx={{ ...fillSx, backgroundColor: 'black', objectFit: 'contain' }}
          />
          {!hasStartedPlayback &&
            <IconButton
              onClick={() => videoRef.current?.play()}
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
  // conversion target, so landing here isn't necessarily a bug to report.
  return (
    <ResizableMediaContainer sx={containerSx}>
      <Box sx={{ ...fillSx, position: 'relative' }}>
        <CardMedia
          component="div"
          image={posterSrc}
          sx={{ ...fillSx, backgroundColor: 'grey.800', backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
        <Typography
          variant="caption"
          sx={{
            position: 'absolute', bottom: 8, left: 8, right: 8,
            color: 'common.white', bgcolor: 'rgba(0, 0, 0, 0.6)',
            px: 1, py: 0.5, borderRadius: 1,
          }}
        >
          {playbackFailed
            ? `This .${ext} file couldn't be played here -- use the "Open externally" option.`
            : `Downloaded as .${ext}, which this embedded player can't play -- use the "Open externally" option.`}
        </Typography>
      </Box>
    </ResizableMediaContainer>
  );
});

export default LibraryVideoPlayer;
