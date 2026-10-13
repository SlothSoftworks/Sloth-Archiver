import { Box, type SxProps, type Theme } from '@mui/material';
import { isValidYouTubeVideoId } from '../../utils/utils.ts';

// youtube-nocookie.com (not youtube.com) + an explicit referrerPolicy -- the
// renderer loads from a real http://127.0.0.1 loopback origin specifically
// so this can carry a real Referer. YouTube's embed player requires one and
// fails with "Error 153: Video player configuration error" without it -- a
// file:// origin, or a custom app:// protocol, both send none no matter
// what's set here.
//
// videoId comes from remote metadata, so it's checked against YouTube's real
// id shape before being spliced into the frame URL (SEC-009) -- an id
// carrying "../", "?" or "#" could otherwise point the frame at a different
// path on that origin. An invalid id renders nothing rather than a frame.
export default function YouTubeEmbed({ videoId, sx }: { videoId: string; sx?: SxProps<Theme> }) {
  if (!isValidYouTubeVideoId(videoId)) return null;
  return (
    <Box
      component="iframe"
      title="YouTube video player"
      src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`}
      referrerPolicy="strict-origin-when-cross-origin"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      sx={{ border: 0, ...sx }}
    />
  );
}
