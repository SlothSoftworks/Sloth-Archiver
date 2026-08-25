import { Box, Paper, Slider, Stack } from '@mui/material';
import PhotoSizeSelectSmallIcon from '@mui/icons-material/PhotoSizeSelectSmall';
import PhotoSizeSelectLargeIcon from '@mui/icons-material/PhotoSizeSelectLarge';

export const THUMBNAIL_SIZE_MIN = 160;
export const THUMBNAIL_SIZE_MAX = 360;
export const THUMBNAIL_SIZE_STEP = 10;

// Persistent bottom bar for the Library tab's video grids -- a container for
// display/customization controls, not a single-purpose slider widget. Ships
// with only thumbnail size today; the left region is reserved so future
// controls have an obvious home without restructuring this component. Purely
// presentational/controlled, same pattern as LibraryViewModeToggle --
// LibraryScreen owns the state and the settings IPC round-trip.
export default function LibraryBottomBar({ thumbnailSize, onThumbnailSizeChange, onThumbnailSizeCommit }: {
  thumbnailSize: number;
  onThumbnailSizeChange: (size: number) => void;
  onThumbnailSizeCommit: (size: number) => void;
}) {
  return (
    // A flex sibling of LibraryScreen's own scrollable content region (see
    // LibraryScreen.tsx's return, enabled by CustomTabPanel's `fill` prop in
    // MainPage.tsx) -- not an in-flow scrolling element, so it stays pinned
    // at the tab's bottom regardless of how much content is above it, the
    // same way the top tab bar stays pinned above .tabContainer's scroll
    // region. flexShrink:0 keeps it from being squeezed by a tall grid.
    <Paper
      variant="outlined"
      sx={{
        flexShrink: 0, mt: 2,
        px: 2, py: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2,
      }}
    >
      <Box /> {/* reserved for future display/customization controls */}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: 220 }}>
        <PhotoSizeSelectSmallIcon fontSize="small" color="action" />
        <Slider
          size="small"
          value={thumbnailSize}
          min={THUMBNAIL_SIZE_MIN}
          max={THUMBNAIL_SIZE_MAX}
          step={THUMBNAIL_SIZE_STEP}
          onChange={(_e, value) => onThumbnailSizeChange(value as number)}
          onChangeCommitted={(_e, value) => onThumbnailSizeCommit(value as number)}
          aria-label="Thumbnail size"
        />
        <PhotoSizeSelectLargeIcon fontSize="small" color="action" />
      </Stack>
    </Paper>
  );
}
