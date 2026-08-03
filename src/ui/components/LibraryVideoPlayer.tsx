import { Box, CardMedia } from '@mui/material';
import type { LibraryVideoMetadata } from '../screens/LibraryVideoDetail';
import YouTubeEmbed from './YouTubeEmbed';
import ResizableMediaContainer from './ResizableMediaContainer';

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

// filePath is a full absolute path already resolved server-side (see
// findFinalFile in main.js) -- this URL is only ever built from that trusted
// value, never from arbitrary/user-typed input. cacheBustKey is appended as
// a query param (ignored by the protocol handler, which only reads the
// pathname) so a "download different quality" swap that lands back on the
// exact same path+extension still forces a real reload instead of the
// <video> element silently continuing to show the old cached bytes under an
// unchanged src string.
function buildAppVideoUrl(filePath: string, cacheBustKey: number): string {
  return `app-video://local/${encodeURIComponent(filePath)}?v=${cacheBustKey}`;
}

const containerSx = { borderRadius: 2 };
const fillSx = { width: '100%', height: '100%', display: 'block' };

export default function LibraryVideoPlayer({ metadata, cacheBustKey = 0 }: { metadata: LibraryVideoMetadata; cacheBustKey?: number }) {
  const { downloadedFilePath, downloadedResolution, thumbnail, videoId } = metadata;

  if (!downloadedFilePath) {
    return (
      <ResizableMediaContainer sx={containerSx}>
        <YouTubeEmbed videoId={videoId} sx={fillSx} />
      </ResizableMediaContainer>
    );
  }

  if (downloadedResolution === 'MP3') {
    return (
      <ResizableMediaContainer sx={containerSx}>
        <CardMedia
          component="div"
          image={thumbnail || undefined}
          sx={{ height: '100%', backgroundColor: 'grey.800', backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
        <Box sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, p: 1, backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <Box component="audio" controls src={buildAppVideoUrl(downloadedFilePath, cacheBustKey)} sx={{ width: '100%' }} />
        </Box>
      </ResizableMediaContainer>
    );
  }

  if (PLAYABLE_VIDEO_EXTENSIONS.has(getExtension(downloadedFilePath))) {
    return (
      <ResizableMediaContainer sx={containerSx}>
        <Box
          component="video"
          controls
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
        image={thumbnail || undefined}
        sx={{ ...fillSx, backgroundColor: 'grey.800', backgroundSize: 'cover', backgroundPosition: 'center' }}
      />
    </ResizableMediaContainer>
  );
}
