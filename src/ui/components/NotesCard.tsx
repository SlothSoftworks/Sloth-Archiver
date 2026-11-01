import { useEffect, useState } from 'react';
import { Button, Card, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';

// Mirrors library.mjs's NOTES_MAX_LENGTH, which main enforces on save --
// main process and renderer never cross-import, so keep the two in sync.
export const NOTES_MAX_LENGTH = 500;

// User-written notes for a library video or a clip. Shows the saved text
// until Edit is clicked; nothing is written until Save.
export default function NotesCard({ notes, onSave }: {
  notes: string;
  onSave: (notes: string) => Promise<{ success: boolean; notes?: string; message?: string }>;
}) {
  // Shown right after a save, before the caller's refreshed data comes back
  // down as a new `notes` prop.
  const [savedNotes, setSavedNotes] = useState(notes);
  useEffect(() => { setSavedNotes(notes); }, [notes]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setDraft(savedNotes);
    setError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const result = await onSave(draft);
    setSaving(false);
    if (!result.success) {
      setError(result.message || "Couldn't save notes.");
      return;
    }
    setSavedNotes(result.notes ?? draft);
    setEditing(false);
  };

  return (
    <Card variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center">
          <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1, flexGrow: 1 }}>
            Notes
          </Typography>
          {!editing &&
            <Tooltip title="Edit notes">
              <IconButton size="small" aria-label="Edit notes" onClick={startEditing}>
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>}
        </Stack>
        {editing ? (
          <>
            <TextField
              multiline
              minRows={3}
              size="small"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving}
              helperText={`${draft.length}/${NOTES_MAX_LENGTH}`}
              slotProps={{ htmlInput: { maxLength: NOTES_MAX_LENGTH, 'aria-label': 'Notes' } }}
            />
            {error && <Typography variant="caption" color="error">{error}</Typography>}
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button size="small" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              <Button size="small" variant="contained" onClick={handleSave} disabled={saving}>Save</Button>
            </Stack>
          </>
        ) : savedNotes ? (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{savedNotes}</Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">No notes yet.</Typography>
        )}
      </Stack>
    </Card>
  );
}
