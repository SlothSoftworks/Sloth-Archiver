import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { Avatar, Box, IconButton, Slider, Stack, Tooltip, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import CloseIcon from '@mui/icons-material/Close';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { buildAppVideoUrl } from '../../utils/utils.ts';
import { useBackgroundPlayer, videoDetailPathFor, formatPlaybackTime } from '../hooks/useBackgroundPlayer.tsx';
import QueueDrawer from './QueueDrawer';
import VolumePopover from './VolumePopover';

// Persistent across every tab -- rendered in MainPage.tsx as a sibling to
// its CustomTabPanels, the same placement BulkAddSidePanel already uses to
// survive tab switches. Shows a static thumbnail, never a live video frame
// -- the underlying <video> element (BackgroundPlayerProvider) keeps
// playing regardless, this is just a control surface for it.
export default function MiniPlayerBar() {
  const {
    queue, currentIndex, current, paused, currentTime, duration, volume, muted, setVolume, setMuted,
    pause, resume, seek, next, previous, stop,
  } = useBackgroundPlayer();
  const [queueOpen, setQueueOpen] = useState(false);
  const [volumeAnchorEl, setVolumeAnchorEl] = useState<HTMLElement | null>(null);

  if (!current) return null;

  return (
    <>
      {/* Hidden (not unmounted -- QueueDrawer's own `open` prop still
          toggling, rather than this whole bar controlling its mount, is
          what lets MUI animate the drawer's exit) while the full queue view
          is active, reappearing once it's minimized again -- the drawer is
          the "expanded" form of this same bar, not a separate surface on
          top of it. */}
      {!queueOpen &&
        <Box
          sx={{
            display: 'flex', alignItems: 'center', gap: 1.5,
            px: 2, py: 1,
            borderTop: 1, borderColor: 'divider',
            backgroundColor: 'background.paper',
            flexShrink: 0,
          }}
        >
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

          <Box
            component={RouterLink}
            to={videoDetailPathFor(current)}
            sx={{
              display: 'flex', alignItems: 'center', gap: 1.5, flex: 1, minWidth: 0,
              textDecoration: 'none', color: 'inherit', cursor: 'pointer',
            }}
          >
            <Avatar
              variant="rounded"
              src={current.thumbnailPath ? buildAppVideoUrl(current.thumbnailPath) : undefined}
              sx={{ width: 40, height: 40, flexShrink: 0 }}
            >
              <MusicNoteIcon fontSize="small" />
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>{current.title || current.videoId}</Typography>
              {current.channel &&
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{current.channel}</Typography>}
            </Box>
          </Box>

          <Stack direction="row" alignItems="center" spacing={1} sx={{ width: 260, flexShrink: 0 }}>
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
            {/* Anchored inside the same Stack as the seek slider -- not as a
                sibling further along the bar -- so it keeps the same
                breathing room from the window edge that QueueDrawer's own
                volume button has inside its (narrower) drawer panel. */}
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
          </Stack>

          {queue.length > 1 &&
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              ({currentIndex + 1}/{queue.length})
            </Typography>}
          {queue.length > 1 &&
            <Tooltip title="Show queue">
              <IconButton size="small" onClick={() => setQueueOpen(true)} aria-label="Show queue">
                <KeyboardArrowUpIcon fontSize="small" />
              </IconButton>
            </Tooltip>}

          <Tooltip title="Stop">
            <IconButton size="small" onClick={stop} aria-label="Stop">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>}

      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
    </>
  );
}
