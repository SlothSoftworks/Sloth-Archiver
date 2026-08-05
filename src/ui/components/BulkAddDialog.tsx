import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { isValidUrl } from '../../utils/utils.ts';
import { useBulkAddQueue, type BulkAddEntry } from '../hooks/useBulkAddQueue.tsx';

// A fixed, hardcoded set of common YouTube quality tiers -- not derived from
// any specific video's own available resolutions (those aren't known until
// each entry's info is actually fetched, one at a time, once the queue is
// already running). Per-video matching against whichever of these is picked
// happens in useBulkAddQueue's pickClosestResolution.
const QUALITY_TIERS = ['2160', '1440', '1080', '720', '480', '360', '240', '144', 'MP3'];

function isPlaylistUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.has('list');
  } catch {
    return false;
  }
}

export default function BulkAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { start } = useBulkAddQueue();
  const [input, setInput] = useState('');
  const [download, setDownload] = useState(false);
  const [targetResolution, setTargetResolution] = useState('720');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    setInput('');
    setError(null);
    onClose();
  };

  const handleSubmit = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setError(null);

    // A single line that's itself a playlist URL is treated as "fetch the
    // whole playlist" -- anything else (one or more lines) is treated as an
    // explicit list of individual video links, comma- or newline-separated.
    const lines = trimmed.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
    const isSinglePlaylist = lines.length === 1 && isPlaylistUrl(lines[0]);

    if (!isSinglePlaylist) {
      const invalid = lines.filter((l) => !isValidUrl(l));
      if (invalid.length > 0) {
        setError(`${invalid.length} of ${lines.length} link(s) aren't valid URLs -- fix or remove them before adding.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      let entries: BulkAddEntry[];
      let playlistId: string | undefined;
      if (isSinglePlaylist) {
        const result = await window.electronAPI.fetchPlaylistEntries(lines[0]);
        if (!result.success || !result.entries) {
          throw new Error(result.message || 'Failed to fetch playlist.');
        }
        entries = result.entries.map((e) => ({ ...e, videoId: e.id }));
        playlistId = result.playlistId;
      } else {
        entries = lines.map((url) => ({ id: url, title: null, url }));
      }
      if (entries.length === 0) {
        throw new Error('No videos found.');
      }
      start(entries, { download, targetResolution, playlistId });
      setInput('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start bulk add.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Bulk add</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Paste a single YouTube playlist link, or a comma/newline-separated list of individual video links.
          </Typography>
          <TextField
            multiline
            minRows={4}
            maxRows={10}
            fullWidth
            placeholder={'https://www.youtube.com/playlist?list=...\nor\nhttps://youtu.be/abc, https://youtu.be/def'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={submitting}
          />
          <FormControlLabel
            control={<Switch checked={download} onChange={(e) => setDownload(e.target.checked)} disabled={submitting} />}
            label="Also download each video (not just add to the library)"
          />
          {download &&
            <Select
              size="small"
              value={targetResolution}
              onChange={(e) => setTargetResolution(e.target.value)}
              disabled={submitting}
            >
              {QUALITY_TIERS.map((tier) => (
                <MenuItem key={tier} value={tier}>{tier === 'MP3' ? 'MP3' : `${tier}p`}</MenuItem>
              ))}
            </Select>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
        <Button onClick={handleSubmit} variant="contained" disabled={submitting || !input.trim()}>
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
