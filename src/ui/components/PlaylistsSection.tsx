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
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
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
import LinkIcon from '@mui/icons-material/Link';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { convertYYYYMMDDStringToDate, buildAppVideoUrl, formatEpochLabel } from '../../utils/utils.ts';
import LibrarySearchBar from './LibrarySearchBar';
import { useLibrarySearch } from '../hooks/useLibrarySearch.tsx';
import type { PlaylistSummary, PlaylistSnapshot } from '../../types';

// Mirrors library.mjs's own CURRENT_PLAYLIST_SCHEMA_VERSION (main process
// and renderer never cross-import in this codebase).
const CURRENT_PLAYLIST_SCHEMA_VERSION = 1;

// Prefers the live first-entry thumbnail over the locally-cached fallback
// (ensurePlaylistThumbnail, main.mjs), which only matters once there's no
// live one to show (an empty playlist, or a dead first entry).
function playlistThumbnailSrc(thumbnailUrl: string | null | undefined, thumbnailPath: string | null | undefined): string | undefined {
  if (thumbnailUrl) return thumbnailUrl;
  if (thumbnailPath) return buildAppVideoUrl(thumbnailPath);
  return undefined;
}

// Deliberately minimal for this first version -- a plain list and detail
// view, no extra polish beyond title search (sorting, bulk actions, etc).
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
  const [linkCopiedSnackbarOpen, setLinkCopiedSnackbarOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { query, setQuery, isSearching, filtered: filteredPlaylists, clear } = useLibrarySearch(
    playlists,
    (playlist) => playlist.title || playlist.playlistId,
  );

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

  const handleCopyLink = async () => {
    if (!selectedPlaylist?.originalUrl) return;
    await navigator.clipboard.writeText(selectedPlaylist.originalUrl);
    setLinkCopiedSnackbarOpen(true);
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

  // Only ever deletes the playlist's own saved snapshot (see
  // deletePlaylistSnapshot, library.mjs) -- the videos it references stay in
  // the library untouched, hence the notice in the confirm dialog rather
  // than the "videoDeleted"-style branching the single-video delete flow has.
  const handleDeletePlaylist = async () => {
    if (!selectedPlaylistId) return;
    setDeleting(true);
    setActionError(null);
    const result = await window.electronAPI.deletePlaylist(selectedPlaylistId);
    setDeleting(false);
    setDeleteDialogOpen(false);
    if (result.success) {
      handleBack();
    } else {
      setActionError(result.message || 'Failed to delete this playlist.');
    }
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
          <Avatar
            variant="rounded"
            src={playlistThumbnailSrc(selectedPlaylist?.entries[0]?.thumbnailUrl, selectedPlaylist?.thumbnailPath)}
            sx={{ width: 48, height: 27, flexShrink: 0 }}
          >
            <PlaylistPlayIcon fontSize="small" />
          </Avatar>
          <Tooltip title="Copy link">
            <span>
              <IconButton size="small" onClick={handleCopyLink} disabled={!selectedPlaylist?.originalUrl} aria-label="Copy link">
                <LinkIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Typography variant="h6" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            {selectedPlaylist?.title || selectedPlaylistId}
          </Typography>
          {selectedPlaylist && (selectedPlaylist.schemaVersion ?? 0) < CURRENT_PLAYLIST_SCHEMA_VERSION &&
            <Tooltip title="This playlist's saved data predates newer features -- Refresh from YouTube to pick them up">
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                icon={<WarningAmberIcon fontSize="small" />}
                label="Outdated data"
                sx={{ flexShrink: 0 }}
              />
            </Tooltip>}
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
          <Tooltip title="Delete this playlist">
            <IconButton size="small" color="error" onClick={() => setDeleteDialogOpen(true)} aria-label="Delete playlist">
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
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
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography component="span" noWrap>
                          {entry.title || <em>Unknown title</em>}
                        </Typography>
                        {entry.unavailable &&
                          <Chip size="small" color="warning" variant="outlined" label="Not on YouTube" sx={{ flexShrink: 0 }} />}
                      </Stack>
                    }
                    secondary={entry.uploadDate ? convertYYYYMMDDStringToDate(entry.uploadDate) || entry.uploadDate : null}
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

        <Snackbar
          open={linkCopiedSnackbarOpen}
          autoHideDuration={3000}
          onClose={() => setLinkCopiedSnackbarOpen(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert onClose={() => setLinkCopiedSnackbarOpen(false)} severity="success" variant="filled">
            Link copied
          </Alert>
        </Snackbar>

        <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
          <DialogTitle>Delete this playlist?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              This only removes the playlist's saved entry from your library, not any of its
              videos -- anything you've already downloaded stays exactly where it is.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>Cancel</Button>
            <Button onClick={handleDeletePlaylist} color="error" variant="contained" disabled={deleting}>
              {deleting ? <CircularProgress size={20} /> : 'Delete'}
            </Button>
          </DialogActions>
        </Dialog>
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
      <LibrarySearchBar value={query} onChange={setQuery} onClear={clear} placeholder="Search playlists..." />
      {isSearching && filteredPlaylists.length === 0 &&
        <Typography variant="body2" color="text.secondary">No playlists match "{query}".</Typography>}
      {filteredPlaylists.map((playlist) => (
        <Card key={playlist.playlistId} variant="outlined">
          <CardActionArea onClick={() => handleSelectPlaylist(playlist.playlistId)} sx={{ p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
              <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minWidth: 0 }}>
                <Avatar
                  variant="rounded"
                  src={playlistThumbnailSrc(playlist.thumbnailUrl, playlist.thumbnailPath)}
                  sx={{ width: 48, height: 27, flexShrink: 0 }}
                >
                  <PlaylistPlayIcon fontSize="small" />
                </Avatar>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body1" noWrap>{playlist.title || playlist.playlistId}</Typography>
                  {playlist.uploader &&
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{playlist.uploader}</Typography>}
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                    Last updated {formatEpochLabel(playlist.lastRefreshedEpoch || playlist.addedEpoch)}
                  </Typography>
                </Box>
              </Stack>
              <Chip size="small" label={`${playlist.entryCount} videos`} sx={{ flexShrink: 0 }} />
            </Stack>
          </CardActionArea>
        </Card>
      ))}
    </Stack>
  );
}
