import { useState } from 'react';
import {
  Box,
  Checkbox,
  Divider,
  FormControlLabel,
  FormGroup,
  Popover,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

// The only place a video's tags are ever removed -- a checkbox per tag
// known in the active sublibrary (checked = applied to this video),
// toggling calls onToggle immediately (no separate save step, same
// immediate-effect convention as everything else in the bulk/detail bars).
// The text field at the bottom creates a brand-new tag and applies it to
// this video in one action -- no separate "create tag" flow exists.
export default function VideoTagsPopover({ open, anchorEl, onClose, allTags, appliedTags, onToggle, onCreate }: {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  allTags: string[];
  appliedTags: string[];
  onToggle: (tagName: string, applied: boolean) => void;
  onCreate: (tagName: string) => void;
}) {
  const [newTagName, setNewTagName] = useState('');

  const handleCreate = () => {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setNewTagName('');
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Box sx={{ p: 1.5, minWidth: 220 }}>
        {allTags.length > 0 &&
          <FormGroup>
            {allTags.map((tag) => (
              <FormControlLabel
                key={tag}
                label={tag}
                control={
                  <Checkbox
                    size="small"
                    checked={appliedTags.includes(tag)}
                    onChange={(e) => onToggle(tag, e.target.checked)}
                  />
                }
              />
            ))}
          </FormGroup>}
        {allTags.length === 0 &&
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>No tags yet in this sublibrary.</Typography>}
        <Divider sx={{ my: 1 }} />
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            autoFocus
            size="small"
            fullWidth
            placeholder="New tag"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          />
        </Stack>
      </Box>
    </Popover>
  );
}
