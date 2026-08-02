import { useEffect, useState } from 'react';
import { Box, CircularProgress, Grid, InputAdornment, Stack, IconButton, Tooltip, Typography } from '@mui/material';
import './screens.css'
import TextField from '@mui/material/TextField';
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
  const [videoInfoError, setVideoInfoError] = useState<string | null>(null);


  useEffect(() => {
    setVideoInfoError(null);
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
    setVideoInfoError(null);
    try {
      const result = await window.electronAPI.getVideoInfoPython(url);
      if (result.success) {
        setVideoInfo(result.data.response);
      }
    } catch (err) {
      setVideoInfo(null);
      setVideoInfoError(err instanceof Error ? err.message : 'Failed to load video information.');
    } finally {
      setLoadingVideoData(false);
    }
  }

  return (
    <>
    <Box sx={{ alignContent: 'center'}}>
        <Box sx={{ flexGrow: 1 }}>
        <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              error={isUrlError}
              helperText={isUrlError ? 'Invalid URL' : ''}
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              fullWidth
              id="outlined-basic"
              label="URL"
              variant="filled"
              slotProps={{
                input: {
                  endAdornment: loadingVideoData ? (
                    <InputAdornment position="end">
                      <CircularProgress color="inherit" size={20} />
                    </InputAdornment>
                  ) : undefined,
                },
              }}
            />
            <Tooltip title="Add to library (coming soon)" placement="top">
              <span>
                <IconButton
                  onClick={handlePickFolder}
                  sx={{
                    width: 56,
                    height: 56,
                    borderRadius: 1,
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    '&:hover': { bgcolor: 'primary.dark' },
                  }}
                >
                  <LibraryAddIcon/>
                </IconButton>
              </span>
            </Tooltip>
        </Stack>
        {videoInfoError &&
          <Typography color="error" sx={{ mt: 2 }}>{videoInfoError}</Typography>}
        <Grid container spacing={2} sx={{ mt: 1 }}>
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