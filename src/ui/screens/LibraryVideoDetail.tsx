import { useEffect, useState } from 'react';
import {
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
  Stack,
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
import { convertYYYYMMDDStringToDate } from '../../utils/utils.ts';
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
function ResolutionPicker({ resolutions, excludeResolution, onSelect, selectedFormat, onFormatChange, isError }: {
  resolutions: LibraryResolution[];
  excludeResolution?: string | null;
  onSelect: (resolution: string) => void;
  selectedFormat: string;
  onFormatChange: (format: string) => void;
  isError: boolean;
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
              disabled={res.resolution === excludeResolution}
              sx={{ whiteSpace: 'pre-line' }}
              color={res.resolution === 'MP3' ? 'secondary' : 'primary'}
              fullWidth
              variant={res.resolution === 'MP3' ? 'contained' : 'outlined'}
            >
              <Stack spacing={0} direction="column" divider={<Divider flexItem sx={{ mx: 1 }} orientation="horizontal" />}>
                <Typography variant="button" textTransform="none">
                  {res.resolution}{res.resolution === 'MP3' ? '' : 'p'}{res.resolution === excludeResolution ? ' (current)' : ''}
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
  // Bumped after a successful quality swap and threaded into the player's
  // src URL -- a swap can land back on the exact same file path+extension,
  // and without this the <video>/<audio> element has no signal that the
  // underlying bytes changed, so it just keeps showing the old content.
  const [cacheBustKey, setCacheBustKey] = useState(0);

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
    setDownloadMode('swap');
    setSelectedResolution(resolution);
    const outputPath = `${video.videoDir}/${selectedEpoch}/video.new`;
    startDownload({ videoUrl: metadata.originalUrl || '', outputPath, format: selectedFormat, resolution });
  };

  useEffect(() => {
    if (!isDone || !selectedEpoch) return;
    (async () => {
      if (downloadMode === 'swap') {
        const updated = await window.electronAPI.swapLibraryDownload({
          videoDir: video.videoDir,
          epoch: selectedEpoch,
          tempFilePath: finalFilePath,
          oldFilePath: metadata.downloadedFilePath,
          resolution: selectedResolution,
          format: selectedFormat,
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
        });
        setMetadata((prev) => ({
          ...prev,
          downloadedFilePath: finalFilePath,
          downloadedResolution: selectedResolution,
          downloadedFormat: selectedFormat,
        }));
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

  const isDownloading = !!selectedResolution && !isError && !metadata.downloadedFilePath && !swappingQuality;
  const isSwapDownloading = !!selectedResolution && !isError && swappingQuality;
  const resolutions = metadata.resolutions || [];

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
                              {epochMetadata.downloadedFilePath &&
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
                      label={metadata.downloadedResolution === 'MP3' ? 'MP3' : `${metadata.downloadedResolution}p`}
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
                    resolutions={resolutions}
                    excludeResolution={metadata.downloadedResolution}
                    onSelect={handleSwapDownload}
                    selectedFormat={selectedFormat}
                    onFormatChange={setSelectedFormat}
                    isError={isError}
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
                  {selectedResolution && ` (${selectedResolution}${selectedResolution.toLowerCase() === 'mp3' ? '' : 'p'})`}
                </Typography>
                <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} />
              </Stack>
            ) : resolutions.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                No quality info was saved for this entry (it may have been added before this feature, or via testing) --
                re-add it from the Downloader tab to enable downloading here.
              </Typography>
            ) : (
              <ResolutionPicker
                resolutions={resolutions}
                onSelect={handleDownload}
                selectedFormat={selectedFormat}
                onFormatChange={setSelectedFormat}
                isError={isError}
              />
            )}
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
    </Box>
  );
}
