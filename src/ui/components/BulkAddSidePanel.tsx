import { useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
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
import { getRetryStage, useBulkAddQueue, type BulkAddItem, type BulkAddStatus } from '../hooks/useBulkAddQueue.tsx';
import BulkAddDialog from './BulkAddDialog';

const STATUS_COLOR: Record<BulkAddStatus, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  pending: 'default',
  fetching: 'info',
  downloading: 'info',
  done: 'success',
  skipped: 'warning',
  failed: 'error',
};

const STATUS_LABEL: Record<BulkAddStatus, string> = {
  pending: 'Pending',
  fetching: 'Fetching...',
  downloading: 'Downloading...',
  done: 'Done',
  skipped: 'Already in library',
  failed: 'Failed',
};

// Small header button, meant to live in MainPage.tsx's tab bar row so it's
// reachable regardless of which tab is active -- badge reflects however many
// items are still pending/in-flight, not the whole list.
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

function BulkAddListItem({ item, onRetry, onRemove }: { item: BulkAddItem; onRetry: () => void; onRemove: () => void }) {
  const isActive = item.status === 'fetching' || item.status === 'downloading';
  // Once an item is done there's nothing left to cancel or clean up
  // individually -- "Clear done" (below) is the affordance for that now, so
  // a per-item delete button that would otherwise sit there doing nothing
  // useful is just hidden instead.
  const showDelete = item.status !== 'done';
  const retryLabel = getRetryStage(item) === 'download' ? 'Retry download' : 'Retry';
  return (
    <ListItem
      alignItems="flex-start"
      sx={{ minHeight: 72, py: 1 }}
      secondaryAction={
        <Stack direction="row" spacing={0.5}>
          {item.status === 'failed' &&
            <Tooltip title={retryLabel}>
              <IconButton size="small" onClick={onRetry} aria-label={retryLabel}>
                <ReplayIcon fontSize="small" />
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
            {item.error && <Typography variant="caption" color="error" display="block" sx={{ mt: 0.5 }}>{item.error}</Typography>}
          </>
        }
        slotProps={{ primary: { noWrap: true } }}
        sx={{ pr: 8 }}
      />
    </ListItem>
  );
}

export default function BulkAddSidePanel() {
  const { items, isRunning, panelOpen, setPanelOpen, stop, retryItem, removeItem, clearFinished } = useBulkAddQueue();
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasFinished = items.some((it) => it.status === 'done' || it.status === 'skipped');

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
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          {isRunning &&
            <Button size="small" color="error" startIcon={<StopIcon />} onClick={stop}>
              Stop after current item
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
                  onRetry={() => retryItem(item.id)}
                  onRemove={() => removeItem(item.id)}
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
