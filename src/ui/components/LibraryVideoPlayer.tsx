import { useEffect, useState } from 'react';
import { Box, CardMedia, Typography } from '@mui/material';
import type { LibraryVideoMetadata } from '../screens/LibraryVideoDetail';
import YouTubeEmbed from './YouTubeEmbed';
import ResizableMediaContainer from './ResizableMediaContainer';
import { buildAppVideoUrl } from '../../utils/utils.ts';

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
export default function LibraryVideoPlayer({
  metadata,
  thumbnailPath,
  cacheBustKey = 0,
}: {
  metadata: LibraryVideoMetadata;
  thumbnailPath?: string | null;
  cacheBustKey?: number;
}) {
  const { downloadedFilePath, thumbnail, videoId } = metadata;
  // Extension alone says "this container is a Chromium demuxer can at least
  // attempt", not "this exact file will actually decode" -- an unusual codec
  // inside an otherwise-playable mp4/webm, or a truncated/corrupt file, can
  // still fail at runtime. playbackFailed catches that case via the <video>
  // element's own error event, so this component degrades to the same
  // thumbnail-plus-"open externally" fallback as a known-unplayable
  // extension, instead of leaving a black, silently-broken player on screen.
  const [playbackFailed, setPlaybackFailed] = useState(false);
  useEffect(() => {
    setPlaybackFailed(false);
  }, [downloadedFilePath, cacheBustKey]);

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
        <Box
          component="video"
          controls
          poster={posterSrc}
          src={buildAppVideoUrl(downloadedFilePath, cacheBustKey)}
          onError={() => setPlaybackFailed(true)}
          sx={{ ...fillSx, backgroundColor: 'black', objectFit: 'contain' }}
        />
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
}
