import { useState } from 'react';
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';

// Mirrors listLibraryTags' return shape (library.mjs) -- see LibraryScreen.tsx's
// own copy of this type for why it isn't shared/imported across screens.
type LibraryTag = {
  tagName: string;
  folderName: string;
  createdEpoch: number | null;
};

// options is deliberately the caller's responsibility to filter (excluding
// whichever sublibrary is currently active -- there's nowhere to move a
// video *to* the one it's already in), same as this dialog owning nothing
// beyond its own draft selection, matching CreateSubLibraryDialog's split.
export default function MoveToSubLibraryDialog({ open, onClose, count, options, moving, error, onConfirm }: {
  open: boolean;
  onClose: () => void;
  count: number;
  options: LibraryTag[];
  moving: boolean;
  error: string | null;
  onConfirm: (targetTag: string) => void;
}) {
  const [targetTag, setTargetTag] = useState('');

  // The dialog opens with nothing explicitly picked -- defaulting to
  // options[0] the first time it renders with a real list avoids an extra
  // click for the overwhelmingly common case (exactly one other sublibrary
  // to move into). Confirming must use this, not the raw targetTag state,
  // or accepting that default without ever touching the Select would submit
  // an empty target.
  const selectedValue = targetTag || options[0]?.folderName || '';

  const handleClose = () => {
    if (moving) return;
    setTargetTag('');
    onClose();
  };

  const handleConfirm = () => {
    if (!selectedValue) return;
    onConfirm(selectedValue);
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogContent sx={{ pt: 3 }}>
        <DialogContentText sx={{ mb: 2 }}>
          Move {count} selected video{count === 1 ? '' : 's'} (every saved version, clips, and its channel's icon if
          needed) into a different sublibrary.
        </DialogContentText>
        <FormControl size="small" fullWidth>
          <InputLabel id="move-target-library-label">Move to</InputLabel>
          <Select
            labelId="move-target-library-label"
            label="Move to"
            value={selectedValue}
            onChange={(e) => setTargetTag(e.target.value)}
            disabled={moving}
          >
            {options.map((tag) => (
              <MenuItem key={tag.folderName} value={tag.folderName}>{tag.tagName}</MenuItem>
            ))}
          </Select>
        </FormControl>
        {error && <Typography color="error" variant="body2" sx={{ mt: 1, whiteSpace: 'pre-line' }}>{error}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={moving}>Cancel</Button>
        <Button onClick={handleConfirm} variant="contained" disabled={moving || !selectedValue}>
          {moving ? <CircularProgress size={20} /> : 'Move'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
