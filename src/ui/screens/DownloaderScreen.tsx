import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  InputAdornment,
  Stack,
  IconButton,
  Snackbar,
  Tooltip,
  Typography,
} from '@mui/material';
import './screens.css'
import TextField from '@mui/material/TextField';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { isValidUrl } from '../../utils/utils.ts';
import VideoDetailCard from './VideoDetailCard';

import { useDebounce } from '../../utils/useDebounce';

import { videoResponseMock } from '../../../testing/mockData/pythonResponseMocks.ts';
import VideoDetailCardSkeleton from './VideoDetailCardSkeleton.tsx';
import { useLibraryNotification } from '../hooks/useLibraryNotifications';


export default function DownloaderScreen() {

  const { increment: incrementLibraryNotifications } = useLibraryNotification();
  const [videoUrl, setVideoUrl] = useState("");
  const [loadingVideoData, setLoadingVideoData] = useState(false);
  const [isUrlError, setIsUrlError] = useState(false);
  const debouncedVideoUrl = useDebounce(videoUrl);
  const [videoInfo, setVideoInfo] = useState(window.mockingElectron !== "yes" ? null : videoResponseMock.data.response); // TODO change this after testing
  const [videoInfoError, setVideoInfoError] = useState<string | null>(null);
  const [videoInfoFromCache, setVideoInfoFromCache] = useState(false);
  const [libraryAddStatus, setLibraryAddStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [libraryErrorMessage, setLibraryErrorMessage] = useState<string | null>(null);
  const [librarySuccessSnackbarOpen, setLibrarySuccessSnackbarOpen] = useState(false);
  const [duplicateMatch, setDuplicateMatch] = useState<{ channelDisplayName: string | null; videoDir: string } | null>(null);


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


  // Bare-bones for now: tracks the video (folder + metadata.json) without
  // downloading its file -- adding to the library and downloading are
  // separate actions, matching how the library is meant to work overall.
  const performAddToLibrary = async () => {
    if (!videoInfo) return;
    setLibraryAddStatus('saving');
    try {
      await window.electronAPI.addLibraryEntry(videoInfo);
      incrementLibraryNotifications();
      setLibrarySuccessSnackbarOpen(true);
      // Clear the search result now that it's been added -- a placeholder for
      // a more refined post-add flow later.
      setVideoUrl('');
      setVideoInfo(null);
      setVideoInfoError(null);
      setVideoInfoFromCache(false);
      setIsUrlError(false);
      setLibraryAddStatus('idle');
    } catch (err) {
      console.error('Failed to add to library', err);
      setLibraryAddStatus('error');
      setLibraryErrorMessage(err instanceof Error ? err.message : 'Failed to add video to the library.');
    }
  };

  const handleAddToLibrary = async () => {
    if (!videoInfo) return;
    setLibraryAddStatus('saving');
    try {
      const existing = await window.electronAPI.findLibraryVideo(videoInfo.id);
      if (existing.found && existing.videoDir) {
        // Pause here rather than writing a redundant epoch folder for a video
        // that's already tracked -- let the user decide via the dialog below.
        setLibraryAddStatus('idle');
        setDuplicateMatch({ channelDisplayName: existing.channelDisplayName || null, videoDir: existing.videoDir });
        return;
      }
      await performAddToLibrary();
    } catch (err) {
      console.error('Failed to check the library for this video', err);
      setLibraryAddStatus('error');
      setLibraryErrorMessage(err instanceof Error ? err.message : 'Failed to add video to the library.');
    }
  };

  // Replaces the existing tracked entry rather than adding another one --
  // deletes its old epoch data first, then writes fresh. "Add as new
  // version" (additive, keeps the old data) is the not-yet-built alternative.
  const handleOverrideAdd = async () => {
    if (!videoInfo || !duplicateMatch) return;
    const existingVideoDir = duplicateMatch.videoDir;
    setDuplicateMatch(null);
    setLibraryAddStatus('saving');
    try {
      await window.electronAPI.overrideLibraryEntry(videoInfo, existingVideoDir);
      incrementLibraryNotifications();
      setLibrarySuccessSnackbarOpen(true);
      setVideoUrl('');
      setVideoInfo(null);
      setVideoInfoError(null);
      setVideoInfoFromCache(false);
      setIsUrlError(false);
      setLibraryAddStatus('idle');
    } catch (err) {
      console.error('Failed to override library entry', err);
      setLibraryAddStatus('error');
      setLibraryErrorMessage(err instanceof Error ? err.message : 'Failed to add video to the library.');
    }
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
    setLibraryAddStatus('idle');
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
            <Tooltip title={
              !videoInfo ? 'Load a video first' :
              libraryAddStatus === 'saving' ? 'Adding...' :
              libraryAddStatus === 'done' ? 'Added to library' :
              libraryAddStatus === 'error' ? 'Failed to add -- click to retry' :
              'Add to library'
            } placement="top">
              <span>
                <IconButton
                  onClick={handleAddToLibrary}
                  disabled={!videoInfo || libraryAddStatus === 'saving'}
                  sx={{
                    width: 56,
                    height: 56,
                    borderRadius: 1,
                    // Only colored once a video is actually loaded -- applying this
                    // bgcolor/color override unconditionally (including while disabled)
                    // fought MUI's own disabled-button styling and made the button
                    // render invisibly, even though its Tooltip still worked (the
                    // span wrapper it needs to show a tooltip on a disabled button
                    // doesn't depend on the button itself being visible).
                    ...(videoInfo && {
                      bgcolor: libraryAddStatus === 'error' ? 'error.main' : libraryAddStatus === 'done' ? 'success.main' : 'primary.main',
                      color: 'primary.contrastText',
                      '&:hover': { bgcolor: libraryAddStatus === 'error' ? 'error.dark' : libraryAddStatus === 'done' ? 'success.dark' : 'primary.dark' },
                    }),
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
    <Dialog open={!!libraryErrorMessage} onClose={() => setLibraryErrorMessage(null)}>
      <DialogTitle>Couldn't add to library</DialogTitle>
      <DialogContent>
        <DialogContentText>{libraryErrorMessage}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setLibraryErrorMessage(null)}>Close</Button>
      </DialogActions>
    </Dialog>
    <Dialog open={!!duplicateMatch} onClose={() => setDuplicateMatch(null)}>
      <DialogTitle>Already in your library</DialogTitle>
      <DialogContent>
        <DialogContentText>
          This video is already tracked in your library{duplicateMatch?.channelDisplayName ? ` under "${duplicateMatch.channelDisplayName}"` : ''}.
          What would you like to do?
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setDuplicateMatch(null)}>Cancel</Button>
        <Tooltip title="Versioning isn't built yet -- coming in a later pass">
          <span>
            <Button disabled>Add as new version</Button>
          </span>
        </Tooltip>
        <Button variant="contained" onClick={handleOverrideAdd}>Override</Button>
      </DialogActions>
    </Dialog>
    <Snackbar
      open={librarySuccessSnackbarOpen}
      autoHideDuration={4000}
      onClose={() => setLibrarySuccessSnackbarOpen(false)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert onClose={() => setLibrarySuccessSnackbarOpen(false)} severity="success" variant="filled">
        Added to library
      </Alert>
    </Snackbar>
    </>
  )
}