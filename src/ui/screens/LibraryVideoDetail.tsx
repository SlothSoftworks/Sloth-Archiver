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
  IconButton,
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import LinkIcon from '@mui/icons-material/Link';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { convertYYYYMMDDStringToDate, cleanElectronErrorMessage } from '../../utils/utils.ts';
import { POPULAR_CONVERT_FORMATS } from '../../utils/ffmpegFormats.ts';
import { formatComment } from '../components/componentUtils';
import useDownloadVideo from '../hooks/useDownloadVideo.tsx';
import VideoQualityDownload from './VideoQualityDownload';
import FfmpegUtilitiesPanel, { OTHER_FORMAT_VALUE } from './FfmpegUtilitiesPanel';
import ClipCollectionView from '../components/ClipCollectionView';
import LibraryVideoPlayerWithTools from '../components/LibraryVideoPlayerWithTools';
import type { LibraryVideoMetadata, LibraryClip } from '../../types';

type LibraryVideo = {
  videoFolderName: string;
  videoDir: string;
  latestEpoch: string | null;
  metadata: LibraryVideoMetadata;
  epochs: { epoch: string; metadata: LibraryVideoMetadata }[];
  thumbnailPath: string | null;
  clipCount: number;
};

// Mirrors library.mjs's own CURRENT_VIDEO_SCHEMA_VERSION (main process and
// renderer never cross-import here). An entry whose stored schemaVersion is
// older than this predates a metadata-shape change and won't have whatever
// that change added -- "Refresh from YouTube" is what fixes it.
const CURRENT_VIDEO_SCHEMA_VERSION = 3;

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
  // Default off: the fast remux-first path is correct often enough (most
  // sources already match the format they're being converted to) that
  // defaulting to a slower forced re-encode for everyone would be the wrong
  // tradeoff -- this is an opt-in fix for the specific case where a remux
  // would silently keep a mismatched codec (e.g. AV1 remuxed into ".webm"
  // instead of real VP9), not a default-on safety net.
  const [forceReencode, setForceReencode] = useState(false);
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
  // file, not a fresh yt-dlp download (see main.mjs's ffmpegUtilityProgress).
  const [ffmpegAction, setFfmpegAction] = useState<'extractMp3' | 'convert' | 'clip' | 'embedMetadata' | 'extractAudioToLibrary' | 'extractClipMp3' | 'convertClip' | null>(null);
  const [ffmpegProgress, setFfmpegProgress] = useState(0);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  // Separate from ffmpegError -- embedding is fast enough that a plain
  // disabled->enabled flicker isn't a reliable "it worked" signal, so a
  // toast confirms it explicitly.
  const [embedSuccessSnackbarOpen, setEmbedSuccessSnackbarOpen] = useState(false);
  const [linkCopiedSnackbarOpen, setLinkCopiedSnackbarOpen] = useState(false);

  // Clip Collection -- video-level, independent of selectedEpoch. 'video' is
  // the normal player+instrument-panel layout; 'clips' swaps the whole thing
  // out for ClipCollectionView. clips starts empty and is fetched lazily the
  // first time the tab is opened (see the activeView effect below), not
  // eagerly on mount, since most videos will never have any.
  const [activeView, setActiveView] = useState<'video' | 'clips'>('video');
  const [clips, setClips] = useState<LibraryClip[]>([]);
  const [clipsLoaded, setClipsLoaded] = useState(false);

  useEffect(() => {
    if (activeView === 'clips' && !clipsLoaded) {
      window.electronAPI.getClips({ videoDir: video.videoDir }).then((res) => {
        if (res.success) setClips(res.clips);
        setClipsLoaded(true);
      });
    }
  }, [activeView, clipsLoaded, video.videoDir]);
  useEffect(() => {
    window.electronAPI.onFfmpegUtilityProgress(({ percent }) => {
      if (typeof percent === 'number') setFfmpegProgress(percent);
    });
    return () => window.electronAPI.removeFfmpegUtilityProgressListener();
  }, []);

  const { downloadProgress, postprocessProgress, downloadStatus, finalFilePath, isDone, isError, downloadErrorKind, isRetrying, startDownload, cancelDownload } = useDownloadVideo();

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
      setCreateVersionError(err instanceof Error ? cleanElectronErrorMessage(err.message) : 'Failed to create a new version.');
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
      setRefreshMetadataError(err instanceof Error ? cleanElectronErrorMessage(err.message) : 'Failed to refresh this version from YouTube.');
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

  // Clip Collection's own file-level utilities -- distinct from the ones
  // above since they operate on a clip's file in <videoDir>/clips, not the
  // video's own downloadedFilePath.
  const handleOpenClipFileLocation = () => {
    window.electronAPI.openDirectory(`${video.videoDir}/clips`);
  };

  const handleExtractClipMp3 = async (clip: LibraryClip) => {
    const inputPath = `${video.videoDir}/clips/${clip.fileName}`;
    const result = await window.electronAPI.saveExportedFile({
      defaultName: `${clip.title}.mp3`,
      extensions: ['mp3'],
      inputPath,
    });
    if (result.canceled || !result.filePath) return;
    setFfmpegAction('extractClipMp3');
    setFfmpegError(null);
    setFfmpegProgress(0);
    const res = await window.electronAPI.extractMp3FromFile({ inputPath, outputPath: result.filePath });
    if (!res.success) setFfmpegError(res.message || 'Failed to extract MP3.');
    setFfmpegAction(null);
  };

  // "Save into new file" mirrors handleExtractClipMp3's export-outside-the-library
  // flow (a save dialog + the existing generic convertFormat IPC, no clips.json
  // involvement); leaving it unchecked converts the clip in place instead --
  // window.electronAPI.convertClip does the temp-file-then-rename swap on the
  // main process side and returns the clip's updated manifest record (same
  // id/title/createdAt, new fileName/durationSeconds) to merge into local state.
  const handleConvertClip = async (clip: LibraryClip, format: string, saveAsNewFile: boolean, forceReencode: boolean) => {
    const inputPath = `${video.videoDir}/clips/${clip.fileName}`;
    if (saveAsNewFile) {
      const result = await window.electronAPI.saveExportedFile({
        defaultName: `${clip.title}.${format}`,
        extensions: [format],
        inputPath,
      });
      if (result.canceled || !result.filePath) return;
      setFfmpegAction('convertClip');
      setFfmpegError(null);
      setFfmpegProgress(0);
      const res = await window.electronAPI.convertFileFormat({ inputPath, outputPath: result.filePath, format, forceReencode });
      if (!res.success) setFfmpegError(res.message || 'Failed to convert.');
      setFfmpegAction(null);
      return;
    }
    setFfmpegAction('convertClip');
    setFfmpegError(null);
    setFfmpegProgress(0);
    const res = await window.electronAPI.convertClip({ videoDir: video.videoDir, clipId: clip.id, format, forceReencode });
    if (!res.success || !res.clip) {
      setFfmpegError(res.message || 'Failed to convert.');
      setFfmpegAction(null);
      return;
    }
    setClips((prev) => prev.map((c) => (c.id === clip.id ? res.clip! : c)));
    setFfmpegAction(null);
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
    const res = await window.electronAPI.convertFileFormat({ inputPath: metadata.downloadedFilePath, outputPath: result.filePath, format: targetFormat, forceReencode });
    if (!res.success) setFfmpegError(res.message || 'Failed to convert.');
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
    // tells main.mjs which stream index the cover art lands at.
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
        <Stack direction="row" spacing={0.5} alignItems="center">
          {(clips.length > 0 || (!clipsLoaded && video.clipCount > 0)) &&
            <ToggleButtonGroup
              size="small"
              value={activeView}
              exclusive
              onChange={(_e, v: 'video' | 'clips' | null) => v && setActiveView(v)}
              sx={{ mr: 0.5 }}
            >
              <ToggleButton value="video">Video</ToggleButton>
              <ToggleButton value="clips">Clip Collection</ToggleButton>
            </ToggleButtonGroup>}
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

      {activeView === 'clips' ? (
        <ClipCollectionView
          videoDir={video.videoDir}
          clips={clips}
          onClipsChanged={setClips}
          onEmptied={() => setActiveView('video')}
          onOpenFileLocation={handleOpenClipFileLocation}
          onExtractMp3={handleExtractClipMp3}
          extractingMp3={ffmpegAction === 'extractClipMp3'}
          extractMp3Disabled={ffmpegAction !== null}
          extractMp3Progress={ffmpegProgress}
          extractMp3Error={ffmpegError}
          convertFormatOptions={convertFormatOptions}
          onConvertClip={handleConvertClip}
          convertingClip={ffmpegAction === 'convertClip'}
          convertClipDisabled={ffmpegAction !== null}
          convertClipProgress={ffmpegProgress}
          convertClipError={ffmpegError}
        />
      ) : (
      /* Keyed on the selected version so switching versions forces a full
          remount of the player + download panel, rather than relying on
          every branch inside them to react correctly to a props change --
          a plain data refresh wasn't reliable enough to swap the player
          between local-file and YouTube-embed branches on version switch. */
      <Stack key={selectedEpoch || 'no-epoch'} direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <Stack spacing={2} sx={{ width: { xs: '100%', md: '70%' } }}>
          <LibraryVideoPlayerWithTools
            metadata={metadata}
            thumbnailPath={video.thumbnailPath}
            cacheBustKey={cacheBustKey}
            videoDir={video.videoDir}
            existingClipTitles={clips.map((c) => c.title)}
            convertFormatOptions={convertFormatOptions}
            onClipCreated={(clip) => {
              setClips((prev) => [...prev, clip]);
              onVersionsChanged();
            }}
          />

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
              <VideoQualityDownload
                video={video}
                metadata={metadata}
                selectedEpoch={selectedEpoch}
                onSelectEpoch={handleSelectEpoch}
                videoResolutions={videoResolutions}
                mp3Resolution={mp3Resolution}
                selectedFormat={selectedFormat}
                onFormatChange={setSelectedFormat}
                selectedResolution={selectedResolution}
                isError={isError}
                downloadErrorKind={downloadErrorKind}
                downloadStatus={downloadStatus}
                downloadProgress={downloadProgress}
                postprocessProgress={postprocessProgress}
                swappingQuality={swappingQuality}
                onCancelQualitySwap={() => setSwappingQuality(false)}
                isDownloading={isDownloading}
                isSwapDownloading={isSwapDownloading}
                onDownload={handleDownload}
                onSwapDownload={handleSwapDownload}
                isAudioActionActive={isAudioActionActive}
                onOpenFileLocation={handleOpenFileLocation}
                onOpenExternally={handleOpenExternally}
                cacheBustKey={cacheBustKey}
                onAudioDownload={handleAudioDownload}
                onOpenAudioFileLocation={handleOpenAudioFileLocation}
                onOpenAudioExternally={handleOpenAudioExternally}
                isVideoActionActive={isVideoActionActive}
                isVideoDownloaded={isVideoDownloaded}
                ffmpegAction={ffmpegAction}
                ffmpegProgress={ffmpegProgress}
                onExtractAudioToLibrary={handleExtractAudioToLibrary}
                isRetrying={isRetrying}
                onCancelDownload={cancelDownload}
              />

              <FfmpegUtilitiesPanel
                ffmpegAction={ffmpegAction}
                ffmpegProgress={ffmpegProgress}
                ffmpegError={ffmpegError}
                isVideoDownloaded={isVideoDownloaded}
                hasAudioFile={!!metadata.downloadedAudioFilePath}
                convertFormat={convertFormat}
                setConvertFormat={setConvertFormat}
                convertFormatOptions={convertFormatOptions}
                otherFormatInput={otherFormatInput}
                setOtherFormatInput={setOtherFormatInput}
                forceReencode={forceReencode}
                setForceReencode={setForceReencode}
                onExtractMp3={handleExtractMp3}
                onConvertFormat={handleConvertFormat}
                onEmbedMetadata={handleEmbedMetadata}
              />
            </Stack>
          </Card>
        </Stack>
      </Stack>
      )}

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
