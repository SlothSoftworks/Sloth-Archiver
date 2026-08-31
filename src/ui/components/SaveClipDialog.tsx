import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { formatClipTimestampInput, parseClipTimestampSeconds, OTHER_FORMAT_VALUE, TRANSCODE_ON_CONVERT_TOOLTIP } from '../screens/FfmpegUtilitiesPanel';
import LinearProgressWithLabel from './LinearProgressWithLabel';

// "Same as source" sentinel -- skips the convert step entirely (fast
// lossless -c copy trim, ffmpegUtils.mjs's clipAndConvert), rather than a
// pointless re-encode into the same container.
const SOURCE_FORMAT_VALUE = 'source';

// Replaces the old save-file-dialog flow for Extract Clip: instead of
// picking an arbitrary disk location, this collects a name (permanent
// library storage, <videoDir>/clips/<name>.<ext>) plus a further-tunable
// start/end and an optional format conversion. Modeled on
// BulkDownloadQualityDialog.tsx's structure.
export default function SaveClipDialog({
  open, onClose, title = 'Save clip', defaultClipStart, defaultClipEnd, convertFormatOptions, existingClipTitles, submitting, progress, error, offerSaveAsFile, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  // e.g. "Save clip to file" for standaloneClipping mode -- makes it clear
  // at a glance that this save behaves differently from the normal
  // library-clip flow.
  title?: string;
  defaultClipStart: string;
  defaultClipEnd: string;
  convertFormatOptions: string[];
  existingClipTitles: string[];
  submitting: boolean;
  progress: number;
  error: string | null;
  // Shows a "Save as file" checkbox -- for callers (currently just
  // LibraryVideoPlayerWithTools) whose normal save has a permanent home
  // (library clips.json) but that also want to offer diverting this
  // particular save to an arbitrary disk location instead.
  offerSaveAsFile?: boolean;
  onSubmit: (payload: { clipName: string; start: string; end: string; format: string; forceReencode: boolean; saveAsFile: boolean }) => void;
}) {
  const [clipName, setClipName] = useState('');
  const [start, setStart] = useState(defaultClipStart);
  const [end, setEnd] = useState(defaultClipEnd);
  const [format, setFormat] = useState(SOURCE_FORMAT_VALUE);
  const [otherFormatInput, setOtherFormatInput] = useState('');
  const [forceReencode, setForceReencode] = useState(false);
  const [saveAsFile, setSaveAsFile] = useState(false);

  // Re-seed from the panel's current values each time the dialog opens --
  // it may be reopened later with a different range than last time.
  useEffect(() => {
    if (open) {
      setClipName('');
      setStart(defaultClipStart);
      setEnd(defaultClipEnd);
      setFormat(SOURCE_FORMAT_VALUE);
      setOtherFormatInput('');
      setForceReencode(false);
      setSaveAsFile(false);
    }
  }, [open, defaultClipStart, defaultClipEnd]);

  const trimmedName = clipName.trim();
  const isDuplicate = trimmedName.length > 0 && existingClipTitles.some((t) => t.toLowerCase() === trimmedName.toLowerCase());
  const rangeInvalid = !!start.trim() && !!end.trim() && parseClipTimestampSeconds(end) < parseClipTimestampSeconds(start) + 1;
  const resolvedFormat = format === OTHER_FORMAT_VALUE ? otherFormatInput.trim().toLowerCase() : format;
  const canSubmit = !!trimmedName && !isDuplicate && !rangeInvalid && !!start.trim() && !!end.trim()
    && (format !== OTHER_FORMAT_VALUE || !!otherFormatInput.trim()) && !submitting;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ clipName: trimmedName, start: start.trim(), end: end.trim(), format: resolvedFormat, forceReencode, saveAsFile });
  };

  return (
    <Dialog open={open} onClose={() => !submitting && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            size="small"
            label="Clip name"
            value={clipName}
            onChange={(e) => setClipName(e.target.value)}
            disabled={submitting}
            error={isDuplicate}
            helperText={isDuplicate ? 'A clip with this name already exists for this video.' : undefined}
            autoFocus
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              label="Start"
              placeholder="HH:MM:SS"
              value={start}
              onChange={(e) => setStart(formatClipTimestampInput(e.target.value))}
              disabled={submitting}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            />
            <Typography variant="body2" color="text.secondary">–</Typography>
            <TextField
              size="small"
              label="End"
              placeholder="HH:MM:SS"
              value={end}
              onChange={(e) => setEnd(formatClipTimestampInput(e.target.value))}
              disabled={submitting}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            />
          </Stack>
          {rangeInvalid &&
            <Typography variant="caption" color="error">End must be at least 1 second after start.</Typography>}

          <Select size="small" value={format} onChange={(e) => setFormat(e.target.value)} disabled={submitting}>
            <MenuItem value={SOURCE_FORMAT_VALUE}>Same as source</MenuItem>
            {convertFormatOptions.map((f) => (
              <MenuItem key={f} value={f.toLowerCase()}>{f.toUpperCase()}</MenuItem>
            ))}
            <MenuItem value={OTHER_FORMAT_VALUE}>Other...</MenuItem>
          </Select>
          {format === OTHER_FORMAT_VALUE &&
            <TextField
              size="small"
              variant="standard"
              placeholder="Format name"
              value={otherFormatInput}
              onChange={(e) => setOtherFormatInput(e.target.value)}
              disabled={submitting}
              helperText="Must match a real ffmpeg muxer name (e.g. mp4, matroska, avi)."
            />}
          {format !== SOURCE_FORMAT_VALUE &&
            <Stack direction="row" spacing={0.5} alignItems="center">
              <FormControlLabel
                sx={{ ml: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={forceReencode}
                    onChange={(e) => setForceReencode(e.target.checked)}
                    disabled={submitting}
                  />
                }
                label={<Typography variant="body2">Transcode on convert</Typography>}
              />
              <Tooltip title={TRANSCODE_ON_CONVERT_TOOLTIP}>
                <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
              </Tooltip>
            </Stack>}

          {offerSaveAsFile &&
            <Stack direction="row" spacing={0.5} alignItems="center">
              <FormControlLabel
                sx={{ ml: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={saveAsFile}
                    onChange={(e) => setSaveAsFile(e.target.checked)}
                    disabled={submitting}
                  />
                }
                label={<Typography variant="body2">Save as file</Typography>}
              />
              <Tooltip title="This clip will not be saved to your Clip Collection -- you'll be asked where to save the file instead.">
                <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
              </Tooltip>
            </Stack>}

          {submitting && <LinearProgressWithLabel value={progress} valueBuffer={progress} />}

          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button onClick={handleSubmit} variant="contained" disabled={!canSubmit}>
          Save clip
        </Button>
      </DialogActions>
    </Dialog>
  );
}
