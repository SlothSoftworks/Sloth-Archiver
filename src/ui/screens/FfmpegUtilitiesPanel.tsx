import {
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
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
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
  onExtractMp3,
  onConvertFormat,
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
  onExtractMp3: () => void;
  onConvertFormat: () => void;
  onEmbedMetadata: () => void;
}) {
  const ffmpegControlsDisabled = !isVideoDownloaded || ffmpegAction !== null;
  // Embed Metadata doesn't need the video file specifically -- it can tag
  // whichever of video/audio exists, so it's enabled whenever either is
  // downloaded, not gated on isVideoDownloaded like the rest of the panel.
  const embedMetadataDisabled = (!isVideoDownloaded && !hasAudioFile) || ffmpegAction !== null;

  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Stack spacing={1}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
            FFMPEG utilities
          </Typography>
          <Tooltip title="FFmpeg is a tool this app uses to edit media files already on your device -- extracting audio, converting formats, or adding info tags -- without re-downloading anything. Clipping now lives in the player's own controls, above.">
            <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          </Tooltip>
        </Stack>
        {!isVideoDownloaded && !hasAudioFile &&
          <Typography variant="caption" color="text.secondary">
            Download the video or its MP3 for this version to use these tools.
          </Typography>}
        {!isVideoDownloaded && hasAudioFile &&
          <Typography variant="caption" color="text.secondary">
            Download the video for this version to use Extract MP3 and Convert.
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
