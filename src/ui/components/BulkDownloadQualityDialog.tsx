import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { QUALITY_TIERS } from './BulkAddDialog';

// Narrower than the full LibraryVideoMetadata -- this dialog only reads
// originalUrl, so callers (and tests) don't need to supply every field.
type SelectedVideo = { videoDir: string; metadata: { originalUrl: string | null } };

// One resolution for the whole batch -- deliberately no per-video picker.
// Pure UI: the actual queuing happens in the caller via useBulkAddQueue's start().
export default function BulkDownloadQualityDialog({ open, onClose, videos, onConfirm }: {
  open: boolean;
  onClose: () => void;
  videos: SelectedVideo[];
  onConfirm: (targetResolution: string) => void;
}) {
  const [targetResolution, setTargetResolution] = useState('720');

  // Entries without a saved source URL can't be re-fetched for a download,
  // so they're excluded from the queued batch; this warning is the only
  // place that's surfaced to the user.
  const skippedCount = videos.filter((v) => !v.metadata.originalUrl).length;

  const handleConfirm = () => {
    onConfirm(targetResolution);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Download {videos.length} selected video{videos.length === 1 ? '' : 's'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Select
            size="small"
            value={targetResolution}
            onChange={(e) => setTargetResolution(e.target.value)}
          >
            {QUALITY_TIERS.map((tier) => (
              <MenuItem key={tier} value={tier}>{tier === 'MP3' ? 'MP3' : `${tier}p`}</MenuItem>
            ))}
          </Select>
          <Typography variant="caption" color="text.secondary">
            Each video downloads at the highest quality it has available, up to your chosen resolution -- not every
            video necessarily offers this exact tier.
          </Typography>
          {skippedCount > 0 &&
            <Alert severity="warning">
              {skippedCount} of {videos.length} selected video{skippedCount === 1 ? '' : 's'} {skippedCount === 1 ? 'has' : 'have'} no
              saved source link and will be skipped.
            </Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleConfirm} variant="contained" disabled={skippedCount === videos.length}>
          Queue Download
        </Button>
      </DialogActions>
    </Dialog>
  );
}
