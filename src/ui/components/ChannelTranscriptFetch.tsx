import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  IconButton, LinearProgress, Snackbar, Stack, Tooltip, Typography,
} from '@mui/material';
import SubtitlesOutlinedIcon from '@mui/icons-material/SubtitlesOutlined';
import CloseIcon from '@mui/icons-material/Close';
import type { LibraryChannel } from '../../types';
import type { TranscriptBatchStatus } from '../../types/electron-api';

// One fetch plus the queue's 2 s gap, roughly.
const SECONDS_PER_TRANSCRIPT = 5;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function summarize(status: TranscriptBatchStatus): { severity: 'success' | 'info' | 'warning'; text: string } {
  const fetched = status.done - status.failed;
  switch (status.stoppedReason) {
    case 'rateLimit':
      return { severity: 'warning', text: `Stopped: YouTube is rate-limiting. ${fetched} fetched -- try the rest later.` };
    case 'botBlock':
      return { severity: 'warning', text: `Stopped: YouTube is asking to confirm you're not a bot. ${fetched} fetched.` };
    case 'cancelled':
      return { severity: 'info', text: `Cancelled. ${fetched} fetched.` };
    default:
      return status.failed === 0
        ? { severity: 'success', text: `${plural(fetched, 'transcript')} fetched` }
        : { severity: 'success', text: `${fetched} fetched, ${status.failed} unavailable` };
  }
}

// The channel header's "Fetch missing transcripts": every latest version
// without one goes to main's transcript queue as a single batch. The batch
// lives in main, so progress is picked back up on mount; it's labelled with
// the channel so another channel's header doesn't claim it.
export default function ChannelTranscriptFetch({ channel, onFinished }: {
  channel: LibraryChannel;
  onFinished: () => void;
}) {
  const [status, setStatus] = useState<TranscriptBatchStatus | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<{ severity: 'success' | 'info' | 'warning' | 'error'; text: string } | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const missing = useMemo(
    () => channel.videos.filter((video) => video.latestEpoch && !video.metadata.transcript && video.metadata.platform !== 'local'),
    [channel.videos],
  );

  useEffect(() => {
    let cancelled = false;
    let updated = false;
    window.electronAPI.getTranscriptBatchStatus().then((current) => {
      if (!cancelled && !updated) setStatus(current);
    });
    window.electronAPI.onTranscriptBatchProgress((update) => {
      updated = true;
      setStatus(update);
      if (update.finished && update.label === channel.channelFolderName) {
        setMessage(summarize(update));
        onFinishedRef.current();
      }
    });
    return () => {
      cancelled = true;
      window.electronAPI.removeTranscriptBatchProgressListener();
    };
  }, [channel.channelFolderName]);

  const handleConfirm = async () => {
    setConfirmOpen(false);
    const result = await window.electronAPI.fetchTranscripts({
      items: missing.map((video) => ({ videoDir: video.videoDir, epoch: video.latestEpoch as string })),
      label: channel.channelFolderName,
    });
    if (!result.success) setMessage({ severity: 'error', text: result.message ?? "Couldn't start fetching transcripts." });
  };

  const running = !!status && !status.finished;
  const ours = running && status.label === channel.channelFolderName;
  const minutes = Math.max(1, Math.round((missing.length * SECONDS_PER_TRANSCRIPT) / 60));

  return (
    <>
      {ours ? (
        <Stack direction="row" spacing={1} alignItems="center" data-testid="transcript-batch-progress">
          <LinearProgress variant="determinate" value={status.total ? (status.done / status.total) * 100 : 0} sx={{ width: 80 }} />
          <Typography variant="caption" color="text.secondary" noWrap>
            Transcripts {status.done} / {status.total}
          </Typography>
          <Tooltip title="Stop fetching transcripts">
            <IconButton size="small" onClick={() => window.electronAPI.cancelTranscriptBatch()} aria-label="Stop fetching transcripts">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      ) : (
        <Tooltip
          title={running ? 'Transcripts for another channel are being fetched'
            : missing.length === 0 ? 'Every video here has a transcript'
              : `Fetch missing transcripts (${missing.length})`}
        >
          <span>
            <IconButton
              size="small"
              onClick={() => setConfirmOpen(true)}
              disabled={running || missing.length === 0}
              aria-label="Fetch missing transcripts"
            >
              {running ? <CircularProgress size={18} /> : <SubtitlesOutlinedIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Fetch {plural(missing.length, 'missing transcript')}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {plural(missing.length, 'video')} in {channel.displayName} {missing.length === 1 ? 'has' : 'have'} no transcript yet.
            They're fetched one at a time with a short pause between each, so this takes about {plural(minutes, 'minute')}.
            You can keep using the app meanwhile. Videos that have no transcript are skipped.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleConfirm}>Fetch</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!message}
        autoHideDuration={6000}
        onClose={() => setMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setMessage(null)} severity={message?.severity ?? 'success'} variant="filled">
          {message?.text}
        </Alert>
      </Snackbar>
    </>
  );
}
