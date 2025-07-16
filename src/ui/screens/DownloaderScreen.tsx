import { useEffect, useState } from 'react';
import { Box, Grid } from '@mui/material';
import './screens.css'
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import { isValidUrl } from '../../utils/utils.ts';
import VideoDetailCard from './VideoDetailCard';

import { useDebounce } from '../../utils/useDebounce';

import { videoResponseMock } from '../../../testing/mockData/pythonResponseMocks.ts';


export default function DownloaderScreen() {

  const [videoUrl, setVideoUrl] = useState("");
  const debouncedVideoUrl = useDebounce(videoUrl);
  const [videoInfo, setVideoInfo] = useState(window.mockingElectron !== "yes" ? null : videoResponseMock.data.response); // TODO change this after testing


  useEffect(() => {
    if (debouncedVideoUrl != '' && isValidUrl(debouncedVideoUrl)) {
      handleGetVideoInfo(debouncedVideoUrl);
    } else {
      console.log('INVALID URL');
    }
    
  }, [debouncedVideoUrl])


  const handlePickFolder = async () => {
    const result = await window.electronAPI.pickFolder( {
      title: "Select Download Folder", 
      buttonLabel: "ONEGAI",
      message: "KIOBO",
    });
    console.log(result);
  };

  const handleGetVideoInfo = async (url: string) => {
    const result = await window.electronAPI.getVideoInfoPython(url);
    if (result.success) {
      setVideoInfo(result.data.response);
    }
    console.log(result);
  }

  return (
    <>
    <div className='tabContent'>
        <Box sx={{ flexGrow: 1 }}>
        <Grid container spacing={2}>
            <Grid size={10}>
            <TextField value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} fullWidth id="outlined-basic" label="URL" variant="filled" />
            </Grid>
            <Grid size={1}>
            <Button onClick={handlePickFolder} fullWidth variant="contained"><LibraryAddIcon/></Button>
            </Grid>
            {videoInfo && <Grid size={10}>
            <VideoDetailCard videoMetaData={videoInfo}/>
            </Grid>}
        </Grid>
        </Box>
    </div>
    </>
  )
}