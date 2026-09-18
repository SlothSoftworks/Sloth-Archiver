import { Link as RouterLink } from 'react-router';
import { Avatar, Box, IconButton, Slider, Stack, Tooltip, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import CloseIcon from '@mui/icons-material/Close';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import { buildAppVideoUrl } from '../../utils/utils.ts';
import { useBackgroundPlayer } from '../hooks/useBackgroundPlayer.tsx';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Persistent across every tab -- rendered in MainPage.tsx as a sibling to
// its CustomTabPanels, the same placement BulkAddSidePanel already uses to
// survive tab switches. Shows a static thumbnail, never a live video frame
// -- the underlying <video> element (BackgroundPlayerProvider) keeps
// playing regardless, this is just a control surface for it.
export default function MiniPlayerBar() {
  const { current, paused, currentTime, duration, pause, resume, seek, stop } = useBackgroundPlayer();

  if (!current) return null;

  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'center', gap: 1.5,
        px: 2, py: 1,
        borderTop: 1, borderColor: 'divider',
        backgroundColor: 'background.paper',
        flexShrink: 0,
      }}
    >
      <Tooltip title={paused ? 'Play' : 'Pause'}>
        <IconButton size="small" onClick={() => (paused ? resume() : pause())} aria-label={paused ? 'Play' : 'Pause'}>
          {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
        </IconButton>
      </Tooltip>

      <Box
        component={RouterLink}
        to={current.clipId
          ? `/library/video/${current.videoId}?view=clips&clip=${current.clipId}`
          : `/library/video/${current.videoId}`}
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

      <Stack direction="row" alignItems="center" spacing={1} sx={{ width: 220, flexShrink: 0 }}>
        <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32, textAlign: 'right' }}>
          {formatTime(currentTime)}
        </Typography>
        <Slider
          size="small"
          value={Math.min(currentTime, duration || 0)}
          max={duration || 0}
          onChange={(_e, value) => seek(value as number)}
          disabled={!duration}
          aria-label="Seek"
        />
        <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32 }}>
          {formatTime(duration)}
        </Typography>
      </Stack>

      <Tooltip title="Stop">
        <IconButton size="small" onClick={stop} aria-label="Stop">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
