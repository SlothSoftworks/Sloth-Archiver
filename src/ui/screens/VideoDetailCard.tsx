import React, { useState, useEffect } from 'react';

import {
  Box,
  Button,
  Card,
  CardMedia,
  Typography,
  Grid,
  Stack,
  Paper,
  Divider,
  MenuItem,
  Select,
} from '@mui/material';

import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import FileOpenIcon from '@mui/icons-material/FileOpen';

import LinearProgress from '@mui/material/LinearProgress';
import type { LinearProgressProps } from '@mui/material/LinearProgress';

import { convertYYYYMMDDStringToDate } from '../../utils/utils.ts';
import { formatComment } from '../components/componentUtils';

import { electronAPIMock, electronAPIPythonDownloadMock } from '../../../testing/mockData/electronAPIMocks.ts'


if (!window.electronAPI) {
  window.mockingElectron = "yes";
  window.electronAPI = electronAPIMock;
  window.electronAPIPythonDownload = electronAPIPythonDownloadMock;
}

async function handleOpenFileLocation(filePath: string) {
  await window.electronAPI.openFileInDirectory(filePath);
}

function LinearProgressWithLabel(props: LinearProgressProps & { value: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Box sx={{ width: '100%', mr: 1 }}>
        <LinearProgress variant="determinate" {...props} />
      </Box>
      <Box sx={{ minWidth: 35 }}>
        <Typography
          variant="body2"
          sx={{ color: 'text.secondary' }}
        >{`${Math.round(props.value)}%`}</Typography>
      </Box>
    </Box>
  );
}

function LinearWithValueLabel() {
  const [progress, setProgress] = useState(10);

  useEffect(() => {
    const timer = setInterval(() => {
      setProgress((prevProgress) => (prevProgress >= 100 ? 10 : prevProgress + 10));
    }, 800);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <Box sx={{ width: '100%' }}>
      <LinearProgressWithLabel value={progress} />
    </Box>
  );
}

interface Resolution {
    resolution: string;
    filesizeMb: string;
}

interface VideoDataProps {
    videoMetaData: {
        fullTitle: string;
        description: string;
        thumbnail: string;
        resolutions: Resolution[];
        originalUrl: string;
        durationString: string;
        uploadDate: string;
    }
  }

interface DownloadProgressMessage {
  type: string;
  payload: {
    filename: string;
    downloadedBytes: string;
    totalBytes: string;
    percent: string;
    speed: string;
  }
}

const VideoDetailCard: React.FC<VideoDataProps> = ({ videoMetaData }) => {

  const [selectedFormat, setSelectedFormat] = useState('dflt');
  const [downloadStatus, setDownloadStatus] = useState('idle');
  const [currentDownloadProgress, setCurrentDownloadProgress] = useState('0%');
  const [currentDownloadFinalPath, setCurrentDownloadFinalPath] = useState('');


  const handleDownloadOperationFromResolution = async (resolution: string) => {
    console.log('resolution:', resolution, 'format:', selectedFormat)
    const selectedFile = await window.electronAPI.saveVideoFile(videoMetaData.fullTitle);
    console.log(selectedFile)

    if (!selectedFile.canceled) {
      window.electronAPIPythonDownload.startDownloadPython({ videoUrl: videoMetaData.originalUrl, outputhPath: selectedFile.filePath })
    }
    
  }


  useEffect(() => {
    window.electronAPIPythonDownload.onProgressUpdate((msg: DownloadProgressMessage) => {
      const { type, payload } = msg;
      switch(type) {
        case 'progress':
          setCurrentDownloadProgress(payload.percent);
          setDownloadStatus('progress');
          break;
        case 'downloading':
          setDownloadStatus('Downloading...');
          break;
        case 'postprocessing':
          setDownloadStatus('Postprocessing...')
          break;
        case 'error':
          console.error('Download error:', msg)
          break;
        case 'done':
          setDownloadStatus('Done: ')
          setCurrentDownloadFinalPath(payload.filename)
          break;
      }
      //TODO add validation for download done and link it to the openfolder function
    });

    return () => {
      window.electronAPIPythonDownload.removeProgressListener();
    }

  })


  return (
    <Card elevation={3} sx={{ display: 'flex', p: 2, borderRadius: 4, backgroundColor: 'grey.800' }}>
      <Box sx={{ width: '50%', pr: 2}}>
        <CardMedia
          component="div"
          image={videoMetaData.thumbnail}
          sx={{
            height: 240,
            border: '2px solid black',
            borderRadius: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            mb: 2,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          <Typography position={"absolute"} variant="h2"> <a target="_blank" href={videoMetaData.originalUrl}>▶</a></Typography>
          <Typography sx={{backgroundColor: 'grey.800', left: '42%', top: '36%', position:'sticky', borderRadius: 2, padding: '0% 1% 0% 1%'}} variant='body1'>{videoMetaData.durationString}</Typography>
        </CardMedia>

        <Paper sx={{ p: 1, border: '2px solid black', borderRadius: 2 }}>
          <Grid container spacing={1}>
            {videoMetaData.resolutions?.map((res, idx) => (
              <Grid size={{xs: 4}} key={idx}>
                <Button onClick={() => handleDownloadOperationFromResolution(res.resolution)} sx={{whiteSpace: "pre-line"}}  fullWidth variant="outlined">
                  <Stack 
                      spacing={0}
                      direction="column"
                      divider={<Divider flexItem sx={{mx:1}} orientation='horizontal'/>}>
                      <Typography variant="button">{res.resolution}</Typography>
                      <Typography variant="caption">{res.filesizeMb}Mb</Typography>
                  </Stack>
                </Button>
              </Grid>
            ))}
          </Grid>
          <Divider flexItem sx={{pt:1}} orientation='horizontal'/>
          <Grid container sx={{pt: '3%'}}>
            <Select
                    labelId="format-selector"
                    id="format-selector"
                    value={"dflt"}
                    label="Format"
                    onChange={(e) => setSelectedFormat(e.target.value)}
                    variant='standard'
                >
                    <MenuItem value={"dflt"}>{"Default (keep origin format)"}</MenuItem>
                    <MenuItem value={"mp4"}>MP4</MenuItem>
                    <MenuItem value={"webm"}>WEBM</MenuItem>
                    <MenuItem value={"mkv"}>MKV</MenuItem>
                </Select>
          </Grid>
        </Paper>
        <Paper sx={{ p: 1, border: '2px solid black', borderRadius: 2 }}>
          <Grid container spacing={1}>
            <LinearWithValueLabel/>
            
            <Stack direction={"row"}>
            <Typography variant="caption">{downloadStatus}</Typography>
            <Button onClick={() => handleOpenFileLocation(currentDownloadFinalPath)} variant="contained"><FileOpenIcon/></Button>
            </Stack>
            <Box sx={{ width: '100%' }}>
              <LinearProgressWithLabel value={parseInt(currentDownloadProgress.replace('%', ''))} />
            </Box>
            {currentDownloadProgress}
          </Grid>
        </Paper>
      </Box>

      <Box sx={{ width: '50%' }}>
        <Stack spacing={1} direction="row" justifyContent="flex-end" mb={1}>
          <Button variant="contained">Save</Button>
          <Button variant="contained"><LibraryAddIcon/></Button>
        </Stack>

        <Stack spacing={6} direction="row" justifyContent="left" mb={1}>
            <Grid size={8}>
                <Typography textAlign="initial" variant="h6"> <a target="_blank" href={videoMetaData.originalUrl}>{videoMetaData.fullTitle}</a></Typography>
            </Grid>
            <Grid sx={{whiteSpace: 'nowrap'}} size={2} justifyContent={'right'}>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                {convertYYYYMMDDStringToDate(videoMetaData.uploadDate)}
                </Typography>
            </Grid>
        </Stack>
        <Card sx={{backgroundColor: 'primary.contrastText'}} >
            <Stack sx={{backgroundColor: 'primary.main'}} spacing={1} direction="row" justifyContent="left">
                <Typography justifyContent={'left'} variant="subtitle1" gutterBottom>
                Description
                </Typography>
            </Stack>
            <Typography sx={{textAlign: 'justify', overflowY: 'scroll', maxHeight: '45vh', p:1}} variant="body2">
            {formatComment(videoMetaData.description)}
            </Typography>
        </Card>
        <Divider flexItem sx={{mx: 3}} orientation='horizontal'/>
        <Box>
            <Typography>Post-Processing (WIP)</Typography>
        </Box>
      </Box>
    </Card>
  );
};

export default VideoDetailCard;
