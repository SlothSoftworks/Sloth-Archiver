import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Box, CardMedia, IconButton, Typography } from '@mui/material';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import type { LibraryVideoMetadata } from '../screens/LibraryVideoDetail';
import YouTubeEmbed from './YouTubeEmbed';
import ResizableMediaContainer from './ResizableMediaContainer';
import { buildAppVideoUrl } from '../../utils/utils.ts';

// Exposed so LibraryVideoDetail.tsx's clip tool can grab "wherever playback
// currently is" for its "Set as start"/"Set as end" buttons -- the <video>
// element (and its currentTime) only exists inside this component, which
// otherwise has no reason to hand anything back up to its parent. Returns
// null when there's no actual local video element mounted right now (no
// downloaded file yet, or a downloaded container this player can't play at
// all -- see PLAYABLE_VIDEO_EXTENSIONS below), rather than a misleading 0.
export type LibraryVideoPlayerHandle = {
  getCurrentTime: () => number | null;
};

// Only mp4/webm play reliably in Chromium's <video> element -- MKV is a
// Chromium container-parsing limitation that no delivery mechanism (custom
// protocol or otherwise) can work around, even though it used to be a
// possible outcome of a default (no explicit format chosen) download before
// buildDownloadArgs (main.js) started forcing --merge-output-format mp4.
// That's exactly why "open in default player" exists as an unconditional
// button in LibraryVideoDetail -- this component just quietly falls back to
// the static thumbnail rather than attempting a player known to fail to
// load, for any file downloaded before that fix (or any other container
// Chromium doesn't support landing here some other way).
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
  // Extension alone says "this container is a Chromium demuxer can at least
  // attempt", not "this exact file will actually decode" -- an unusual codec
  // inside an otherwise-playable mp4/webm, or a truncated/corrupt file, can
  // still fail at runtime. playbackFailed catches that case via the <video>
  // element's own error event, so this component degrades to the same
  // thumbnail-plus-"open externally" fallback as a known-unplayable
  // extension, instead of leaving a black, silently-broken player on screen.
  const [playbackFailed, setPlaybackFailed] = useState(false);
  // Purely a one-time "you can start playback here" affordance, not a
  // persistent pause indicator -- once the video has ever started playing
  // for this file, the overlay is gone for good (native controls already
  // handle play/pause from then on). Resets alongside playbackFailed
  // whenever the underlying file actually changes.
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    setPlaybackFailed(false);
    setHasStartedPlayback(false);
  }, [downloadedFilePath, cacheBustKey]);

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => (videoRef.current ? videoRef.current.currentTime : null),
  }), []);

  // Prefer the locally-cached, offline-capable copy (video-level, shared
  // across every version of this video) over the hotlinked YouTube URL --
  // that URL is still the fallback for entries added before this feature
  // existed, or if the background fetch hasn't landed yet.
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
            // Chromium's native "3 dot" controls menu offers a Download
            // entry by default -- redundant here (this file is already on
            // disk, "Open file location"/"Open in default player" exist
            // right next to this player) and confusing on top of that.
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

  // Named explicitly (the actual extension) rather than a generic "can't be
  // played" -- this app's own Downloader tab lets users deliberately choose
  // mkv/3gp as a conversion target (see SUPPORTED_FORMATS, constants.mjs),
  // so a video landing here in one of those formats isn't necessarily a bug
  // to report, just an expected consequence of that choice the user should
  // be able to recognize at a glance.
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
