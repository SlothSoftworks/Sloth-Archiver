import { useEffect, useState } from 'react';
import Grid from '@mui/material/Grid';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import { styled } from '@mui/material/styles';
import './screens.css'
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import DownloadIcon from '@mui/icons-material/Download';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import { isValidUrl } from '../../utils/utils.mjs';

import { useDebounce } from '../../utils/useDebounce';

const Item = styled(Paper)(({ theme }) => ({
    backgroundColor: '#fff',
    ...theme.typography.body2,
    padding: theme.spacing(1),
    textAlign: 'center',
    color: (theme.vars ?? theme).palette.text.secondary,
    ...theme.applyStyles('dark', {
      backgroundColor: '#1A2027',
    }),
  }));

export default function DownloaderScreen() {

  const [videoUrl, setVideoUrl] = useState("");
  const debouncedVideoUrl = useDebounce(videoUrl);
  const [currentVidSavePath, setCurrentVidSavePath] = useState("");
  const [videoInfo, setVideoInfo] = useState('');


  useEffect(() => {
    console.log(debouncedVideoUrl);
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

  const handleSaveVideo = async () => {
    const result = await window.electronAPI.saveVideoFile();
    console.log(result);
    if (!result.canceled) {
      console.log('notcanceled');
      setCurrentVidSavePath(result.filePath);
    }
  };

  const handleGetVideoInfo = async (url: string) => {
    const result = await window.electronAPI.getVideoInfoPython(url);
    console.log(result);
  }

  const handleDowloadFromPython = async () => {
    const args = {
      url: videoUrl,
      outputPath: currentVidSavePath,
    }
    const result = await window.electronAPI.downloadVideoPython(args);
    console.log(result);
  }

  return (
    <>
    <div className='tabContent'>
        <Box sx={{ flexGrow: 1 }}>
        <Grid container spacing={2}>
            <Grid size={6}>
            <TextField value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} fullWidth id="outlined-basic" label="URL" variant="filled" />
            </Grid>
            <Grid size={2}>
            <Button onClick={handleSaveVideo} startIcon={<DownloadIcon/>} fullWidth variant="contained">DIRECT DOWNLOAD</Button>
            </Grid>
            <Grid size={2}>
            <Button onClick={handlePickFolder} fullWidth variant="contained"><LibraryAddIcon/></Button>
            </Grid>
            <Grid size={4}>
            {currentVidSavePath && <Item>Filepath current vid {currentVidSavePath}</Item>} 
            </Grid>
            <Grid size={8}>
            <Item>size=8</Item>
            </Grid>
        </Grid>
        </Box>
    </div>
    </>
  )
}
