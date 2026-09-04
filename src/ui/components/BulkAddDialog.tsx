import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { isValidUrl } from '../../utils/utils.ts';
import { useBulkAddQueue, type BulkAddEntry } from '../hooks/useBulkAddQueue.tsx';

// Fixed set of common quality tiers -- not derived from any specific video's
// own available resolutions, since those aren't known until each entry is
// fetched. Per-video matching happens in useBulkAddQueue's pickClosestResolution.
export const QUALITY_TIERS = ['2160', '1440', '1080', '720', '480', '360', '240', '144', 'MP3'];

// Mirrors listLibraryTags' return shape (library.mjs) -- see LibraryScreen.tsx's
// own copy of this type for why it isn't shared/imported across screens.
type LibraryTag = {
  tagName: string;
  folderName: string;
  createdEpoch: number | null;
};

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
  // Only ever shown/relevant once more than one sublibrary exists -- same
  // fetch-once-on-mount pattern as DownloaderScreen's own copy of this.
  const [libraryTags, setLibraryTags] = useState<LibraryTag[]>([]);
  const [targetLibraryTag, setTargetLibraryTag] = useState('');
  useEffect(() => {
    (async () => {
      const [{ tags }, { activeLibraryTag }] = await Promise.all([
        window.electronAPI.listLibraryTags(),
        window.electronAPI.getActiveLibraryTag(),
      ]);
      setLibraryTags(tags);
      setTargetLibraryTag(activeLibraryTag);
    })();
  }, []);

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

    // Each line is classified independently, so one submission can mix a
    // playlist link with plain video links.
    const lines = trimmed.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);

    const invalid = lines.filter((l) => !isValidUrl(l));
    if (invalid.length > 0) {
      setError(`${invalid.length} of ${lines.length} link(s) aren't valid URLs -- fix or remove them before adding.`);
      return;
    }

    setSubmitting(true);
    try {
      const entryLists = await Promise.all(lines.map(async (line): Promise<BulkAddEntry[]> => {
        if (!isPlaylistUrl(line)) {
          return [{ id: line, title: null, url: line }];
        }
        const result = await window.electronAPI.fetchPlaylistEntries(line);
        if (!result.success || !result.entries) {
          throw new Error(result.message || `Failed to fetch playlist: ${line}`);
        }
        return result.entries.map((e) => ({ ...e, videoId: e.id, playlistId: result.playlistId }));
      }));
      const entries = entryLists.flat();
      if (entries.length === 0) {
        throw new Error('No videos found.');
      }
      start(entries, { download, targetResolution, targetLibraryTag: targetLibraryTag || undefined });
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
          {libraryTags.length > 1 &&
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="bulk-add-target-library-label">Add to</InputLabel>
              <Select
                labelId="bulk-add-target-library-label"
                label="Add to"
                value={targetLibraryTag}
                onChange={(e) => setTargetLibraryTag(e.target.value)}
                disabled={submitting}
              >
                {libraryTags.map((tag) => (
                  <MenuItem key={tag.folderName} value={tag.folderName}>{tag.tagName}</MenuItem>
                ))}
              </Select>
            </FormControl>}
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
