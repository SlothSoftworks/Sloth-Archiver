import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  FormGroup,
  Popover,
  Typography,
} from '@mui/material';

// Pure selection state -- unlike VideoTagsPopover (which applies each
// toggle immediately via setVideoTag, for one specific video), this has no
// video of its own and no IPC call: the caller owns selectedTags and
// narrows whatever list it's filtering. A video must carry every selected
// tag to match (AND, not ANY), per the decided design.
export default function TagFilterPopover({ open, anchorEl, onClose, allTags, selectedTags, onToggle, onClear }: {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  allTags: string[];
  selectedTags: Set<string>;
  onToggle: (tagName: string, checked: boolean) => void;
  onClear: () => void;
}) {
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Box sx={{ p: 1.5, minWidth: 220 }}>
        {allTags.length > 0 ? (
          <FormGroup>
            {allTags.map((tag) => (
              <FormControlLabel
                key={tag}
                label={tag}
                control={
                  <Checkbox
                    size="small"
                    checked={selectedTags.has(tag)}
                    onChange={(e) => onToggle(tag, e.target.checked)}
                  />
                }
              />
            ))}
          </FormGroup>
        ) : (
          <Typography variant="body2" color="text.secondary">No tags yet in this sublibrary.</Typography>
        )}
        {selectedTags.size > 0 &&
          <Button size="small" onClick={onClear} sx={{ mt: 1 }}>Clear filter</Button>}
      </Box>
    </Popover>
  );
}
