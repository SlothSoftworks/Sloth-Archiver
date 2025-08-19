import { useEffect, useState } from 'react';
import { Box, CircularProgress, Grid } from '@mui/material';
import './screens.css'
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import { isValidUrl } from '../../utils/utils.ts';
import VideoDetailCard from './VideoDetailCard';

import { useDebounce } from '../../utils/useDebounce';

import { videoResponseMock } from '../../../testing/mockData/pythonResponseMocks.ts';
import VideoDetailCardSkeleton from './VideoDetailCardSkeleton.tsx';


export default function DownloaderScreen() {

  const [videoUrl, setVideoUrl] = useState("");
  const [loadingVideoData, setLoadingVideoData] = useState(false);
  const [isUrlError, setIsUrlError] = useState(false);
  const debouncedVideoUrl = useDebounce(videoUrl);
  const [videoInfo, setVideoInfo] = useState(window.mockingElectron !== "yes" ? null : videoResponseMock.data.response); // TODO change this after testing


  useEffect(() => {
    if (debouncedVideoUrl === '') { return; }
    if (isValidUrl(debouncedVideoUrl)) {
      setIsUrlError(false)
      handleGetVideoInfo(debouncedVideoUrl);
    } else {
      setIsUrlError(true);
    }
    
  }, [debouncedVideoUrl])


  const handlePickFolder = async () => {
    const result = await window.electronAPI.pickFolder( {
      title: "Select Download Folder", 
      buttonLabel: "ONEGAI",
      message: "KIOBO",
    });
  };

  const handleGetVideoInfo = async (url: string) => {
    setLoadingVideoData(true);
    const result = await window.electronAPI.getVideoInfoPython(url);
    setLoadingVideoData(false);
    if (result.success) {
      setVideoInfo(result.data.response);
    } console.log(result)
  }

  return (
    <>
    <Box sx={{ alignContent: 'center'}}>
        <Box sx={{ flexGrow: 1 }}>
        <Grid container spacing={2}>
            <Grid size={10}>
            <TextField error={isUrlError} helperText={isUrlError ? 'Invalid URL' : ''} value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} fullWidth id="outlined-basic" label="URL" variant="filled" />
            </Grid>
            {loadingVideoData && <CircularProgress color='inherit'/>}
            <Grid size={1}>
            <Button onClick={handlePickFolder} fullWidth variant="contained"><LibraryAddIcon/></Button>
            </Grid>
            {
              loadingVideoData && 
              <Grid size={10}>
                <VideoDetailCardSkeleton/>
              </Grid>
            }
            {videoInfo &&
              <Grid size={10}>
                <VideoDetailCard videoMetaData={videoInfo}/>
              </Grid>}
        </Grid>
        </Box>
    </Box>
    </>
  )
}