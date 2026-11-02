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
// startSeconds is how the transcript seeks a video that isn't downloaded:
// a plain iframe can't be seeked, so the caller re-keys it to reload there.
export default function YouTubeEmbed({ videoId, startSeconds, sx }: { videoId: string; startSeconds?: number | null; sx?: SxProps<Theme> }) {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const query = startSeconds != null ? `?start=${Math.floor(startSeconds)}&autoplay=1` : '';
  return (
    <Box
      component="iframe"
      title="YouTube video player"
      src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}${query}`}
      referrerPolicy="strict-origin-when-cross-origin"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      sx={{ border: 0, ...sx }}
    />
  );
}
