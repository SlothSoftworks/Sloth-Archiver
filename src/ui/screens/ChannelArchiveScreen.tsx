import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { estimateDownloadBytes, formatBytesApprox, safeRemoteImageUrl } from '../../utils/utils.ts';
import ChannelVideoTable, { type ChannelVideoTableRow } from '../components/ChannelVideoTable';
import { QUALITY_TIERS, qualityTierLabel } from '../components/BulkAddDialog';
import { useChannelArchiveStatus, useChannelArchiveView, type ChannelScanStatus } from '../hooks/useChannelArchive.tsx';
import { useLibraryTags } from '../hooks/useLibraryTags.tsx';
import type { ArchiveBacklogAddJobResult } from '../../types/electron-api';

const BATCH_SIZE_PRESETS = [10, 20, 30, 40, 50];
const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 500;
const NO_SELECTION: ReadonlySet<string> = new Set();
const TABLE_MIN_HEIGHT = 360;
const STACKED_TABLE_HEIGHT = 480;

export function scanProgressMessage(scan: Pick<ChannelScanStatus, 'status' | 'found' | 'total'>): string {
  if (scan.status === 'resolving') return 'Looking up the channel…';
  if (scan.status === 'counting') return 'Counting videos…';
  // The total is the channel's public count, which leaves out members-only
  // videos the listing does include: once past it, it only misleads.
  if (scan.total === null || scan.found > scan.total) return `Fetched ${scan.found} videos`;
  return `Fetched ${scan.found} of ~${scan.total} videos`;
}

function describeScanError(scan: ChannelScanStatus): string {
  if (scan.errorKind === 'botBlock') {
    return 'YouTube asked to confirm you are not a bot. Add cookies from a signed-in account in Options, or wait a while, then try again.';
  }
  if (scan.errorKind === 'rateLimit') {
    return 'YouTube is limiting requests right now. Wait a while, or add cookies in Options, then try again.';
  }
  return scan.message || 'The channel could not be read.';
}

function describeAddRefusal(result: Extract<ArchiveBacklogAddJobResult, { success: false }>): string {
  switch (result.reason) {
    case 'noLibraryDir':
      return 'Choose a library folder in Options before archiving a channel.';
    case 'invalidTag':
      return 'The chosen sublibrary no longer exists. Pick another one and try again.';
    case 'tooManyItems':
      return 'That is more videos than the backlog can hold at once. Add them in smaller groups.';
    case 'noValidItems':
      return 'None of the chosen videos could be added.';
    case 'ioError':
      return `The backlog could not be saved: ${result.message || 'unknown error'}`;
    default:
      return 'The videos could not be added to the backlog.';
  }
}

// Remote image straight from YouTube's metadata, so it goes through the
// same guard as every other remote thumbnail. MUI falls back to the child
// (the channel's initial) when there is no URL or the image fails to load.
function ChannelAvatar({ avatarUrl, title, size = 40 }: { avatarUrl: string | null | undefined; title: string; size?: number }) {
  return (
    <Avatar src={safeRemoteImageUrl(avatarUrl)} alt="" sx={{ width: size, height: size, flexShrink: 0 }}>
      {title.trim().charAt(0).toUpperCase() || '?'}
    </Avatar>
  );
}

function FullViewMessage({ children }: { children: ReactNode }) {
  return (
    <Stack spacing={2} alignItems="center" justifyContent="center" sx={{ flex: 1, textAlign: 'center', px: 3 }}>
      {children}
    </Stack>
  );
}

export default function ChannelArchiveScreen() {
  const navigate = useNavigate();
  const { scan, counts, backlogState } = useChannelArchiveStatus();
  const view = useChannelArchiveView();
  const { libraryTags } = useLibraryTags();

  const [availableSelection, setAvailableSelection] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [queueSelection, setQueueSelection] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [customBatchSize, setCustomBatchSize] = useState(() => !BATCH_SIZE_PRESETS.includes(view.batchSize));
  const [batchSizeText, setBatchSizeText] = useState(String(view.batchSize));
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [libraryMismatch, setLibraryMismatch] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ count: number; channelTitle: string } | null>(null);
  const [dateNoticeOpen, setDateNoticeOpen] = useState(true);

  const { entries, queueIds, inLibraryIds } = view;
  const availableRows = useMemo<ChannelVideoTableRow[]>(() => {
    const queued = new Set(queueIds);
    return entries.filter((entry) => !queued.has(entry.videoId)).map((entry) => ({
      id: entry.videoId,
      title: entry.title || entry.videoId,
      approxTimestamp: entry.approxTimestamp,
      durationSeconds: entry.durationSeconds,
      disabledReason: inLibraryIds.has(entry.videoId) ? 'In library' : undefined,
      badges: entry.membersOnly ? ['Members only'] : undefined,
    }));
  }, [entries, queueIds, inLibraryIds]);
  const queueRows = useMemo<ChannelVideoTableRow[]>(() => {
    const byId = new Map(entries.map((entry) => [entry.videoId, entry]));
    return queueIds.flatMap((videoId) => {
      const entry = byId.get(videoId);
      return entry ? [{
        id: videoId,
        title: entry.title || videoId,
        approxTimestamp: entry.approxTimestamp,
        badges: entry.membersOnly ? ['Members only'] : undefined,
      }] : [];
    });
  }, [entries, queueIds]);

  // Over the videos chosen to be added, at the chosen quality.
  const sizeEstimate = useMemo(() => {
    if (!view.download || queueIds.length === 0) return null;
    const durationById = new Map(entries.map((entry) => [entry.videoId, entry.durationSeconds]));
    return estimateDownloadBytes(queueIds.map((videoId) => durationById.get(videoId)), view.targetResolution);
  }, [view.download, view.targetResolution, queueIds, entries]);

  const leave = () => {
    view.resetScan();
    navigate('/');
  };

  // Relaunching the app, or a stray link, lands here with nothing scanned.
  if (scan.status === 'idle' && entries.length === 0) {
    return <Navigate to="/" replace />;
  }

  if (scan.status === 'resolving' || scan.status === 'counting' || scan.status === 'listing') {
    return (
      <FullViewMessage>
        <CircularProgress />
        <Typography variant="body1" role="status">{scanProgressMessage(scan)}</Typography>
        <Button onClick={leave}>Cancel</Button>
      </FullViewMessage>
    );
  }

  if (scan.status === 'error' || scan.status === 'cancelled') {
    const { scanUrl } = view;
    return (
      <FullViewMessage>
        <Typography variant="h6">{scan.status === 'cancelled' ? 'Scan cancelled' : 'The channel could not be scanned'}</Typography>
        {scan.status === 'error' && <Alert severity="error" sx={{ maxWidth: 560, textAlign: 'left' }}>{describeScanError(scan)}</Alert>}
        <Stack direction="row" spacing={1}>
          {scanUrl && <Button variant="contained" onClick={() => { view.beginScan(scanUrl); }}>Try again</Button>}
          <Button onClick={leave}>Back</Button>
        </Stack>
      </FullViewMessage>
    );
  }

  const channelTitle = view.channel?.title || 'this channel';

  if (started) {
    return (
      <FullViewMessage>
        <ChannelAvatar avatarUrl={view.channel?.avatarUrl} title={started.channelTitle} size={64} />
        <Typography variant="h6">
          {started.count === 0
            ? 'Those videos were already waiting in the backlog.'
            : `Archiving ${started.count} ${started.count === 1 ? 'video' : 'videos'} from ${started.channelTitle} has started.`}
        </Typography>
        <Typography variant="body2" color="text.secondary">Progress is in the bulk add panel.</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={leave}>Done</Button>
          <Button onClick={() => setStarted(null)}>Add more from this channel</Button>
        </Stack>
      </FullViewMessage>
    );
  }

  const unprocessed = counts.pending + counts.errors;

  const moveToQueue = () => {
    view.addToQueue([...availableSelection].filter((id) => !inLibraryIds.has(id)));
    setAvailableSelection(NO_SELECTION);
  };

  const removeFromQueue = () => {
    view.removeFromQueue([...queueSelection]);
    setQueueSelection(NO_SELECTION);
  };

  const runSubmit = async (mode: 'append' | 'replace') => {
    setChoiceOpen(false);
    setLibraryMismatch(false);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await view.submit(mode);
      if (!result) return;
      if (result.success) {
        setQueueSelection(NO_SELECTION);
        setAvailableSelection(NO_SELECTION);
        setStarted({ count: result.added, channelTitle });
      } else if (result.reason === 'libraryDirMismatch') {
        setLibraryMismatch(true);
        setChoiceOpen(true);
      } else {
        setSubmitError(describeAddRefusal(result));
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'The videos could not be added to the backlog.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdd = () => {
    if (unprocessed > 0) {
      setLibraryMismatch(backlogState ? !backlogState.libraryDirMatches : false);
      setChoiceOpen(true);
    } else {
      runSubmit('append');
    }
  };

  const applyBatchSizeText = (text: string) => {
    const parsed = Number.parseInt(text, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(BATCH_SIZE_MAX, Math.max(BATCH_SIZE_MIN, parsed)) : view.batchSize;
    view.setBatchSize(clamped);
    setBatchSizeText(String(clamped));
  };

  return (
    <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0, p: 2, overflowY: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ flexShrink: 0 }}>
        <ChannelAvatar avatarUrl={view.channel?.avatarUrl} title={view.channel?.title || ''} />
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography variant="h6" noWrap>{view.channel?.title || 'Channel'}</Typography>
          <Typography variant="body2" color="text.secondary">
            {entries.length} {entries.length === 1 ? 'video' : 'videos'} found
            {inLibraryIds.size > 0 ? ` · ${inLibraryIds.size} already in your library` : ''}
            {view.truncated ? ' · The channel has more videos than can be listed at once; only the newest are shown.' : ''}
          </Typography>
        </Box>
        <Tooltip title="Close">
          <IconButton onClick={leave} aria-label="Close channel view">
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction="row" spacing={2} alignItems="flex-start" useFlexGap sx={{ flexWrap: 'wrap', flexShrink: 0 }}>
        <FormControlLabel
          control={<Switch checked={view.download} onChange={(e) => view.setDownload(e.target.checked)} />}
          label="Also download each video"
        />
        {view.download &&
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel id="channel-archive-quality-label">Quality</InputLabel>
            <Select
              labelId="channel-archive-quality-label"
              label="Quality"
              value={view.targetResolution}
              onChange={(e) => {
                const tier = QUALITY_TIERS.find((t) => t === e.target.value);
                if (tier) view.setTargetResolution(tier);
              }}
            >
              {QUALITY_TIERS.map((tier) => (
                <MenuItem key={tier} value={tier}>{qualityTierLabel(tier)}</MenuItem>
              ))}
            </Select>
          </FormControl>}
        {libraryTags.length > 1 &&
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel id="channel-archive-target-library-label">Add to</InputLabel>
            <Select
              labelId="channel-archive-target-library-label"
              label="Add to"
              value={view.targetLibraryTag}
              onChange={(e) => view.setTargetLibraryTag(e.target.value)}
            >
              {libraryTags.map((tag) => (
                <MenuItem key={tag.folderName} value={tag.folderName}>{tag.tagName}</MenuItem>
              ))}
            </Select>
          </FormControl>}
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel id="channel-archive-batch-size-label">Batch size</InputLabel>
          <Select
            labelId="channel-archive-batch-size-label"
            label="Batch size"
            value={customBatchSize ? 'other' : String(view.batchSize)}
            onChange={(e) => {
              if (e.target.value === 'other') {
                setCustomBatchSize(true);
                setBatchSizeText(String(view.batchSize));
              } else {
                setCustomBatchSize(false);
                view.setBatchSize(Number(e.target.value));
              }
            }}
          >
            {BATCH_SIZE_PRESETS.map((size) => (
              <MenuItem key={size} value={String(size)}>{size}</MenuItem>
            ))}
            <MenuItem value="other">Other…</MenuItem>
          </Select>
          <FormHelperText>Videos handed to the queue at a time</FormHelperText>
        </FormControl>
        {customBatchSize &&
          <TextField
            size="small"
            type="number"
            label="Custom batch size"
            value={batchSizeText}
            onChange={(e) => setBatchSizeText(e.target.value)}
            onBlur={(e) => applyBatchSizeText(e.target.value)}
            helperText={`${BATCH_SIZE_MIN} to ${BATCH_SIZE_MAX}`}
            slotProps={{ htmlInput: { min: BATCH_SIZE_MIN, max: BATCH_SIZE_MAX } }}
            sx={{ width: 150 }}
          />}
      </Stack>

      {dateNoticeOpen &&
        <Alert severity="info" onClose={() => setDateNoticeOpen(false)} sx={{ flexShrink: 0, py: 0, '& .MuiAlert-message': { py: 0.75 } }}>
          Dates here are approximate. YouTube's channel list only gives each video's age ("3 days ago", "4 years ago"), so recent
          videos show a full date and older ones only the month or the year. The date filter works on these approximate dates;
          the exact upload date is saved once a video is added to your library.
        </Alert>}

      {/* Side by side, the tables share whatever height the window has left
          (never less than TABLE_MIN_HEIGHT); stacked, each gets a fixed
          height and the whole view scrolls instead. */}
      <Box sx={{ flex: { xs: 'none', lg: 1 }, minHeight: { lg: TABLE_MIN_HEIGHT }, flexShrink: 0, display: 'flex', flexDirection: { xs: 'column', lg: 'row' }, gap: 2 }}>
        <Box sx={{ flex: { lg: 3 }, height: { xs: STACKED_TABLE_HEIGHT, lg: 'auto' }, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Channel videos</Typography>
          <ChannelVideoTable
            ariaLabel="Channel videos"
            rows={availableRows}
            selectedIds={availableSelection}
            onSelectedIdsChange={setAvailableSelection}
            emptyMessage="Every video from this channel is in the download queue."
            searchPlaceholder="Search titles..."
            toolbarActions={
              <Button variant="outlined" size="small" onClick={moveToQueue} disabled={availableSelection.size === 0}>
                Add to download queue ({availableSelection.size})
              </Button>
            }
          />
        </Box>
        <Box sx={{ flex: { lg: 2 }, height: { xs: STACKED_TABLE_HEIGHT, lg: 'auto' }, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Download queue</Typography>
          <ChannelVideoTable
            compact
            ariaLabel="Download queue"
            rows={queueRows}
            selectedIds={queueSelection}
            onSelectedIdsChange={setQueueSelection}
            emptyMessage="Nothing chosen yet. Select videos on the left and add them here."
            searchPlaceholder="Search the queue..."
            toolbarActions={
              <Button variant="outlined" size="small" color="warning" onClick={removeFromQueue} disabled={queueSelection.size === 0}>
                Remove selected ({queueSelection.size})
              </Button>
            }
          />
        </Box>
      </Box>

      {submitError && <Alert severity="error" onClose={() => setSubmitError(null)}>{submitError}</Alert>}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ flexShrink: 0 }}>
        <Button variant="contained" onClick={handleAdd} disabled={queueIds.length === 0 || submitting} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
          Add {queueIds.length} {queueIds.length === 1 ? 'video' : 'videos'}
        </Button>
        <Box sx={{ minWidth: 0 }}>
          {sizeEstimate &&
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography variant="body2">
                Estimated download size: about {formatBytesApprox(sizeEstimate.bytes)} (rough estimate)
                {sizeEstimate.unknownCount > 0
                  ? ` · ${sizeEstimate.unknownCount} ${sizeEstimate.unknownCount === 1 ? 'video' : 'videos'} with unknown length not included`
                  : ''}
              </Typography>
              <Tooltip title="Worked out from each video's length and a typical bitrate for the chosen quality. It assumes every video is available at that quality (ones that are not will be smaller), and real sizes vary a lot with the content.">
                <InfoOutlinedIcon fontSize="small" color="action" aria-label="About this estimate" tabIndex={0} />
              </Tooltip>
            </Stack>}
          <Typography variant="caption" color="text.secondary" display="block">
            Each video is fetched individually, so large selections take a while; progress is saved and survives closing the app.
          </Typography>
        </Box>
      </Stack>

      <Dialog open={choiceOpen} onClose={() => setChoiceOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>There is already a backlog</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {libraryMismatch
              ? `The existing backlog was queued for a different library folder, so these videos cannot be added to it. Replacing it discards its ${unprocessed} unprocessed ${unprocessed === 1 ? 'video' : 'videos'}.`
              : `${unprocessed} ${unprocessed === 1 ? 'video is' : 'videos are'} still waiting in the backlog. Replacing it discards them.`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setChoiceOpen(false)}>Cancel</Button>
          <Button color="error" onClick={() => runSubmit('replace')}>Replace the backlog</Button>
          {!libraryMismatch &&
            <Button variant="contained" onClick={() => runSubmit('append')}>Add to the existing backlog</Button>}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
