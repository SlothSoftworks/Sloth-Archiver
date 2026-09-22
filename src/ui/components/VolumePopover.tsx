import { Box, IconButton, Popover, Slider, Tooltip } from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';

// Shared by MiniPlayerBar and QueueDrawer -- both anchor this off their own
// volume IconButton (which only opens/closes the popover; see its own
// onClick), with the actual mute toggle living here instead so the two
// interactions on that one icon don't collide.
export default function VolumePopover({ open, anchorEl, onClose, volume, muted, onVolumeChange, onToggleMute }: {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  volume: number;
  muted: boolean;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
}) {
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
        <Slider
          size="small"
          orientation="vertical"
          value={volume}
          min={0}
          max={1}
          step={0.01}
          // SAFETY: this Slider has no `range` prop, so MUI's onChange
          // always reports a single number here, never number[].
          onChange={(_e, value) => onVolumeChange(value as number)}
          aria-label="Volume"
          sx={{ height: 96 }}
        />
        <Tooltip title={muted ? 'Unmute' : 'Mute'}>
          <IconButton size="small" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted || volume === 0 ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>
    </Popover>
  );
}
