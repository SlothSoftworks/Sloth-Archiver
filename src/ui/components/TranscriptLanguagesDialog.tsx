import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  IconButton, List, ListItem, ListItemButton, ListItemText, Tooltip,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import DownloadDoneIcon from '@mui/icons-material/DownloadDone';
import type { TranscriptLanguageOption } from '../../types/electron-api';

// Every language the video offers, marked with what's already saved.
// Clicking a row shows that language (downloading it first if needed); the
// download icon saves one without leaving the current transcript.
export default function TranscriptLanguagesDialog({ open, onClose, videoDir, epoch, currentLanguage, onShow }: {
  open: boolean;
  onClose: () => void;
  videoDir: string;
  epoch: string;
  currentLanguage: string;
  onShow: (language: string) => void;
}) {
  const [languages, setLanguages] = useState<TranscriptLanguageOption[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const loadLanguages = async () => {
    setListError(null);
    const result = await window.electronAPI.listTranscriptLanguages({ videoDir, epoch });
    if (result.success) setLanguages(result.languages ?? []);
    else setListError(result.message ?? "Couldn't load the languages.");
  };

  useEffect(() => {
    if (open && !languages) loadLanguages();
    // Loaded once per open; the dialog keeps it current after downloads itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const download = async (code: string): Promise<boolean> => {
    setDownloadError(null);
    setDownloading((prev) => new Set(prev).add(code));
    const result = await window.electronAPI.fetchTranscript({ videoDir, epoch, language: code });
    setDownloading((prev) => {
      const next = new Set(prev);
      next.delete(code);
      return next;
    });
    if (!result.success) {
      setDownloadError(result.message);
      return false;
    }
    setLanguages((prev) => prev?.map((l) => (l.code === code ? { ...l, saved: true } : l)) ?? prev);
    return true;
  };

  const show = async (language: TranscriptLanguageOption) => {
    if (!language.saved && !(await download(language.code))) return;
    onShow(language.code);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Transcript languages</DialogTitle>
      <DialogContent>
        <DialogContentText variant="body2" sx={{ mb: 1 }}>
          Saved transcripts open instantly. Any other language is downloaded once and kept with this version.
        </DialogContentText>
        {listError &&
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={loadLanguages}>Retry</Button>}>{listError}</Alert>}
        {downloadError && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setDownloadError(null)}>{downloadError}</Alert>}
        {!languages && !listError &&
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>}
        {languages?.length === 0 && <DialogContentText variant="body2">This video offers no other languages.</DialogContentText>}
        {languages && languages.length > 0 &&
          <List dense disablePadding sx={{ maxHeight: 360, overflowY: 'auto' }}>
            {languages.map((language) => (
              <ListItem
                key={language.code}
                disablePadding
                secondaryAction={
                  downloading.has(language.code) ? (
                    <CircularProgress size={18} aria-label={`Downloading ${language.name}`} />
                  ) : language.saved ? (
                    <Tooltip title="Saved on this computer">
                      <DownloadDoneIcon fontSize="small" color="success" aria-label={`${language.name} is saved`} />
                    </Tooltip>
                  ) : (
                    <Tooltip title="Download">
                      <IconButton edge="end" size="small" onClick={() => download(language.code)} aria-label={`Download ${language.name}`}>
                        <DownloadIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )
                }
              >
                <ListItemButton
                  selected={language.code === currentLanguage}
                  disabled={downloading.has(language.code)}
                  onClick={() => show(language)}
                >
                  <ListItemText
                    primary={
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                        {language.name}
                        {language.isDefault && <Chip size="small" label="Default" />}
                      </Box>
                    }
                    secondary={language.source === 'auto' ? 'Auto-generated' : 'Uploader subtitles'}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
