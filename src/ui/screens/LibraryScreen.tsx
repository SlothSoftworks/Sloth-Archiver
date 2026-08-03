import { useEffect, useState } from 'react';
import {
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
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { convertYYYYMMDDStringToDate } from '../../utils/utils.ts';
import LibraryVideoDetail from './LibraryVideoDetail';

// Mirrors the shape returned by window.electronAPI.getLibraryIndex() -- kept
// local rather than imported, matching how video-metadata shapes are already
// defined per-file elsewhere in this codebase (e.g. VideoDetailCard.tsx).
type LibraryVideoMetadata = {
  videoId: string;
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
};

type LibraryChannel = {
  channelFolderName: string;
  displayName: string;
  videos: LibraryVideo[];
};

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
      />
    );
  }

  if (selectedChannel) {
    return (
      <VideoGrid
        channel={selectedChannel}
        onBack={() => setSelectedChannel(null)}
        onSelectVideo={setSelectedVideo}
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
                  <FolderIcon color="primary" />
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

function VideoGrid({ channel, onBack, onSelectVideo }: {
  channel: LibraryChannel;
  onBack: () => void;
  onSelectVideo: (video: LibraryVideo) => void;
}) {
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <IconButton onClick={onBack} size="small" aria-label="Back to channels">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="h6">{channel.displayName}</Typography>
      </Stack>
      <Grid container spacing={2}>
        {channel.videos.map((video) => (
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
                    {video.metadata.downloadedFilePath ? (
                      <Chip
                        size="small"
                        color="success"
                        label={video.metadata.downloadedResolution === 'MP3' ? 'MP3' : `${video.metadata.downloadedResolution}p`}
                      />
                    ) : (
                      <Chip size="small" variant="outlined" label="Not downloaded" />
                    )}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {convertYYYYMMDDStringToDate(video.metadata.uploadDate || '') || video.metadata.uploadDate}
                  </Typography>
                </Box>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
