import { useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ReplayIcon from '@mui/icons-material/Replay';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useChannelArchiveStatus } from '../hooks/useChannelArchive.tsx';
import type { ArchiveBacklogItem } from '../../types/electron-api';

const MAX_ERRORS_SHOWN = 100;
const COOKIE_HELPED_ERROR_KINDS = new Set(['ageRestricted', 'loginRequired']);

export function describeBacklogError(item: Pick<ArchiveBacklogItem, 'errorKind' | 'errorMessage'>): string {
  switch (item.errorKind) {
    case 'ageRestricted':
      return 'Age-restricted';
    case 'unavailable':
      return 'Private or unavailable';
    case 'loginRequired':
      return 'Members-only or sign-in required';
    case 'geoBlocked':
      return 'Not available in your region';
    case 'cancelled':
      return 'Cancelled';
    default:
      return item.errorMessage ? `Failed: ${item.errorMessage}` : 'Failed';
  }
}

// What is left of a channel-archive run: shown in the bulk-add panel
// whenever the backlog holds anything, which is also how a run interrupted
// by quitting the app is picked back up.
export default function ArchiveBacklogStatus() {
  const { backlogState, counts, progress, runState, pauseRequested, pauseReason, pauseKind, canResume, resumeBlockedReason, resumeBacklog, pauseBacklog, removeBacklog, retryErrors, dismissErrors } = useChannelArchiveStatus();
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);

  const unprocessed = counts.pending + counts.errors;
  if (!backlogState || unprocessed === 0) return null;

  const channelNames = [...new Set(backlogState.backlog.jobs.map((job) => job.channelTitle || 'Unknown channel'))];
  const channelLabel = channelNames.length > 2 ? `${channelNames.length} channels` : channelNames.join(', ');
  const errorItems = backlogState.backlog.jobs.flatMap((job) => job.items.filter((item) => item.status === 'error'));
  // A bot-check or rate-limit pause already says this in its own reason.
  const pauseReasonCoversCookies = runState === 'paused' && (pauseKind === 'botBlock' || pauseKind === 'rateLimit');
  const cookiesMayHelp = !pauseReasonCoversCookies && errorItems.some((item) => COOKIE_HELPED_ERROR_KINDS.has(item.errorKind || ''));
  const running = runState === 'running';

  let stateLine: string;
  if (running) stateLine = pauseRequested ? 'Pausing after this batch…' : 'Running';
  else if (runState === 'paused') stateLine = pauseReason || 'Paused';
  else stateLine = counts.pending > 0 ? 'Not running' : 'Finished with errors';

  const handleConfirmRemove = async () => {
    setConfirmRemoveOpen(false);
    await removeBacklog();
  };

  return (
    <Box role="region" aria-label="Channel archive backlog" sx={{ mb: 1, p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Typography variant="subtitle2" noWrap title={channelNames.join(', ')}>
        Channel backlog: {channelLabel}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="baseline" justifyContent="space-between">
        <Typography variant="body2">
          {progress.done} of {progress.total} done
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {progress.pending} pending · {counts.errors} {counts.errors === 1 ? 'error' : 'errors'}
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0}
        aria-label="Backlog progress"
        sx={{ mt: 0.5, height: 4, borderRadius: 1 }}
      />
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5 }}>
        {running && <CircularProgress size={12} />}
        <Typography variant="caption" color={runState === 'paused' ? 'warning.main' : 'text.secondary'}>
          {stateLine}
        </Typography>
      </Stack>
      {cookiesMayHelp &&
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          Adding cookies from a signed-in account in Options may let these videos through.
        </Typography>}
      {!running && counts.pending > 0 && !canResume && resumeBlockedReason &&
        <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
          {resumeBlockedReason}
        </Typography>}
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap' }}>
        {!running && counts.pending > 0 &&
          <Tooltip title={canResume ? '' : resumeBlockedReason || ''}>
            <span>
              <Button size="small" color="primary" startIcon={<PlayArrowIcon />} onClick={resumeBacklog} disabled={!canResume}>
                Resume backlog
              </Button>
            </span>
          </Tooltip>}
        {running &&
          <Button size="small" startIcon={<PauseIcon />} onClick={pauseBacklog} disabled={pauseRequested}>
            Pause
          </Button>}
        {counts.errors > 0 &&
          <Button size="small" startIcon={<ReplayIcon />} onClick={() => { retryErrors(); }}>
            Retry errors
          </Button>}
        {counts.errors > 0 &&
          <Button size="small" startIcon={<ClearAllIcon />} onClick={() => { dismissErrors(); }}>
            Dismiss errors
          </Button>}
        <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} onClick={() => setConfirmRemoveOpen(true)}>
          Remove backlog
        </Button>
      </Stack>
      {counts.errors > 0 &&
        <>
          <Button
            size="small"
            onClick={() => setErrorsOpen((open) => !open)}
            endIcon={errorsOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            aria-expanded={errorsOpen}
            sx={{ mt: 0.5 }}
          >
            {errorsOpen ? 'Hide' : 'Show'} videos with errors
          </Button>
          <Collapse in={errorsOpen} unmountOnExit>
            <List dense disablePadding aria-label="Videos with errors" sx={{ maxHeight: 200, overflowY: 'auto' }}>
              {errorItems.slice(0, MAX_ERRORS_SHOWN).map((item) => (
                <ListItem key={item.videoId} disableGutters>
                  <ListItemText
                    primary={item.title || item.videoId}
                    secondary={describeBacklogError(item)}
                    slotProps={{ primary: { noWrap: true, variant: 'body2' }, secondary: { variant: 'caption' } }}
                  />
                </ListItem>
              ))}
            </List>
            {errorItems.length > MAX_ERRORS_SHOWN &&
              <Typography variant="caption" color="text.secondary">
                and {errorItems.length - MAX_ERRORS_SHOWN} more
              </Typography>}
          </Collapse>
        </>}
      <Dialog open={confirmRemoveOpen} onClose={() => setConfirmRemoveOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove backlog?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {unprocessed} unprocessed {unprocessed === 1 ? 'video' : 'videos'} will be discarded. Videos already added to your library are not affected.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRemoveOpen(false)}>Cancel</Button>
          <Button onClick={handleConfirmRemove} color="error" variant="contained">Remove backlog</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
