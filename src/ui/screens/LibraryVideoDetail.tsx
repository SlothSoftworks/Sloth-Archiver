import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormGroup,
  Grid,
  IconButton,
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
};

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

export default function LibraryVideoDetail({ video, onBack, onLibraryChanged, onDeleted }: {
  video: LibraryVideo;
  onBack: () => void;
  onLibraryChanged: () => Promise<void> | void;
  onDeleted: () => void;
}) {
  const [metadata, setMetadata] = useState(video.metadata);
  const [selectedFormat, setSelectedFormat] = useState('dflt');
  const [selectedResolution, setSelectedResolution] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { downloadProgress, postprocessProgress, downloadStatus, finalFilePath, isDone, isError, startDownload } = useDownloadVideo();

  const handleDownload = (resolution: string) => {
    if (!video.latestEpoch) return;
    setSelectedResolution(resolution);
    // Deterministic path inside the video's own storage -- no Save dialog,
    // no overwrite/resume prompt needed (this folder is ours, not a
    // user-picked location with pre-existing files to worry about). A fixed
    // base filename avoids any need to sanitize the title again for the
    // renderer side; yt-dlp/ffmpeg fill in the right extension, same
    // findFinalFile-style resolution used everywhere else in this app.
    const outputPath = `${video.videoDir}/${video.latestEpoch}/video`;
    startDownload({ videoUrl: metadata.originalUrl || '', outputPath, format: selectedFormat, resolution });
  };

  useEffect(() => {
    if (!isDone || !video.latestEpoch) return;
    (async () => {
      await window.electronAPI.recordLibraryDownload({
        videoDir: video.videoDir,
        epoch: video.latestEpoch as string,
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
      await onLibraryChanged();
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
      await window.electronAPI.deleteLibraryEntry(video.videoDir);
      await onLibraryChanged();
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete this entry.');
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  const isDownloading = !!selectedResolution && !isError && !metadata.downloadedFilePath;
  const resolutions = metadata.resolutions || [];

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <IconButton onClick={onBack} size="small" aria-label="Back to videos">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography variant="h6" noWrap>{metadata.title || video.videoFolderName}</Typography>
        </Stack>
        <Tooltip title="Delete this video from the library">
          <IconButton size="small" color="error" onClick={() => setDeleteDialogOpen(true)} aria-label="Delete video">
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <Stack spacing={2} sx={{ width: { xs: '100%', md: '70%' } }}>
          <LibraryVideoPlayer metadata={metadata} />

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="info.main" fontWeight="bolder">
              {convertYYYYMMDDStringToDate(metadata.uploadDate || '') || metadata.uploadDate}
            </Typography>
            {metadata.downloadedFilePath &&
              <Chip
                color="success"
                label={metadata.downloadedResolution === 'MP3' ? 'MP3' : `${metadata.downloadedResolution}p`}
              />}
          </Stack>

          <Typography variant="body2" sx={{ textAlign: 'justify' }}>
            {formatComment(metadata.description || '')}
          </Typography>
        </Stack>

        <Stack spacing={2} sx={{ width: { xs: '100%', md: '30%' } }}>
          <Card sx={{ p: 1 }} variant="outlined">
            {metadata.downloadedFilePath ? (
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
              <>
                {isError &&
                  <Typography color="error" variant="body2" sx={{ mb: 1 }}>Download failed -- try again.</Typography>}
                <Grid container spacing={1} columns={{ xs: 2, sm: 9, md: 12 }}>
                  {resolutions.map((res, idx) => (
                    <Grid size={{ xs: 1, sm: 3 }} key={idx}>
                      <Button
                        onClick={() => handleDownload(res.resolution)}
                        sx={{ whiteSpace: 'pre-line' }}
                        color={res.resolution === 'MP3' ? 'secondary' : 'primary'}
                        fullWidth
                        variant={res.resolution === 'MP3' ? 'contained' : 'outlined'}
                      >
                        <Stack spacing={0} direction="column" divider={<Divider flexItem sx={{ mx: 1 }} orientation="horizontal" />}>
                          <Typography variant="button" textTransform="none">{res.resolution}{res.resolution === 'MP3' ? '' : 'p'}</Typography>
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
                    onChange={(e) => setSelectedFormat(e.target.value)}
                    variant="standard"
                  >
                    <MenuItem value="dflt">Default (keep origin format)</MenuItem>
                    <MenuItem value="mp4">MP4</MenuItem>
                    <MenuItem value="webm">WEBM</MenuItem>
                    <MenuItem value="mkv">MKV</MenuItem>
                  </Select>
                </FormGroup>
              </>
            )}
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
