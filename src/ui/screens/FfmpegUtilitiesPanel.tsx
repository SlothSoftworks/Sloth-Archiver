import {
  Box,
  Checkbox,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import LinearProgressWithLabel from '../components/LinearProgressWithLabel';

// Sentinel Select value for "Other" -- a one-off custom format typed for
// just this conversion, distinct from the persisted custom list Options
// manages (that one adds a format to the dropdown; this one doesn't save
// anything).
export const OTHER_FORMAT_VALUE = '__other__';

// Shared wording for every "Transcode on convert" checkbox (main video
// Convert to, clip creation, clip Convert to) so the explanation reads
// identically wherever the option appears.
export const TRANSCODE_ON_CONVERT_TOOLTIP = 'When on, converting fully '
  + 're-encodes into the target format’s real codec (e.g. H.264 for MP4, '
  + 'VP9 for WebM) instead of just swapping the container -- guarantees the '
  + 'actual codec matches what the format implies, at the cost of a slower '
  + 'conversion and a re-encoded (not bit-identical) file. When off, a fast '
  + 'lossless container swap is tried first and only falls back to '
  + 're-encoding if that isn’t possible -- quicker, but the codec inside '
  + 'can end up being whatever the source file already used.';

// Digit-only, auto-formatting clip-timestamp input -- strips non-digits and
// right-aligns the typed digits into HH:MM:SS, growing an hours group past 4
// digits. Needed since archived videos can easily run past an hour.
export function formatClipTimestampInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  const len = digits.length;
  if (len <= 2) return digits;
  if (len <= 4) return `${digits.slice(0, len - 2)}:${digits.slice(len - 2)}`;
  return `${digits.slice(0, len - 4)}:${digits.slice(len - 4, len - 2)}:${digits.slice(len - 2)}`;
}

// Exported so SaveClipDialog.tsx can reuse the exact same "end >= start + 1s"
// validation rule, rather than re-implementing it.
export function parseClipTimestampSeconds(value: string): number {
  const parts = value.split(':').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts.slice(-3);
  return h * 3600 + m * 60 + s;
}

export function formatSecondsAsClipTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Backs the clip fields' up/down spinner arrows -- parses whatever's typed
// (SS / MM:SS / HH:MM:SS, or empty) down to a second count, nudges it, and
// renders back out fully zero-padded so the result stays unambiguous.
function stepClipTimestamp(value: string, deltaSeconds: number): string {
  return formatSecondsAsClipTimestamp(parseClipTimestampSeconds(value) + deltaSeconds);
}

// Every control here operates on the video *file*, gated on isVideoDownloaded
// (regardless of an existing MP3), or on ffmpegAction !== null while another
// utility is already running (they share one ffmpegAction slot in the
// parent, since only one can run at a time).
export default function FfmpegUtilitiesPanel({
  ffmpegAction,
  ffmpegProgress,
  ffmpegError,
  isVideoDownloaded,
  hasAudioFile,
  convertFormat,
  setConvertFormat,
  convertFormatOptions,
  otherFormatInput,
  setOtherFormatInput,
  forceReencode,
  setForceReencode,
  clipStart,
  setClipStart,
  clipEnd,
  setClipEnd,
  onSetClipStartFromPlayer,
  onSetClipEndFromPlayer,
  onExtractMp3,
  onConvertFormat,
  onExtractClip,
  onEmbedMetadata,
}: {
  ffmpegAction: 'extractMp3' | 'convert' | 'clip' | 'embedMetadata' | 'extractAudioToLibrary' | 'extractClipMp3' | 'convertClip' | null;
  ffmpegProgress: number;
  ffmpegError: string | null;
  isVideoDownloaded: boolean;
  hasAudioFile: boolean;
  convertFormat: string;
  setConvertFormat: (format: string) => void;
  convertFormatOptions: string[];
  otherFormatInput: string;
  setOtherFormatInput: (value: string) => void;
  forceReencode: boolean;
  setForceReencode: (value: boolean) => void;
  clipStart: string;
  setClipStart: (value: string) => void;
  clipEnd: string;
  setClipEnd: (value: string) => void;
  onSetClipStartFromPlayer: () => void;
  onSetClipEndFromPlayer: () => void;
  onExtractMp3: () => void;
  onConvertFormat: () => void;
  onExtractClip: () => void;
  onEmbedMetadata: () => void;
}) {
  const ffmpegControlsDisabled = !isVideoDownloaded || ffmpegAction !== null;
  // Embed Metadata doesn't need the video file specifically -- it can tag
  // whichever of video/audio exists, so it's enabled whenever either is
  // downloaded, not gated on isVideoDownloaded like the rest of the panel.
  const embedMetadataDisabled = (!isVideoDownloaded && !hasAudioFile) || ffmpegAction !== null;
  // ffmpeg's -to is an absolute end timestamp, not a duration -- if it isn't
  // at least a second past -ss, ffmpeg aborts with "-to value smaller than
  // -ss". Caught here since there's nothing to extract from end <= start.
  const clipRangeInvalid = !!clipStart.trim() && !!clipEnd.trim()
    && parseClipTimestampSeconds(clipEnd) < parseClipTimestampSeconds(clipStart) + 1;

  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Stack spacing={1}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
            FFMPEG utilities
          </Typography>
          <Tooltip title="FFmpeg is a tool this app uses to edit media files already on your device -- extracting audio, converting formats, trimming clips, or adding info tags -- without re-downloading anything.">
            <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          </Tooltip>
        </Stack>
        {!isVideoDownloaded && !hasAudioFile &&
          <Typography variant="caption" color="text.secondary">
            Download the video or its MP3 for this version to use these tools.
          </Typography>}
        {!isVideoDownloaded && hasAudioFile &&
          <Typography variant="caption" color="text.secondary">
            Download the video for this version to use Extract MP3, Convert, and Clip.
          </Typography>}
        {ffmpegAction &&
          <LinearProgressWithLabel value={ffmpegProgress} valueBuffer={ffmpegProgress} />}
        {ffmpegError &&
          <Typography variant="caption" color="error">{ffmpegError}</Typography>}

        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ flexGrow: 1 }}>Extract MP3</Typography>
          <Tooltip title="Extract MP3">
            <span>
              <IconButton size="small" aria-label="Extract MP3" onClick={onExtractMp3} disabled={ffmpegControlsDisabled}>
                <AudiotrackIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ flexGrow: 1 }}>Convert to</Typography>
          <Select
            size="small"
            variant="standard"
            value={convertFormat}
            onChange={(e) => setConvertFormat(e.target.value)}
            disabled={ffmpegControlsDisabled}
          >
            {convertFormatOptions.map((format) => (
              <MenuItem key={format} value={format.toLowerCase()}>{format.toUpperCase()}</MenuItem>
            ))}
            <MenuItem value={OTHER_FORMAT_VALUE}>Other...</MenuItem>
          </Select>
          <Tooltip title="Convert">
            <span>
              <IconButton size="small" aria-label="Convert to a different format" onClick={onConvertFormat} disabled={ffmpegControlsDisabled}>
                <SwapHorizIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        {convertFormat === OTHER_FORMAT_VALUE &&
          <Stack spacing={0.5}>
            <TextField
              size="small"
              variant="standard"
              placeholder="Format name"
              value={otherFormatInput}
              onChange={(e) => setOtherFormatInput(e.target.value)}
              disabled={ffmpegControlsDisabled}
              slotProps={{ htmlInput: { 'aria-label': 'Custom format name' } }}
            />
            <Typography variant="caption" color="text.secondary">
              Must match a real ffmpeg muxer name (e.g. mp4, matroska, avi).
            </Typography>
          </Stack>}
        <Stack direction="row" spacing={0.5} alignItems="center">
          <FormControlLabel
            sx={{ ml: 0 }}
            control={
              <Checkbox
                size="small"
                checked={forceReencode}
                onChange={(e) => setForceReencode(e.target.checked)}
                disabled={ffmpegControlsDisabled}
              />
            }
            label={<Typography variant="body2">Transcode on convert</Typography>}
          />
          <Tooltip title={TRANSCODE_ON_CONVERT_TOOLTIP}>
            <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          </Tooltip>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2">Clip</Typography>
          <Tooltip title="Set start to the player's current position">
            <span>
              <IconButton
                size="small"
                onClick={onSetClipStartFromPlayer}
                disabled={ffmpegControlsDisabled}
                aria-label="Set clip start from player position"
              >
                <AccessTimeIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <TextField
            size="small"
            variant="standard"
            placeholder="HH:MM:SS"
            value={clipStart}
            onChange={(e) => setClipStart(formatClipTimestampInput(e.target.value))}
            disabled={ffmpegControlsDisabled}
            sx={{ width: 96 }}
            slotProps={{
              htmlInput: { inputMode: 'numeric', 'aria-label': 'Clip start (HH:MM:SS)' },
              input: {
                endAdornment: (
                  <Stack sx={{ ml: 0.5 }}>
                    <IconButton
                      size="small"
                      sx={{ p: 0 }}
                      disabled={ffmpegControlsDisabled}
                      onClick={() => setClipStart(stepClipTimestamp(clipStart, 1))}
                      aria-label="Increase clip start by 1 second"
                    >
                      <KeyboardArrowUpIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                    <IconButton
                      size="small"
                      sx={{ p: 0 }}
                      disabled={ffmpegControlsDisabled}
                      onClick={() => setClipStart(stepClipTimestamp(clipStart, -1))}
                      aria-label="Decrease clip start by 1 second"
                    >
                      <KeyboardArrowDownIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Stack>
                ),
              },
            }}
          />
          <Typography variant="body2" color="text.secondary">–</Typography>
          <Tooltip title="Set end to the player's current position">
            <span>
              <IconButton
                size="small"
                onClick={onSetClipEndFromPlayer}
                disabled={ffmpegControlsDisabled}
                aria-label="Set clip end from player position"
              >
                <AccessTimeIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <TextField
            size="small"
            variant="standard"
            placeholder="HH:MM:SS"
            value={clipEnd}
            onChange={(e) => setClipEnd(formatClipTimestampInput(e.target.value))}
            disabled={ffmpegControlsDisabled}
            sx={{ width: 96 }}
            slotProps={{
              htmlInput: { inputMode: 'numeric', 'aria-label': 'Clip end (HH:MM:SS)' },
              input: {
                endAdornment: (
                  <Stack sx={{ ml: 0.5 }}>
                    <IconButton
                      size="small"
                      sx={{ p: 0 }}
                      disabled={ffmpegControlsDisabled}
                      onClick={() => setClipEnd(stepClipTimestamp(clipEnd, 1))}
                      aria-label="Increase clip end by 1 second"
                    >
                      <KeyboardArrowUpIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                    <IconButton
                      size="small"
                      sx={{ p: 0 }}
                      disabled={ffmpegControlsDisabled}
                      onClick={() => setClipEnd(stepClipTimestamp(clipEnd, -1))}
                      aria-label="Decrease clip end by 1 second"
                    >
                      <KeyboardArrowDownIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Stack>
                ),
              },
            }}
          />
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title={clipRangeInvalid ? 'End must be at least 1 second after start' : 'Extract clip'}>
            <span>
              <IconButton
                size="small"
                aria-label="Extract clip"
                onClick={onExtractClip}
                disabled={ffmpegControlsDisabled || !clipStart.trim() || !clipEnd.trim() || clipRangeInvalid}
              >
                <ContentCutIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        {clipRangeInvalid &&
          <Typography variant="caption" color="error">
            End must be at least 1 second after start.
          </Typography>}

        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ flexGrow: 1 }}>Embed metadata</Typography>
          <Tooltip title="Embed metadata">
            <span>
              <IconButton size="small" aria-label="Embed metadata into local file" onClick={onEmbedMetadata} disabled={embedMetadataDisabled}>
                <LabelOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>
    </>
  );
}
