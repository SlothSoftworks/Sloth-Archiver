import { useEffect, useState } from 'react';
import {
  Avatar,
  Box,
  Card,
  CardActionArea,
  CardMedia,
  Chip,
  CircularProgress,
  Grid,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import FaceRetouchingNaturalIcon from '@mui/icons-material/FaceRetouchingNatural';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { convertYYYYMMDDStringToDate, buildAppVideoUrl } from '../../utils/utils.ts';
import LibraryVideoDetail from './LibraryVideoDetail';

// Mirrors the shape returned by window.electronAPI.getLibraryIndex() -- kept
// local rather than imported, matching how video-metadata shapes are already
// defined per-file elsewhere in this codebase (e.g. VideoDetailCard.tsx).
type LibraryVideoMetadata = {
  videoId: string;
  channelId: string | null;
  channel: string | null;
  title: string | null;
  fullTitle: string | null;
  description: string | null;
  thumbnail: string | null;
  originalUrl: string | null;
  durationString: string | null;
  uploadDate: string | null;
  resolutions?: { resolution: string; filesizeMb: string }[];
  downloadedFilePath: string | null;
  downloadedResolution: string | null;
  downloadedFormat: string | null;
};

type LibraryVideo = {
  videoFolderName: string;
  videoDir: string;
  latestEpoch: string | null;
  metadata: LibraryVideoMetadata;
  epochs: { epoch: string; metadata: LibraryVideoMetadata }[];
};

type LibraryChannel = {
  channelFolderName: string;
  displayName: string;
  channelIconPath: string | null;
  videos: LibraryVideo[];
};

// Reflects the best quality captured across ALL versions, not just the
// video's latest one -- a newer version might not be downloaded yet while
// an older one already has a real file, and showing "Not downloaded" in
// that case would misrepresent what's actually archived.
function getBestDownloadedQuality(epochs: { metadata: LibraryVideoMetadata }[]): { resolution: string; format: string | null } | null {
  const downloaded = epochs.filter((e) => e.metadata.downloadedFilePath);
  if (downloaded.length === 0) return null;
  // Prefer an actual video resolution over an MP3-only capture when both
  // exist -- a real video is generally the more "complete" archive of the two.
  const videoOnly = downloaded.filter((e) => e.metadata.downloadedResolution !== 'MP3');
  const pool = videoOnly.length > 0 ? videoOnly : downloaded;
  const best = pool.reduce((a, b) => (Number(b.metadata.downloadedResolution) > Number(a.metadata.downloadedResolution) ? b : a));
  return { resolution: best.metadata.downloadedResolution as string, format: best.metadata.downloadedFormat };
}

export default function LibraryScreen() {
  const [libraryDir, setLibraryDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [channels, setChannels] = useState<LibraryChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<LibraryChannel | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<LibraryVideo | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ libraryDir }, index] = await Promise.all([
      window.electronAPI.getLibraryDir(),
      window.electronAPI.getLibraryIndex(),
    ]);
    setLibraryDir(libraryDir);
    setChannels(index.channels);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleRefresh = async () => {
    setLoading(true);
    const index = await window.electronAPI.refreshLibraryIndex();
    setChannels(index.channels);
    setLoading(false);
  };

  // No loading-spinner toggle -- used after a download/delete completes while
  // already viewing a video's detail, where swapping the whole screen to a
  // spinner would be a jarring regression rather than a background update.
  const refreshChannelsSilently = async () => {
    const index = await window.electronAPI.refreshLibraryIndex();
    setChannels(index.channels);
  };

  // Unlike handleVideoDeleted below, this stays on the current channel page
  // rather than bouncing back to the root -- refreshing a channel's icon
  // should update in place so the user actually sees the new icon, not lose
  // their spot. Updates both the root `channels` list (so the channel-list
  // view is also current when the user navigates back) and `selectedChannel`
  // itself (the actual prop VideoGrid renders from -- without this the new
  // icon wouldn't show until a full re-navigation, same staleness class of
  // bug as the one handleVideoDeleted works around below).
  const handleChannelsUpdated = (updatedChannels: LibraryChannel[]) => {
    setChannels(updatedChannels);
    setSelectedChannel((prev) => (prev && updatedChannels.find((c) => c.channelFolderName === prev.channelFolderName)) || prev);
  };

  // Any action that adds or removes a *version* (not just updates a field on
  // the one already displayed, like a normal download/quality-swap) needs
  // this instead of the plain onLibraryChanged/refreshChannelsSilently --
  // the version-selector's option list is read straight from the `video`
  // prop's `epochs` array, so if only the root `channels` list gets
  // refreshed (leaving `selectedVideo` stale), the selector never grows a
  // new option after "download new version," or never shrinks one after
  // deleting a version. Same staleness fix as handleChannelsUpdated above,
  // applied to `selectedVideo`/`selectedChannel` instead of just `channels`.
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

  // Resets both selectedChannel and selectedVideo, not just the latter --
  // selectedChannel is a stale snapshot taken when the user first navigated
  // into it, and refreshChannelsSilently (already called by LibraryVideoDetail
  // via onLibraryChanged before this fires) only updates the root `channels`
  // list, not that snapshot. Without this, deleting a channel's only video
  // left VideoGrid rendering a "ghost" of the just-deleted entry until the
  // user manually round-tripped through the channel list. Simplest fix for
  // now: always land back at the root after a delete, no in-place refresh.
  const handleVideoDeleted = () => {
    setSelectedVideo(null);
    setSelectedChannel(null);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!libraryDir) {
    return (
      <Box sx={{ textAlign: 'center', mt: 6 }}>
        <Typography variant="h6" gutterBottom>No library folder set</Typography>
        <Typography variant="body2" color="text.secondary">
          Set a library folder in the Options tab to get started.
        </Typography>
      </Box>
    );
  }

  if (selectedVideo) {
    return (
      <LibraryVideoDetail
        video={selectedVideo}
        onBack={() => setSelectedVideo(null)}
        onLibraryChanged={refreshChannelsSilently}
        onDeleted={handleVideoDeleted}
        onVersionsChanged={handleVersionsChanged}
      />
    );
  }

  if (selectedChannel) {
    return (
      <VideoGrid
        channel={selectedChannel}
        onBack={() => setSelectedChannel(null)}
        onSelectVideo={setSelectedVideo}
        onChannelsUpdated={handleChannelsUpdated}
      />
    );
  }

  return (
    <ChannelList
      channels={channels}
      libraryDir={libraryDir}
      onSelectChannel={setSelectedChannel}
      onRefresh={handleRefresh}
    />
  );
}

function ChannelList({ channels, libraryDir, onSelectChannel, onRefresh }: {
  channels: LibraryChannel[];
  libraryDir: string;
  onSelectChannel: (channel: LibraryChannel) => void;
  onRefresh: () => void;
}) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h6">Library</Typography>
        <Stack direction="row" spacing={0.5}>
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
      {channels.length === 0 &&
        <Typography variant="body2" color="text.secondary">
          Nothing in the library yet -- use the library-add button next to the URL field on the Downloader tab.
        </Typography>}
      <Grid container spacing={2}>
        {channels.map((channel) => (
          <Grid size={{ xs: 12, sm: 6, md: 4 }} key={channel.channelFolderName}>
            <Card variant="outlined">
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
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

function VideoGrid({ channel, onBack, onSelectVideo, onChannelsUpdated }: {
  channel: LibraryChannel;
  onBack: () => void;
  onSelectVideo: (video: LibraryVideo) => void;
  onChannelsUpdated: (channels: LibraryChannel[]) => void;
}) {
  const [refreshingIcon, setRefreshingIcon] = useState(false);

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
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <IconButton onClick={onBack} size="small" aria-label="Back to channels">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography variant="h6">{channel.displayName}</Typography>
          {channel.channelIconPath &&
            <Avatar src={buildAppVideoUrl(channel.channelIconPath)} alt={channel.displayName} sx={{ width: 28, height: 28 }} />}
        </Stack>
        <Tooltip title="Refresh channel icon">
          <span>
            <IconButton onClick={handleRefreshIcon} disabled={refreshingIcon} size="small" aria-label="Refresh channel icon">
              {refreshingIcon ? <CircularProgress size={18} /> : <FaceRetouchingNaturalIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Grid container spacing={2}>
        {channel.videos.map((video) => {
          const bestQuality = getBestDownloadedQuality(video.epochs);
          return (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={video.videoFolderName}>
              <Card variant="outlined">
                <CardActionArea onClick={() => onSelectVideo(video)}>
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
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        {convertYYYYMMDDStringToDate(video.metadata.uploadDate || '') || video.metadata.uploadDate}
                      </Typography>
                      {video.epochs.length > 1 &&
                        <Typography variant="caption" color="text.secondary">{video.epochs.length} versions</Typography>}
                    </Stack>
                  </Box>
                </CardActionArea>
              </Card>
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
}
