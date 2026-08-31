import { Box, type SxProps, type Theme } from '@mui/material';

// youtube-nocookie.com (not youtube.com) + an explicit referrerPolicy -- the
// renderer loads from a real http://127.0.0.1 loopback origin specifically
// so this can carry a real Referer. YouTube's embed player requires one and
// fails with "Error 153: Video player configuration error" without it -- a
// file:// origin, or a custom app:// protocol, both send none no matter
// what's set here.
export default function YouTubeEmbed({ videoId, sx }: { videoId: string; sx?: SxProps<Theme> }) {
  return (
    <Box
      component="iframe"
      title="YouTube video player"
      src={`https://www.youtube-nocookie.com/embed/${videoId}`}
      referrerPolicy="strict-origin-when-cross-origin"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      sx={{ border: 0, ...sx }}
    />
  );
}
