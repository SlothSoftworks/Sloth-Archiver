import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useLibraryTags } from '../hooks/useLibraryTags.tsx';

dayjs.extend(customParseFormat);

// The app's canonical uploadDate format is strict YYYYMMDD (see
// convertYYYYMMDDStringToDate in utils.ts) -- these two helpers are the only
// place this form crosses between that string and the Dayjs value the
// DatePicker actually works with.
function parseCanonicalUploadDate(value: string): Dayjs | null {
  if (!value) return null;
  const parsed = dayjs(value, 'YYYYMMDD', true);
  return parsed.isValid() ? parsed : null;
}

function toCanonicalUploadDate(value: Dayjs | null): string {
  return value?.isValid() ? value.format('YYYYMMDD') : '';
}

// ffmpeg container date tags aren't guaranteed to be YYYYMMDD -- could be
// "2024", "2024-05-01", a full ISO timestamp, or unparseable junk. Lenient
// dayjs parsing covers the well-formed cases; anything it can't make sense
// of prefills empty rather than passing a malformed value through.
function normalizeProbedUploadDate(raw: string | null | undefined): string {
  if (!raw) return '';
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format('YYYYMMDD') : '';
}

// Mirrors buildGenericEpochMetadata's (library.mjs) own field set --
// ExtraDataTable.tsx renders exactly these fields for a generic entry, so
// the add form collects exactly what that view can later show.
export type LocalFileFormFields = {
  title: string;
  description: string;
  uploader: string;
  uploadDate: string;
  license: string;
  categories: string[];
  tags: string[];
  music: { track: string; artist: string; album: string; genre: string };
};

function emptyFormFields(): LocalFileFormFields {
  return {
    title: '', description: '', uploader: '', uploadDate: '', license: '',
    categories: [], tags: [],
    music: { track: '', artist: '', album: '', genre: '' },
  };
}

// Comma-separated free text is how categories/tags are edited here -- there's
// no chip-input component already in this codebase to reuse, and these are
// low-cardinality, occasionally-filled fields, not worth introducing one for.
function parseCommaList(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

// Picks a local video file, probes it (read-only) to prefill Title/Metadata,
// and submits it for cataloging via library:addLocalFile. Modeled on
// SaveClipDialog's controlled-form shape and DownloaderScreen/
// CreateSubLibraryDialog's sublibrary Select (backed by the shared
// useLibraryTags() hook, not its own fetch).
export default function AddLocalFileDialog({
  open, onClose, submitting, error, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: { sourceFilePath: string; formFields: LocalFileFormFields; targetTag: string }) => void;
}) {
  const { libraryTags, activeLibraryTag } = useLibraryTags();
  const [sourceFilePath, setSourceFilePath] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [fields, setFields] = useState<LocalFileFormFields>(emptyFormFields());
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [targetTag, setTargetTag] = useState(activeLibraryTag);
  const [categoriesInput, setCategoriesInput] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  // Re-seed every time the dialog opens, same as SaveClipDialog -- a
  // successful submit closes this dialog without unmounting it, so its own
  // form state would otherwise still be showing the just-added file next
  // time it opens.
  useEffect(() => {
    if (open) {
      setSourceFilePath(null);
      setFields(emptyFormFields());
      setCategoriesInput('');
      setTagsInput('');
      setMetadataOpen(false);
      setTargetTag(activeLibraryTag);
    }
  }, [open, activeLibraryTag]);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handlePickFile = async () => {
    const result = await window.electronAPI.openLocalVideoFile();
    const filePath = result.filePaths?.[0];
    if (!filePath) return;
    setSourceFilePath(filePath);

    const baseName = filePath.split(/[/\\]/).pop() || filePath;
    const titleFromFileName = baseName.replace(/\.[^.]+$/, '');

    setProbing(true);
    try {
      const probe = await window.electronAPI.probeLocalFile(filePath);
      setFields({
        title: probe.tags.title || titleFromFileName,
        description: probe.tags.comment || '',
        uploader: probe.tags.artist || '',
        uploadDate: normalizeProbedUploadDate(probe.tags.date),
        license: '',
        categories: [],
        tags: probe.tags.genre ? [probe.tags.genre] : [],
        music: { track: '', artist: probe.tags.artist || '', album: '', genre: probe.tags.genre || '' },
      });
      setCategoriesInput('');
      setTagsInput(probe.tags.genre || '');
    } catch {
      // Missing/unreadable tags are not fatal -- fall back to a plain
      // filename-derived title, same as if probing had never run.
      setFields({ ...emptyFormFields(), title: titleFromFileName });
    } finally {
      setProbing(false);
    }
  };

  const handleSubmit = () => {
    if (!sourceFilePath || !fields.title.trim()) return;
    onSubmit({
      sourceFilePath,
      formFields: { ...fields, categories: parseCommaList(categoriesInput), tags: parseCommaList(tagsInput) },
      targetTag,
    });
  };

  const canSubmit = !!sourceFilePath && !!fields.title.trim() && !submitting && !probing;

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>Add local file to library</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info" variant="outlined">
              This copies the file into your library -- the original file is never moved or deleted.
            </Alert>
  
            <Stack direction="row" spacing={1} alignItems="center">
              <Button variant="outlined" onClick={handlePickFile} disabled={submitting || probing}>
                Choose file...
              </Button>
              <Typography variant="body2" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {sourceFilePath || 'No file selected'}
              </Typography>
            </Stack>
  
            <TextField
              size="small"
              label="Title"
              value={fields.title}
              onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
              disabled={submitting}
              fullWidth
            />
  
            {libraryTags.length > 1 &&
              <FormControl size="small" fullWidth>
                <InputLabel id="add-local-file-target-tag-label">Sublibrary</InputLabel>
                <Select
                  labelId="add-local-file-target-tag-label"
                  label="Sublibrary"
                  value={targetTag}
                  onChange={(e) => setTargetTag(e.target.value)}
                  disabled={submitting}
                >
                  {libraryTags.map((tag) => (
                    <MenuItem key={tag.folderName} value={tag.folderName}>{tag.tagName}</MenuItem>
                  ))}
                </Select>
              </FormControl>}
  
            <Button
              size="small"
              onClick={() => setMetadataOpen((v) => !v)}
              endIcon={metadataOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              sx={{ alignSelf: 'flex-start' }}
            >
              Metadata
            </Button>
            <Collapse in={metadataOpen}>
              <Stack spacing={2}>
                <TextField
                  size="small"
                  label="Description"
                  value={fields.description}
                  onChange={(e) => setFields((f) => ({ ...f, description: e.target.value }))}
                  disabled={submitting}
                  multiline
                  minRows={2}
                  fullWidth
                />
                <Stack direction="row" spacing={1}>
                  <TextField
                    size="small"
                    label="Uploader"
                    value={fields.uploader}
                    onChange={(e) => setFields((f) => ({ ...f, uploader: e.target.value }))}
                    disabled={submitting}
                    fullWidth
                  />
                  <DatePicker
                    label="Upload date"
                    value={parseCanonicalUploadDate(fields.uploadDate)}
                    onChange={(date) => setFields((f) => ({ ...f, uploadDate: toCanonicalUploadDate(date) }))}
                    disabled={submitting}
                    slotProps={{ textField: { size: 'small', fullWidth: true } }}
                  />
                </Stack>
                <TextField
                  size="small"
                  label="License"
                  value={fields.license}
                  onChange={(e) => setFields((f) => ({ ...f, license: e.target.value }))}
                  disabled={submitting}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="Categories"
                  helperText="Comma-separated"
                  value={categoriesInput}
                  onChange={(e) => setCategoriesInput(e.target.value)}
                  disabled={submitting}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="Tags"
                  helperText="Comma-separated"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  disabled={submitting}
                  fullWidth
                />
                <Typography variant="body2" color="text.secondary">Music</Typography>
                <Stack direction="row" spacing={1}>
                  <TextField
                    size="small"
                    label="Track"
                    value={fields.music.track}
                    onChange={(e) => setFields((f) => ({ ...f, music: { ...f.music, track: e.target.value } }))}
                    disabled={submitting}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label="Artist"
                    value={fields.music.artist}
                    onChange={(e) => setFields((f) => ({ ...f, music: { ...f.music, artist: e.target.value } }))}
                    disabled={submitting}
                    fullWidth
                  />
                </Stack>
                <Stack direction="row" spacing={1}>
                  <TextField
                    size="small"
                    label="Album"
                    value={fields.music.album}
                    onChange={(e) => setFields((f) => ({ ...f, music: { ...f.music, album: e.target.value } }))}
                    disabled={submitting}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label="Genre"
                    value={fields.music.genre}
                    onChange={(e) => setFields((f) => ({ ...f, music: { ...f.music, genre: e.target.value } }))}
                    disabled={submitting}
                    fullWidth
                  />
                </Stack>
              </Stack>
            </Collapse>
  
            {error && <Typography variant="body2" color="error">{error}</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} variant="contained" disabled={!canSubmit}>
            Add to library
          </Button>
        </DialogActions>
      </Dialog>
    </LocalizationProvider>
  );
}
