import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Radio,
  RadioGroup,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { formatClipTimestampInput, formatSecondsAsClipTimestamp, parseClipTimestampSeconds } from '../screens/FfmpegUtilitiesPanel';

type ThumbnailMode = 'timestamp' | 'file';

// Player context menu's "Change thumbnail" action -- grabs a frame from the
// video at a given time, or lets the user pick an image file from disk.
// Modeled on SaveClipDialog's controlled-form shape (its own timestamp field
// reuses the same format/parse helpers). Unlike AddLocalFileDialog's
// best-effort thumbnail extraction, a failure here (bad timestamp, corrupt
// image, ffmpeg error) must be shown, not swallowed -- this is a deliberate
// user action, not an auto-fill.
export default function ChangeThumbnailDialog({
  open, onClose, videoDir, downloadedFilePath, initialTimestampSeconds, onThumbnailChanged,
}: {
  open: boolean;
  onClose: () => void;
  videoDir: string;
  // Null when the current epoch has no local video file -- disables
  // "From timestamp" (there's nothing to grab a frame from), but "From file"
  // still works for any library entry.
  downloadedFilePath: string | null;
  initialTimestampSeconds: number | null;
  onThumbnailChanged: () => void;
}) {
  const [mode, setMode] = useState<ThumbnailMode>('timestamp');
  const [timestamp, setTimestamp] = useState('');
  const [imageFilePath, setImageFilePath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed every time the dialog opens, same as SaveClipDialog/
  // AddLocalFileDialog -- it stays mounted across opens, so its own state
  // would otherwise still show the previous attempt.
  useEffect(() => {
    if (open) {
      setMode(downloadedFilePath ? 'timestamp' : 'file');
      setTimestamp(formatSecondsAsClipTimestamp(initialTimestampSeconds ?? 0));
      setImageFilePath(null);
      setSubmitting(false);
      setError(null);
    }
  }, [open, downloadedFilePath, initialTimestampSeconds]);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handlePickImage = async () => {
    const result = await window.electronAPI.openImageFile();
    const filePath = result.filePaths?.[0];
    if (!filePath) return;
    setImageFilePath(filePath);
  };

  const canSubmit = !submitting
    && (mode === 'timestamp' ? !!downloadedFilePath && !!timestamp.trim() : !!imageFilePath);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const res = mode === 'timestamp'
      ? await window.electronAPI.changeThumbnail({
        videoDir, mode: 'timestamp', downloadedFilePath: downloadedFilePath!, timestampSeconds: parseClipTimestampSeconds(timestamp),
      })
      : await window.electronAPI.changeThumbnail({ videoDir, mode: 'file', imageFilePath: imageFilePath! });
    setSubmitting(false);
    if (!res.success) {
      setError(res.message || 'Failed to change thumbnail.');
      return;
    }
    onThumbnailChanged();
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Change thumbnail</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <RadioGroup
            value={mode}
            onChange={(e) => {
              // SAFETY: the two FormControlLabel `value`s below are the only
              // values this RadioGroup can ever report.
              setMode(e.target.value as ThumbnailMode);
            }}
            sx={{ flexDirection: 'row', alignItems: 'flex-start', gap: 2 }}
          >
            <Stack sx={{ flex: 1, minWidth: 0 }} spacing={1}>
              <FormControlLabel value="timestamp" control={<Radio size="small" />} disabled={submitting || !downloadedFilePath} label="From timestamp" />
              <TextField
                size="small"
                label="Timestamp"
                placeholder="HH:MM:SS"
                value={timestamp}
                onChange={(e) => setTimestamp(formatClipTimestampInput(e.target.value))}
                disabled={submitting || mode !== 'timestamp' || !downloadedFilePath}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              />
            </Stack>

            <Stack sx={{ flex: 1, minWidth: 0 }} spacing={1}>
              <FormControlLabel value="file" control={<Radio size="small" />} disabled={submitting} label="From file" />
              <Stack spacing={0.5}>
                <Button variant="outlined" onClick={handlePickImage} disabled={submitting || mode !== 'file'}>
                  Choose image...
                </Button>
                <Typography variant="body2" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {imageFilePath || 'No file selected'}
                </Typography>
              </Stack>
            </Stack>
          </RadioGroup>

          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
        <Button onClick={handleSubmit} variant="contained" disabled={!canSubmit}>
          Change thumbnail
        </Button>
      </DialogActions>
    </Dialog>
  );
}
