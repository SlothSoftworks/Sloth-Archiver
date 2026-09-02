import { useEffect } from 'react';
import {
  Backdrop,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { useYtdlpUpdater, IN_PROGRESS_STAGES } from '../hooks/useYtdlpUpdater';

export default function YtdlpUpdateDialog() {
  const { updateAvailable, currentVersion, latestVersion, stage, stageLabel, updateError, verificationFailure, checkForUpdate, startUpdate, quit } = useYtdlpUpdater();

  useEffect(() => {
    checkForUpdate();
    // Only ever check once, automatically, on launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // startUpdate() sets stage to 'checking' synchronously before the IPC call
  // even starts, so `stage` alone is enough to know we're mid-update -- no
  // separate "in flight" flag needed.
  const isWorking = IN_PROGRESS_STAGES.has(stage);

  // Once the user has chosen to update, the choice dialog steps aside for the
  // full-view overlay below -- there's nothing left to choose until it either
  // finishes (back to normal, no further prompt needed) or fails (offering
  // Retry/Quit in the overlay itself).
  const choiceDialogOpen = updateAvailable && !isWorking && !updateError;
  const overlayOpen = isWorking || !!updateError;

  return (
    <>
      {/* No onClose handler on purpose: yt-dlp is a required dependency, so the
          only ways out of this dialog are the two explicit buttons below --
          clicking the backdrop or pressing Escape must not silently continue
          with a stale version. */}
      <Dialog open={choiceDialogOpen} disableEscapeKeyDown>
        <DialogTitle>yt-dlp update available</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            A newer version of yt-dlp is available ({currentVersion} → {latestVersion}). Updating downloads and
            verifies yt-dlp's own signed release build -- this only takes a few seconds.
          </DialogContentText>
          <DialogContentText color="error">
            yt-dlp is a required dependency -- if you cancel, the app will close.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={quit} color="error">Cancel</Button>
          <Button onClick={() => startUpdate()} variant="contained">Update</Button>
        </DialogActions>
      </Dialog>

      <Backdrop open={overlayOpen} sx={{ color: '#fff', zIndex: (theme) => theme.zIndex.modal + 1, flexDirection: 'column' }}>
        {isWorking &&
          <Stack spacing={2} alignItems="center">
            <CircularProgress color="inherit" />
            <Typography variant="body1">{stageLabel}</Typography>
          </Stack>}
        {updateError && !isWorking &&
          <Stack spacing={2} alignItems="center" sx={{ maxWidth: 480, textAlign: 'center', px: 3 }}>
            <Typography variant="h6">Update failed</Typography>
            <Typography variant="body2">{updateError}</Typography>
            {verificationFailure &&
              <Typography variant="body2" sx={{ color: 'warning.main' }}>
                This looks like a problem with yt-dlp's own release download, not with this app -- the downloaded
                file didn't match yt-dlp's published checksum/signature. This is usually a corrupted download, so
                retrying often fixes it; if it keeps happening, it may be worth checking yt-dlp's official release
                page directly before retrying again.
              </Typography>}
            <Typography variant="body2" color="error">
              yt-dlp is a required dependency -- if you quit instead of retrying, the app will close.
            </Typography>
            <Box>
              <Stack direction="row" spacing={2}>
                <Button onClick={quit} color="error" variant="outlined">Quit</Button>
                {/* Every step of the update this dialog just ran gets logged
                    there, so this is the one place a failure here is
                    actually diagnosable without leaving the app. */}
                <Button onClick={() => window.electronAPI.openErrorLog()} variant="outlined">Open error log</Button>
                <Button onClick={() => startUpdate()} variant="contained">Retry</Button>
              </Stack>
            </Box>
          </Stack>}
      </Backdrop>
    </>
  );
}
