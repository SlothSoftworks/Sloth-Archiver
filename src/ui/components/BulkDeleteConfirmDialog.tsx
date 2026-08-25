import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '@mui/material';

// Bulk counterpart to LibraryVideoDetail.tsx's single-delete confirmation
// dialog -- same shape/tone, just count-aware.
export default function BulkDeleteConfirmDialog({ open, count, deleting, error, onCancel, onConfirm }: {
  open: boolean;
  count: number;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onClose={() => !deleting && onCancel()}>
      <DialogTitle>Delete {count} video{count === 1 ? '' : 's'}?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          This deletes the tracked entries, their metadata, and any downloaded files from your library folder.
          This can't be undone.
        </DialogContentText>
        {error && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{error}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={deleting}>Cancel</Button>
        <Button onClick={onConfirm} color="error" variant="contained" disabled={deleting}>
          {deleting ? <CircularProgress size={20} /> : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
