import { Box } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { PlayButton, MuteButton, FullscreenButton, Time, TimeSlider, VolumeSlider, useMediaState } from '@vidstack/react';

// Every control below is one of Vidstack's headless primitives (real,
// correctly-ARIA'd DOM elements with built-in click/drag/keyboard behavior
// already wired to the nearest ancestor <MediaPlayer>) rendered via MUI's
// `Box component={...}` -- the exact same "render as a different element but
// keep MUI's sx styling" pattern LibraryVideoPlayer.tsx itself already uses
// for `Box component="video"`. This keeps every pixel of paint coming from
// this app's own theme (no Vidstack CSS imported beyond the layout-critical
// base.css) while reusing Vidstack's accessible interaction logic, which is
// the entire reason a player library was adopted over hand-rolling controls.
const resetButtonSx = {
  border: 0,
  background: 'none',
  padding: 0.5,
  margin: 0,
  color: 'inherit',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 1,
  '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.15)' },
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '-2px' },
};

const timeTextSx = {
  typography: 'caption',
  color: 'inherit',
  minWidth: 44,
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
  userSelect: 'none',
};

// Shared slider track/fill/thumb look between the time and volume sliders --
// --slider-fill is a Vidstack-managed CSS custom property (a percentage
// string) reflecting current position/volume, kept in sync during drag
// without this component reading or computing it itself.
const sliderRootSx = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  cursor: 'pointer',
  touchAction: 'none',
  outline: 'none',
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2, borderRadius: 1 },
};

const sliderTrackSx = {
  position: 'relative',
  width: '100%',
  height: 4,
  borderRadius: 2,
  backgroundColor: 'rgba(255, 255, 255, 0.3)',
};

const sliderTrackFillSx = {
  position: 'absolute',
  height: '100%',
  width: 'var(--slider-fill)',
  borderRadius: 2,
  backgroundColor: 'primary.main',
};

const sliderThumbSx = {
  position: 'absolute',
  top: '50%',
  left: 'var(--slider-fill)',
  width: 12,
  height: 12,
  borderRadius: '50%',
  backgroundColor: 'primary.main',
  transform: 'translate(-50%, -50%)',
};

export default function LibraryVideoPlayerControls() {
  const paused = useMediaState('paused');
  const muted = useMediaState('muted');
  const fullscreen = useMediaState('fullscreen');
  const canFullscreen = useMediaState('canFullscreen');

  return (
    <Box
      sx={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        display: 'flex', alignItems: 'center', gap: 1,
        px: 1.5, py: 0.75,
        color: 'common.white',
        background: 'linear-gradient(to top, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0))',
      }}
    >
      <Box component={PlayButton} aria-label={paused ? 'Play' : 'Pause'} sx={resetButtonSx}>
        {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
      </Box>

      <Box component={Time} type="current" sx={timeTextSx} />

      <Box component={TimeSlider.Root} aria-label="Seek" sx={{ ...sliderRootSx, flex: 1 }}>
        <Box component={TimeSlider.Track} sx={sliderTrackSx}>
          <Box component={TimeSlider.TrackFill} sx={sliderTrackFillSx} />
        </Box>
        <Box component={TimeSlider.Thumb} sx={sliderThumbSx} />
      </Box>

      <Box component={Time} type="duration" sx={timeTextSx} />

      <Box component={MuteButton} aria-label={muted ? 'Unmute' : 'Mute'} sx={resetButtonSx}>
        {muted ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
      </Box>

      <Box component={VolumeSlider.Root} aria-label="Volume" sx={{ ...sliderRootSx, width: 64 }}>
        <Box component={VolumeSlider.Track} sx={sliderTrackSx}>
          <Box component={VolumeSlider.TrackFill} sx={sliderTrackFillSx} />
        </Box>
        <Box component={VolumeSlider.Thumb} sx={sliderThumbSx} />
      </Box>

      {canFullscreen &&
        <Box component={FullscreenButton} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} sx={resetButtonSx}>
          {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
        </Box>}
    </Box>
  );
}
