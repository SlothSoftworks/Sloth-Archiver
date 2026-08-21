import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormGroup,
  Grid,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import DownloadDoneIcon from '@mui/icons-material/DownloadDone';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import LinkIcon from '@mui/icons-material/Link';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { convertYYYYMMDDStringToDate, buildAppVideoUrl } from '../../utils/utils.ts';
import { POPULAR_CONVERT_FORMATS } from '../../utils/ffmpegFormats.ts';
import { formatComment } from '../components/componentUtils';
import useDownloadVideo from '../hooks/useDownloadVideo.tsx';
import LibraryVideoPlayer, { type LibraryVideoPlayerHandle } from '../components/LibraryVideoPlayer';

type LibraryResolution = { resolution: string; filesizeMb: string };

export type LibraryVideoMetadata = {
  schemaVersion?: number;
  videoId: string;
  channel: string | null;
  title: string | null;
  fullTitle: string | null;
  description: string | null;
  thumbnail: string | null;
  originalUrl: string | null;
  durationString: string | null;
  uploadDate: string | null;
  resolutions?: LibraryResolution[];
  downloadedFilePath: string | null;
  downloadedResolution: string | null;
  downloadedFormat: string | null;
  // MP3 is a separate, coexisting artifact, not a competing "quality" -- its
  // own slot, independent of the video fields above.
  downloadedAudioFilePath: string | null;
};

type LibraryVideo = {
  videoFolderName: string;
  videoDir: string;
  latestEpoch: string | null;
  metadata: LibraryVideoMetadata;
  epochs: { epoch: string; metadata: LibraryVideoMetadata }[];
  thumbnailPath: string | null;
};

// Epoch folder names are Date.now() ms timestamps -- no existing formatter
// anywhere in the renderer turns one into something readable.
function formatEpochLabel(epoch: string): string {
  return new Date(Number(epoch)).toLocaleString();
}

// Same small extension-extraction as LibraryVideoPlayer.tsx's own copy, not
// shared -- this file has no other coupling to that component.
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot === -1 ? '' : filePath.slice(lastDot + 1).toLowerCase();
}

// Digit-only, auto-formatting clip-timestamp input -- strips non-digits and
// right-aligns the typed digits into HH:MM:SS, growing an hours group past 4
// digits. Needed since archived videos can easily run past an hour.
function formatClipTimestampInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  const len = digits.length;
  if (len <= 2) return digits;
  if (len <= 4) return `${digits.slice(0, len - 2)}:${digits.slice(len - 2)}`;
  return `${digits.slice(0, len - 4)}:${digits.slice(len - 4, len - 2)}:${digits.slice(len - 2)}`;
}

// Backs the clip fields' up/down spinner arrows -- parses whatever's typed
// (SS / MM:SS / HH:MM:SS, or empty) down to a second count, nudges it, and
// renders back out fully zero-padded so the result stays unambiguous.
function parseClipTimestampSeconds(value: string): number {
  const parts = value.split(':').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts.slice(-3);
  return h * 3600 + m * 60 + s;
}

function formatSecondsAsClipTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function stepClipTimestamp(value: string, deltaSeconds: number): string {
  return formatSecondsAsClipTimestamp(parseClipTimestampSeconds(value) + deltaSeconds);
}

// Sentinel Select value for "Other" -- a one-off custom format typed for
// just this conversion, distinct from the persisted custom list Options
// manages (that one adds a format to the dropdown; this one doesn't save
// anything).
const OTHER_FORMAT_VALUE = '__other__';

// Mirrors library.mjs's own CURRENT_VIDEO_SCHEMA_VERSION (main process and
// renderer never cross-import here). An entry whose stored schemaVersion is
// older than this predates a metadata-shape change and won't have whatever
// that change added -- "Refresh from YouTube" is what fixes it.
const CURRENT_VIDEO_SCHEMA_VERSION = 3;

// Same visual pattern as VideoDetailCard.tsx's buffer bar, kept as a
// separate copy since this file has no other coupling to that component.
function LinearProgressWithLabel({ value, valueBuffer }: { value: number; valueBuffer: number }) {
  const displayValue = value > 0 ? value : valueBuffer;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Box sx={{ width: '100%', mr: 1 }}>
        <LinearProgress variant="buffer" value={value} valueBuffer={valueBuffer} />
      </Box>
      <Box sx={{ minWidth: 35 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{`${Math.round(displayValue)}%`}</Typography>
      </Box>
    </Box>
  );
}

// Shared between the first-download and "download different quality" flows
// -- excludeResolution blocks re-picking whatever's already downloaded
// rather than hiding it, so it's clear why one button is greyed out instead
// of silently missing.
function ResolutionPicker({ resolutions, excludeResolution, onSelect, selectedFormat, onFormatChange, isError, disabled }: {
  resolutions: LibraryResolution[];
  excludeResolution?: string | null;
  onSelect: (resolution: string) => void;
  selectedFormat: string;
  onFormatChange: (format: string) => void;
  isError: boolean;
  disabled?: boolean;
}) {
  return (
    <>
      {isError &&
        <Typography color="error" variant="body2" sx={{ mb: 1 }}>Download failed -- try again.</Typography>}
      <Grid container spacing={1} columns={{ xs: 2, sm: 9, md: 12 }}>
        {resolutions.map((res, idx) => (
          <Grid size={{ xs: 1, sm: 3 }} key={idx}>
            <Button
              onClick={() => onSelect(res.resolution)}
              disabled={res.resolution === excludeResolution || disabled}
              sx={{ whiteSpace: 'pre-line' }}
              fullWidth
              variant="outlined"
            >
              <Stack spacing={0} direction="column" divider={<Divider flexItem sx={{ mx: 1 }} orientation="horizontal" />}>
                <Typography variant="button" textTransform="none">
                  {res.resolution}p{res.resolution === excludeResolution ? ' (current)' : ''}
                </Typography>
                <Typography variant="caption">{res.filesizeMb}Mb</Typography>
              </Stack>
            </Button>
          </Grid>
        ))}
      </Grid>
      <Divider sx={{ my: 1 }} />
      <FormGroup>
        <Select
          size="small"
          value={selectedFormat}
          onChange={(e) => onFormatChange(e.target.value)}
          variant="standard"
        >
          <MenuItem value="dflt">Default (keep origin format)</MenuItem>
          <MenuItem value="mp4">MP4</MenuItem>
          <MenuItem value="webm">WEBM</MenuItem>
          <MenuItem value="mkv">MKV</MenuItem>
        </Select>
      </FormGroup>
    </>
  );
}

export default function LibraryVideoDetail({ video, onBack, onLibraryChanged, onDeleted, onVersionsChanged }: {
  video: LibraryVideo;
  onBack: () => void;
  onLibraryChanged: () => Promise<void> | void;
  onDeleted: () => void;
  onVersionsChanged: () => Promise<void> | void;
}) {
  const [selectedEpoch, setSelectedEpoch] = useState(video.latestEpoch);
  const [metadata, setMetadata] = useState(video.metadata);
  const [selectedFormat, setSelectedFormat] = useState('dflt');
  const [selectedResolution, setSelectedResolution] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [swappingQuality, setSwappingQuality] = useState(false);
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [createVersionError, setCreateVersionError] = useState<string | null>(null);
  const [refreshingMetadata, setRefreshingMetadata] = useState(false);
  const [refreshMetadataError, setRefreshMetadataError] = useState<string | null>(null);
  // 'initial' vs 'swap' decides which backend call the isDone effect below
  // makes -- both flows reuse the same useDownloadVideo() instance below
  // (startDownload resets isDone/isError/progress on every call, so reusing
  // one hook instance across calls is safe).
  const [downloadMode, setDownloadMode] = useState<'initial' | 'swap'>('initial');
  // Video and audio (MP3) downloads coexist as separate files but share this
  // one useDownloadVideo() instance -- its progress events aren't tagged
  // per-download (TD-008), so two running at once would cross-talk.
  // downloadTarget says which one owns the in-flight download; the UI
  // disables the *other* target's controls while one is active.
  const [downloadTarget, setDownloadTarget] = useState<'video' | 'audio'>('video');
  // Bumped after a successful quality swap and threaded into the player's
  // src URL -- a swap can land on the same file path+extension, and without
  // this the <video>/<audio> element has no signal the bytes changed.
  const [cacheBustKey, setCacheBustKey] = useState(0);

  // FFMPEG utilities -- kept minimal: a single target-format choice for
  // convert, plain start/end text fields for the clip trim, no scrubber.
  const [convertFormat, setConvertFormat] = useState('mp4');
  const [otherFormatInput, setOtherFormatInput] = useState('');
  const [clipStart, setClipStart] = useState('');
  const [clipEnd, setClipEnd] = useState('');
  // Backs the clip fields' "pick from player" buttons -- LibraryVideoPlayer
  // exposes the <video> element's currentTime through this handle, since the
  // element lives inside that component, not here.
  const playerRef = useRef<LibraryVideoPlayerHandle>(null);
  // User-added muxers from Options, on top of the popular default set --
  // fetched once on mount, no live-update need within a session.
  const [customConvertFormats, setCustomConvertFormats] = useState<string[]>([]);
  useEffect(() => {
    window.electronAPI.getCustomConvertFormats().then(({ customConvertFormats }) => setCustomConvertFormats(customConvertFormats));
  }, []);
  const convertFormatOptions = [
    ...POPULAR_CONVERT_FORMATS,
    ...customConvertFormats.filter((f) => !POPULAR_CONVERT_FORMATS.includes(f.toLowerCase())),
  ];

  // Which ffmpeg utility (if any) is currently running -- gates the panel
  // the same way downloadTarget gates video-vs-audio above, but on an
  // entirely separate hook/channel: these run against an already-downloaded
  // file, not a fresh yt-dlp download (see main.js's ffmpegUtilityProgress).
  const [ffmpegAction, setFfmpegAction] = useState<'extractMp3' | 'convert' | 'clip' | 'embedMetadata' | 'extractAudioToLibrary' | null>(null);
  const [ffmpegProgress, setFfmpegProgress] = useState(0);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  // Separate from ffmpegError -- embedding is fast enough that a plain
  // disabled->enabled flicker isn't a reliable "it worked" signal, so a
  // toast confirms it explicitly.
  const [embedSuccessSnackbarOpen, setEmbedSuccessSnackbarOpen] = useState(false);
  const [linkCopiedSnackbarOpen, setLinkCopiedSnackbarOpen] = useState(false);
  useEffect(() => {
    window.electronAPI.onFfmpegUtilityProgress(({ percent }) => {
      if (typeof percent === 'number') setFfmpegProgress(percent);
    });
    return () => window.electronAPI.removeFfmpegUtilityProgressListener();
  }, []);

  const { downloadProgress, postprocessProgress, downloadStatus, finalFilePath, isDone, isError, startDownload } = useDownloadVideo();

  // A genuinely different video was selected (not just a data refresh of the
  // same one, e.g. after a download/swap/version-add) -- jump to its latest.
  useEffect(() => {
    setSelectedEpoch(video.latestEpoch);
    setMetadata(video.metadata);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.videoDir]);

  // The epoch currently viewed may have just been deleted -- if a refresh
  // shows it's no longer in the list, fall back to the new latest rather
  // than pointing at a version that no longer exists.
  useEffect(() => {
    if (selectedEpoch && !video.epochs.some((e) => e.epoch === selectedEpoch)) {
      setSelectedEpoch(video.latestEpoch);
      setMetadata(video.metadata);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.epochs]);

  const handleSelectEpoch = (epoch: string) => {
    const found = video.epochs.find((e) => e.epoch === epoch);
    if (!found) return;
    setSelectedEpoch(epoch);
    setMetadata(found.metadata);
    // Reset transient per-epoch UI state -- these reflect the previous
    // version's in-progress state and don't apply to the newly selected one.
    setSelectedResolution('');
    setSwappingQuality(false);
  };

  // "Download new version" -- re-fetches live data (never the cache, since
  // the whole point is capturing what may have actually changed since this
  // video was first tracked) and adds it as a new epoch under this same
  // video, then swaps the view to it.
  const handleDownloadNewVersion = async () => {
    if (!metadata.originalUrl) return;
    setCreatingVersion(true);
    setCreateVersionError(null);
    // Tracks whether addLibraryVersion has actually created a new epoch on
    // disk -- if anything fails after that (e.g. the resync below), the
    // catch block rolls it back instead of leaving an orphaned epoch folder.
    let createdEpoch: string | null = null;
    try {
      await window.electronAPI.deleteVideoInfoCacheEntry(metadata.originalUrl);
      const result = await window.electronAPI.getVideoInfoPython(metadata.originalUrl);
      if (!result.success) {
        throw new Error('Failed to fetch fresh video data.');
      }
      // getVideoInfoPython already rejects a dead video server-side -- this
      // repeats that same check as defense in depth, so a technically
      // successful fetch with dead data can never create a new version.
      const freshResponse = result.data.response;
      if (!freshResponse.channelId && !freshResponse.uploader) {
        throw new Error('This video appears to be unavailable on YouTube (private, deleted, or removed) -- no new version was created.');
      }
      const added = await window.electronAPI.addLibraryVersion(freshResponse, video.videoDir);
      createdEpoch = added.epoch;
      // Needs the deeper resync, not plain onLibraryChanged: the version
      // selector's option list reads from the `video` prop's own `epochs`
      // array, which needs a fresh prop after adding an epoch.
      await onVersionsChanged();
      setSelectedEpoch(added.epoch);
      setMetadata(added.metadata);
      setSelectedResolution('');
      setSwappingQuality(false);
    } catch (err) {
      if (createdEpoch) {
        await window.electronAPI.deleteLibraryEntry(video.videoDir, createdEpoch);
        await onVersionsChanged();
      }
      setCreateVersionError(err instanceof Error ? err.message : 'Failed to create a new version.');
    } finally {
      setCreatingVersion(false);
    }
  };

  const handleCopyLink = async () => {
    if (!metadata.originalUrl) return;
    await navigator.clipboard.writeText(metadata.originalUrl);
    setLinkCopiedSnackbarOpen(true);
  };

  // "Refresh from YouTube" -- re-fetches live data like "Download new
  // version" does, but writes it into the *currently selected* version in
  // place instead of adding a new one, for when just the metadata (title,
  // description, or a since-private/unlisted status) has gone stale.
  const handleRefreshFromYouTube = async () => {
    if (!metadata.originalUrl || !selectedEpoch) return;
    setRefreshingMetadata(true);
    setRefreshMetadataError(null);
    try {
      await window.electronAPI.deleteVideoInfoCacheEntry(metadata.originalUrl);
      const result = await window.electronAPI.getVideoInfoPython(metadata.originalUrl);
      if (!result.success) {
        throw new Error('Failed to fetch fresh video data.');
      }
      const freshResponse = result.data.response;
      if (!freshResponse.channelId && !freshResponse.uploader) {
        throw new Error('This video appears to be unavailable on YouTube (private, deleted, or removed) -- nothing was changed.');
      }
      const refreshed = await window.electronAPI.refreshLibraryEntry(video.videoDir, selectedEpoch, freshResponse);
      setMetadata(refreshed.metadata);
      await onVersionsChanged();
    } catch (err) {
      setRefreshMetadataError(err instanceof Error ? err.message : 'Failed to refresh this version from YouTube.');
    } finally {
      setRefreshingMetadata(false);
    }
  };

  const handleDownload = (resolution: string) => {
    if (!selectedEpoch) return;
    setDownloadTarget('video');
    setDownloadMode('initial');
    setSelectedResolution(resolution);
    // Deterministic path inside the video's own storage -- no Save dialog or
    // overwrite prompt needed, since this folder is ours, not a user-picked
    // location. Keyed off whichever version is currently selected, not
    // always the newest. yt-dlp/ffmpeg fill in the right extension, same
    // findFinalFile-style resolution used elsewhere in this app.
    const outputPath = `${video.videoDir}/${selectedEpoch}/video`;
    startDownload({ videoUrl: metadata.originalUrl || '', outputPath, format: selectedFormat, resolution });
  };

  // "Download different quality" -- downloads to a distinct "video.new.<ext>"
  // path rather than the live file's path, so a failed/interrupted download
  // never touches the working file. The actual delete-old/rename-new swap
  // only happens in the isDone effect below, once the new file is complete.
  const handleSwapDownload = (resolution: string) => {
    if (!selectedEpoch) return;
    setDownloadTarget('video');
    setDownloadMode('swap');
    setSelectedResolution(resolution);
    const outputPath = `${video.videoDir}/${selectedEpoch}/video.new`;
    startDownload({ videoUrl: metadata.originalUrl || '', outputPath, format: selectedFormat, resolution });
  };

  // Covers both "download MP3 for the first time" and "re-download to
  // replace an existing one" -- decided by whether downloadedAudioFilePath
  // is already set, no confirm-UI needed since there's only one MP3 option.
  // The re-download case still gets the safe temp-then-rename treatment via
  // swapLibraryDownload in the isDone effect below.
  const handleAudioDownload = () => {
    if (!selectedEpoch) return;
    const isReplacing = !!metadata.downloadedAudioFilePath;
    setDownloadTarget('audio');
    setDownloadMode(isReplacing ? 'swap' : 'initial');
    setSelectedResolution('mp3');
    const outputPath = `${video.videoDir}/${selectedEpoch}/${isReplacing ? 'audio.new' : 'audio'}`;
    startDownload({ videoUrl: metadata.originalUrl || '', outputPath, format: 'dflt', resolution: 'mp3' });
  };

  useEffect(() => {
    if (!isDone || !selectedEpoch) return;
    (async () => {
      const kind = downloadTarget;
      if (downloadMode === 'swap') {
        const updated = await window.electronAPI.swapLibraryDownload({
          videoDir: video.videoDir,
          epoch: selectedEpoch,
          tempFilePath: finalFilePath,
          oldFilePath: kind === 'audio' ? metadata.downloadedAudioFilePath : metadata.downloadedFilePath,
          resolution: selectedResolution,
          format: selectedFormat,
          kind,
        });
        setMetadata(updated);
        setCacheBustKey((prev) => prev + 1);
        setSwappingQuality(false);
        setSelectedResolution('');
      } else {
        await window.electronAPI.recordLibraryDownload({
          videoDir: video.videoDir,
          epoch: selectedEpoch,
          filePath: finalFilePath,
          resolution: selectedResolution,
          format: selectedFormat,
          kind,
        });
        setMetadata((prev) => (kind === 'audio'
          ? { ...prev, downloadedAudioFilePath: finalFilePath }
          : { ...prev, downloadedFilePath: finalFilePath, downloadedResolution: selectedResolution, downloadedFormat: selectedFormat }));
        // Audio has no video-style "swap confirm UI" to fall back out of --
        // always clear selectedResolution so the Audio section's
        // active-download check doesn't stay stuck showing progress.
        if (kind === 'audio') setSelectedResolution('');
      }
      // Deep resync, not the shallow onLibraryChanged: handleSelectEpoch
      // re-reads from the `video` prop's `epochs` array on every switch, so
      // without this, switching away from this epoch and back would revert
      // to the stale downloadedFilePath the prop had before this download.
      await onVersionsChanged();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDone]);

  const handleOpenFileLocation = () => {
    if (metadata.downloadedFilePath) {
      window.electronAPI.openFileInDirectory(metadata.downloadedFilePath);
    }
  };

  const handleOpenExternally = () => {
    if (metadata.downloadedFilePath) {
      window.electronAPI.openFileExternally(metadata.downloadedFilePath);
    }
  };

  const handleOpenAudioFileLocation = () => {
    if (metadata.downloadedAudioFilePath) {
      window.electronAPI.openFileInDirectory(metadata.downloadedAudioFilePath);
    }
  };

  const handleOpenAudioExternally = () => {
    if (metadata.downloadedAudioFilePath) {
      window.electronAPI.openFileExternally(metadata.downloadedAudioFilePath);
    }
  };

  const handleExtractMp3 = async () => {
    if (!metadata.downloadedFilePath) return;
    const result = await window.electronAPI.saveExportedFile({
      defaultName: `${metadata.title || video.videoFolderName}.mp3`,
      extensions: ['mp3'],
      inputPath: metadata.downloadedFilePath,
    });
    if (result.canceled || !result.filePath) return;
    setFfmpegAction('extractMp3');
    setFfmpegError(null);
    setFfmpegProgress(0);
    const res = await window.electronAPI.extractMp3FromFile({ inputPath: metadata.downloadedFilePath, outputPath: result.filePath });
    if (!res.success) setFfmpegError(res.message || 'Failed to extract MP3.');
    setFfmpegAction(null);
  };

  const handleConvertFormat = async () => {
    if (!metadata.downloadedFilePath) return;
    const targetFormat = (convertFormat === OTHER_FORMAT_VALUE ? otherFormatInput : convertFormat).trim().toLowerCase();
    if (!targetFormat) return;
    const result = await window.electronAPI.saveExportedFile({
      defaultName: `${metadata.title || video.videoFolderName}.${targetFormat}`,
      extensions: [targetFormat],
      inputPath: metadata.downloadedFilePath,
    });
    if (result.canceled || !result.filePath) return;
    setFfmpegAction('convert');
    setFfmpegError(null);
    setFfmpegProgress(0);
    const res = await window.electronAPI.convertFileFormat({ inputPath: metadata.downloadedFilePath, outputPath: result.filePath, format: targetFormat });
    if (!res.success) setFfmpegError(res.message || 'Failed to convert.');
    setFfmpegAction(null);
  };

  // "Pick timestamp" -- grabs wherever the player's playback currently sits
  // and drops it into the clip field, rounded down to a whole second since
  // the clip fields are whole-second precision. A silent no-op with no
  // active video element to read from -- ffmpegControlsDisabled already
  // keeps the buttons disabled in that case.
  const handleSetClipStartFromPlayer = () => {
    const time = playerRef.current?.getCurrentTime();
    if (time == null) return;
    setClipStart(formatSecondsAsClipTimestamp(Math.floor(time)));
  };

  const handleSetClipEndFromPlayer = () => {
    const time = playerRef.current?.getCurrentTime();
    if (time == null) return;
    setClipEnd(formatSecondsAsClipTimestamp(Math.floor(time)));
  };

  const handleExtractClip = async () => {
    if (!metadata.downloadedFilePath || !clipStart.trim() || !clipEnd.trim() || clipRangeInvalid) return;
    const ext = getExtension(metadata.downloadedFilePath) || 'mp4';
    const result = await window.electronAPI.saveExportedFile({
      defaultName: `${metadata.title || video.videoFolderName} (clip).${ext}`,
      extensions: [ext],
      inputPath: metadata.downloadedFilePath,
    });
    if (result.canceled || !result.filePath) return;
    setFfmpegAction('clip');
    setFfmpegError(null);
    setFfmpegProgress(0);
    const res = await window.electronAPI.extractClipFromFile({
      inputPath: metadata.downloadedFilePath,
      outputPath: result.filePath,
      start: clipStart.trim(),
      end: clipEnd.trim(),
    });
    if (!res.success) setFfmpegError(res.message || 'Failed to extract clip.');
    setFfmpegAction(null);
  };

  // Local ffmpeg extraction from the already-downloaded video file, landing
  // directly in this version's own audio slot -- unlike handleExtractMp3
  // above (exports a copy to a user-picked location), this saves and plays
  // back through the library like a real MP3 download, without re-fetching
  // from YouTube. Only invoked from the "no MP3 yet" branch, so no
  // replace/swap path is needed.
  const handleExtractAudioToLibrary = async () => {
    if (!selectedEpoch || !metadata.downloadedFilePath || metadata.downloadedAudioFilePath) return;
    setFfmpegAction('extractAudioToLibrary');
    setFfmpegError(null);
    setFfmpegProgress(0);
    const outputPath = `${video.videoDir}/${selectedEpoch}/audio.mp3`;
    const res = await window.electronAPI.extractMp3FromFile({ inputPath: metadata.downloadedFilePath, outputPath });
    if (res.success) {
      await window.electronAPI.recordLibraryDownload({
        videoDir: video.videoDir,
        epoch: selectedEpoch,
        filePath: outputPath,
        resolution: 'mp3',
        format: 'dflt',
        kind: 'audio',
      });
      setMetadata((prev) => ({ ...prev, downloadedAudioFilePath: outputPath }));
      // Same deep resync reason as the isDone effect above.
      await onVersionsChanged();
    } else {
      setFfmpegError(res.message || 'Failed to extract MP3.');
    }
    setFfmpegAction(null);
  };

  const handleEmbedMetadata = async () => {
    // Embeds into whichever of the video/audio files this version has --
    // either, or both, since they're independent coexisting slots. kind
    // tells main.js which stream index the cover art lands at.
    const targets: { path: string; kind: 'video' | 'audio' }[] = [
      metadata.downloadedFilePath ? { path: metadata.downloadedFilePath, kind: 'video' as const } : null,
      metadata.downloadedAudioFilePath ? { path: metadata.downloadedAudioFilePath, kind: 'audio' as const } : null,
    ].filter((t): t is { path: string; kind: 'video' | 'audio' } => !!t);
    if (targets.length === 0) return;
    setFfmpegAction('embedMetadata');
    setFfmpegError(null);
    setFfmpegProgress(0);
    const metadataTags = {
      title: metadata.title,
      artist: metadata.channel,
      date: metadata.uploadDate,
      description: metadata.description,
    };
    let failureMessage: string | null = null;
    for (const target of targets) {
      const res = await window.electronAPI.embedFileMetadata({
        inputPath: target.path,
        kind: target.kind,
        thumbnailPath: video.thumbnailPath,
        metadataTags,
      });
      if (!res.success) failureMessage = res.message || 'Failed to embed metadata.';
    }
    if (failureMessage) {
      setFfmpegError(failureMessage);
    } else {
      // Same file paths as before, new bytes -- without this the player
      // would keep showing whatever it already had cached under that
      // unchanged src, same reason every quality swap bumps this too.
      setCacheBustKey((prev) => prev + 1);
      setEmbedSuccessSnackbarOpen(true);
    }
    setFfmpegAction(null);
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      // Deletes only the currently-displayed version -- if that was the
      // last one, the whole video goes with it and we land back at the
      // library root. Otherwise the parent refreshes both the root channel
      // list and this stale `video` prop so the view swaps to the new latest.
      const { videoDeleted } = await window.electronAPI.deleteLibraryEntry(video.videoDir, selectedEpoch || undefined);
      if (videoDeleted) {
        await onLibraryChanged();
        onDeleted();
      } else {
        await onVersionsChanged();
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete this entry.');
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  const isAudioActionActive = downloadTarget === 'audio' && !!selectedResolution && !isError;
  const isDownloading = downloadTarget === 'video' && !!selectedResolution && !isError && !metadata.downloadedFilePath && !swappingQuality;
  const isSwapDownloading = downloadTarget === 'video' && !!selectedResolution && !isError && swappingQuality;
  // Derived from the two flags above, not a standalone check, so it clears
  // the instant a video download finishes -- selectedResolution is
  // deliberately left set after an initial download (see the isDone
  // effect), so nothing else would clear this and it would lock out Audio.
  const isVideoActionActive = isDownloading || isSwapDownloading;
  // Gates the whole FFMPEG utilities section -- every tool there operates on
  // the video file, not the separate MP3 slot.
  const isVideoDownloaded = !!metadata.downloadedFilePath;
  // Shared disabled condition for every ffmpeg-utility control: no video
  // downloaded, or another utility already mid-run (one ffmpegAction slot).
  const ffmpegControlsDisabled = !isVideoDownloaded || ffmpegAction !== null;
  // Embed Metadata doesn't need the video file specifically -- it can tag
  // whichever of video/audio exists, so it's enabled whenever either is
  // downloaded, not gated on isVideoDownloaded like the rest of the panel.
  const embedMetadataDisabled = (!isVideoDownloaded && !metadata.downloadedAudioFilePath) || ffmpegAction !== null;
  // ffmpeg's -to is an absolute end timestamp, not a duration -- if it isn't
  // at least a second past -ss, ffmpeg aborts with "-to value smaller than
  // -ss". Caught here since there's nothing to extract from end <= start.
  const clipRangeInvalid = !!clipStart.trim() && !!clipEnd.trim()
    && parseClipTimestampSeconds(clipEnd) < parseClipTimestampSeconds(clipStart) + 1;
  const resolutions = metadata.resolutions || [];
  // MP3 is rendered in its own Audio sub-section, not mixed into the video
  // quality grid.
  const videoResolutions = resolutions.filter((r) => r.resolution !== 'MP3');
  const mp3Resolution = resolutions.find((r) => r.resolution === 'MP3');
  const isSchemaOutdated = (metadata.schemaVersion ?? 0) < CURRENT_VIDEO_SCHEMA_VERSION;

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <IconButton onClick={onBack} size="small" aria-label="Back to videos">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography variant="h6" noWrap>{metadata.title || video.videoFolderName}</Typography>
          <Tooltip title="Copy link">
            <span>
              <IconButton size="small" onClick={handleCopyLink} disabled={!metadata.originalUrl} aria-label="Copy link">
                <LinkIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Chip
            size="small"
            color="info"
            label={convertYYYYMMDDStringToDate(metadata.uploadDate || '') || metadata.uploadDate}
            sx={{ flexShrink: 0, fontWeight: 'bolder' }}
          />
          {isSchemaOutdated &&
            <Tooltip title="This version's saved data predates newer features -- use Refresh from YouTube to pick them up">
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                icon={<WarningAmberIcon fontSize="small" />}
                label="Outdated data"
                sx={{ flexShrink: 0 }}
              />
            </Tooltip>}
        </Stack>
        <Stack direction="row" spacing={0.5}>
          <Tooltip title="Refresh this version from YouTube (updates its data in place)">
            <span>
              <IconButton
                size="small"
                onClick={handleRefreshFromYouTube}
                disabled={refreshingMetadata || creatingVersion || !metadata.originalUrl}
                aria-label="Refresh from YouTube"
              >
                {refreshingMetadata ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Download new version (re-fetches live data)">
            <span>
              <IconButton
                size="small"
                onClick={handleDownloadNewVersion}
                disabled={creatingVersion || refreshingMetadata || !metadata.originalUrl}
                aria-label="Download new version"
              >
                {creatingVersion ? <CircularProgress size={18} /> : <AddCircleOutlineIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          {metadata.downloadedFilePath && resolutions.length > 0 &&
            <Tooltip title="Download a different quality">
              <IconButton
                size="small"
                onClick={() => { setSwappingQuality(true); setSelectedResolution(''); }}
                aria-label="Download a different quality"
              >
                <CloudDownloadIcon fontSize="small" />
              </IconButton>
            </Tooltip>}
          <Tooltip title="Delete this video from the library">
            <IconButton size="small" color="error" onClick={() => setDeleteDialogOpen(true)} aria-label="Delete video">
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
      {createVersionError &&
        <Typography color="error" variant="body2" sx={{ mb: 2 }}>{createVersionError}</Typography>}
      {refreshMetadataError &&
        <Typography color="error" variant="body2" sx={{ mb: 2 }}>{refreshMetadataError}</Typography>}

      {/* Keyed on the selected version so switching versions forces a full
          remount of the player + download panel, rather than relying on
          every branch inside them to react correctly to a props change --
          a plain data refresh wasn't reliable enough to swap the player
          between local-file and YouTube-embed branches on version switch. */}
      <Stack key={selectedEpoch || 'no-epoch'} direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <Stack spacing={2} sx={{ width: { xs: '100%', md: '70%' } }}>
          <LibraryVideoPlayer ref={playerRef} metadata={metadata} thumbnailPath={video.thumbnailPath} cacheBustKey={cacheBustKey} />

          {/* Bounded + scrollable rather than letting a long description
              push the instrument panel below the fold. */}
          <Card variant="outlined" sx={{ p: 1.5, maxHeight: 260, overflowY: 'auto' }}>
            <Typography variant="body2" sx={{ textAlign: 'justify' }}>
              {formatComment(metadata.description || '')}
            </Typography>
          </Card>
        </Stack>

        {/* "Instrument panel" -- version selector, download status, and every
            download/quality-swap control in one Card so they read as a
            single section. */}
        <Stack spacing={2} sx={{ width: { xs: '100%', md: '30%' } }}>
          <Card sx={{ p: 1.5 }} variant="outlined">
            <Stack spacing={1.5}>
              {(video.epochs.length > 1 || metadata.downloadedFilePath) &&
                <Stack spacing={1.5}>
                  {video.epochs.length > 1 &&
                    <FormControl size="small" fullWidth>
                      <InputLabel id="library-version-select-label">Version</InputLabel>
                      <Select
                        labelId="library-version-select-label"
                        label="Version"
                        value={selectedEpoch || ''}
                        onChange={(e) => handleSelectEpoch(e.target.value)}
                      >
                        {video.epochs.map(({ epoch, metadata: epochMetadata }) => (
                          <MenuItem key={epoch} value={epoch}>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              {(epochMetadata.downloadedFilePath || epochMetadata.downloadedAudioFilePath) &&
                                <DownloadDoneIcon fontSize="small" color="success" />}
                              <span>
                                {formatEpochLabel(epoch)}{epoch === video.latestEpoch ? ' (latest)' : ''}
                              </span>
                            </Stack>
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>}
                  {metadata.downloadedFilePath &&
                    <Chip
                      color="success"
                      label={`${metadata.downloadedResolution}p`}
                      sx={{ alignSelf: 'flex-start' }}
                    />}
                  <Divider />
                </Stack>}

            {swappingQuality ? (
              isSwapDownloading ? (
                <Stack spacing={1} sx={{ p: 1 }}>
                  <Typography variant="subtitle1" textAlign="center">
                    {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : 'Downloading'}
                    {selectedResolution && ` (${selectedResolution}${selectedResolution.toLowerCase() === 'mp3' ? '' : 'p'})`}
                  </Typography>
                  <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} />
                </Stack>
              ) : (
                <>
                  <ResolutionPicker
                    resolutions={videoResolutions}
                    excludeResolution={metadata.downloadedResolution}
                    onSelect={handleSwapDownload}
                    selectedFormat={selectedFormat}
                    onFormatChange={setSelectedFormat}
                    isError={isError}
                    disabled={isAudioActionActive}
                  />
                  <Button size="small" onClick={() => setSwappingQuality(false)} sx={{ mt: 1 }}>
                    Cancel
                  </Button>
                </>
              )
            ) : metadata.downloadedFilePath ? (
              <Stack direction="row" spacing={1}>
                <Button size="small" startIcon={<FolderOpenIcon />} onClick={handleOpenFileLocation}>
                  Open file location
                </Button>
                <Button size="small" startIcon={<OpenInNewIcon />} onClick={handleOpenExternally}>
                  Open in default player
                </Button>
              </Stack>
            ) : isDownloading ? (
              <Stack spacing={1} sx={{ p: 1 }}>
                <Typography variant="subtitle1" textAlign="center">
                  {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : 'Downloading'}
                  {selectedResolution && ` (${selectedResolution}p)`}
                </Typography>
                <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} />
              </Stack>
            ) : videoResolutions.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                No quality info was saved for this entry (it may have been added before this feature, or via testing) --
                re-add it from the Downloader tab to enable downloading here.
              </Typography>
            ) : (
              <ResolutionPicker
                resolutions={videoResolutions}
                onSelect={handleDownload}
                selectedFormat={selectedFormat}
                onFormatChange={setSelectedFormat}
                isError={isError}
                disabled={isAudioActionActive}
              />
            )}

            {/* Audio (MP3) -- a separate, always-available download,
                independent of video quality. Shares the single download
                hook with the video controls above (downloadTarget/TD-008),
                so it's disabled rather than hidden during a video
                download/swap. */}
            {mp3Resolution &&
              <>
                <Divider sx={{ my: 1.5 }} />
                <Stack spacing={1}>
                  <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
                    Audio
                  </Typography>
                  {isAudioActionActive ? (
                    <Stack spacing={1} sx={{ p: 1 }}>
                      <Typography variant="subtitle1" textAlign="center">
                        {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : 'Downloading'} (MP3)
                      </Typography>
                      <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} />
                    </Stack>
                  ) : metadata.downloadedAudioFilePath ? (
                    // Replaces the download button in place -- the player
                    // lives here in the instrument panel, tied to its own
                    // download controls, not alongside the video above.
                    <Stack spacing={0.5}>
                      <Box
                        component="audio"
                        controls
                        src={buildAppVideoUrl(metadata.downloadedAudioFilePath, cacheBustKey)}
                        sx={{ width: '100%', height: 32 }}
                      />
                      <Stack direction="row" spacing={0.5}>
                        <Tooltip title="Open file location">
                          <IconButton size="small" onClick={handleOpenAudioFileLocation} aria-label="Open audio file location">
                            <FolderOpenIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Open in default player">
                          <IconButton size="small" onClick={handleOpenAudioExternally} aria-label="Open audio in default player">
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Re-download MP3">
                          <span>
                            <IconButton
                              size="small"
                              onClick={handleAudioDownload}
                              disabled={isVideoActionActive}
                              aria-label="Re-download MP3"
                            >
                              <CloudDownloadIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </Stack>
                  ) : ffmpegAction === 'extractAudioToLibrary' ? (
                    <Stack spacing={1} sx={{ p: 1 }}>
                      <Typography variant="subtitle1" textAlign="center">Extracting MP3</Typography>
                      <LinearProgressWithLabel value={ffmpegProgress} valueBuffer={ffmpegProgress} />
                    </Stack>
                  ) : (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Button
                        size="small"
                        color="secondary"
                        variant="contained"
                        startIcon={<CloudDownloadIcon />}
                        onClick={handleAudioDownload}
                        disabled={isVideoActionActive}
                      >
                        Download MP3 ({mp3Resolution.filesizeMb}Mb)
                      </Button>
                      {isVideoDownloaded &&
                        <Tooltip title="Extract MP3 from the already-downloaded video (no re-download)">
                          <span>
                            <IconButton
                              size="small"
                              onClick={handleExtractAudioToLibrary}
                              disabled={isVideoActionActive || ffmpegAction !== null}
                              aria-label="Extract MP3 from downloaded video"
                            >
                              <AudiotrackIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>}
                    </Stack>
                  )}
                </Stack>
              </>}

            {/* FFMPEG utilities -- every control operates on the video
                *file*, disabled whenever this version has no video
                downloaded (regardless of an existing MP3), or while another
                utility is already running (they share one ffmpegAction
                slot). */}
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
              {!isVideoDownloaded && !metadata.downloadedAudioFilePath &&
                <Typography variant="caption" color="text.secondary">
                  Download the video or its MP3 for this version to use these tools.
                </Typography>}
              {!isVideoDownloaded && metadata.downloadedAudioFilePath &&
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
                    <IconButton size="small" aria-label="Extract MP3" onClick={handleExtractMp3} disabled={ffmpegControlsDisabled}>
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
                    <IconButton size="small" aria-label="Convert to a different format" onClick={handleConvertFormat} disabled={ffmpegControlsDisabled}>
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

              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2">Clip</Typography>
                <Tooltip title="Set start to the player's current position">
                  <span>
                    <IconButton
                      size="small"
                      onClick={handleSetClipStartFromPlayer}
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
                            onClick={() => setClipStart((v) => stepClipTimestamp(v, 1))}
                            aria-label="Increase clip start by 1 second"
                          >
                            <KeyboardArrowUpIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                          <IconButton
                            size="small"
                            sx={{ p: 0 }}
                            disabled={ffmpegControlsDisabled}
                            onClick={() => setClipStart((v) => stepClipTimestamp(v, -1))}
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
                      onClick={handleSetClipEndFromPlayer}
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
                            onClick={() => setClipEnd((v) => stepClipTimestamp(v, 1))}
                            aria-label="Increase clip end by 1 second"
                          >
                            <KeyboardArrowUpIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                          <IconButton
                            size="small"
                            sx={{ p: 0 }}
                            disabled={ffmpegControlsDisabled}
                            onClick={() => setClipEnd((v) => stepClipTimestamp(v, -1))}
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
                      onClick={handleExtractClip}
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
                    <IconButton size="small" aria-label="Embed metadata into local file" onClick={handleEmbedMetadata} disabled={embedMetadataDisabled}>
                      <LabelOutlinedIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>
            </Stack>
          </Card>
        </Stack>
      </Stack>

      <Dialog open={deleteDialogOpen} onClose={() => !deleting && setDeleteDialogOpen(false)}>
        <DialogTitle>Delete this video?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This deletes the tracked entry, its metadata, and the downloaded file (if any) from your library folder.
            This can't be undone.
          </DialogContentText>
          {deleteError && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{deleteError}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained" disabled={deleting}>Delete</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={embedSuccessSnackbarOpen}
        autoHideDuration={4000}
        onClose={() => setEmbedSuccessSnackbarOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setEmbedSuccessSnackbarOpen(false)} severity="success" variant="filled">
          Metadata embedded
        </Alert>
      </Snackbar>

      <Snackbar
        open={linkCopiedSnackbarOpen}
        autoHideDuration={3000}
        onClose={() => setLinkCopiedSnackbarOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setLinkCopiedSnackbarOpen(false)} severity="success" variant="filled">
          Link copied
        </Alert>
      </Snackbar>
    </Box>
  );
}
