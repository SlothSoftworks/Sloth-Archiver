import {
  Box,
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  FormGroup,
  Popover,
  Typography,
} from '@mui/material';

// Fixed (not dynamic like tags), so declared once here rather than
// generated per-caller. Both entries AND together with each other and with
// any selected tags -- checking both at once is a valid, if useless,
// combination (matches "0 results" rather than being blocked).
export type SystemFilterKey = 'downloaded' | 'notDownloaded';
export const SYSTEM_FILTER_OPTIONS: { key: SystemFilterKey; label: string }[] = [
  { key: 'downloaded', label: 'Downloaded' },
  { key: 'notDownloaded', label: 'Not Downloaded' },
];

// Pure selection state -- unlike VideoTagsPopover (which applies each
// toggle immediately via setVideoTag, for one specific video), this has no
// video of its own and no IPC call: the caller owns selectedTags and
// narrows whatever list it's filtering. A video must carry every selected
// tag to match (AND, not ANY), per the decided design.
export default function TagFilterPopover({
  open, anchorEl, onClose, allTags, selectedTags, onToggle, selectedSystemFilters, onToggleSystemFilter, onClear,
}: {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  allTags: string[];
  selectedTags: Set<string>;
  onToggle: (tagName: string, checked: boolean) => void;
  selectedSystemFilters: Set<SystemFilterKey>;
  onToggleSystemFilter: (key: SystemFilterKey, checked: boolean) => void;
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
        <Divider sx={{ my: 1 }} />
        <FormGroup>
          {SYSTEM_FILTER_OPTIONS.map(({ key, label }) => (
            <FormControlLabel
              key={key}
              label={label}
              control={
                <Checkbox
                  size="small"
                  checked={selectedSystemFilters.has(key)}
                  onChange={(e) => onToggleSystemFilter(key, e.target.checked)}
                />
              }
            />
          ))}
        </FormGroup>
        {(selectedTags.size > 0 || selectedSystemFilters.size > 0) &&
          <Button size="small" onClick={onClear} sx={{ mt: 1 }}>Clear filter</Button>}
      </Box>
    </Popover>
  );
}
