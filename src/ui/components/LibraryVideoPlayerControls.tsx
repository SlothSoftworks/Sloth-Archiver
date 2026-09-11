import { useRef, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import { alpha } from '@mui/material/styles';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import StartIcon from '@mui/icons-material/Start';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import ClearIcon from '@mui/icons-material/Clear';
import { PlayButton, MuteButton, FullscreenButton, Time, TimeSlider, VolumeSlider, useMediaState, useMediaRemote, formatTime } from '@vidstack/react';
import type { ClipMarkersControl } from './LibraryVideoPlayer';

// Every control below is one of Vidstack's headless primitives (real,
// correctly-ARIA'd DOM elements with built-in click/drag/keyboard behavior
// already wired to the nearest ancestor <MediaPlayer>) rendered via MUI's
// `Box component={...}`. This keeps every pixel of paint coming from this
// app's own theme (no Vidstack CSS imported beyond the layout-critical
// base.css) while reusing Vidstack's accessible interaction logic.
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
  cursor: 'pointer',
};

// Wider than timeTextSx's default minWidth -- ".mmm" needs the extra room a
// plain "1:23" never did.
const detailedTimeTextSx = { ...timeTextSx, minWidth: 84 };

// Millisecond-precision stand-in for Vidstack's own <Time>, which has no
// showMs option (confirmed against its props: type/showHours/padHours/
// padMinutes/remainder/toggle/hidden, none of them fraction-related) --
// reuses Vidstack's own formatTime util instead of hand-rolling formatting.
function DetailedTime({ type }: { type: 'current' | 'duration' }) {
  const currentTime = useMediaState('currentTime');
  const duration = useMediaState('duration');
  const seconds = type === 'current' ? currentTime : duration;
  return <>{Number.isFinite(seconds) ? formatTime(seconds, { showMs: true }) : ''}</>;
}

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

const clipButtonSx = {
  padding: 0.5,
  color: 'inherit',
  '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.15)' },
  '&.Mui-disabled': { color: 'rgba(255, 255, 255, 0.3)' },
};

// Pure, geometry-in-geometry-out conversion -- deliberately not inlined in a
// pointer-event handler so it can be unit-tested with a plain object shaped
// like a DOMRect. That's required, not just tidy: jsdom's real
// getBoundingClientRect() always returns a zero-size rect (no layout
// engine), so this math could never be verified through a rendered tree.
export function secondsFromPointerX(clientX: number, trackRect: { left: number; width: number }, duration: number): number {
  if (trackRect.width <= 0 || duration <= 0) return 0;
  const pct = Math.min(1, Math.max(0, (clientX - trackRect.left) / trackRect.width));
  return pct * duration;
}

export function clipMarkerPercent(seconds: number | null, duration: number): number | null {
  if (seconds == null || !(duration > 0)) return null;
  return Math.min(1, Math.max(0, seconds / duration)) * 100;
}

// One draggable marker -- used for both the clip start and end positions.
// Drag itself never seeks (avoids seek-spam on every pointer-move); only the
// final position on release does, via Vidstack's own remote control.
//
// Shaped like a bracket -- "[" for start, "]" for end -- so which marker is
// which is legible at a glance. The end marker sits on a higher z-index:
// when start and end land only a pixel or two apart, their thin hit-areas
// overlap almost exactly, and without an explicit stacking order a drag
// meant for one could silently grab whichever happened to be later in the
// DOM. Making end win matches "fine-tuning the end after placing the start"
// being the more common next action.
function ClipMarker({
  seconds, duration, variant, trackRef, onSecondsChange,
}: {
  seconds: number | null;
  duration: number;
  variant: 'start' | 'end';
  trackRef: React.RefObject<HTMLElement | null>;
  onSecondsChange: (seconds: number) => void;
}) {
  const remote = useMediaRemote();
  const pct = clipMarkerPercent(seconds, duration);
  if (pct == null) return null;

  const armSide = variant === 'start' ? 'left' : 'right';

  const computeSeconds = (clientX: number): number | null => {
    const track = trackRef.current;
    if (!track) return null;
    return secondsFromPointerX(clientX, track.getBoundingClientRect(), duration);
  };

  return (
    <Box
      role="slider"
      aria-label={variant === 'start' ? 'Clip start' : 'Clip end'}
      aria-valuenow={seconds ?? 0}
      tabIndex={0}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.buttons) return;
        const next = computeSeconds(e.clientX);
        if (next != null) onSecondsChange(next);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        const next = computeSeconds(e.clientX);
        if (next != null) remote.seek(next);
      }}
      sx={{
        position: 'absolute', top: -4, bottom: -4, left: `${pct}%`,
        // warning.main, not primary.main (already used for the playback
        // fill/thumb), so a clip marker never gets confused for current position.
        width: 3, backgroundColor: 'warning.main', cursor: 'ew-resize',
        transform: 'translateX(-50%)', touchAction: 'none',
        zIndex: variant === 'end' ? 2 : 1,
        '&::before, &::after': {
          content: '""',
          position: 'absolute',
          height: 2,
          width: 6,
          backgroundColor: 'warning.main',
          [armSide]: 0,
        },
        '&::before': { top: 0 },
        '&::after': { bottom: 0 },
      }}
    />
  );
}

export default function LibraryVideoPlayerControls({ clipMarkers }: { clipMarkers?: ClipMarkersControl }) {
  const paused = useMediaState('paused');
  const muted = useMediaState('muted');
  const fullscreen = useMediaState('fullscreen');
  const canFullscreen = useMediaState('canFullscreen');
  const duration = useMediaState('duration');
  const trackRef = useRef<HTMLElement | null>(null);
  const [detailedTime, setDetailedTime] = useState(false);
  const toggleDetailedTime = () => setDetailedTime((v) => !v);

  const startPct = clipMarkers ? clipMarkerPercent(clipMarkers.startSeconds, duration) : null;
  const endPct = clipMarkers ? clipMarkerPercent(clipMarkers.endSeconds, duration) : null;

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

      {detailedTime
        ? <Box data-testid="time-current" onDoubleClick={toggleDetailedTime} sx={detailedTimeTextSx}><DetailedTime type="current" /></Box>
        : <Box component={Time} type="current" data-testid="time-current" onDoubleClick={toggleDetailedTime} sx={timeTextSx} />}

      <Box component={TimeSlider.Root} aria-label="Seek" sx={{ ...sliderRootSx, flex: 1 }}>
        <Box ref={trackRef} component={TimeSlider.Track} sx={sliderTrackSx}>
          <Box component={TimeSlider.TrackFill} sx={sliderTrackFillSx} />
          {clipMarkers && startPct != null && endPct != null &&
            <Box
              sx={{
                position: 'absolute', height: '100%',
                left: `${Math.min(startPct, endPct)}%`,
                width: `${Math.abs(endPct - startPct)}%`,
                backgroundColor: (theme) => alpha(theme.palette.warning.main, 0.35),
              }}
            />}
        </Box>
        <Box component={TimeSlider.Thumb} sx={sliderThumbSx} />
        {clipMarkers &&
          <ClipMarker
            seconds={clipMarkers.startSeconds}
            duration={duration}
            variant="start"
            trackRef={trackRef}
            onSecondsChange={clipMarkers.onStartSecondsChange}
          />}
        {clipMarkers &&
          <ClipMarker
            seconds={clipMarkers.endSeconds}
            duration={duration}
            variant="end"
            trackRef={trackRef}
            onSecondsChange={clipMarkers.onEndSecondsChange}
          />}
      </Box>

      {detailedTime
        ? <Box data-testid="time-duration" onDoubleClick={toggleDetailedTime} sx={detailedTimeTextSx}><DetailedTime type="duration" /></Box>
        : <Box component={Time} type="duration" data-testid="time-duration" onDoubleClick={toggleDetailedTime} sx={timeTextSx} />}

      <Box component={MuteButton} aria-label={muted ? 'Unmute' : 'Mute'} sx={resetButtonSx}>
        {muted ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
      </Box>

      <Box component={VolumeSlider.Root} aria-label="Volume" sx={{ ...sliderRootSx, width: 64 }}>
        <Box component={VolumeSlider.Track} sx={sliderTrackSx}>
          <Box component={VolumeSlider.TrackFill} sx={sliderTrackFillSx} />
        </Box>
        <Box component={VolumeSlider.Thumb} sx={sliderThumbSx} />
      </Box>

      {clipMarkers &&
        <>
          <Tooltip title="Set clip start here">
            <IconButton aria-label="Set clip start" onClick={clipMarkers.onSetStart} sx={clipButtonSx}>
              <StartIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Set clip end here">
            <IconButton aria-label="Set clip end" onClick={clipMarkers.onSetEnd} sx={clipButtonSx}>
              {/* Same icon as Set Start, mirrored -- reads as "the other end" of the same action. */}
              <StartIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Save clip">
            <span>
              <IconButton aria-label="Save clip" onClick={clipMarkers.onSave} disabled={clipMarkers.saveDisabled} sx={clipButtonSx}>
                <ContentCutIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Clear clip selection">
            <span>
              <IconButton aria-label="Clear clip selection" onClick={clipMarkers.onClear} disabled={clipMarkers.clearDisabled} sx={clipButtonSx}>
                <ClearIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </>}

      {canFullscreen &&
        <Box component={FullscreenButton} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} sx={resetButtonSx}>
          {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
        </Box>}
    </Box>
  );
}
