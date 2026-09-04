import { useState } from 'react';
import {
  Autocomplete,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  TextField,
  Typography,
} from '@mui/material';

// Add-only, mirroring MoveToSubLibraryDialog's controlled shape -- removal
// only ever happens per-video, via VideoTagsPopover on the video detail
// screen. freeSolo Autocomplete (same pattern as the convert-formats field
// in OptionsScreen.tsx) lets picking an existing tag and typing a brand-new
// one share one field, "one at a time" per the decided design.
export default function TagSelectedDialog({ open, onClose, count, options, tagging, error, onConfirm }: {
  open: boolean;
  onClose: () => void;
  count: number;
  options: string[];
  tagging: boolean;
  error: string | null;
  onConfirm: (tagName: string) => void;
}) {
  const [tagName, setTagName] = useState('');

  const handleClose = () => {
    if (tagging) return;
    setTagName('');
    onClose();
  };

  const handleConfirm = () => {
    if (!tagName.trim()) return;
    onConfirm(tagName.trim());
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogContent sx={{ pt: 3 }}>
        <DialogContentText sx={{ mb: 2 }}>
          Tag {count} selected video{count === 1 ? '' : 's'} with an existing tag, or create a new one.
        </DialogContentText>
        <Autocomplete
          freeSolo
          size="small"
          options={options}
          inputValue={tagName}
          onInputChange={(_e, newValue) => setTagName(newValue)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
          disabled={tagging}
          renderInput={(params) => <TextField {...params} autoFocus label="Tag" />}
        />
        {error && <Typography color="error" variant="body2" sx={{ mt: 1, whiteSpace: 'pre-line' }}>{error}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={tagging}>Cancel</Button>
        <Button onClick={handleConfirm} variant="contained" disabled={tagging || !tagName.trim()}>
          {tagging ? <CircularProgress size={20} /> : 'Tag'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
