import { ListItemIcon, Menu, MenuItem } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';

// A short, hardcoded item list -- only two items exist today, and a third
// playback option can be added here the same way later without needing a
// generic item-array abstraction now.
export default function PlayerContextMenu({
  open, anchorPosition, onClose,
  loopEnabled, onToggleLoop,
  loopSequenceEnabled, onToggleLoopSequence, loopSequenceDisabled,
}: {
  open: boolean;
  anchorPosition: { top: number; left: number } | null;
  onClose: () => void;
  loopEnabled: boolean;
  onToggleLoop: () => void;
  loopSequenceEnabled: boolean;
  onToggleLoopSequence: () => void;
  loopSequenceDisabled: boolean;
}) {
  return (
    <Menu open={open} onClose={onClose} anchorReference="anchorPosition" anchorPosition={anchorPosition ?? undefined}>
      <MenuItem onClick={() => { onToggleLoop(); onClose(); }}>
        {/* Reserves the icon's slot whether or not it's checked, so item
            text stays aligned across rows. */}
        <ListItemIcon>{loopEnabled && <CheckIcon fontSize="small" />}</ListItemIcon>
        Loop
      </MenuItem>
      <MenuItem onClick={() => { onToggleLoopSequence(); onClose(); }} disabled={loopSequenceDisabled}>
        <ListItemIcon>{loopSequenceEnabled && <CheckIcon fontSize="small" />}</ListItemIcon>
        Loop sequence
      </MenuItem>
    </Menu>
  );
}
