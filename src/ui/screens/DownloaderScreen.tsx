import { useEffect, useState } from 'react';
import { Box, Chip, CircularProgress, InputAdornment, Stack, IconButton, Tooltip, Typography } from '@mui/material';
import './screens.css'
import TextField from '@mui/material/TextField';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
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
  const [videoInfoFromCache, setVideoInfoFromCache] = useState(false);


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

  // Testing convenience: evict just this URL's cache entry without waiting
  // out the week-long TTL or clearing the whole cache file by hand.
  const handleDeleteCacheEntry = async () => {
    await window.electronAPI.deleteVideoInfoCacheEntry(debouncedVideoUrl);
    setVideoInfoFromCache(false);
  };

  const handleGetVideoInfo = async (url: string) => {
    setLoadingVideoData(true);
    setVideoInfoError(null);
    setVideoInfoFromCache(false);
    try {
      const result = await window.electronAPI.getVideoInfoPython(url);
      if (result.success) {
        setVideoInfo(result.data.response);
        setVideoInfoFromCache(!!result.data.fromCache);
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
        {videoInfoFromCache && videoInfo && !loadingVideoData &&
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1 }}>
            <Chip label="Loaded from cache" color="info" variant="outlined" size="small" />
            <Tooltip title="Delete this entry from the cache (testing)" placement="top">
              <IconButton size="small" onClick={handleDeleteCacheEntry}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>}
        {loadingVideoData &&
          <Box sx={{ mt: 2 }}>
            <VideoDetailCardSkeleton/>
          </Box>}
        {videoInfo &&
          <Box sx={{ mt: 2 }}>
            <VideoDetailCard videoMetaData={videoInfo}/>
          </Box>}
        </Box>
    </Box>
    </>
  )
}