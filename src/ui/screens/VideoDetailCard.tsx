import React, { useState, useEffect } from 'react';

import {
  Box,
  Button,
  Card,
  Typography,
  Grid,
  Stack,
  Paper,
  Divider,
  MenuItem,
  Select,
  FormGroup,
  Tooltip,
  IconButton,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  DialogContentText,
  TextareaAutosize,
  Link
} from '@mui/material';
import type { DownloadVideoParams, Resolution } from '../../types';

import InfoOutlineIcon from '@mui/icons-material/InfoOutline';
import FileOpenIcon from '@mui/icons-material/FileOpen';
import BugReportIcon from '@mui/icons-material/BugReport';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CancelIcon from '@mui/icons-material/Cancel';

import { convertYYYYMMDDStringToDate, isLongVideoForPostprocess } from '../../utils/utils.ts';
import { formatComment } from '../components/componentUtils';

import useDownloadVideo from '../hooks/useDownloadVideo.tsx';
import YouTubeEmbed from '../components/YouTubeEmbed';
import ResizableMediaContainer from '../components/ResizableMediaContainer';
import LinearProgressWithLabel from '../components/LinearProgressWithLabel';



async function handleOpenFileLocation(filePath: string) {
  await window.electronAPI.openFileInDirectory(filePath);
}

interface VideoDataProps {
    videoMetaData: {
        id: string;
        fullTitle: string;
        description: string;
        thumbnail: string;
        resolutions: Resolution[];
        originalUrl: string;
        duration?: number | null;
        durationString: string;
        uploadDate: string;
    }
  }

const VideoDetailCard: React.FC<VideoDataProps> = ({ videoMetaData }) => {

  const displayedResolutions = videoMetaData.resolutions;
  const [selectedFormat, setSelectedFormat] = useState('dflt');
  const [currentDownloadFinalPath, setCurrentDownloadFinalPath] = useState<string>('');

  const [openBugDialog, setOpenBugDialog] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(true);
  const [selectedResolution, setSelectedResolution] = useState('');
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<{ outputPath: string; resolution: string } | null>(null);

  const { finalFilePath, downloadStatus, downloadProgress, postprocessProgress, postprocessIndeterminate, isDone, isError, downloadError, downloadErrorKind, isRetrying, startDownload, cancelDownload } = useDownloadVideo();

  const beginDownload = (outputPath: string, resolution: string, overwriteMode?: DownloadVideoParams['overwriteMode']) => {
    setSelectedResolution(resolution);
    startDownload({ videoUrl: videoMetaData.originalUrl, outputPath, format: selectedFormat, resolution, overwriteMode });
  }

  const handleDownloadOperationFromResolution = async (resolution: string) => {
    const selectedFile = await window.electronAPI.saveVideoFile(videoMetaData.fullTitle);
    if (selectedFile.canceled) return;

    const exists = await window.electronAPI.checkFileExists(selectedFile.filePath);
    if (exists) {
      setPendingDownload({ outputPath: selectedFile.filePath, resolution });
      setOverwriteDialogOpen(true);
      return;
    }

    beginDownload(selectedFile.filePath, resolution);
  }

  const handleOverwriteChoice = (mode: 'overwrite' | 'resume') => {
    setOverwriteDialogOpen(false);
    if (pendingDownload) {
      beginDownload(pendingDownload.outputPath, pendingDownload.resolution, mode);
    }
    setPendingDownload(null);
  }

  useEffect(() => {
    if (isDone) {
      setCurrentDownloadFinalPath(finalFilePath);
    }
  }, [isDone])

  return (
    <>
      <Card elevation={3} sx={{ display: 'flex', p: 2, borderRadius: 4 }}>
        <Stack spacing={2} direction={{ xs: 'column', md: 'row' }} sx={{ width: '100%' }}>
        <Stack spacing={2} sx={{ width: { xs: '100%', md: '70%' } }}>
          <Box sx={{ px: 1.5, py: 1, borderBottom: 2, borderColor: 'primary.main', order: 1 }}>
            <Stack spacing={2} direction="row" justifyContent="space-between" alignItems="flex-start">
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="h5" fontWeight="bold">
                      <Link target="_blank" rel="noopener noreferrer" href={videoMetaData.originalUrl}>{videoMetaData.fullTitle}</Link>
                    </Typography>
                </Box>
                <Box sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                    <Typography variant="body2" gutterBottom textAlign="right" sx={{color: 'info.main', fontWeight: 'bolder'}}>
                    {convertYYYYMMDDStringToDate(videoMetaData.uploadDate)}
                    </Typography>
                </Box>
            </Stack>
          </Box>

          <ResizableMediaContainer sx={{ border: '2px solid black', borderRadius: 2, order: 0 }}>
            <YouTubeEmbed videoId={videoMetaData.id} sx={{ width: '100%', height: '100%' }} />
          </ResizableMediaContainer>

          <Card sx={{backgroundColor: 'primary.contrastText', order: 2}} >
              <Stack
                sx={{backgroundColor: 'primary.main', px: 2, py: 1, cursor: 'pointer'}}
                spacing={1}
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                onClick={() => setDescriptionExpanded((prev) => !prev)}
              >
                  <Typography variant="subtitle1" sx={{ color: 'primary.contrastText', m: 0 }}>
                  Description
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); setDescriptionExpanded((prev) => !prev); }}
                    aria-label={descriptionExpanded ? 'Collapse description' : 'Expand description'}
                    sx={{
                      color: 'primary.contrastText',
                      transform: descriptionExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s',
                    }}
                  >
                    <ExpandMoreIcon/>
                  </IconButton>
              </Stack>
              <Collapse in={descriptionExpanded}>
                <Typography sx={{textAlign: 'justify', overflowY: 'scroll', maxHeight: '35vh', p:1}} variant="body2">
                {formatComment(videoMetaData.description)}
                </Typography>
              </Collapse>
          </Card>
        </Stack>

        <Stack spacing={2} sx={{ width: { xs: '100%', md: '30%' } }}>
          <Paper sx={{ p: 1, border: '2px solid black', borderRadius: 2 }}>
            {selectedResolution && !isError ? (
              <Stack spacing={1} sx={{ p: 1 }}>
                <Stack direction="row" spacing={0.5} justifyContent="center" alignItems="center">
                  <Typography variant="subtitle1" textAlign="center">
                    {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : isDone ? 'Downloaded' : 'Downloading'}
                    {selectedResolution && ` (${selectedResolution}${selectedResolution.toLowerCase() === 'mp3' ? '' : 'p'})`}
                  </Typography>
                  {isDone &&
                    <Tooltip title="Open file location">
                      <IconButton size="small" onClick={() => handleOpenFileLocation(currentDownloadFinalPath)} color="primary">
                        <FileOpenIcon fontSize="small"/>
                      </IconButton>
                    </Tooltip>}
                  {!isDone &&
                    <Tooltip title="Cancel this download">
                      <IconButton size="small" onClick={cancelDownload} color="error">
                        <CancelIcon fontSize="small"/>
                      </IconButton>
                    </Tooltip>}
                </Stack>
                {isRetrying &&
                  <Typography variant="caption" color="warning.main" textAlign="center">
                    Retrying after a download error...
                  </Typography>}
                <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} indeterminate={postprocessIndeterminate} />
                {!isDone && isLongVideoForPostprocess(videoMetaData.duration) &&
                  <Typography variant="caption" color="warning.main" textAlign="center">
                    This is a long video -- postprocessing may take a while with no visible progress.
                  </Typography>}
              </Stack>
            ) : (
              <>
                {isError && downloadErrorKind === 'cancelled' ? (
                  <Typography color="warning.main" variant="subtitle2" fontWeight="bold" sx={{ mb: 1 }}>Cancelled</Typography>
                ) : isError && (
                  <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
                    <Typography color="error" variant="subtitle2">Download failed</Typography>
                    <Button size="small" onClick={() => setOpenBugDialog(true)} color="error" variant="outlined">Details<BugReportIcon fontSize="small"/></Button>
                  </Stack>
                )}
                <Grid container
                spacing={{xs:1, sm:1 }}
                columns={{xs: 2, sm: 9,md: 12}}>
                  {displayedResolutions?.map((res, idx) => (
                    <Grid size={{xs: 1, sm: 3}} key={idx}>
                      <Button onClick={() => handleDownloadOperationFromResolution(res.resolution)}
                      sx={{whiteSpace: "pre-line"}}
                      color={res.resolution === 'MP3' ? 'secondary' : 'primary'}
                      fullWidth
                      variant={res.resolution === 'MP3' ? 'contained' : 'outlined'}>
                        <Stack
                            spacing={0}
                            direction="column"
                            divider={<Divider flexItem sx={{mx:1}} orientation='horizontal'/>}>
                            <Typography variant="button" textTransform='none'>{res.resolution}{res.resolution === 'MP3' ? '' : 'p'}</Typography>
                            <Typography variant="caption">{res.filesizeMb}Mb</Typography>
                        </Stack>
                      </Button>
                    </Grid>
                  ))}
                </Grid>
                <Divider flexItem sx={{pt:1}} orientation='horizontal'/>
                <Box sx={{display: 'flex', alignItems: 'center'}}>
                  <Typography variant="button">Post-Processing</Typography>
                  <Tooltip placement="top" title="The postprocessing steps will add some extra processing after the download is done, for a quicker downloa select the Default option" arrow>
                    <InfoOutlineIcon sx={{fontSize: 'medium', textAlign:'center', pl: 2}}/>
                  </Tooltip>
                </Box>
                <Grid container spacing={2} sx={{pt: '3%'}}>
                  <FormGroup>
                    <Stack direction="row" spacing={10}>
                    <Select
                          labelId="format-selector"
                          id="format-selector"
                          value={selectedFormat}
                          label="Format"
                          onChange={(e) => setSelectedFormat(e.target.value)}
                          variant='standard'>
                            <MenuItem value={"dflt"}>{"Default (keep origin format)"}</MenuItem>
                            <MenuItem value={"mp4"}>MP4</MenuItem>
                            <MenuItem value={"webm"}>WEBM</MenuItem>
                            <MenuItem value={"mkv"}>MKV</MenuItem>
                        </Select>
                    </Stack>
                  </FormGroup>
                </Grid>
              </>
            )}
          </Paper>
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
      <Dialog
        open={openBugDialog}
        onClose={() => setOpenBugDialog(false)}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">
          {"A bug has been encountered"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="alert-dialog-description">
            The bug information has been loaded below. You can copy this and send a bug report in the project repo
          </DialogContentText>
          <TextareaAutosize
            aria-label="minimum height"
            placeholder="Bug trace"
            style={{ width: '100%', height: '100%' }}
            value={JSON.stringify(downloadError)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenBugDialog(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default VideoDetailCard;
