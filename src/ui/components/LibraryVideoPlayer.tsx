import { Box, CardMedia } from '@mui/material';
import type { LibraryVideoMetadata } from '../screens/LibraryVideoDetail';
import YouTubeEmbed from './YouTubeEmbed';
import ResizableMediaContainer from './ResizableMediaContainer';
import { buildAppVideoUrl } from '../../utils/utils.ts';

// Only mp4/webm play reliably in Chromium's <video> element -- MKV is a
// Chromium container-parsing limitation that no delivery mechanism (custom
// protocol or otherwise) can work around, even though it's one of this
// app's own three download format choices. That's exactly why "open in
// default player" exists as an unconditional button in LibraryVideoDetail --
// this component just quietly falls back to the static thumbnail rather
// than attempting a player that would fail to load.
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

  if (PLAYABLE_VIDEO_EXTENSIONS.has(getExtension(downloadedFilePath))) {
    return (
      <ResizableMediaContainer sx={containerSx}>
        <Box
          component="video"
          controls
          poster={posterSrc}
          src={buildAppVideoUrl(downloadedFilePath, cacheBustKey)}
          sx={{ ...fillSx, backgroundColor: 'black', objectFit: 'contain' }}
        />
      </ResizableMediaContainer>
    );
  }

  return (
    <ResizableMediaContainer sx={containerSx}>
      <CardMedia
        component="div"
        image={posterSrc}
        sx={{ ...fillSx, backgroundColor: 'grey.800', backgroundSize: 'cover', backgroundPosition: 'center' }}
      />
    </ResizableMediaContainer>
  );
}
