import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import type { LibraryExportCounts, LibraryImportSummary } from '../../types/electron-api';

type Notice = { severity: 'success' | 'error' | 'info'; text: string };
type ImportPreview = {
  token: string;
  fileName: string;
  exportedAt: string | null;
  counts: LibraryExportCounts;
  plan: LibraryImportSummary;
};

function plural(n: number, singular: string, pluralForm = `${singular}s`) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

// One line per non-zero outcome, in the order a user cares about.
function describeImportSummary(summary: LibraryImportSummary): string[] {
  const lines: string[] = [];
  if (summary.videosAdded) lines.push(plural(summary.videosAdded, 'new video'));
  const extraVersions = summary.versionsAdded - summary.videosAdded;
  if (extraVersions > 0) lines.push(`${plural(extraVersions, 'additional version')} of videos`);
  if (summary.sublibrariesCreated) lines.push(plural(summary.sublibrariesCreated, 'new sublibrary', 'new sublibraries'));
  if (summary.playlistsAdded) lines.push(plural(summary.playlistsAdded, 'saved playlist'));
  if (summary.labelsApplied) lines.push(`${plural(summary.labelsApplied, 'label')} applied`);
  if (summary.videosAlreadyPresent) lines.push(`${plural(summary.videosAlreadyPresent, 'video')} already in your library (left as is)`);
  if (summary.playlistsAlreadyPresent) lines.push(`${plural(summary.playlistsAlreadyPresent, 'playlist')} already saved (left as is)`);
  if (summary.localFilesSkipped) lines.push(`${plural(summary.localFilesSkipped, 'local-file entry', 'local-file entries')} skipped -- there's no source to download those from`);
  if (summary.invalidSkipped) lines.push(`${plural(summary.invalidSkipped, 'damaged entry', 'damaged entries')} skipped`);
  return lines;
}

// Options -> "Library Backup". Export writes every sublibrary's metadata to
// one JSON file; import previews what a file would add, then adds it. Both
// file dialogs are opened by the main process (library:exportToFile /
// library:previewImport).
export default function LibraryBackupSection({ libraryConfigured }: { libraryConfigured: boolean }) {
  const [busy, setBusy] = useState<'export' | 'preview' | 'import' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const handleExport = async () => {
    setBusy('export');
    setNotice(null);
    try {
      const result = await window.electronAPI.exportLibrary();
      if (result.canceled) return;
      if (!result.success || !result.counts) {
        setNotice({ severity: 'error', text: result.message || 'Export failed.' });
        return;
      }
      const { videos, sublibraries, playlists } = result.counts;
      setNotice({ severity: 'success', text: `Exported ${plural(videos, 'video')} from ${plural(sublibraries, 'sublibrary', 'sublibraries')} and ${plural(playlists, 'playlist')}.` });
    } finally {
      setBusy(null);
    }
  };

  const handlePreviewImport = async () => {
    setBusy('preview');
    setNotice(null);
    try {
      const result = await window.electronAPI.previewLibraryImport();
      if (result.canceled) return;
      if (!result.success || !result.token || !result.plan || !result.counts) {
        setNotice({ severity: 'error', text: result.message || 'That file couldn\'t be read.' });
        return;
      }
      setPreview({ token: result.token, fileName: result.fileName || '', exportedAt: result.exportedAt ?? null, counts: result.counts, plan: result.plan });
    } finally {
      setBusy(null);
    }
  };

  const handleConfirmImport = async () => {
    if (!preview) return;
    setBusy('import');
    try {
      const result = await window.electronAPI.applyLibraryImport(preview.token);
      setPreview(null);
      if (!result.success || !result.summary) {
        setNotice({ severity: 'error', text: result.message || 'Import failed.' });
        return;
      }
      const lines = describeImportSummary(result.summary);
      setNotice({ severity: 'success', text: lines.length ? `Imported: ${lines.join('; ')}. Thumbnails will fill in over the next few minutes.` : 'Nothing new to import -- everything in that file is already in your library.' });
    } finally {
      setBusy(null);
    }
  };

  const planLines = preview ? describeImportSummary(preview.plan) : [];
  const hasChanges = !!preview && (preview.plan.versionsAdded > 0 || preview.plan.playlistsAdded > 0 || preview.plan.labelsApplied > 0 || preview.plan.sublibrariesCreated > 0);

  return (
    <>
      <Typography variant="h6" gutterBottom>Library Backup</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Save every sublibrary's videos, versions, labels and playlists to one file, or bring
        them in from one -- e.g. to move your library to another computer. This is the
        library's information only, not the downloaded files: imported videos show as not
        downloaded, and importing never changes or removes anything already in your library.
      </Typography>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button variant="outlined" onClick={handleExport} disabled={!libraryConfigured || busy !== null} startIcon={busy === 'export' ? <CircularProgress size={16} /> : undefined}>
          Export library
        </Button>
        <Button variant="outlined" onClick={handlePreviewImport} disabled={!libraryConfigured || busy !== null} startIcon={busy === 'preview' ? <CircularProgress size={16} /> : undefined}>
          Import library
        </Button>
      </Stack>
      {!libraryConfigured && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Choose a library folder first.</Typography>
      )}
      {notice && (
        <Alert severity={notice.severity} variant="outlined" sx={{ mt: 2 }} onClose={() => setNotice(null)}>{notice.text}</Alert>
      )}

      <Dialog open={!!preview} onClose={() => (busy ? null : setPreview(null))} fullWidth maxWidth="sm">
        <DialogTitle>Import library</DialogTitle>
        <DialogContent>
          {preview && (
            <>
              <DialogContentText sx={{ mb: 2 }}>
                <strong>{preview.fileName}</strong> has {plural(preview.counts.videos, 'video')} and {plural(preview.counts.playlists, 'playlist')}
                {preview.exportedAt ? ` (exported ${new Date(preview.exportedAt).toLocaleString()})` : ''}.
              </DialogContentText>
              {hasChanges ? (
                <>
                  <Typography variant="body2" sx={{ mb: 1 }}>Importing it will add:</Typography>
                  <ul style={{ marginTop: 0 }}>
                    {planLines.map((line) => <li key={line}><Typography variant="body2">{line}</Typography></li>)}
                  </ul>
                </>
              ) : (
                <Alert severity="info" variant="outlined">Everything in this file is already in your library -- there's nothing new to import.</Alert>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreview(null)} disabled={busy === 'import'}>Cancel</Button>
          <Button variant="contained" onClick={handleConfirmImport} disabled={!hasChanges || busy === 'import'} startIcon={busy === 'import' ? <CircularProgress size={16} /> : undefined}>
            Import
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
