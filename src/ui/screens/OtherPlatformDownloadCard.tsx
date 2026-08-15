import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardMedia,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Grid,
  IconButton,
  LinearProgress,
  Link,
  Snackbar,
  Stack,
  TextareaAutosize,
  Tooltip,
  Typography,
} from '@mui/material';
import type { LinearProgressProps } from '@mui/material/LinearProgress';
import FileOpenIcon from '@mui/icons-material/FileOpen';
import BugReportIcon from '@mui/icons-material/BugReport';
import DownloadIcon from '@mui/icons-material/Download';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import type { DownloadVideoParams } from '../../types';
import useDownloadVideo from '../hooks/useDownloadVideo.tsx';
import { getPlatformLabel } from '../../utils/utils.ts';

// Same visual pattern as VideoDetailCard.tsx's own progress bar -- kept as a
// separate copy rather than shared, matching this codebase's established
// convention for these small per-file visual helpers (e.g.
// LibraryVideoDetail.tsx's own copy of the same idea).
function LinearProgressWithLabel(props: LinearProgressProps & { value: number; valueBuffer: number }) {
  const { value, valueBuffer } = props;
  const displayValue = value > 0 ? value : valueBuffer;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Box sx={{ width: '100%', mr: 1 }}>
        <LinearProgress variant="buffer" {...props} />
      </Box>
      <Box sx={{ minWidth: 35 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{`${Math.round(displayValue)}%`}</Typography>
      </Box>
    </Box>
  );
}

// Deliberately minimal, and deliberately NOT a branch inside VideoDetailCard --
// that component already has real YouTube-specific logic threaded through it
// (the YouTube iframe embed, the resolution grid, MP3 special-casing), and
// keeping this separate means future per-platform work (e.g. a resolution
// picker for Twitter/X specifically, since unlike TikTok/Instagram/SoundCloud
// it can genuinely have more than one real quality) has a clean home that
// can't destabilize the existing YouTube flow. No resolution picker, no
// format picker, no "add to library" -- just enough to get one real file
// downloaded, since a per-height quality ladder isn't consistently available
// outside YouTube at all (confirmed live: SoundCloud is audio-only with zero
// height-having formats; TikTok/Instagram typically expose only one real
// quality).
interface OtherPlatformVideoDataProps {
  videoMetaData: {
    title: string;
    fullTitle: string;
    thumbnail: string;
    uploader: string | null;
    durationString: string | null;
    uploadDate: string | null;
    description: string | null;
    originalUrl: string;
    // Computed generically for every platform, not just YouTube (see
    // buildResolutions, main.js) -- unused here except for Dailymotion,
    // since that's the one non-YouTube platform confirmed to reliably expose
    // a real per-height ladder (SoundCloud is audio-only; TikTok/Instagram
    // typically expose only one real quality).
    resolutions?: { resolution: string; filesizeMb: string }[];
  };
}

export default function OtherPlatformDownloadCard({ videoMetaData }: OtherPlatformVideoDataProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [selectedResolution, setSelectedResolution] = useState('');
  const [currentDownloadFinalPath, setCurrentDownloadFinalPath] = useState('');
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<{ outputPath: string; resolution: string } | null>(null);
  const [openBugDialog, setOpenBugDialog] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [embedSuccessOpen, setEmbedSuccessOpen] = useState(false);

  const { finalFilePath, downloadProgress, postprocessProgress, downloadStatus, isDone, isError, downloadError, startDownload } = useDownloadVideo();

  const platformLabel = getPlatformLabel(videoMetaData.originalUrl);
  // SoundCloud is audio-only -- there's no scenario where a "video" would
  // ever be the right download, so this skips the generic 'best' selector
  // entirely and always extracts a real MP3 (the same direct-ffmpeg pass
  // YouTube's own MP3 downloads use, see needsDirectFfmpegPass/main.js --
  // resolution: 'mp3' is what triggers it), rather than just downloading
  // whatever raw audio format SoundCloud happens to serve.
  const isSoundCloud = platformLabel === 'SoundCloud';
  const isDailymotion = platformLabel === 'Dailymotion';
  const resolutions = videoMetaData.resolutions || [];

  // resolution is either a real height (Dailymotion's own resolution grid),
  // 'mp3' (SoundCloud), or 'best' -- the generic "let yt-dlp pick" selector
  // every other platform still uses, since a real per-height ladder isn't
  // consistently available outside YouTube/Dailymotion.
  const beginDownload = (outputPath: string, resolution: string, overwriteMode?: DownloadVideoParams['overwriteMode']) => {
    setSelectedResolution(resolution);
    setIsDownloading(true);
    setEmbedError(null);
    startDownload({ videoUrl: videoMetaData.originalUrl, outputPath, format: 'dflt', resolution, overwriteMode });
  };

  // Reuses the exact same generic embedFileMetadata IPC LibraryVideoDetail.tsx's
  // own "Embed metadata" tool calls -- it only ever needs a file path plus
  // tag values, it was never actually library-specific despite the IPC
  // channel's "library:" prefix, so this works here with zero backend
  // changes even though this download never gets added to the library.
  // Offered specifically for SoundCloud for now (per the user's own scoping) --
  // downloaded audio files rarely carry real ID3 tags otherwise.
  const handleEmbedMetadata = async () => {
    if (!currentDownloadFinalPath) return;
    setEmbedding(true);
    setEmbedError(null);
    const res = await window.electronAPI.embedFileMetadata({
      inputPath: currentDownloadFinalPath,
      metadataTags: {
        title: videoMetaData.fullTitle || videoMetaData.title,
        artist: videoMetaData.uploader,
        date: videoMetaData.uploadDate,
        description: videoMetaData.description,
      },
      thumbnailPath: videoMetaData.thumbnail,
      kind: 'audio',
    });
    if (res.success) {
      setEmbedSuccessOpen(true);
    } else {
      setEmbedError(res.message || 'Failed to embed metadata.');
    }
    setEmbedding(false);
  };

  const handleDownload = async (resolution: string) => {
    const selectedFile = await window.electronAPI.saveVideoFile(videoMetaData.fullTitle || videoMetaData.title);
    if (selectedFile.canceled) return;

    const exists = await window.electronAPI.checkFileExists(selectedFile.filePath);
    if (exists) {
      setPendingDownload({ outputPath: selectedFile.filePath, resolution });
      setOverwriteDialogOpen(true);
      return;
    }
    beginDownload(selectedFile.filePath, resolution);
  };

  const handleOverwriteChoice = (mode: 'overwrite' | 'resume') => {
    setOverwriteDialogOpen(false);
    if (pendingDownload) {
      beginDownload(pendingDownload.outputPath, pendingDownload.resolution, mode);
    }
    setPendingDownload(null);
  };

  useEffect(() => {
    if (isDone) {
      setCurrentDownloadFinalPath(finalFilePath);
    }
  }, [isDone]);

  return (
    <>
      <Card elevation={3} sx={{ display: 'flex', p: 2, borderRadius: 4 }}>
        <Stack spacing={2} direction={{ xs: 'column', sm: 'row' }} sx={{ width: '100%' }}>
          <CardMedia
            component="img"
            image={videoMetaData.thumbnail}
            sx={{ width: { xs: '100%', sm: 240 }, height: { xs: 180, sm: 135 }, borderRadius: 2, objectFit: 'cover', flexShrink: 0 }}
          />
          <Stack spacing={0.5} sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip size="small" label={platformLabel} />
            </Stack>
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
              <Link target="_blank" rel="noopener noreferrer" href={videoMetaData.originalUrl}>
                {videoMetaData.fullTitle || videoMetaData.title}
              </Link>
            </Typography>
            {videoMetaData.uploader &&
              <Typography variant="body2" color="text.secondary">{videoMetaData.uploader}</Typography>}
            {videoMetaData.durationString &&
              <Typography variant="body2" color="text.secondary">{videoMetaData.durationString}</Typography>}

            <Box sx={{ mt: 2 }}>
              {isDownloading && !isError ? (
                <Stack spacing={1}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Typography variant="subtitle2">
                      {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : isDone ? 'Downloaded' : 'Downloading'}
                      {isDailymotion && selectedResolution && !['best', 'MP3'].includes(selectedResolution) && ` (${selectedResolution}p)`}
                      {isDailymotion && selectedResolution === 'MP3' && ' (MP3)'}
                    </Typography>
                    {isDone &&
                      <Tooltip title="Open file location">
                        <IconButton size="small" onClick={() => window.electronAPI.openFileInDirectory(currentDownloadFinalPath)} color="primary">
                          <FileOpenIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>}
                  </Stack>
                  <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} />
                  {isDone && isSoundCloud &&
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={embedding ? <CircularProgress size={16} /> : <LabelOutlinedIcon fontSize="small" />}
                        onClick={handleEmbedMetadata}
                        disabled={embedding}
                      >
                        Embed metadata
                      </Button>
                      {embedError && <Typography color="error" variant="body2">{embedError}</Typography>}
                    </Stack>}
                </Stack>
              ) : (
                <>
                  {isError &&
                    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
                      <Typography color="error" variant="subtitle2">Download failed</Typography>
                      <Button size="small" onClick={() => setOpenBugDialog(true)} color="error" variant="outlined">
                        Details<BugReportIcon fontSize="small" />
                      </Button>
                    </Stack>}
                  {isDailymotion && resolutions.length > 0 ? (
                    <Grid container spacing={1} columns={{ xs: 2, sm: 6 }}>
                      {resolutions.map((res, idx) => (
                        <Grid size={1} key={idx}>
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
                  ) : (
                    <Button variant="contained" startIcon={<DownloadIcon />} onClick={() => handleDownload(isSoundCloud ? 'mp3' : 'best')}>
                      {isSoundCloud ? 'Download MP3' : 'Download'}
                    </Button>
                  )}
                </>
              )}
            </Box>
          </Stack>
        </Stack>
      </Card>

      <Dialog open={overwriteDialogOpen} onClose={() => setOverwriteDialogOpen(false)}>
        <DialogTitle>File already exists</DialogTitle>
        <DialogContent>
          <DialogContentText>
            A file already exists at that location. Resume will continue a partial download
            (or skip if it's already complete); Overwrite will start over from scratch.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOverwriteDialogOpen(false)}>Cancel</Button>
          <Button onClick={() => handleOverwriteChoice('resume')}>Resume</Button>
          <Button onClick={() => handleOverwriteChoice('overwrite')} color="error" variant="contained">Overwrite</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={openBugDialog} onClose={() => setOpenBugDialog(false)}>
        <DialogTitle>A bug has been encountered</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The bug information has been loaded below. You can copy this and send a bug report in the project repo.
          </DialogContentText>
          <TextareaAutosize
            aria-label="Bug trace"
            placeholder="Bug trace"
            style={{ width: '100%', height: '100%' }}
            value={JSON.stringify(downloadError)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenBugDialog(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={embedSuccessOpen}
        autoHideDuration={4000}
        onClose={() => setEmbedSuccessOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setEmbedSuccessOpen(false)} severity="success" variant="filled">
          Metadata embedded.
        </Alert>
      </Snackbar>
    </>
  );
}
