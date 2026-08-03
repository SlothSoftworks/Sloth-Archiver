import { Box, type SxProps, type Theme } from '@mui/material';
import type { ReactNode } from 'react';

// A fixed pixel height doesn't scale with the window -- on a wide panel the
// video shrinks to a tiny rectangle inside a much wider bar. aspect-ratio
// keeps a true 16:9 at any container width instead. resize: horizontal (not
// "both") lets the user drag it bigger/smaller while aspect-ratio
// recalculates height to match automatically -- so the ratio can never be
// broken by the resize handle itself, only "both" (independently draggable
// height) could do that.
const baseSx = {
  width: '100%',
  maxWidth: '100%',
  minWidth: 240,
  aspectRatio: '16 / 9',
  overflow: 'hidden',
  resize: 'horizontal',
  position: 'relative',
};

export default function ResizableMediaContainer({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  return <Box sx={{ ...baseSx, ...sx }}>{children}</Box>;
}
