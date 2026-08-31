import { Box, Button, Paper, Slider, Stack, Typography } from '@mui/material';
import PhotoSizeSelectSmallIcon from '@mui/icons-material/PhotoSizeSelectSmall';
import PhotoSizeSelectLargeIcon from '@mui/icons-material/PhotoSizeSelectLarge';
import DownloadIcon from '@mui/icons-material/Download';
import FolderDeleteIcon from '@mui/icons-material/FolderDelete';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';

export const THUMBNAIL_SIZE_MIN = 160;
export const THUMBNAIL_SIZE_MAX = 360;
export const THUMBNAIL_SIZE_STEP = 10;

// Purely presentational/controlled -- the caller owns the state and any
// settings IPC round-trip. Thumbnail-size props are optional: the Playlists
// view has no thumbnail grid to size, so omitting them hides that section
// entirely rather than showing an irrelevant control.
export default function LibraryBottomBar({
  thumbnailSize, onThumbnailSizeChange, onThumbnailSizeCommit,
  selectedCount, canBulkDownload, onDownloadSelected,
  canDeleteLocalFiles, onDeleteLocalFiles, onDeleteFromLibrary,
}: {
  thumbnailSize?: number;
  onThumbnailSizeChange?: (size: number) => void;
  onThumbnailSizeCommit?: (size: number) => void;
  selectedCount: number;
  canBulkDownload: boolean;
  onDownloadSelected: () => void;
  canDeleteLocalFiles: boolean;
  onDeleteLocalFiles: () => void;
  onDeleteFromLibrary: () => void;
}) {
  return (
    // A flex sibling of the scrollable content region, not an in-flow
    // scrolling element, so it stays pinned at the tab's bottom regardless of
    // how much content is above it. flexShrink:0 keeps it from being
    // squeezed by a tall grid.
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
            {canDeleteLocalFiles &&
              <Button size="small" variant="outlined" color="error" startIcon={<FolderDeleteIcon fontSize="small" />} onClick={onDeleteLocalFiles}>
                Delete local files
              </Button>}
            <Button size="small" variant="outlined" color="error" startIcon={<DeleteForeverIcon fontSize="small" />} onClick={onDeleteFromLibrary}>
              Delete from library
            </Button>
          </>}
      </Box>
      {thumbnailSize !== undefined && onThumbnailSizeChange && onThumbnailSizeCommit &&
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
        </Stack>}
    </Paper>
  );
}
