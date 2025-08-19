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
  FormGroup,
  Tooltip,
  CircularProgress,
  LinearProgress
} from '@mui/material';

import InfoOutlineIcon from '@mui/icons-material/InfoOutline';
import FileOpenIcon from '@mui/icons-material/FileOpen';

import type { LinearProgressProps } from '@mui/material/LinearProgress';

import { convertYYYYMMDDStringToDate, getEstimateFileSizeMbForMP3 } from '../../utils/utils.ts';
import { formatComment } from '../components/componentUtils';

import useDownloadVideo from '../hooks/useDownloadVideo.tsx';



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

const VideoDetailCard: React.FC<VideoDataProps> = ({ videoMetaData }) => {

  const displayedResolutions = videoMetaData.resolutions;
  const [selectedFormat, setSelectedFormat] = useState('dflt');
  const [currentDownloadFinalPath, setCurrentDownloadFinalPath] = useState<string>('');

  const { finalFilePath, downloadStatus, downloadProgress, isDone, isError, downloadError, startDownload } = useDownloadVideo();

  const handleDownloadOperationFromResolution = async (resolution: string) => {
    console.log('resolution:', resolution, 'format:', selectedFormat)
    const selectedFile = await window.electronAPI.saveVideoFile(videoMetaData.fullTitle);

    if (!selectedFile.canceled) {
      startDownload({ videoUrl: videoMetaData.originalUrl, outputPath: selectedFile.filePath, format: selectedFormat, resolution});
    }
    
  }

  if(downloadError) {
    console.log(downloadError);
  }

  useEffect(() => {
    if (isDone) {
      setCurrentDownloadFinalPath(finalFilePath);
    }
  }, [isDone])

  useEffect(() => {
    displayedResolutions.push({
      resolution: 'MP3',
      filesizeMb: getEstimateFileSizeMbForMP3(videoMetaData.durationString)
    })
  }, [])

  return (
    <Card elevation={3} sx={{ display: 'flex', p: 2, borderRadius: 4 }}>
      <Stack>
        <Stack direction="row">
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

            <Paper sx={{ p: 1, border: '2px solid black', borderRadius: 2, height: '50%' }}>
              <Grid container
              spacing={{xs:1, sm:1 }}
              columns={{xs: 1, sm: 9,md: 12}}>
                {displayedResolutions?.map((res, idx) => (
                  <Grid size={{xs: 2, sm: 3}} key={idx}>
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
                <Button onClick={() => handleDownloadOperationFromResolution('mp3')} sx={{whiteSpace: "pre-line"}} color="secondary"  fullWidth variant="contained">
                      <Stack 
                          spacing={0}
                          direction="column"
                          divider={<Divider flexItem sx={{mx:1}} orientation='horizontal'/>}>
                          <Typography variant="button" textTransform='none'>MP3</Typography>
                          <Typography variant="caption">{getEstimateFileSizeMbForMP3(videoMetaData.durationString)}Mb</Typography>
                      </Stack>
                    </Button>
              </Grid>
              <Divider flexItem sx={{pt:1}} orientation='horizontal'/>
              <Box sx={{alignItems: 'center'}}>
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
            </Paper>
          </Box>
          <Box sx={{ width: '50%' }}>
            <Stack spacing={6} direction="row" justifyContent="left" mb={1}>
                <Grid size={8}>
                    <Typography textAlign="initial" variant="h6"> <a target="_blank" href={videoMetaData.originalUrl}>{videoMetaData.fullTitle}</a></Typography>
                </Grid>
                <Grid sx={{whiteSpace: 'nowrap'}} size={2} justifyContent={'right'}>
                    <Typography variant="body2" gutterBottom sx={{color: 'info.main', fontWeight: 'bolder'}}>
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
          </Box>
        </Stack>
        <Box sx={{p:2}}>
        <Divider flexItem sx={{mx: 3}} orientation='horizontal'/>
          <Grid container sx={{width: '100%'}} spacing={1}>            
                <Stack direction={"row"}>
                <Typography variant="subtitle1">Download</Typography>
                <Typography variant="subtitle1">{`(${downloadStatus})`}</Typography>
                {isDone && <Button onClick={() => handleOpenFileLocation(currentDownloadFinalPath)} variant="contained">Open File Location<FileOpenIcon/></Button>}
                </Stack>
                <Box sx={{ width: '100%' }}>
                  <LinearProgressWithLabel value={downloadProgress} />
                </Box>
                {isError && <Typography>VALIO VERGAAAA</Typography>}
          </Grid>
        </Box>
      </Stack>
    </Card>
    
  );
};

export default VideoDetailCard;
