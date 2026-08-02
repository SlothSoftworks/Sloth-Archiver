import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

export default function OptionsScreen() {
  const [cookieLoaded, setCookieLoaded] = useState(false);
  const [cookieCount, setCookieCount] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cookieText, setCookieText] = useState('');
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');

  const refreshStatus = async () => {
    const status = await window.electronAPI.getCookieStatus();
    setCookieLoaded(status.loaded);
    setCookieCount(status.cookieCount);
  };

  useEffect(() => {
    refreshStatus();
  }, []);

  const handleOpenDialog = () => {
    setCookieText('');
    setError('');
    setSavedMessage('');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!cookieText.trim()) {
      setError("Paste your cookie text before saving.");
      return;
    }
    try {
      const result = await window.electronAPI.saveCookie(cookieText);
      await refreshStatus();
      if (result.skipped > 0) {
        setError(`Saved ${result.cookieCount} cookie(s), but ${result.skipped} line(s) couldn't be parsed. Try re-copying the cookie text -- a long value may have picked up stray line breaks when copied.`);
        return;
      }
      setDialogOpen(false);
      setSavedMessage(`Saved ${result.cookieCount} cookie(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save cookie.');
    }
  };

  const handleDelete = async () => {
    await window.electronAPI.deleteCookie();
    await refreshStatus();
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Personal Cookie</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 640 }}>
        Loading a personal YouTube cookie lets requests authenticate as you, which can help avoid
        "Sign in to confirm you're not a bot" errors. Paste either a Netscape-format cookies.txt
        export or the raw cookie header value copied from your browser's developer tools.
      </Typography>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button variant="contained" onClick={handleOpenDialog}>
          Load personal cookie
        </Button>
        <Button variant="outlined" color="error" onClick={handleDelete} disabled={!cookieLoaded}>
          Delete cookie
        </Button>
        <Chip
          label={cookieLoaded ? `Cookie loaded (${cookieCount})` : 'No cookie loaded'}
          color={cookieLoaded ? 'success' : 'default'}
          variant="outlined"
        />
      </Stack>
      {savedMessage &&
        <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>{savedMessage}</Typography>}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Load personal cookie</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Paste your YouTube cookie text below. This is stored locally and only used to
            authenticate your own download requests.
          </DialogContentText>
          <TextField
            autoFocus
            multiline
            minRows={6}
            fullWidth
            variant="outlined"
            placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t...\n\nor: CONSENT=YES+42; VISITOR_INFO1_LIVE=...; ..."}
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            error={!!error}
            helperText={error}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSave}>Save</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
