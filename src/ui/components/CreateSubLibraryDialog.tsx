import { useState } from 'react';
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  TextField,
  Typography,
  DialogTitle,
} from '@mui/material';

// Pure UI, same split as BulkDownloadQualityDialog: this owns the text
// field's own draft value, the caller owns the actual createLibraryTag IPC
// call plus its loading/error state, since only the caller knows what to do
// once creation succeeds (switch to it) or fails (surface the message here).
export default function CreateSubLibraryDialog({ open, onClose, creating, error, onConfirm }: {
  open: boolean;
  onClose: () => void;
  creating: boolean;
  error: string | null;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState('');

  const handleClose = () => {
    if (creating) return;
    setName('');
    onClose();
  };

  const handleConfirm = () => {
    if (!name.trim()) return;
    onConfirm(name.trim());
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>Add new sublibrary</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Creates a separate section of your library, kept apart from your other sublibraries until you switch back.
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Sublibrary name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
          disabled={creating}
        />
        {error && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{error}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={creating}>Cancel</Button>
        <Button onClick={handleConfirm} variant="contained" disabled={creating || !name.trim()}>
          {creating ? <CircularProgress size={20} /> : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
