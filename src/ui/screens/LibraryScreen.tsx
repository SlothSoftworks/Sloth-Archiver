import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardMedia,
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
import { formatComment } from '../components/componentUtils';

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
  downloadedFilePath: string | null;
  downloadedResolution: string | null;
};

type LibraryVideo = {
  videoFolderName: string;
  videoDir: string;
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
    return <VideoDetail video={selectedVideo} onBack={() => setSelectedVideo(null)} />;
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
                  sx={{ height: 140, backgroundColor: 'grey.800', backgroundSize: 'cover', backgroundPosition: 'center' }}
                />
                <Box sx={{ p: 1.5 }}>
                  <Typography variant="body1" noWrap>{video.metadata.title || video.videoFolderName}</Typography>
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

function VideoDetail({ video, onBack }: { video: LibraryVideo; onBack: () => void }) {
  const { metadata } = video;

  const handleOpenFileLocation = () => {
    if (metadata.downloadedFilePath) {
      window.electronAPI.openFileInDirectory(metadata.downloadedFilePath);
    }
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <IconButton onClick={onBack} size="small" aria-label="Back to videos">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="h6" noWrap>{metadata.title || video.videoFolderName}</Typography>
      </Stack>
      <CardMedia
        component="div"
        image={metadata.thumbnail || undefined}
        sx={{ height: 320, backgroundColor: 'grey.800', borderRadius: 2, mb: 2, backgroundSize: 'cover', backgroundPosition: 'center' }}
      />
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="body2" color="info.main" fontWeight="bolder">
          {convertYYYYMMDDStringToDate(metadata.uploadDate || '') || metadata.uploadDate}
        </Typography>
        {metadata.downloadedFilePath ? (
          <Button size="small" startIcon={<FolderOpenIcon />} onClick={handleOpenFileLocation}>
            Open file location
          </Button>
        ) : (
          <Typography variant="body2" color="text.secondary">Not downloaded yet</Typography>
        )}
      </Stack>
      <Typography variant="body2" sx={{ textAlign: 'justify' }}>
        {formatComment(metadata.description || '')}
      </Typography>
    </Box>
  );
}
