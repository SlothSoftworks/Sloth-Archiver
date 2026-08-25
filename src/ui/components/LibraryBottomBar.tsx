import { Box, Button, Paper, Slider, Stack, Typography } from '@mui/material';
import PhotoSizeSelectSmallIcon from '@mui/icons-material/PhotoSizeSelectSmall';
import PhotoSizeSelectLargeIcon from '@mui/icons-material/PhotoSizeSelectLarge';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteIcon from '@mui/icons-material/Delete';

export const THUMBNAIL_SIZE_MIN = 160;
export const THUMBNAIL_SIZE_MAX = 360;
export const THUMBNAIL_SIZE_STEP = 10;

// Persistent bottom bar for the Library tab's video grids -- a container for
// display/customization controls, not a single-purpose slider widget. Ships
// with thumbnail size and bulk-select actions; the left region was reserved
// for exactly this kind of addition without restructuring the component.
// Purely presentational/controlled, same pattern as LibraryViewModeToggle --
// LibraryScreen owns the state and the settings IPC round-trip.
export default function LibraryBottomBar({
  thumbnailSize, onThumbnailSizeChange, onThumbnailSizeCommit,
  selectedCount, canBulkDownload, onDownloadSelected, onDeleteSelected,
}: {
  thumbnailSize: number;
  onThumbnailSizeChange: (size: number) => void;
  onThumbnailSizeCommit: (size: number) => void;
  selectedCount: number;
  canBulkDownload: boolean;
  onDownloadSelected: () => void;
  onDeleteSelected: () => void;
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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minHeight: 32 }}>
        {selectedCount > 0 &&
          <>
            <Typography variant="body2">{selectedCount} item{selectedCount === 1 ? '' : 's'} selected</Typography>
            {canBulkDownload &&
              <Button size="small" variant="outlined" startIcon={<DownloadIcon fontSize="small" />} onClick={onDownloadSelected}>
                Download selected
              </Button>}
            <Button size="small" variant="outlined" color="error" startIcon={<DeleteIcon fontSize="small" />} onClick={onDeleteSelected}>
              Delete selected
            </Button>
          </>}
      </Box>
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
