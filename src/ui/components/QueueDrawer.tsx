import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Avatar, Box, Divider, Drawer, IconButton, List, ListItem, Slider, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import VideocamIcon from '@mui/icons-material/Videocam';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { buildAppVideoUrl } from '../../utils/utils.ts';
import { useBackgroundPlayer, videoDetailPathFor, formatPlaybackTime } from '../hooks/useBackgroundPlayer.tsx';
import VolumePopover from './VolumePopover';

const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 360;

type MediaMode = 'audio' | 'video';

// Opened from MiniPlayerBar.tsx's up-arrow -- the full queue view, sliding
// in from the screen's left edge.
export default function QueueDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    queue, currentIndex, current, paused, currentTime, duration, volume, muted, setVolume, setMuted,
    pause, resume, seek, next, previous, playAt, removeAt, setVisibleContainer,
  } = useBackgroundPlayer();
  const [mediaMode, setMediaMode] = useState<MediaMode>('audio');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [volumeAnchorEl, setVolumeAnchorEl] = useState<HTMLElement | null>(null);
  const draggingRef = useRef(false);

  // Drags the drawer's right edge to resize it -- window-level pointermove/
  // pointerup listeners (not React's own onPointerMove) since the pointer
  // routinely leaves this element's bounds mid-drag.
  const handleResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startWidth = width;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      if (!draggingRef.current) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (moveEvent.clientX - startX))));
    };
    const handleUp = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  return (
    <Drawer anchor="left" variant="temporary" open={open} onClose={onClose}>
      <Box
        // width as a plain style prop, not sx -- this changes continuously
        // during a drag, and sx would mint a brand new emotion class on
        // every pixel of movement instead of just updating one CSS property.
        style={{ width }}
        sx={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}
      >
        {current &&
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            <Typography variant="subtitle2" noWrap>{current.title || current.videoId}</Typography>
            {current.channel &&
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{current.channel}</Typography>}
          </Box>}
        <Divider />

        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ px: 1, py: 1 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Tooltip title="Previous">
              <IconButton size="small" onClick={previous} disabled={currentIndex <= 0} aria-label="Previous">
                <SkipPreviousIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={paused ? 'Play' : 'Pause'}>
              <IconButton size="small" onClick={() => (paused ? resume() : pause())} aria-label={paused ? 'Play' : 'Pause'}>
                {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Next">
              <IconButton size="small" onClick={next} disabled={currentIndex >= queue.length - 1} aria-label="Next">
                <SkipNextIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          {/* Same style as LibraryScreen.tsx's own by-channel/by-video
              LibraryViewModeToggle -- an exclusive, icon-only
              ToggleButtonGroup. Audio is the default: reparenting the live
              <video> into view (see the visibleContainer effect in
              useBackgroundPlayer.tsx) is an opt-in, not automatic, every
              time the queue view opens. */}
          <ToggleButtonGroup
            value={mediaMode}
            exclusive
            size="small"
            onChange={(_e, value: MediaMode | null) => value && setMediaMode(value)}
            aria-label="Playback mode"
          >
            <ToggleButton value="audio" aria-label="Audio only">
              <Tooltip title="Audio only">
                <AudiotrackIcon fontSize="small" />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="video" aria-label="Video">
              <Tooltip title="Video">
                <VideocamIcon fontSize="small" />
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {current && mediaMode === 'video' &&
          // The one real background-player <video> element (see
          // useBackgroundPlayer.tsx's Provider) gets manually reparented into
          // this box while it's mounted, and back to its default hidden
          // container the moment it unmounts (switching to audio-only,
          // closing the drawer, or variant="temporary" itself unmounting
          // it) -- a plain callback ref registers/unregisters it, no
          // separate effect needed here. Playback position/audio/buffered
          // data all carry over since it's the same element, not a new one.
          // Native `controls` (added by the Provider once visible) is what
          // lets the user actually scrub/pause/volume it.
          <Box
            ref={setVisibleContainer}
            sx={{ width: '100%', aspectRatio: '16 / 9', backgroundColor: 'black', flexShrink: 0 }}
          />}
        {current && mediaMode === 'audio' &&
          // No thumbnail box here -- just the seek line. No native
          // <video controls> to scrub with while the live element stays
          // hidden in audio mode, so this is the same seek bar
          // MiniPlayerBar.tsx already offers, keeping audio playback from
          // ever being left with no controls at all.
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32, textAlign: 'right' }}>
              {formatPlaybackTime(currentTime)}
            </Typography>
            <Slider
              size="small"
              value={Math.min(currentTime, duration || 0)}
              max={duration || 0}
              // SAFETY: this Slider has no `range` prop, so MUI's onChange
              // always reports a single number here, never number[].
              onChange={(_e, value) => seek(value as number)}
              disabled={!duration}
              aria-label="Seek"
            />
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32 }}>
              {formatPlaybackTime(duration)}
            </Typography>
            <Tooltip title={volumeAnchorEl ? 'Hide volume' : 'Show volume'}>
              <IconButton
                size="small"
                onClick={(e) => setVolumeAnchorEl(volumeAnchorEl ? null : e.currentTarget)}
                aria-label={volumeAnchorEl ? 'Hide volume' : 'Show volume'}
              >
                {muted || volume === 0 ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <VolumePopover
              open={!!volumeAnchorEl}
              anchorEl={volumeAnchorEl}
              onClose={() => setVolumeAnchorEl(null)}
              volume={volume}
              muted={muted}
              onVolumeChange={setVolume}
              onToggleMute={() => setMuted(!muted)}
            />
          </Stack>}

        <Divider />
        <List sx={{ overflowY: 'auto', flex: 1 }}>
          {queue.map((item, index) => (
            <ListItem
              key={index}
              disablePadding
              data-active={index === currentIndex ? 'true' : undefined}
              sx={{
                backgroundColor: index === currentIndex ? 'action.selected' : undefined,
                '&:hover .queue-item-remove': { opacity: 1 },
              }}
              secondaryAction={
                <Tooltip title="Remove from queue">
                  <IconButton
                    className="queue-item-remove"
                    size="small"
                    edge="end"
                    aria-label={`Remove ${item.title || item.videoId} from queue`}
                    onClick={(e) => { e.stopPropagation(); removeAt(index); }}
                    sx={{ opacity: 0, transition: 'opacity 0.1s' }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
            >
              <Box
                onClick={() => playAt(index)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', px: 2, py: 1, pr: 5,
                  cursor: 'pointer',
                }}
              >
                {/* Only the thumbnail navigates -- clicking anywhere else on
                    the row plays that entry instead (see playAt above). */}
                <Box
                  component={RouterLink}
                  to={videoDetailPathFor(item)}
                  onClick={(e) => { e.stopPropagation(); onClose(); }}
                  sx={{ flexShrink: 0, display: 'block', lineHeight: 0 }}
                >
                  <Avatar
                    variant="rounded"
                    src={item.thumbnailPath ? buildAppVideoUrl(item.thumbnailPath) : undefined}
                    sx={{ width: 40, height: 40 }}
                  >
                    <MusicNoteIcon fontSize="small" />
                  </Avatar>
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap>{item.title || item.videoId}</Typography>
                  {item.channel &&
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{item.channel}</Typography>}
                </Box>
              </Box>
            </ListItem>
          ))}
        </List>

        {/* Drag-to-resize handle -- window-level pointer listeners (attached
            on pointerdown, see handleResizePointerDown) so dragging keeps
            tracking even once the pointer leaves this thin strip. */}
        <Box
          onPointerDown={handleResizePointerDown}
          data-testid="queue-drawer-resize-handle"
          sx={{
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 6,
            cursor: 'col-resize',
            '&:hover': { backgroundColor: 'action.hover' },
          }}
        />
      </Box>
    </Drawer>
  );
}
