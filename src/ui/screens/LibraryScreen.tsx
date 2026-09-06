import { useEffect, useMemo, useState } from 'react';
import { useMatch, useNavigate, useSearchParams } from 'react-router';
import {
  Alert,
  Avatar,
  Badge,
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
import { pink } from '@mui/material/colors';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import FaceRetouchingNaturalIcon from '@mui/icons-material/FaceRetouchingNatural';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import FilterListIcon from '@mui/icons-material/FilterList';
import { convertYYYYMMDDStringToDate, buildAppVideoUrl, getBestDownloadedQuality, responsiveGridTemplateColumns, thumbnailGridTemplateColumns } from '../../utils/utils.ts';
import LibraryVideoDetail from './LibraryVideoDetail';
import PlaylistsSection, { type PlaylistBulkBar } from '../components/PlaylistsSection';
import LibrarySearchBar from '../components/LibrarySearchBar';
import LibraryBottomBar from '../components/LibraryBottomBar';
import BulkDownloadQualityDialog from '../components/BulkDownloadQualityDialog';
import BulkDeleteConfirmDialog from '../components/BulkDeleteConfirmDialog';
import CreateSubLibraryDialog from '../components/CreateSubLibraryDialog';
import MoveToSubLibraryDialog from '../components/MoveToSubLibraryDialog';
import TagSelectedDialog from '../components/TagSelectedDialog';
import TagFilterPopover from '../components/TagFilterPopover';
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

// Mirrors listLibraryTags' return shape (library.mjs) -- folderName is what
// every IPC call actually keys on; tagName is presentational (today always
// equal to folderName).
type LibraryTag = {
  tagName: string;
  folderName: string;
  createdEpoch: number | null;
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

// SAFETY: SORT_FIELD_LABELS is a Record<SortField, string>, so Object.keys
// can only return SortField values. Computed once here instead of inline in
// the Select's render below, which recomputed this same array every render.
const SORT_FIELD_OPTIONS = Object.keys(SORT_FIELD_LABELS) as SortField[];

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
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [playlistBulkBar, setPlaylistBulkBar] = useState<PlaylistBulkBar | null>(null);
  const [libraryTags, setLibraryTags] = useState<LibraryTag[]>([]);
  const [activeLibraryTag, setActiveLibraryTagState] = useState('');
  const [activeLibraryTagDir, setActiveLibraryTagDir] = useState('');
  const [createTagDialogOpen, setCreateTagDialogOpen] = useState(false);
  const [creatingTag, setCreatingTag] = useState(false);
  const [createTagError, setCreateTagError] = useState<string | null>(null);
  // The active sublibrary's video-tag map (unrelated to libraryTags above,
  // which is sublibrary switching) -- {} until load() finishes.
  const [videoTags, setVideoTags] = useState<Record<string, string[]>>({});
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const deepLinkMatch = useMatch('/library/video/:videoId');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { start } = useBulkAddQueue();

  const load = async () => {
    setLoading(true);
    const [{ libraryDir }, index, { libraryViewMode }, { thumbnailSize }, { tags }, { activeLibraryTag, activeLibraryTagDir }, { tags: videoTags }] = await Promise.all([
      window.electronAPI.getLibraryDir(),
      window.electronAPI.getLibraryIndex(),
      window.electronAPI.getLibraryViewMode(),
      window.electronAPI.getThumbnailSize(),
      window.electronAPI.listLibraryTags(),
      window.electronAPI.getActiveLibraryTag(),
      window.electronAPI.listVideoTags(),
    ]);
    setLibraryDir(libraryDir);
    setChannels(index.channels);
    setViewMode(libraryViewMode);
    setThumbnailSize(thumbnailSize);
    setLibraryTags(tags);
    setActiveLibraryTagState(activeLibraryTag);
    setActiveLibraryTagDir(activeLibraryTagDir);
    setVideoTags(videoTags);
    setLoading(false);
  };

  const refreshVideoTags = async () => {
    const { tags } = await window.electronAPI.listVideoTags();
    setVideoTags(tags);
  };

  useEffect(() => {
    load();
  }, []);

  // Switching sublibraries resets everything the previous one's scan
  // produced -- channels, any channel/video drill-down, and the current
  // selection -- since none of it belongs to the newly-active sublibrary.
  // Re-runs the same full load() rather than just refreshing the index, so
  // the tag list/active tag/library dir all stay in sync too.
  const switchLibraryTag = async (tag: string) => {
    setSelectedChannel(null);
    setSelectedVideo(null);
    clearSelection();
    await window.electronAPI.setActiveLibraryTag(tag);
    await load();
  };

  const handleCreateLibraryTag = async (name: string) => {
    setCreatingTag(true);
    setCreateTagError(null);
    try {
      const result = await window.electronAPI.createLibraryTag(name);
      if (!result.success) {
        setCreateTagError(result.message || 'Could not create this sublibrary.');
        return;
      }
      // createLibraryTag already switched the active tag server-side --
      // just close the dialog and reload to pick it up, same as
      // switchLibraryTag's own reset/reload.
      setCreateTagDialogOpen(false);
      setSelectedChannel(null);
      setSelectedVideo(null);
      clearSelection();
      await load();
    } finally {
      setCreatingTag(false);
    }
  };

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
  // Only meaningful once another sublibrary actually exists -- there's
  // nowhere else to move a video to otherwise. Every video qualifies
  // regardless of download state (unlike canBulkDownload/canDeleteLocalFiles
  // above), so this doesn't need to inspect selectedVideos at all.
  const canMove = libraryTags.length > 1;
  const moveTargetOptions = libraryTags.filter((tag) => tag.folderName !== activeLibraryTag);
  // Unlike canMove, tagging only ever touches the one active sublibrary --
  // no other-sublibrary-exists gate needed, just something selected.
  const canTag = selectedVideoDirs.size > 0;

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
      // refreshChannelsSilently. deleteEntries also pruned any deleted
      // videos out of the tag map server-side, in one batched write --
      // refetch to pick that up too.
      const index = await window.electronAPI.refreshLibraryIndex();
      handleChannelsUpdated(index.channels);
      await refreshVideoTags();
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

  const handleConfirmMove = async (targetTag: string) => {
    setMoving(true);
    setMoveError(null);
    try {
      const { success, results } = await window.electronAPI.moveLibraryEntries([...selectedVideoDirs], targetTag);
      if (!success) {
        const failed = results.filter((r) => !r.success);
        // Each result already carries the specific reason it failed (e.g. a
        // video already existing at the target) -- surface it per-video
        // rather than a generic count, so the user knows which ones and why.
        const failedDetails = failed
          .map((r) => `${videoByDir.get(r.videoDir)?.metadata.title ?? r.videoDir}${r.error ? `: ${r.error}` : ''}`)
          .join('\n');
        setMoveError(`${failed.length} of ${results.length} video(s) couldn't be moved:\n${failedDetails}`);
        // Only the failed ones stay selected, so the user can immediately
        // retry just those via the same bottom-bar button.
        setSelectedVideoDirs(new Set(failed.map((r) => r.videoDir)));
      } else {
        setMoveDialogOpen(false);
        clearSelection();
      }
      // The index already refreshed server-side inside the IPC handler --
      // this just pulls the updated channels list, same pattern as
      // refreshChannelsSilently. moveEntries also transferred the moved
      // videos' tags to the target sublibrary's manifest server-side, in one
      // batched write each -- refetch this sublibrary's map to pick up
      // whatever got removed from it.
      const index = await window.electronAPI.refreshLibraryIndex();
      handleChannelsUpdated(index.channels);
      await refreshVideoTags();
    } finally {
      setMoving(false);
    }
  };

  const handleConfirmTag = async (tagName: string) => {
    setTagging(true);
    setTagError(null);
    try {
      await window.electronAPI.tagVideos(selectedVideos.map((v) => v.metadata.videoId), tagName);
      await refreshVideoTags();
      setTagDialogOpen(false);
      clearSelection();
    } finally {
      setTagging(false);
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
  //
  // An optional ?tag= query param names which sublibrary the video actually
  // lives in (set by DownloaderScreen's "View" link when it added to a
  // non-active sublibrary) -- without switching to it first, the lookup/
  // refresh below (both scoped to whatever's currently active) would never
  // find it. Omitted, this falls back to searching whatever's active, same
  // as before this param existed.
  const videoIdToOpen = deepLinkMatch?.params.videoId;
  const libraryTagToOpen = searchParams.get('tag');
  useEffect(() => {
    if (!videoIdToOpen) return;
    (async () => {
      // Checked against the real current tag via IPC, not the local
      // activeLibraryTag state -- this effect can fire before load()'s own
      // fetch has resolved (both run on mount), so that state may still be
      // its unset initial value here, wrongly triggering a switch.
      if (libraryTagToOpen) {
        const { activeLibraryTag: currentActiveTag } = await window.electronAPI.getActiveLibraryTag();
        if (libraryTagToOpen !== currentActiveTag) {
          await switchLibraryTag(libraryTagToOpen);
        }
      }
      const result = await window.electronAPI.findLibraryVideo(videoIdToOpen, libraryTagToOpen || undefined);
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
      videoTags={videoTags}
      onVideoTagsChanged={refreshVideoTags}
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
      videoTags={videoTags}
    />
  ) : viewMode === 'video' ? (
    <FlatVideoList
      channels={channels}
      openFolderDir={activeLibraryTagDir}
      viewMode={viewMode}
      thumbnailSize={thumbnailSize}
      selectedVideoDirs={selectedVideoDirs}
      onToggleSelect={toggleVideoSelected}
      onViewModeChange={handleViewModeChange}
      onSelectVideo={setSelectedVideo}
      onRefresh={handleRefresh}
      videoTags={videoTags}
    />
  ) : (
    <ChannelList
      channels={channels}
      openFolderDir={activeLibraryTagDir}
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
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap gap={1}>
            <ToggleButtonGroup
              value={librarySection}
              exclusive
              size="small"
              onChange={(_e, value: LibrarySection | null) => { if (value) setLibrarySection(value); clearSelection(); }}
            >
              <ToggleButton value="videos">
                <VideoLibraryIcon fontSize="small" sx={{ mr: 0.5 }} />
                Videos
              </ToggleButton>
              <ToggleButton value="playlists">
                <PlaylistPlayIcon fontSize="small" sx={{ mr: 0.5 }} />
                Playlists
              </ToggleButton>
            </ToggleButtonGroup>
            <Stack direction="row" spacing={1} alignItems="center">
              {libraryTags.length > 1 &&
                <FormControl size="small" variant="standard" sx={{ minWidth: 140 }}>
                  <InputLabel id="library-tag-label">Sublibrary</InputLabel>
                  <Select
                    labelId="library-tag-label"
                    label="Sublibrary"
                    value={activeLibraryTag}
                    onChange={(e) => switchLibraryTag(e.target.value)}
                  >
                    {libraryTags.map((tag) => (
                      <MenuItem key={tag.folderName} value={tag.folderName}>{tag.tagName}</MenuItem>
                    ))}
                  </Select>
                </FormControl>}
              <Tooltip title="Add new sublibrary">
                <IconButton onClick={() => setCreateTagDialogOpen(true)} size="small" aria-label="Add new sublibrary">
                  <CreateNewFolderIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>}
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
          canMove={canMove}
          onMoveSelected={() => setMoveDialogOpen(true)}
          canTag={canTag}
          onTagSelected={() => setTagDialogOpen(true)}
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
      <CreateSubLibraryDialog
        open={createTagDialogOpen}
        onClose={() => { setCreateTagDialogOpen(false); setCreateTagError(null); }}
        creating={creatingTag}
        error={createTagError}
        onConfirm={handleCreateLibraryTag}
      />
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
      <MoveToSubLibraryDialog
        open={moveDialogOpen}
        onClose={() => { setMoveDialogOpen(false); setMoveError(null); }}
        count={selectedVideoDirs.size}
        options={moveTargetOptions}
        moving={moving}
        error={moveError}
        onConfirm={handleConfirmMove}
      />
      <TagSelectedDialog
        open={tagDialogOpen}
        onClose={() => { setTagDialogOpen(false); setTagError(null); }}
        count={selectedVideoDirs.size}
        options={Object.keys(videoTags)}
        tagging={tagging}
        error={tagError}
        onConfirm={handleConfirmTag}
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
function VideoCard({ video, onSelect, channelLabel, selected, selectionActive, onToggleSelect, videoTags }: {
  video: LibraryVideo;
  onSelect: (video: LibraryVideo) => void;
  channelLabel?: string;
  selected: boolean;
  selectionActive: boolean;
  onToggleSelect: (videoDir: string) => void;
  videoTags: Record<string, string[]>;
}) {
  const bestQuality = getBestDownloadedQuality(video.epochs);
  const appliedTags = Object.keys(videoTags).filter((name) => videoTags[name].includes(video.metadata.videoId));
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
          {appliedTags.length > 0 &&
            <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ my: 0.5 }}>
              {appliedTags.map((tag) => (
                <Chip key={tag} size="small" label={tag} sx={{ bgcolor: pink[700], color: '#fff' }} />
              ))}
            </Stack>}
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

function FlatVideoList({ channels, openFolderDir, viewMode, thumbnailSize, selectedVideoDirs, onToggleSelect, onViewModeChange, onSelectVideo, onRefresh, videoTags }: {
  channels: LibraryChannel[];
  openFolderDir: string;
  viewMode: LibraryViewMode;
  thumbnailSize: number;
  selectedVideoDirs: Set<string>;
  onToggleSelect: (videoDir: string) => void;
  onViewModeChange: (mode: LibraryViewMode) => void;
  onSelectVideo: (video: LibraryVideo) => void;
  onRefresh: () => void;
  videoTags: Record<string, string[]>;
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

  // Ephemeral, like search below -- resets on navigation/reload rather than
  // persisting to settings the way sortField/sortDirection do, since this is
  // a "narrow what I'm looking at right now" tool, not a standing
  // preference. AND semantics (every selected tag, not just one): a video
  // must carry all of them to match.
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);
  const [selectedFilterTags, setSelectedFilterTags] = useState<Set<string>>(new Set());
  const toggleFilterTag = (tag: string, checked: boolean) => {
    setSelectedFilterTags((prev) => {
      const next = new Set(prev);
      if (checked) next.add(tag);
      else next.delete(tag);
      return next;
    });
  };
  const tagFilteredVideos = useMemo(() => {
    if (selectedFilterTags.size === 0) return flatVideos;
    return flatVideos.filter(({ video }) => [...selectedFilterTags].every((tag) => videoTags[tag]?.includes(video.metadata.videoId)));
  }, [flatVideos, selectedFilterTags, videoTags]);

  const { query, setQuery, isSearching, filtered, clear } = useLibrarySearch(
    tagFilteredVideos,
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
          <Tooltip title="Filter by tag">
            <IconButton
              size="small"
              onClick={(e) => setFilterAnchorEl(e.currentTarget)}
              aria-label="Filter by tag"
              color={selectedFilterTags.size > 0 ? 'primary' : 'default'}
            >
              <Badge badgeContent={selectedFilterTags.size} color="primary">
                <FilterListIcon fontSize="small" />
              </Badge>
            </IconButton>
          </Tooltip>
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
                // SAFETY: every MenuItem below is keyed by a SortField, so
                // this Select can only ever emit one of those values.
                onChange={(e) => setSortField(e.target.value as SortField)}
              >
                {SORT_FIELD_OPTIONS.map((field) => (
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
            <IconButton onClick={() => window.electronAPI.openDirectory(openFolderDir)} size="small" aria-label="Open library folder">
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
      ) : filtered.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {isSearching ? `No videos match "${query}".` : 'No videos match the selected tag filter.'}
        </Typography>
      )}
      <TagFilterPopover
        open={!!filterAnchorEl}
        anchorEl={filterAnchorEl}
        onClose={() => setFilterAnchorEl(null)}
        allTags={Object.keys(videoTags)}
        selectedTags={selectedFilterTags}
        onToggle={toggleFilterTag}
        onClear={() => setSelectedFilterTags(new Set())}
      />
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
            videoTags={videoTags}
          />
        ))}
      </Box>
    </Box>
  );
}

function ChannelList({ channels, openFolderDir, viewMode, onViewModeChange, onSelectChannel, onRefresh }: {
  channels: LibraryChannel[];
  openFolderDir: string;
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
            <IconButton onClick={() => window.electronAPI.openDirectory(openFolderDir)} size="small" aria-label="Open library folder">
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

function VideoGrid({ channel, thumbnailSize, selectedVideoDirs, onToggleSelect, onBack, onSelectVideo, onChannelsUpdated, videoTags }: {
  channel: LibraryChannel;
  thumbnailSize: number;
  selectedVideoDirs: Set<string>;
  onToggleSelect: (videoDir: string) => void;
  onBack: () => void;
  onSelectVideo: (video: LibraryVideo) => void;
  onChannelsUpdated: (channels: LibraryChannel[]) => void;
  videoTags: Record<string, string[]>;
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
            videoTags={videoTags}
          />
        ))}
      </Box>
    </Box>
  );
}
