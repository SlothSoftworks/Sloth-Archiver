import { useEffect, useState } from 'react';
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
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import { convertYYYYMMDDStringToDate, buildAppVideoUrl } from '../../utils/utils.ts';
import { POPULAR_CONVERT_FORMATS } from '../../utils/ffmpegFormats.ts';
import { formatComment } from '../components/componentUtils';
import useDownloadVideo from '../hooks/useDownloadVideo.tsx';
import LibraryVideoPlayer from '../components/LibraryVideoPlayer';

type LibraryResolution = { resolution: string; filesizeMb: string };

export type LibraryVideoMetadata = {
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
  // MP3 is a separate, coexisting artifact of the video, not a competing
  // "quality" -- its own slot, entirely independent of the video fields
  // above (which a real video download can populate at the same time).
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

// Same small extension-extraction as LibraryVideoPlayer.tsx's own copy --
// not shared, this file has no other coupling to that component.
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot === -1 ? '' : filePath.slice(lastDot + 1).toLowerCase();
}

// Sentinel Select value for "Other" -- a one-off custom format typed for
// just this conversion, distinct from the persisted custom list Options
// manages (that one adds a format to the dropdown itself; this one doesn't
// save anything, just lets a single conversion target something not listed).
const OTHER_FORMAT_VALUE = '__other__';


// Same visual pattern as VideoDetailCard.tsx's buffer bar -- kept as a
// separate copy rather than a shared import since this file has no other
// coupling to that component (different data shape, no Save-dialog/TD-001
// overwrite flow here, the library controls its own deterministic path).
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

// Shared between the first-download and "download different quality" flows --
// excludeResolution blocks re-picking whatever's already downloaded (that's
// not a "different" quality) rather than hiding it, so it's clear why one
// button is greyed out instead of it just silently not being there.
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
  // 'initial' vs 'swap' decides which backend call the isDone effect below
  // makes -- both flows reuse the same useDownloadVideo() instance below
  // (startDownload resets isDone/isError/progress at the start of every
  // call, so a second download through the same hook instance is safe).
  const [downloadMode, setDownloadMode] = useState<'initial' | 'swap'>('initial');
  // Video and audio (MP3) downloads coexist as separate files, but they
  // still share this one useDownloadVideo() hook instance -- its progress
  // events aren't tagged per-download (see TD-008), so two independent
  // instances running at once would cross-talk. downloadTarget says which
  // one the currently in-flight download (if any) belongs to; the UI
  // disables the *other* target's controls while one is active rather than
  // letting both fire at once.
  const [downloadTarget, setDownloadTarget] = useState<'video' | 'audio'>('video');
  // Bumped after a successful quality swap and threaded into the player's
  // src URL -- a swap can land back on the exact same file path+extension,
  // and without this the <video>/<audio> element has no signal that the
  // underlying bytes changed, so it just keeps showing the old content.
  const [cacheBustKey, setCacheBustKey] = useState(0);

  // FFMPEG utilities -- kept minimal deliberately: a single target-format
  // choice for convert, and plain start/end text fields for the clip trim
  // rather than a scrubber.
  const [convertFormat, setConvertFormat] = useState('mp4');
  const [otherFormatInput, setOtherFormatInput] = useState('');
  const [clipStart, setClipStart] = useState('');
  const [clipEnd, setClipEnd] = useState('');
  // User-added muxers from Options, on top of the small popular default set
  // -- fetched once on mount, same as any other settings-backed value with
  // no live-update need within a single session.
  const [customConvertFormats, setCustomConvertFormats] = useState<string[]>([]);
  useEffect(() => {
    window.electronAPI.getCustomConvertFormats().then(({ customConvertFormats }) => setCustomConvertFormats(customConvertFormats));
  }, []);
  const convertFormatOptions = [
    ...POPULAR_CONVERT_FORMATS,
    ...customConvertFormats.filter((f) => !POPULAR_CONVERT_FORMATS.includes(f.toLowerCase())),
  ];

  // Which ffmpeg utility (if any) is currently running -- gates the rest of
  // the panel the same way downloadTarget gates video-vs-audio above,
  // except entirely separate from that hook/channel (see main.js's
  // ffmpegUtilityProgress comment for why: these run against an
  // already-downloaded file, not a fresh yt-dlp download).
  const [ffmpegAction, setFfmpegAction] = useState<'extractMp3' | 'convert' | 'clip' | 'embedMetadata' | 'extractAudioToLibrary' | null>(null);
  const [ffmpegProgress, setFfmpegProgress] = useState(0);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  // Separate from ffmpegError -- embedding is fast enough that a plain
  // disabled->enabled flicker on the button isn't a reliable "it worked"
  // signal, so a toast confirms it explicitly.
  const [embedSuccessSnackbarOpen, setEmbedSuccessSnackbarOpen] = useState(false);
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

  // The epoch currently being viewed may have just been deleted (this
  // component's own version-scoped delete) -- if a refresh comes through and
  // it's no longer in the list, fall back to whatever's now latest rather
  // than silently pointing at a version that no longer exists.
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
    try {
      await window.electronAPI.deleteVideoInfoCacheEntry(metadata.originalUrl);
      const result = await window.electronAPI.getVideoInfoPython(metadata.originalUrl);
      if (!result.success) {
        throw new Error('Failed to fetch fresh video data.');
      }
      const added = await window.electronAPI.addLibraryVersion(result.data.response, video.videoDir);
      // Needs the deeper resync (not plain onLibraryChanged) -- this just
      // added a new epoch, so the version selector's option list (read
      // straight from the `video` prop's `epochs` array) needs a fresh
      // `video` prop, not just a refreshed root channel list.
      await onVersionsChanged();
      setSelectedEpoch(added.epoch);
      setMetadata(added.metadata);
      setSelectedResolution('');
      setSwappingQuality(false);
    } catch (err) {
      setCreateVersionError(err instanceof Error ? err.message : 'Failed to create a new version.');
    } finally {
      setCreatingVersion(false);
    }
  };

  const handleDownload = (resolution: string) => {
    if (!selectedEpoch) return;
    setDownloadTarget('video');
    setDownloadMode('initial');
    setSelectedResolution(resolution);
    // Deterministic path inside the video's own storage -- no Save dialog,
    // no overwrite/resume prompt needed (this folder is ours, not a
    // user-picked location with pre-existing files to worry about). Keyed
    // off whichever version is currently selected, not always the newest --
    // a "download new version" that hasn't been downloaded yet is still
    // browsable and downloadable like any other version. A fixed base
    // filename avoids any need to sanitize the title again for the renderer
    // side; yt-dlp/ffmpeg fill in the right extension, same
    // findFinalFile-style resolution used everywhere else in this app.
    const outputPath = `${video.videoDir}/${selectedEpoch}/video`;
    startDownload({ videoUrl: metadata.originalUrl || '', outputPath, format: selectedFormat, resolution });
  };

  // "Download different quality" -- downloads to a distinct "video.new.<ext>"
  // path rather than the live file's own path, so a failed/interrupted
  // download never touches the working file (the safety rule this feature
  // was specced with). The actual delete-old/rename-new swap only happens in
  // the isDone effect below, once the new file is confirmed complete.
  const handleSwapDownload = (resolution: string) => {
    if (!selectedEpoch) return;
    setDownloadTarget('video');
    setDownloadMode('swap');
    setSelectedResolution(resolution);
    const outputPath = `${video.videoDir}/${selectedEpoch}/video.new`;
    startDownload({ videoUrl: metadata.originalUrl || '', outputPath, format: selectedFormat, resolution });
  };

  // Covers both "download MP3 for the first time" and "re-download to
  // replace an existing one" -- which of those it is just depends on
  // whether downloadedAudioFilePath is already set, no separate confirm-UI
  // needed the way the video quality-swap flow has one (there's only ever
  // one MP3 option, nothing to pick between). The re-download case still
  // gets the same safe temp-then-rename treatment via swapLibraryDownload
  // in the isDone effect below.
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
        // always clear selectedResolution for it so the Audio section's
        // active-download check (which, unlike the video one, doesn't also
        // gate on !downloadedAudioFilePath) doesn't stay stuck showing progress.
        if (kind === 'audio') setSelectedResolution('');
      }
      // Deep resync, not the shallow onLibraryChanged -- a regular download
      // or quality-swap only touches the currently-selected epoch's own
      // fields, but handleSelectEpoch re-reads straight from the `video`
      // prop's `epochs` array on every switch. Without this, switching away
      // from this epoch and back would silently revert to whatever
      // downloadedFilePath the prop had *before* this download completed,
      // showing the YouTube embed again for a version that's actually
      // already downloaded.
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

  const handleExtractClip = async () => {
    if (!metadata.downloadedFilePath || !clipStart.trim() || !clipEnd.trim()) return;
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

  // Local ffmpeg extraction straight from the already-downloaded video file,
  // landing directly in this version's own audio slot -- unlike
  // handleExtractMp3 above (which exports a copy to a user-picked location),
  // this one saves and plays back through the library the same way a real
  // MP3 download does, just without re-fetching anything from YouTube. Only
  // ever invoked from the "no MP3 yet" branch of the Audio section, so no
  // replace/swap path is needed here.
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
      // Same deep resync reason as the isDone effect above -- switching
      // versions and back would otherwise revert to the stale `video` prop.
      await onVersionsChanged();
    } else {
      setFfmpegError(res.message || 'Failed to extract MP3.');
    }
    setFfmpegAction(null);
  };

  const handleEmbedMetadata = async () => {
    // Embeds into whichever of the video/audio files this version actually
    // has -- either, or both, since they're independent coexisting slots
    // (see downloadedAudioFilePath's own comment above). kind tells main.js
    // which stream index the embedded cover art lands at (a video file
    // already has its own video stream at v:0; audio doesn't).
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
      // last one, the whole video (now-empty folder) goes with it and we
      // land back at the library root, same as delete always worked before
      // versioning existed. Otherwise the video survives and the parent
      // needs to refresh both the root channel list and this stale
      // `video` prop snapshot so the view swaps to whatever's now latest.
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
  // Derived from the same two flags above (not its own standalone check)
  // specifically so it clears the instant a video download finishes -- an
  // earlier, looser version of this stayed true after an initial (non-swap)
  // video download completed, since selectedResolution is deliberately left
  // set in that case (see the isDone effect) and nothing else cleared it,
  // permanently locking out the Audio button until a full reload.
  const isVideoActionActive = isDownloading || isSwapDownloading;
  // Gates the whole FFMPEG utilities section below -- every tool there
  // operates on the video file itself, not the separate MP3 slot.
  const isVideoDownloaded = !!metadata.downloadedFilePath;
  // Every ffmpeg-utility control shares this one disabled condition: no
  // video downloaded yet, or another utility is already mid-run (they share
  // one ffmpegAction slot, same "one at a time" reasoning as video/audio
  // downloads above).
  const ffmpegControlsDisabled = !isVideoDownloaded || ffmpegAction !== null;
  // Embed Metadata is the one FFMPEG utility that doesn't need the video
  // file specifically -- it can tag whichever of video/audio exists, so it's
  // enabled whenever either one is downloaded, not gated on isVideoDownloaded
  // like the rest of the panel.
  const embedMetadataDisabled = (!isVideoDownloaded && !metadata.downloadedAudioFilePath) || ffmpegAction !== null;
  const resolutions = metadata.resolutions || [];
  // MP3 is rendered in its own Audio sub-section below, not mixed into the
  // video quality grid -- see the Library-view MP3-coexistence design.
  const videoResolutions = resolutions.filter((r) => r.resolution !== 'MP3');
  const mp3Resolution = resolutions.find((r) => r.resolution === 'MP3');

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <IconButton onClick={onBack} size="small" aria-label="Back to videos">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography variant="h6" noWrap>{metadata.title || video.videoFolderName}</Typography>
          <Chip
            size="small"
            color="info"
            label={convertYYYYMMDDStringToDate(metadata.uploadDate || '') || metadata.uploadDate}
            sx={{ flexShrink: 0, fontWeight: 'bolder' }}
          />
        </Stack>
        <Stack direction="row" spacing={0.5}>
          <Tooltip title="Download new version (re-fetches live data)">
            <span>
              <IconButton
                size="small"
                onClick={handleDownloadNewVersion}
                disabled={creatingVersion || !metadata.originalUrl}
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

      {/* Keyed on the selected version so switching versions always forces a
          full remount of the player + download panel below, instead of
          relying on every branch inside them to correctly react to a props
          change -- a plain data refresh alone wasn't reliably enough to get
          the player to swap between the local-file and YouTube-embed
          branches when switching to a version with different download
          status than the one just displayed. */}
      <Stack key={selectedEpoch || 'no-epoch'} direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <Stack spacing={2} sx={{ width: { xs: '100%', md: '70%' } }}>
          <LibraryVideoPlayer metadata={metadata} thumbnailPath={video.thumbnailPath} cacheBustKey={cacheBustKey} />

          {/* Bounded + scrollable rather than letting a long description push
              the instrument panel below the fold -- max height picked to
              comfortably fit a few paragraphs before scrolling kicks in. */}
          <Card variant="outlined" sx={{ p: 1.5, maxHeight: 260, overflowY: 'auto' }}>
            <Typography variant="body2" sx={{ textAlign: 'justify' }}>
              {formatComment(metadata.description || '')}
            </Typography>
          </Card>
        </Stack>

        {/* "Instrument panel" -- version selector, download status, and every
            download/quality-swap control grouped into one Card so they read
            as a single section rather than a loose stack of controls. */}
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
                independent of whatever video quality is or isn't downloaded.
                Shares the single download hook with the video controls above
                (see downloadTarget/TD-008), so it's disabled while a video
                download/swap is actually in flight rather than fully hidden. */}
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
                    // itself lives here in the instrument panel, not
                    // alongside the video above, so it stays visually tied
                    // to its own download controls.
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
                *file*, disabled as a whole whenever this version doesn't
                have one downloaded yet (regardless of whether an MP3
                already exists for it), or while another utility is already
                running (they share one ffmpegAction slot). */}
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
                <TextField
                  size="small"
                  variant="standard"
                  placeholder="0:00"
                  value={clipStart}
                  onChange={(e) => setClipStart(e.target.value)}
                  disabled={ffmpegControlsDisabled}
                  sx={{ width: 56 }}
                  slotProps={{ htmlInput: { 'aria-label': 'Clip start' } }}
                />
                <Typography variant="body2" color="text.secondary">–</Typography>
                <TextField
                  size="small"
                  variant="standard"
                  placeholder="0:00"
                  value={clipEnd}
                  onChange={(e) => setClipEnd(e.target.value)}
                  disabled={ffmpegControlsDisabled}
                  sx={{ width: 56 }}
                  slotProps={{ htmlInput: { 'aria-label': 'Clip end' } }}
                />
                <Box sx={{ flexGrow: 1 }} />
                <Tooltip title="Extract clip">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="Extract clip"
                      onClick={handleExtractClip}
                      disabled={ffmpegControlsDisabled || !clipStart.trim() || !clipEnd.trim()}
                    >
                      <ContentCutIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>

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
    </Box>
  );
}
