import { ListItemIcon, Menu, MenuItem } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';

// A short, hardcoded item list -- a third playback option (Add to queue)
// was added here the same way its own original comment said one could be,
// without needing a generic item-array abstraction yet.
export default function PlayerContextMenu({
  open, anchorPosition, onClose,
  loopEnabled, onToggleLoop,
  loopSequenceEnabled, onToggleLoopSequence, loopSequenceDisabled,
  onAddToQueue,
  onChangeThumbnail, currentTime,
}: {
  open: boolean;
  anchorPosition: { top: number; left: number } | null;
  onClose: () => void;
  loopEnabled: boolean;
  onToggleLoop: () => void;
  loopSequenceEnabled: boolean;
  onToggleLoopSequence: () => void;
  loopSequenceDisabled: boolean;
  // undefined (not just a disabled flag) hides the item entirely -- the
  // caller only ever omits it for a not-yet-ready video.
  onAddToQueue?: () => void;
  // Available for every library entry, unlike onAddToQueue -- always passed
  // when the caller has a real videoDir to write the replaced thumbnail into.
  onChangeThumbnail?: (currentTime: number | null) => void;
  // Playback position at the moment the menu was opened -- prefills the
  // dialog's timestamp field.
  currentTime: number | null;
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
      {onAddToQueue &&
        <MenuItem onClick={() => { onAddToQueue(); onClose(); }}>
          <ListItemIcon />
          Add to queue
        </MenuItem>}
      {onChangeThumbnail &&
        <MenuItem onClick={() => { onChangeThumbnail(currentTime); onClose(); }}>
          <ListItemIcon />
          Change thumbnail
        </MenuItem>}
    </Menu>
  );
}
