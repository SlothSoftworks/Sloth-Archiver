import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  IconButton,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import UndoIcon from '@mui/icons-material/Undo';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import { convertYYYYMMDDStringToDate } from '../../utils/utils.ts';

// Kept local rather than imported from electron-api.d.ts -- matches how
// every other library data shape in this app (LibraryScreen.tsx's own
// LibraryChannel/LibraryVideoMetadata) is defined per-file rather than
// shared, since that .d.ts file's types aren't exported from a module other
// files can import from anyway.
type PlaylistSummary = {
  playlistId: string;
  title: string | null;
  uploader: string | null;
  entryCount: number;
  addedEpoch: number;
  lastRefreshedEpoch: number | null;
  hasPreviousMetadata: boolean;
};

type PlaylistEntry = {
  videoId: string;
  title: string | null;
  url: string;
  thumbnailUrl: string | null;
  uploadDate: string | null;
};

type PlaylistSnapshot = {
  playlistId: string;
  title: string | null;
  uploader: string | null;
  originalUrl: string | null;
  addedEpoch: number;
  lastRefreshedEpoch: number | null;
  entries: PlaylistEntry[];
  localFiles: Record<string, string | null>;
  hasPreviousMetadata: boolean;
  previousMetadataSavedEpoch: number | null;
};

// Epoch folder names/timestamps are Date.now() ms values -- same formatter
// LibraryVideoDetail.tsx's own formatEpochLabel uses, kept as a separate
// copy here rather than shared for the same reason that file gives (no other
// coupling between these components).
function formatEpochLabel(epoch: number): string {
  return new Date(epoch).toLocaleString();
}

// Deliberately minimal for this first version -- a plain list and a plain
// detail view, no extra polish (sorting/searching/filtering, bulk actions on
// entries, etc). The user's own framing: this gets refined in a later pass
// once the reconciliation logic underneath it has been used for a while.
export default function PlaylistsSection() {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSnapshot | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<{ added: number; removed: number; updated: number } | null>(null);

  const loadList = async () => {
    setLoading(true);
    const { playlists } = await window.electronAPI.listPlaylists();
    setPlaylists(playlists);
    setLoading(false);
  };

  useEffect(() => {
    loadList();
  }, []);

  const loadDetail = async (playlistId: string) => {
    setDetailLoading(true);
    const { playlist } = await window.electronAPI.getPlaylist(playlistId);
    setSelectedPlaylist(playlist);
    setDetailLoading(false);
  };

  const handleSelectPlaylist = (playlistId: string) => {
    setSelectedPlaylistId(playlistId);
    setActionError(null);
    loadDetail(playlistId);
  };

  const handleBack = () => {
    setSelectedPlaylistId(null);
    setSelectedPlaylist(null);
    // The list's own hasPreviousMetadata/entryCount can be stale after any
    // refresh/undo done while viewing the detail -- cheap to just reload.
    loadList();
  };

  const handleRefresh = async () => {
    if (!selectedPlaylistId) return;
    setRefreshing(true);
    setActionError(null);
    setRefreshSummary(null);
    const result = await window.electronAPI.refreshPlaylist(selectedPlaylistId);
    if (result.success) {
      setRefreshSummary({ added: result.added || 0, removed: result.removed || 0, updated: result.updated || 0 });
      await loadDetail(selectedPlaylistId);
    } else {
      setActionError(result.message || 'Failed to refresh this playlist.');
    }
    setRefreshing(false);
  };

  const handleUndo = async () => {
    if (!selectedPlaylistId) return;
    setUndoing(true);
    setActionError(null);
    const result = await window.electronAPI.undoPlaylistRefresh(selectedPlaylistId);
    if (result.success) {
      setRefreshSummary(null);
      await loadDetail(selectedPlaylistId);
    } else {
      setActionError(result.message || 'Nothing to undo.');
    }
    setUndoing(false);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (selectedPlaylistId) {
    return (
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <IconButton onClick={handleBack} size="small" aria-label="Back to playlists">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography variant="h6" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            {selectedPlaylist?.title || selectedPlaylistId}
          </Typography>
          {selectedPlaylist?.hasPreviousMetadata &&
            <Tooltip
              title={selectedPlaylist.previousMetadataSavedEpoch
                ? `Revert to the version saved ${formatEpochLabel(selectedPlaylist.previousMetadataSavedEpoch)}`
                : 'Undo the last refresh'}
            >
              <span>
                <Button size="small" startIcon={<UndoIcon />} onClick={handleUndo} disabled={undoing || refreshing}>
                  Undo
                </Button>
              </span>
            </Tooltip>}
          <Tooltip title="Refresh from YouTube">
            <span>
              <Button size="small" variant="contained" startIcon={<RefreshIcon />} onClick={handleRefresh} disabled={refreshing || undoing}>
                Refresh
              </Button>
            </span>
          </Tooltip>
        </Stack>

        {selectedPlaylist?.uploader &&
          <Typography variant="body2" color="text.secondary">{selectedPlaylist.uploader}</Typography>}
        {selectedPlaylist &&
          <Typography variant="caption" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
            Last updated {formatEpochLabel(selectedPlaylist.lastRefreshedEpoch || selectedPlaylist.addedEpoch)}
          </Typography>}

        {actionError &&
          <Typography color="error" variant="body2" sx={{ mb: 2 }}>{actionError}</Typography>}

        {detailLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <List dense>
            {selectedPlaylist?.entries.map((entry) => {
              const videoDir = selectedPlaylist.localFiles[entry.videoId];
              return (
                <ListItem
                  key={entry.videoId}
                  secondaryAction={videoDir &&
                    <Tooltip title="Go to library">
                      <IconButton size="small" component={RouterLink} to={`/library/video/${entry.videoId}`} aria-label="Go to library">
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>}
                >
                  <ListItemAvatar>
                    <Avatar variant="rounded" src={entry.thumbnailUrl || undefined} sx={{ width: 64, height: 36, mr: 1 }} />
                  </ListItemAvatar>
                  <ListItemText
                    primary={entry.title || <em>Video unavailable (removed or private on YouTube)</em>}
                    secondary={entry.uploadDate ? convertYYYYMMDDStringToDate(entry.uploadDate) || entry.uploadDate : null}
                    slotProps={{ primary: { noWrap: true } }}
                  />
                </ListItem>
              );
            })}
          </List>
        )}

        <Snackbar
          open={!!refreshSummary}
          autoHideDuration={6000}
          onClose={() => setRefreshSummary(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            onClose={() => setRefreshSummary(null)}
            severity="success"
            variant="filled"
            action={
              <Button color="inherit" size="small" onClick={handleUndo} disabled={undoing}>
                Undo
              </Button>
            }
          >
            {refreshSummary && `Refreshed: ${refreshSummary.added} added, ${refreshSummary.removed} removed, ${refreshSummary.updated} updated.`}
          </Alert>
        </Snackbar>
      </Box>
    );
  }

  if (playlists.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', mt: 6 }}>
        <PlaylistPlayIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
        <Typography variant="h6" gutterBottom>No playlists saved yet</Typography>
        <Typography variant="body2" color="text.secondary">
          Paste a playlist link into Bulk Add to start archiving one.
        </Typography>
      </Box>
    );
  }

  return (
    <Stack spacing={1.5}>
      {playlists.map((playlist) => (
        <Card key={playlist.playlistId} variant="outlined">
          <CardActionArea onClick={() => handleSelectPlaylist(playlist.playlistId)} sx={{ p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body1" noWrap>{playlist.title || playlist.playlistId}</Typography>
                {playlist.uploader &&
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{playlist.uploader}</Typography>}
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                  Last updated {formatEpochLabel(playlist.lastRefreshedEpoch || playlist.addedEpoch)}
                </Typography>
              </Box>
              <Chip size="small" label={`${playlist.entryCount} videos`} sx={{ flexShrink: 0 }} />
            </Stack>
          </CardActionArea>
        </Card>
      ))}
    </Stack>
  );
}
