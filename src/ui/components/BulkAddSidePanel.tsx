import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import ReplayIcon from '@mui/icons-material/Replay';
import StopIcon from '@mui/icons-material/Stop';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CancelIcon from '@mui/icons-material/Cancel';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { getRetryStage, useBulkAddQueue, type BulkAddItem, type BulkAddStatus } from '../hooks/useBulkAddQueue.tsx';
import BulkAddDialog from './BulkAddDialog';

const STATUS_COLOR: Record<BulkAddStatus, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  pending: 'default',
  fetching: 'info',
  downloading: 'info',
  done: 'success',
  skipped: 'warning',
  failed: 'error',
  cancelled: 'warning',
};

const STATUS_LABEL: Record<BulkAddStatus, string> = {
  pending: 'Pending',
  fetching: 'Fetching...',
  downloading: 'Downloading...',
  done: 'Done',
  skipped: 'Already in library',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// Badge reflects however many items are still pending/in-flight, not the whole list.
export function BulkAddToggleButton() {
  const { items, panelOpen, setPanelOpen } = useBulkAddQueue();
  const activeCount = items.filter((it) => it.status === 'pending' || it.status === 'fetching' || it.status === 'downloading').length;
  return (
    <Tooltip title="Bulk add">
      <IconButton size="small" onClick={() => setPanelOpen(!panelOpen)} aria-label="Bulk add">
        <Badge badgeContent={activeCount} color="info" max={99}>
          <PlaylistAddIcon />
        </Badge>
      </IconButton>
    </Tooltip>
  );
}

// Displays postprocess progress once it's actually progressing, else falls back
// to the raw download percentage.
function BulkAddProgressBar({ downloadProgress, postprocessProgress }: { downloadProgress: number; postprocessProgress: number }) {
  const displayValue = postprocessProgress > 0 ? postprocessProgress : downloadProgress;
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }}>
      <LinearProgress
        variant="buffer"
        value={postprocessProgress}
        valueBuffer={downloadProgress}
        sx={{ flexGrow: 1, height: 6, borderRadius: 1 }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 30, textAlign: 'right' }}>
        {Math.round(displayValue)}%
      </Typography>
    </Stack>
  );
}

function BulkAddListItem({ item, stopping, onRetry, onRemove, onCancel }: { item: BulkAddItem; stopping: boolean; onRetry: () => void; onRemove: () => void; onCancel: () => void }) {
  const isActive = item.status === 'fetching' || item.status === 'downloading';
  const showDelete = item.status !== 'done' && item.status !== 'cancelled';
  const retryLabel = getRetryStage(item) === 'download' ? 'Retry download' : 'Retry';
  return (
    <ListItem
      alignItems="flex-start"
      sx={{ minHeight: 72, py: 1 }}
      secondaryAction={
        <Stack direction="row" spacing={0.5}>
          {item.status === 'done' && item.videoId &&
            <Tooltip title="Go to library">
              <IconButton
                size="small"
                component={RouterLink}
                to={`/library/video/${item.videoId}`}
                aria-label="Go to library"
              >
                <OpenInNewIcon fontSize="small" />
              </IconButton>
            </Tooltip>}
          {item.status === 'failed' &&
            <Tooltip title={retryLabel}>
              <IconButton size="small" onClick={onRetry} aria-label={retryLabel}>
                <ReplayIcon fontSize="small" />
              </IconButton>
            </Tooltip>}
          {item.status === 'downloading' &&
            <Tooltip title="Cancel this download">
              <IconButton size="small" onClick={onCancel} aria-label="Cancel this download">
                <CancelIcon fontSize="small" />
              </IconButton>
            </Tooltip>}
          {showDelete &&
            <Tooltip title="Remove from queue">
              <span>
                <IconButton size="small" onClick={onRemove} disabled={isActive} aria-label="Remove from queue">
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>}
        </Stack>
      }
    >
      <Box
        component={item.thumbnailUrl ? 'img' : 'div'}
        src={item.thumbnailUrl}
        sx={{
          width: 64,
          height: 36,
          borderRadius: 1,
          mr: 1.5,
          mt: 0.5,
          flexShrink: 0,
          backgroundColor: 'grey.800',
          objectFit: 'cover',
        }}
      />
      <ListItemText
        primary={item.title || item.sourceUrl}
        secondary={
          <>
            <Chip
              size="small"
              color={STATUS_COLOR[item.status]}
              label={STATUS_LABEL[item.status]}
              icon={isActive ? <CircularProgress size={14} /> : undefined}
              sx={{ mt: 0.5 }}
            />
            {item.status === 'downloading' &&
              <BulkAddProgressBar
                downloadProgress={item.downloadProgress ?? 0}
                postprocessProgress={item.postprocessProgress ?? 0}
              />}
            {item.isRetrying &&
              <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
                Retrying after a download error...
              </Typography>}
            {item.error && <Typography variant="caption" color="error" display="block" sx={{ mt: 0.5 }}>{item.error}</Typography>}
            {stopping &&
              <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
                Finishing this item, then stopping
              </Typography>}
          </>
        }
        slotProps={{ primary: { noWrap: true } }}
        sx={{ pr: 8 }}
      />
    </ListItem>
  );
}

export default function BulkAddSidePanel() {
  const { items, isRunning, stopRequested, panelOpen, setPanelOpen, stop, resume, cancelAllPending, cancelItem, retryItem, removeItem, clearFinished } = useBulkAddQueue();
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasFinished = items.some((it) => it.status === 'done' || it.status === 'skipped' || it.status === 'cancelled');
  // Only meaningful once stopped -- while running, 'pending' just means "not picked up yet."
  const hasStoppedPending = !isRunning && items.some((it) => it.status === 'pending');

  return (
    <>
      <Drawer
        anchor="right"
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        sx={{ '& .MuiDrawer-paper': { width: 400, p: 2 } }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6">Bulk add</Typography>
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="Add a playlist or list of links">
              <IconButton size="small" onClick={() => setDialogOpen(true)} aria-label="Add a playlist or list of links">
                <AddIcon />
              </IconButton>
            </Tooltip>
            <IconButton size="small" onClick={() => setPanelOpen(false)} aria-label="Close panel">
              <CloseIcon />
            </IconButton>
          </Stack>
        </Stack>
        <Divider sx={{ mb: 1 }} />
        <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
          {isRunning &&
            <Button
              size="small"
              color="error"
              startIcon={stopRequested ? <CircularProgress size={14} color="inherit" /> : <StopIcon />}
              onClick={stop}
              disabled={stopRequested}
            >
              {stopRequested ? 'Stopping after this item...' : 'Stop after current item'}
            </Button>}
          {hasStoppedPending &&
            <Button size="small" color="primary" startIcon={<PlayArrowIcon />} onClick={resume}>
              Resume
            </Button>}
          {hasStoppedPending &&
            <Button size="small" color="warning" startIcon={<CancelIcon />} onClick={cancelAllPending}>
              Cancel all pending
            </Button>}
          {hasFinished &&
            <Button size="small" startIcon={<ClearAllIcon />} onClick={clearFinished}>
              Clear done
            </Button>}
        </Stack>
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing queued yet -- hit the + button to add a playlist or a list of links.
          </Typography>
        ) : (
          <Box sx={{ overflowY: 'auto' }}>
            <List dense disablePadding>
              {items.map((item) => (
                <BulkAddListItem
                  key={item.id}
                  item={item}
                  stopping={stopRequested && (item.status === 'fetching' || item.status === 'downloading')}
                  onRetry={() => retryItem(item.id)}
                  onRemove={() => removeItem(item.id)}
                  onCancel={() => cancelItem(item.id)}
                />
              ))}
            </List>
          </Box>
        )}
      </Drawer>
      <BulkAddDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
