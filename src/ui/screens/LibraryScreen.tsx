import { useEffect, useMemo, useState } from 'react';
import { useMatch, useNavigate } from 'react-router';
import {
  Alert,
  Avatar,
  Box,
  Card,
  CardActionArea,
  CardMedia,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import FaceRetouchingNaturalIcon from '@mui/icons-material/FaceRetouchingNatural';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { convertYYYYMMDDStringToDate, buildAppVideoUrl, getBestDownloadedQuality, responsiveGridTemplateColumns, thumbnailGridTemplateColumns } from '../../utils/utils.ts';
import LibraryVideoDetail from './LibraryVideoDetail';
import PlaylistsSection, { type PlaylistBulkBar } from '../components/PlaylistsSection';
import LibrarySearchBar from '../components/LibrarySearchBar';
import LibraryBottomBar from '../components/LibraryBottomBar';
import BulkDownloadQualityDialog from '../components/BulkDownloadQualityDialog';
import BulkDeleteConfirmDialog from '../components/BulkDeleteConfirmDialog';
import { useLibrarySearch } from '../hooks/useLibrarySearch.tsx';
import { useBulkAddQueue, type BulkAddEntry } from '../hooks/useBulkAddQueue.tsx';
import type { LibraryVideoMetadata } from '../../types';

type LibraryViewMode = 'channel' | 'video';
// Top-level split within the Library tab -- "Videos" is everything this
// screen already did; "Playlists" is the reconciliation-based archive view
// (PlaylistsSection), deliberately its own toggle rather than folded into
// the channel/video LibraryViewMode above. Plain local state, not
// URL-routed, same as the LibraryViewMode toggle below.
type LibrarySection = 'videos' | 'playlists';

type LibraryVideo = {
  videoFolderName: string;
  videoDir: string;
  latestEpoch: string | null;
  metadata: LibraryVideoMetadata;
  epochs: { epoch: string; metadata: LibraryVideoMetadata }[];
  thumbnailPath: string | null;
  clipCount: number;
};

type LibraryChannel = {
  channelFolderName: string;
  displayName: string;
  channelIconPath: string | null;
  videos: LibraryVideo[];
};

// Only the flat by-video list gets a sort control -- the channel view's own
// ordering is alphabetical-by-channel and isn't in scope here.
type SortField = 'title' | 'uploadDate' | 'dateAdded' | 'channel' | 'downloaded' | 'quality';
type SortDirection = 'asc' | 'desc';

const SORT_FIELD_LABELS: Record<SortField, string> = {
  title: 'Title',
  uploadDate: 'Date published',
  dateAdded: 'Date added',
  channel: 'Channel',
  downloaded: 'Downloaded status',
  quality: 'Quality',
};

// "Date added to library" means when the video was first tracked, not when
// its latest version happened to be added -- epochs are already newest-first
// (scanLibrary, library.mjs), so the earliest one is simply the last entry.
function getDateAddedEpoch(video: LibraryVideo): number {
  return video.epochs.length > 0 ? video.epochs[video.epochs.length - 1].metadata.addedEpoch : video.metadata.addedEpoch;
}

// Quality is inherently approximate: a video can have different downloaded
// resolutions across its version history, and an undownloaded video only has
// a list of *available* resolutions, not one real value to sort by. Ranked
// by the same "best downloaded so far" the grid's badge already shows, so
// sorted order matches what's shown on each card. MP3 ranks below any real
// resolution but above "not downloaded" -- still something archived.
function getQualityRank(video: LibraryVideo): number {
  const best = getBestDownloadedQuality(video.epochs);
  if (!best) return -1;
  if (best.resolution === 'MP3') return 0;
  return Number(best.resolution) || 0;
}

function compareFlatVideos(a: { video: LibraryVideo; channelName: string }, b: { video: LibraryVideo; channelName: string }, field: SortField): number {
  switch (field) {
    case 'title':
      return (a.video.metadata.title || a.video.videoFolderName)
        .localeCompare(b.video.metadata.title || b.video.videoFolderName, undefined, { sensitivity: 'base' });
    case 'uploadDate':
      return (a.video.metadata.uploadDate || '').localeCompare(b.video.metadata.uploadDate || '');
    case 'dateAdded':
      return getDateAddedEpoch(a.video) - getDateAddedEpoch(b.video);
    case 'channel':
      return a.channelName.localeCompare(b.channelName, undefined, { sensitivity: 'base' });
    case 'downloaded': {
      const aDownloaded = !!(a.video.metadata.downloadedFilePath || a.video.metadata.downloadedAudioFilePath);
      const bDownloaded = !!(b.video.metadata.downloadedFilePath || b.video.metadata.downloadedAudioFilePath);
      return Number(aDownloaded) - Number(bDownloaded);
    }
    case 'quality':
      return getQualityRank(a.video) - getQualityRank(b.video);
  }
}

export default function LibraryScreen() {
  const [libraryDir, setLibraryDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [channels, setChannels] = useState<LibraryChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<LibraryChannel | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<LibraryVideo | null>(null);
  const [viewMode, setViewMode] = useState<LibraryViewMode>('channel');
  const [librarySection, setLibrarySection] = useState<LibrarySection>('videos');
  const [thumbnailSize, setThumbnailSize] = useState(220); // overwritten by load()
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [selectedVideoDirs, setSelectedVideoDirs] = useState<Set<string>>(new Set());
  const [bulkDownloadDialogOpen, setBulkDownloadDialogOpen] = useState(false);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [bulkDeleteLocalFilesDialogOpen, setBulkDeleteLocalFilesDialogOpen] = useState(false);
  const [bulkDeletingLocalFiles, setBulkDeletingLocalFiles] = useState(false);
  const [bulkDeleteLocalFilesError, setBulkDeleteLocalFilesError] = useState<string | null>(null);
  const [playlistBulkBar, setPlaylistBulkBar] = useState<PlaylistBulkBar | null>(null);
  const deepLinkMatch = useMatch('/library/video/:videoId');
  const navigate = useNavigate();
  const { start } = useBulkAddQueue();

  const load = async () => {
    setLoading(true);
    const [{ libraryDir }, index, { libraryViewMode }, { thumbnailSize }] = await Promise.all([
      window.electronAPI.getLibraryDir(),
      window.electronAPI.getLibraryIndex(),
      window.electronAPI.getLibraryViewMode(),
      window.electronAPI.getThumbnailSize(),
    ]);
    setLibraryDir(libraryDir);
    setChannels(index.channels);
    setViewMode(libraryViewMode);
    setThumbnailSize(thumbnailSize);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // Fire-and-forget, same as every other settings write in this codebase --
  // the local state update below is what the UI reacts to; the write just
  // needs to land before the next app launch reads it back.
  const handleViewModeChange = (mode: LibraryViewMode) => {
    setViewMode(mode);
    window.electronAPI.setLibraryViewMode(mode);
    clearSelection();
  };

  // Local state updates continuously as the slider drags (smooth grid
  // resize); the persisted write only fires once, on release -- see
  // LibraryBottomBar's onChange vs onChangeCommitted split.
  const handleThumbnailSizeChange = (size: number) => {
    setThumbnailSize(size);
  };

  const handleThumbnailSizeCommit = (size: number) => {
    window.electronAPI.setThumbnailSize(size);
  };

  const toggleVideoSelected = (videoDir: string) => {
    setSelectedVideoDirs((prev) => {
      const next = new Set(prev);
      if (next.has(videoDir)) {
        next.delete(videoDir);
      } else {
        next.add(videoDir);
      }
      return next;
    });
  };
  const clearSelection = () => setSelectedVideoDirs(new Set());

  // Flat videoDir -> LibraryVideo lookup over whichever set of videos is
  // currently in view (every channel's videos, so this covers both the flat
  // list and any single channel's grid) -- selection is keyed by videoDir,
  // this is what turns that Set back into the LibraryVideo objects the bulk
  // action handlers/gating need.
  const videoByDir = useMemo(() => {
    const map = new Map<string, LibraryVideo>();
    for (const channel of channels) {
      for (const video of channel.videos) {
        map.set(video.videoDir, video);
      }
    }
    return map;
  }, [channels]);
  const selectedVideos = useMemo(
    () => [...selectedVideoDirs].map((dir) => videoByDir.get(dir)).filter((v): v is LibraryVideo => !!v),
    [selectedVideoDirs, videoByDir],
  );
  // Mixed/all-downloaded selections simply don't offer a download action --
  // no partial/redownload option, per the confirmed bulk-select design.
  const canBulkDownload = selectedVideos.length > 0 && selectedVideos.every((v) => getBestDownloadedQuality(v.epochs) === null);
  // The mirror image of canBulkDownload: "Delete local files" only offers
  // itself when every selected video actually has something downloaded to
  // remove -- a mixed selection hides it entirely (all-or-nothing, same
  // gating style as Download selected), rather than silently skipping the
  // ones with nothing to delete.
  const canDeleteLocalFiles = selectedVideos.length > 0 && selectedVideos.every((v) => getBestDownloadedQuality(v.epochs) !== null);

  const handleConfirmBulkDownload = (targetResolution: string) => {
    const isMp3 = targetResolution.toLowerCase() === 'mp3';
    const entries: BulkAddEntry[] = selectedVideos
      .filter((v) => v.metadata.originalUrl && v.latestEpoch)
      .map((v) => ({
        id: v.videoDir,
        title: v.metadata.title,
        url: v.metadata.originalUrl!,
        videoId: v.metadata.videoId,
        videoDir: v.videoDir,
        epoch: v.latestEpoch!,
        resolution: isMp3 ? 'mp3' : targetResolution,
        kind: isMp3 ? 'audio' : 'video',
      }));
    start(entries, { download: true, targetResolution });
    setBulkDownloadDialogOpen(false);
    clearSelection();
  };

  const handleConfirmBulkDelete = async () => {
    setBulkDeleting(true);
    setBulkDeleteError(null);
    try {
      const { success, results } = await window.electronAPI.deleteLibraryEntries([...selectedVideoDirs]);
      if (!success) {
        const failed = results.filter((r) => !r.success);
        setBulkDeleteError(`${failed.length} of ${results.length} video(s) couldn't be deleted. Try again, or delete them individually.`);
        // Only the failed ones stay selected, so the user can immediately
        // retry just those via the same bottom-bar button.
        setSelectedVideoDirs(new Set(failed.map((r) => r.videoDir)));
      } else {
        setBulkDeleteDialogOpen(false);
        clearSelection();
      }
      // The index already refreshed server-side inside the IPC handler --
      // this just pulls the updated channels list, same pattern as
      // refreshChannelsSilently.
      const index = await window.electronAPI.refreshLibraryIndex();
      handleChannelsUpdated(index.channels);
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleConfirmBulkDeleteLocalFiles = async () => {
    setBulkDeletingLocalFiles(true);
    setBulkDeleteLocalFilesError(null);
    try {
      const { success, results } = await window.electronAPI.deleteLocalFiles([...selectedVideoDirs]);
      if (!success) {
        const failed = results.filter((r) => !r.success);
        setBulkDeleteLocalFilesError(`${failed.length} of ${results.length} video(s) couldn't be updated. Try again, or delete them individually.`);
        setSelectedVideoDirs(new Set(failed.map((r) => r.videoDir)));
      } else {
        setBulkDeleteLocalFilesDialogOpen(false);
        clearSelection();
      }
      const index = await window.electronAPI.refreshLibraryIndex();
      handleChannelsUpdated(index.channels);
    } finally {
      setBulkDeletingLocalFiles(false);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    const index = await window.electronAPI.refreshLibraryIndex();
    setChannels(index.channels);
    setLoading(false);
  };

  // No loading-spinner toggle -- used after a download/delete completes
  // while already viewing a video's detail, where swapping to a spinner
  // would be a jarring regression rather than a background update.
  const refreshChannelsSilently = async () => {
    const index = await window.electronAPI.refreshLibraryIndex();
    setChannels(index.channels);
  };

  // Unlike handleVideoDeleted below, stays on the current channel page
  // rather than bouncing to the root. Updates both the root `channels` list
  // and `selectedChannel` itself -- the prop VideoGrid actually renders
  // from -- so a refreshed icon shows immediately, not after a
  // re-navigation.
  const handleChannelsUpdated = (updatedChannels: LibraryChannel[]) => {
    setChannels(updatedChannels);
    setSelectedChannel((prev) => (prev && updatedChannels.find((c) => c.channelFolderName === prev.channelFolderName)) || prev);
  };

  // Any action that adds or removes a *version* needs this instead of the
  // plain onLibraryChanged/refreshChannelsSilently: the version-selector's
  // options read from the `video` prop's own `epochs` array, so refreshing
  // only the root `channels` list (leaving `selectedVideo` stale) would
  // never grow or shrink that list after adding/deleting a version.
  const handleVersionsChanged = async () => {
    const index = await window.electronAPI.refreshLibraryIndex();
    setChannels(index.channels);
    setSelectedChannel((prev) => (prev && index.channels.find((c) => c.channelFolderName === prev.channelFolderName)) || prev);
    setSelectedVideo((prev) => {
      if (!prev) return prev;
      for (const channel of index.channels) {
        const found = channel.videos.find((v) => v.videoDir === prev.videoDir);
        if (found) return found;
      }
      return prev;
    });
  };

  // Consumes an internal "hyperlink" to a specific video -- the add-success
  // toast (DownloaderScreen) and a finished bulk-add item (BulkAddSidePanel)
  // both navigate to /library/video/:videoId; this turns that into actually
  // landing on the video's detail screen. useMatch, not useParams, since
  // LibraryScreen isn't rendered under a literal
  // <Route path="/library/video/:videoId"> (see App.tsx's single "/*"
  // route), so this reads the param off the current location instead.
  // Always navigates back to /library afterward (replace: true) so this is
  // a one-shot jump, not a redirect that re-triggers on going back.
  const videoIdToOpen = deepLinkMatch?.params.videoId;
  useEffect(() => {
    if (!videoIdToOpen) return;
    (async () => {
      const result = await window.electronAPI.findLibraryVideo(videoIdToOpen);
      if (!result.found || !result.videoDir) {
        setDeepLinkError('This video is no longer in your library.');
        navigate('/library', { replace: true });
        return;
      }
      const index = await window.electronAPI.refreshLibraryIndex();
      setChannels(index.channels);
      const targetChannel = index.channels.find((c) => c.videos.some((v) => v.videoDir === result.videoDir));
      const targetVideo = targetChannel?.videos.find((v) => v.videoDir === result.videoDir);
      if (targetChannel && targetVideo) {
        // The link may have been clicked from inside the Playlists section
        // (which uses this same route) -- without this, librarySection
        // staying 'playlists' would keep rendering that section instead of
        // the video detail below.
        setLibrarySection('videos');
        setSelectedChannel(targetChannel);
        setSelectedVideo(targetVideo);
      } else {
        setDeepLinkError('This video is no longer in your library.');
      }
      navigate('/library', { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoIdToOpen]);

  // Fire-and-forget channel-icon/video-thumbnail fetches (main.mjs) only get
  // picked up on the *next* index refresh -- without this, an already-
  // mounted Library tab would never show a newly-added video's channel icon
  // until the user re-navigated or hit manual refresh. Reuses
  // handleVersionsChanged's deep resync rather than a near-duplicate
  // function -- "re-pull the index and re-sync every stale snapshot" is
  // just as correct here even though this isn't a version change.
  useEffect(() => {
    window.electronAPI.onLibraryBackgroundUpdate(() => { handleVersionsChanged(); });
    return () => window.electronAPI.removeLibraryBackgroundUpdateListener();
  }, []);

  // Resets both selectedChannel and selectedVideo, not just the latter --
  // selectedChannel is a stale snapshot from when the user first navigated
  // into it, and refreshChannelsSilently only updates the root `channels`
  // list, not that snapshot. Without this, deleting a channel's only video
  // left VideoGrid rendering a "ghost" of the deleted entry until the user
  // round-tripped through the channel list.
  const handleVideoDeleted = () => {
    setSelectedVideo(null);
    setSelectedChannel(null);
  };

  const content = loading ? (
    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
      <CircularProgress />
    </Box>
  ) : !libraryDir ? (
    <Box sx={{ textAlign: 'center', mt: 6 }}>
      <Typography variant="h6" gutterBottom>No library folder set</Typography>
      <Typography variant="body2" color="text.secondary">
        Set a library folder in the Options tab to get started.
      </Typography>
    </Box>
  ) : librarySection === 'playlists' ? (
    <PlaylistsSection onBulkBarUpdate={setPlaylistBulkBar} />
  ) : selectedVideo ? (
    <LibraryVideoDetail
      video={selectedVideo}
      onBack={() => setSelectedVideo(null)}
      onLibraryChanged={refreshChannelsSilently}
      onDeleted={handleVideoDeleted}
      onVersionsChanged={handleVersionsChanged}
    />
  ) : selectedChannel ? (
    <VideoGrid
      channel={selectedChannel}
      thumbnailSize={thumbnailSize}
      selectedVideoDirs={selectedVideoDirs}
      onToggleSelect={toggleVideoSelected}
      onBack={() => { setSelectedChannel(null); clearSelection(); }}
      onSelectVideo={setSelectedVideo}
      onChannelsUpdated={handleChannelsUpdated}
    />
  ) : viewMode === 'video' ? (
    <FlatVideoList
      channels={channels}
      libraryDir={libraryDir}
      viewMode={viewMode}
      thumbnailSize={thumbnailSize}
      selectedVideoDirs={selectedVideoDirs}
      onToggleSelect={toggleVideoSelected}
      onViewModeChange={handleViewModeChange}
      onSelectVideo={setSelectedVideo}
      onRefresh={handleRefresh}
    />
  ) : (
    <ChannelList
      channels={channels}
      libraryDir={libraryDir}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      onSelectChannel={(channel) => { setSelectedChannel(channel); clearSelection(); }}
      onRefresh={handleRefresh}
    />
  );

  return (
    <>
      {/* Scrollable region -- everything above the bottom options bar scrolls
          in here; the bar itself (below, outside this Box) stays pinned at
          the bottom of the tab regardless of how much content is above it,
          the same way MainPage's own tab bar stays pinned above
          .tabContainer's scroll region. Requires CustomTabPanel's `fill`
          prop (MainPage.tsx), which leaves its wrapping Box unpadded so the
          bar below can span the tab's full width -- p:3 lives here instead,
          on just this scrollable region, rather than on that shared Box. */}
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, p: 3 }}>
        {/* Only shown at the root level -- hidden while drilled into a
            channel's video grid or a video's own detail. */}
        {!loading && libraryDir && !selectedVideo && !selectedChannel &&
          <ToggleButtonGroup
            value={librarySection}
            exclusive
            size="small"
            onChange={(_e, value: LibrarySection | null) => { if (value) setLibrarySection(value); clearSelection(); }}
            sx={{ mb: 2 }}
          >
            <ToggleButton value="videos">
              <VideoLibraryIcon fontSize="small" sx={{ mr: 0.5 }} />
              Videos
            </ToggleButton>
            <ToggleButton value="playlists">
              <PlaylistPlayIcon fontSize="small" sx={{ mr: 0.5 }} />
              Playlists
            </ToggleButton>
          </ToggleButtonGroup>}
        {content}
      </Box>
      {!loading && libraryDir && librarySection === 'videos' && !selectedVideo && (selectedChannel || viewMode === 'video') &&
        <LibraryBottomBar
          thumbnailSize={thumbnailSize}
          onThumbnailSizeChange={handleThumbnailSizeChange}
          onThumbnailSizeCommit={handleThumbnailSizeCommit}
          selectedCount={selectedVideoDirs.size}
          canBulkDownload={canBulkDownload}
          onDownloadSelected={() => setBulkDownloadDialogOpen(true)}
          canDeleteLocalFiles={canDeleteLocalFiles}
          onDeleteLocalFiles={() => setBulkDeleteLocalFilesDialogOpen(true)}
          onDeleteFromLibrary={() => setBulkDeleteDialogOpen(true)}
        />}
      {!loading && libraryDir && librarySection === 'playlists' && playlistBulkBar &&
        <LibraryBottomBar
          selectedCount={playlistBulkBar.selectedCount}
          canBulkDownload={playlistBulkBar.canBulkDownload}
          onDownloadSelected={playlistBulkBar.onDownloadSelected}
          canDeleteLocalFiles={playlistBulkBar.canDeleteLocalFiles}
          onDeleteLocalFiles={playlistBulkBar.onDeleteLocalFiles}
          onDeleteFromLibrary={playlistBulkBar.onDeleteFromLibrary}
        />}
      <BulkDownloadQualityDialog
        open={bulkDownloadDialogOpen}
        onClose={() => setBulkDownloadDialogOpen(false)}
        videos={selectedVideos.filter((v) => getBestDownloadedQuality(v.epochs) === null)}
        onConfirm={handleConfirmBulkDownload}
      />
      <BulkDeleteConfirmDialog
        open={bulkDeleteDialogOpen}
        title={`Delete ${selectedVideoDirs.size} video${selectedVideoDirs.size === 1 ? '' : 's'}?`}
        description="This deletes the tracked entries, their metadata, and any downloaded files from your library folder. This can't be undone."
        deleting={bulkDeleting}
        error={bulkDeleteError}
        onCancel={() => { setBulkDeleteDialogOpen(false); setBulkDeleteError(null); }}
        onConfirm={handleConfirmBulkDelete}
      />
      <BulkDeleteConfirmDialog
        open={bulkDeleteLocalFilesDialogOpen}
        title={`Delete local files for ${selectedVideoDirs.size} video${selectedVideoDirs.size === 1 ? '' : 's'}?`}
        description="This deletes the downloaded video/audio files for these videos -- across every saved version, not just the latest one. The library entries and their metadata stay, so you can re-download later. To remove just one version's file, open that video's own detail view instead. This can't be undone."
        deleting={bulkDeletingLocalFiles}
        error={bulkDeleteLocalFilesError}
        onCancel={() => { setBulkDeleteLocalFilesDialogOpen(false); setBulkDeleteLocalFilesError(null); }}
        onConfirm={handleConfirmBulkDeleteLocalFiles}
      />
      <Snackbar
        open={!!deepLinkError}
        autoHideDuration={4000}
        onClose={() => setDeepLinkError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setDeepLinkError(null)} severity="error" variant="filled">
          {deepLinkError}
        </Alert>
      </Snackbar>
    </>
  );
}

// Shared root-level header control -- only at the top of the Library tab
// (channel list / flat video list), not inside a channel's grid or the
// detail view, since it toggles the top-level structure, not anything
// channel/video-specific.
function LibraryViewModeToggle({ viewMode, onViewModeChange }: {
  viewMode: LibraryViewMode;
  onViewModeChange: (mode: LibraryViewMode) => void;
}) {
  return (
    <ToggleButtonGroup
      value={viewMode}
      exclusive
      size="small"
      onChange={(_e, value: LibraryViewMode | null) => value && onViewModeChange(value)}
      aria-label="Library view mode"
    >
      <ToggleButton value="channel" aria-label="By channel">
        <Tooltip title="By channel">
          <FolderIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="video" aria-label="By video">
        <Tooltip title="By video">
          <VideoLibraryIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

// Extracted so FlatVideoList (channel-agnostic) can reuse the same card as
// VideoGrid instead of duplicating it. `channelLabel` is only passed by
// FlatVideoList -- VideoGrid's cards already sit under one channel's own
// heading, so repeating the name there would be redundant.
function VideoCard({ video, onSelect, channelLabel, selected, selectionActive, onToggleSelect }: {
  video: LibraryVideo;
  onSelect: (video: LibraryVideo) => void;
  channelLabel?: string;
  selected: boolean;
  selectionActive: boolean;
  onToggleSelect: (videoDir: string) => void;
}) {
  const bestQuality = getBestDownloadedQuality(video.epochs);
  return (
    <Card
      variant="outlined"
      sx={{
        position: 'relative',
        // Real MUI theme token (same one MenuItem/ListItemButton selected
        // states use), not a new palette entry.
        backgroundColor: selected ? 'action.selected' : undefined,
        '&:hover .video-card-checkbox': { opacity: 1 },
      }}
    >
      {/* Sibling of CardActionArea below, not nested inside it -- MUI
          disallows an interactive control inside CardActionArea's own click
          target. Hidden by default, hover-reveals on this one card, and
          forced-visible on every card once any selection exists
          (selectionActive), so extending a selection never requires
          re-hovering each item. */}
      <Box
        className="video-card-checkbox"
        onClick={(e) => e.stopPropagation()}
        sx={{
          position: 'absolute', top: 4, right: 4, zIndex: 1,
          opacity: selectionActive || selected ? 1 : 0,
          transition: 'opacity 0.1s',
          backgroundColor: 'background.paper', borderRadius: '50%',
        }}
      >
        <Checkbox
          size="small"
          checked={selected}
          onChange={() => onToggleSelect(video.videoDir)}
          inputProps={{ 'aria-label': `Select ${video.metadata.title || video.videoFolderName}` }}
        />
      </Box>
      <CardActionArea onClick={() => onSelect(video)}>
        <CardMedia
          component="div"
          image={video.metadata.thumbnail || undefined}
          sx={{ aspectRatio: '16 / 9', backgroundColor: 'grey.800', backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
        <Box sx={{ p: 1.5 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
            <Typography variant="body1" noWrap sx={{ minWidth: 0 }}>{video.metadata.title || video.videoFolderName}</Typography>
            {bestQuality ? (
              <Chip
                size="small"
                color="success"
                label={bestQuality.resolution === 'MP3' ? 'MP3' : `${bestQuality.resolution}p`}
              />
            ) : (
              <Chip size="small" variant="outlined" label="Not downloaded" />
            )}
          </Stack>
          {channelLabel &&
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{channelLabel}</Typography>}
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              {convertYYYYMMDDStringToDate(video.metadata.uploadDate || '') || video.metadata.uploadDate}
            </Typography>
            <Stack direction="row" spacing={1}>
              {video.epochs.length > 1 &&
                <Typography variant="caption" color="text.secondary">{video.epochs.length} versions</Typography>}
              {video.clipCount > 0 &&
                <Typography variant="caption" color="text.secondary">{video.clipCount} clip{video.clipCount === 1 ? '' : 's'}</Typography>}
            </Stack>
          </Stack>
        </Box>
      </CardActionArea>
    </Card>
  );
}

function FlatVideoList({ channels, libraryDir, viewMode, thumbnailSize, selectedVideoDirs, onToggleSelect, onViewModeChange, onSelectVideo, onRefresh }: {
  channels: LibraryChannel[];
  libraryDir: string;
  viewMode: LibraryViewMode;
  thumbnailSize: number;
  selectedVideoDirs: Set<string>;
  onToggleSelect: (videoDir: string) => void;
  onViewModeChange: (mode: LibraryViewMode) => void;
  onSelectVideo: (video: LibraryVideo) => void;
  onRefresh: () => void;
}) {
  const selectionActive = selectedVideoDirs.size > 0;
  const [sortField, setSortFieldState] = useState<SortField>('title');
  const [sortDirection, setSortDirectionState] = useState<SortDirection>('asc');
  useEffect(() => {
    window.electronAPI.getLibrarySort().then(({ sortField, sortDirection }) => {
      setSortFieldState(sortField);
      setSortDirectionState(sortDirection);
    });
  }, []);
  // Fire-and-forget writes, same pattern as handleViewModeChange above --
  // the search term itself is deliberately never persisted here, only the
  // field/direction chosen to order by.
  const setSortField = (field: SortField) => {
    setSortFieldState(field);
    window.electronAPI.setLibrarySort({ sortField: field, sortDirection });
  };
  const setSortDirection = (direction: SortDirection) => {
    setSortDirectionState(direction);
    window.electronAPI.setLibrarySort({ sortField, sortDirection: direction });
  };
  const isDateSortField = sortField === 'uploadDate' || sortField === 'dateAdded';
  const sortDirectionLabel = isDateSortField
    ? (sortDirection === 'asc' ? 'Older' : 'Newer')
    : (sortDirection === 'asc' ? 'Ascending' : 'Descending');

  const flatVideos = useMemo(() => {
    const entries = channels.flatMap((channel) => channel.videos.map((video) => ({ video, channelName: channel.displayName })));
    const directionMultiplier = sortDirection === 'asc' ? 1 : -1;
    entries.sort((a, b) => compareFlatVideos(a, b, sortField) * directionMultiplier);
    return entries;
  }, [channels, sortField, sortDirection]);
  const { query, setQuery, isSearching, filtered, clear } = useLibrarySearch(
    flatVideos,
    ({ video }) => video.metadata.title || video.videoFolderName,
  );

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap gap={1}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="h6">Library</Typography>
          <LibrarySearchBar value={query} onChange={setQuery} onClear={clear} placeholder="Search videos..." />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          {/* Grouped into one bordered container so the field picker and
              direction toggle read as a single "sort" instrument -- Select
              uses variant="standard" so this outer Paper is the only
              border drawn. */}
          <Paper variant="outlined" sx={{ display: 'flex', alignItems: 'center', pl: 1.5, pr: 0.5, borderRadius: 1 }}>
            <FormControl size="small" variant="standard" sx={{ minWidth: 140 }}>
              <InputLabel id="library-sort-field-label">Order by</InputLabel>
              <Select
                labelId="library-sort-field-label"
                label="Order by"
                value={sortField}
                onChange={(e) => setSortField(e.target.value as SortField)}
              >
                {(Object.keys(SORT_FIELD_LABELS) as SortField[]).map((field) => (
                  <MenuItem key={field} value={field}>{SORT_FIELD_LABELS[field]}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title={sortDirectionLabel}>
              <IconButton
                size="small"
                onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
                aria-label="Toggle sort direction"
              >
                {sortDirection === 'asc' ? <ArrowUpwardIcon fontSize="small" /> : <ArrowDownwardIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Paper>
          <LibraryViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
          <Tooltip title="Open library folder">
            <IconButton onClick={() => window.electronAPI.openDirectory(libraryDir)} size="small" aria-label="Open library folder">
              <FolderOpenIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh">
            <IconButton onClick={onRefresh} size="small" aria-label="Refresh library">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
      {flatVideos.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing in the library yet -- use the library-add button next to the URL field on the Downloader tab.
        </Typography>
      ) : isSearching && filtered.length === 0 && (
        <Typography variant="body2" color="text.secondary">No videos match "{query}".</Typography>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: thumbnailGridTemplateColumns(thumbnailSize), gap: 2 }}>
        {filtered.map(({ video, channelName }) => (
          <VideoCard
            key={video.videoDir}
            video={video}
            onSelect={onSelectVideo}
            channelLabel={channelName}
            selected={selectedVideoDirs.has(video.videoDir)}
            selectionActive={selectionActive}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </Box>
    </Box>
  );
}

function ChannelList({ channels, libraryDir, viewMode, onViewModeChange, onSelectChannel, onRefresh }: {
  channels: LibraryChannel[];
  libraryDir: string;
  viewMode: LibraryViewMode;
  onViewModeChange: (mode: LibraryViewMode) => void;
  onSelectChannel: (channel: LibraryChannel) => void;
  onRefresh: () => void;
}) {
  const { query, setQuery, isSearching, filtered, clear } = useLibrarySearch(channels, (channel) => channel.displayName);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap gap={1}>
        <Typography variant="h6">Library</Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <LibrarySearchBar value={query} onChange={setQuery} onClear={clear} placeholder="Search channels..." />
          <LibraryViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
          <Tooltip title="Open library folder">
            <IconButton onClick={() => window.electronAPI.openDirectory(libraryDir)} size="small" aria-label="Open library folder">
              <FolderOpenIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh">
            <IconButton onClick={onRefresh} size="small" aria-label="Refresh library">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
      {channels.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing in the library yet -- use the library-add button next to the URL field on the Downloader tab.
        </Typography>
      ) : isSearching && filtered.length === 0 && (
        <Typography variant="body2" color="text.secondary">No channels match "{query}".</Typography>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: responsiveGridTemplateColumns(260, '20vw', 400), gap: 2 }}>
        {filtered.map((channel) => (
          <Card variant="outlined" key={channel.channelFolderName}>
            <CardActionArea onClick={() => onSelectChannel(channel)} sx={{ p: 2 }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                {channel.channelIconPath ? (
                  <Avatar src={buildAppVideoUrl(channel.channelIconPath)} alt={channel.displayName} />
                ) : (
                  <FolderIcon color="primary" />
                )}
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle1" noWrap>{channel.displayName}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {channel.videos.length} video{channel.videos.length === 1 ? '' : 's'}
                  </Typography>
                </Box>
              </Stack>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Box>
  );
}

function VideoGrid({ channel, thumbnailSize, selectedVideoDirs, onToggleSelect, onBack, onSelectVideo, onChannelsUpdated }: {
  channel: LibraryChannel;
  thumbnailSize: number;
  selectedVideoDirs: Set<string>;
  onToggleSelect: (videoDir: string) => void;
  onBack: () => void;
  onSelectVideo: (video: LibraryVideo) => void;
  onChannelsUpdated: (channels: LibraryChannel[]) => void;
}) {
  const selectionActive = selectedVideoDirs.size > 0;
  const [refreshingIcon, setRefreshingIcon] = useState(false);
  const { query, setQuery, isSearching, filtered, clear } = useLibrarySearch(
    channel.videos,
    (video) => video.metadata.title || video.videoFolderName,
  );

  const handleRefreshIcon = async () => {
    setRefreshingIcon(true);
    try {
      const channelId = channel.videos[0]?.metadata.channelId ?? null;
      const index = await window.electronAPI.refreshChannelIcon({
        channelFolderName: channel.channelFolderName,
        channelId,
      });
      onChannelsUpdated(index.channels);
    } finally {
      setRefreshingIcon(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap gap={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <IconButton onClick={onBack} size="small" aria-label="Back to channels">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography variant="h6">{channel.displayName}</Typography>
          {channel.channelIconPath &&
            <Avatar src={buildAppVideoUrl(channel.channelIconPath)} alt={channel.displayName} sx={{ width: 28, height: 28 }} />}
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <LibrarySearchBar value={query} onChange={setQuery} onClear={clear} placeholder="Search videos..." />
          <Tooltip title="Refresh channel icon">
            <span>
              <IconButton onClick={handleRefreshIcon} disabled={refreshingIcon} size="small" aria-label="Refresh channel icon">
                {refreshingIcon ? <CircularProgress size={18} /> : <FaceRetouchingNaturalIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>
      {isSearching && filtered.length === 0 &&
        <Typography variant="body2" color="text.secondary">No videos match "{query}".</Typography>}
      <Box sx={{ display: 'grid', gridTemplateColumns: thumbnailGridTemplateColumns(thumbnailSize), gap: 2 }}>
        {filtered.map((video) => (
          <VideoCard
            key={video.videoDir}
            video={video}
            onSelect={onSelectVideo}
            selected={selectedVideoDirs.has(video.videoDir)}
            selectionActive={selectionActive}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </Box>
    </Box>
  );
}
