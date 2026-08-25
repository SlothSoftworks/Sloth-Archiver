import { useEffect, useState } from 'react';
import { Box, Card, IconButton, List, ListItem, ListItemButton, ListItemText, Stack, Tooltip, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import LibraryVideoPlayer from './LibraryVideoPlayer';
import BulkDeleteConfirmDialog from './BulkDeleteConfirmDialog';
import LinearProgressWithLabel from './LinearProgressWithLabel';
import { formatSecondsAsClipTimestamp } from '../screens/FfmpegUtilitiesPanel';
import type { LibraryClip, LibraryVideoMetadata } from '../../types';

// Placeholder metadata for LibraryVideoPlayer -- overrideFilePath takes
// priority over every field here, this just satisfies the required prop
// without pretending a clip has a real video identity.
const EMPTY_METADATA = { downloadedFilePath: null, thumbnail: null, videoId: '' } as LibraryVideoMetadata;

// Swaps in for the whole normal video layout (player + instrument panel)
// when the "Clip Collection" tab is active -- a player on the left, a
// scrollable list of this video's saved clips on the right. Reuses
// LibraryVideoPlayer pointed directly at a clip's own file via
// overrideFilePath, and BulkDeleteConfirmDialog (already generic on
// title/description, no LibraryScreen-specific coupling) for delete.
export default function ClipCollectionView({
  videoDir, clips, onClipsChanged, onEmptied,
  onOpenFileLocation, onExtractMp3, extractingMp3, extractMp3Disabled, extractMp3Progress, extractMp3Error,
}: {
  videoDir: string;
  clips: LibraryClip[];
  onClipsChanged: (clips: LibraryClip[]) => void;
  onEmptied: () => void;
  onOpenFileLocation: () => void;
  onExtractMp3: (clip: LibraryClip) => void;
  extractingMp3: boolean;
  extractMp3Disabled: boolean;
  extractMp3Progress: number;
  extractMp3Error: string | null;
}) {
  const [activeClipId, setActiveClipId] = useState<string | null>(clips[0]?.id ?? null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryClip | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Keep a valid active clip if the list changes underneath us (e.g. a
  // delete elsewhere, or the initial fetch landing after mount).
  useEffect(() => {
    if (!clips.some((c) => c.id === activeClipId)) {
      setActiveClipId(clips[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  const activeClip = clips.find((c) => c.id === activeClipId) || null;

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await window.electronAPI.deleteClip({ videoDir, clipId: deleteTarget.id });
    setDeleting(false);
    if (!res.success) {
      setDeleteError(res.message || 'Failed to delete this clip.');
      return;
    }
    const remaining = clips.filter((c) => c.id !== deleteTarget.id);
    onClipsChanged(remaining);
    setDeleteTarget(null);
    if (remaining.length === 0) {
      onEmptied();
    }
  };

  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
      <Stack spacing={2} sx={{ width: { xs: '100%', md: '70%' } }}>
        {activeClip &&
          // No thumbnailPath here on purpose -- a clip's poster should be its
          // own natural first frame (the browser derives this automatically
          // for a video with no explicit poster), not the parent video's
          // unrelated stored thumbnail.
          <LibraryVideoPlayer
            metadata={EMPTY_METADATA}
            overrideFilePath={`${videoDir}/clips/${activeClip.fileName}`}
          />}

        {activeClip &&
          <Card variant="outlined" sx={{ p: 1.5 }}>
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
                Clip options
              </Typography>
              {extractingMp3 &&
                <LinearProgressWithLabel value={extractMp3Progress} valueBuffer={extractMp3Progress} />}
              {extractMp3Error &&
                <Typography variant="caption" color="error">{extractMp3Error}</Typography>}

              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" sx={{ flexGrow: 1 }}>Open file location</Typography>
                <Tooltip title="Open file location">
                  <IconButton size="small" aria-label="Open clip file location" onClick={onOpenFileLocation}>
                    <FolderOpenIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>

              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" sx={{ flexGrow: 1 }}>Extract audio as MP3</Typography>
                <Tooltip title="Extract audio as MP3">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="Extract clip audio as MP3"
                      onClick={() => onExtractMp3(activeClip)}
                      disabled={extractMp3Disabled}
                    >
                      <AudiotrackIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>
          </Card>}
      </Stack>
      <Box sx={{ width: { xs: '100%', md: '30%' }, maxHeight: 480, overflowY: 'auto' }}>
        <List dense>
          {clips.map((clip) => (
            <ListItem
              key={clip.id}
              disablePadding
              sx={{ backgroundColor: clip.id === activeClipId ? 'action.selected' : undefined }}
              secondaryAction={
                <Tooltip title="Delete this clip">
                  <IconButton size="small" edge="end" aria-label={`Delete ${clip.title}`} onClick={() => setDeleteTarget(clip)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
            >
              <ListItemButton onClick={() => setActiveClipId(clip.id)}>
                <ListItemText
                  primary={clip.title}
                  secondary={`${new Date(clip.createdAt).toLocaleDateString()} · ${formatSecondsAsClipTimestamp(Math.round(clip.durationSeconds))}`}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Box>
      <BulkDeleteConfirmDialog
        open={!!deleteTarget}
        title="Delete this clip?"
        description="This permanently deletes the clip file. This can't be undone."
        deleting={deleting}
        error={deleteError}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
        onConfirm={handleConfirmDelete}
      />
    </Stack>
  );
}
