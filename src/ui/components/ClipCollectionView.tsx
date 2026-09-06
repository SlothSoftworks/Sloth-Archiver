import { useEffect, useState } from 'react';
import {
  Box, Card, Checkbox, Chip, Divider, FormControlLabel, IconButton, List, ListItem, ListItemButton, ListItemText,
  MenuItem, Select, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LibraryVideoPlayerWithTools from './LibraryVideoPlayerWithTools';
import BulkDeleteConfirmDialog from './BulkDeleteConfirmDialog';
import LinearProgressWithLabel from './LinearProgressWithLabel';
import { formatSecondsAsClipTimestamp, OTHER_FORMAT_VALUE, TRANSCODE_ON_CONVERT_TOOLTIP } from '../screens/FfmpegUtilitiesPanel';
import type { LibraryClip, LibraryVideoMetadata } from '../../types';

// Placeholder metadata for LibraryVideoPlayerWithTools -- overrideFilePath
// takes priority over every field here, this just satisfies the required
// prop without pretending a clip has a real video identity.
// SAFETY: overrideFilePath always takes priority over these fields in
// LibraryVideoPlayerWithTools, so the properties missing here are never read.
const EMPTY_METADATA = { downloadedFilePath: null, thumbnail: null, videoId: '' } as LibraryVideoMetadata;

function getClipExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot === -1 ? '' : fileName.slice(lastDot + 1).toUpperCase();
}

export default function ClipCollectionView({
  videoDir, clips, onClipsChanged, onEmptied,
  onOpenFileLocation, onExtractMp3, extractingMp3, extractMp3Disabled, extractMp3Progress, extractMp3Error,
  convertFormatOptions, onConvertClip, convertingClip, convertClipDisabled, convertClipProgress, convertClipError,
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
  convertFormatOptions: string[];
  onConvertClip: (clip: LibraryClip, format: string, saveAsNewFile: boolean, forceReencode: boolean) => void;
  convertingClip: boolean;
  convertClipDisabled: boolean;
  convertClipProgress: number;
  convertClipError: string | null;
}) {
  const [activeClipId, setActiveClipId] = useState<string | null>(clips[0]?.id ?? null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryClip | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [convertFormat, setConvertFormat] = useState(convertFormatOptions[0]?.toLowerCase() ?? 'mp4');
  const [otherFormatInput, setOtherFormatInput] = useState('');
  const [saveAsNewFile, setSaveAsNewFile] = useState(false);
  const [forceReencode, setForceReencode] = useState(false);

  // Keep a valid active clip if the list changes underneath us (e.g. a
  // delete elsewhere, or the initial fetch landing after mount).
  useEffect(() => {
    if (!clips.some((c) => c.id === activeClipId)) {
      setActiveClipId(clips[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  const activeClip = clips.find((c) => c.id === activeClipId) || null;
  const resolvedConvertFormat = convertFormat === OTHER_FORMAT_VALUE ? otherFormatInput.trim().toLowerCase() : convertFormat;

  const handleConvert = () => {
    if (!activeClip || !resolvedConvertFormat) return;
    onConvertClip(activeClip, resolvedConvertFormat, saveAsNewFile, forceReencode);
  };

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
          // own natural first frame, not the parent video's unrelated stored
          // thumbnail. standaloneClipping since a clip has nowhere in
          // clips.json to live if re-clipped (clips aren't nested) -- saving
          // always prompts for a file location instead.
          <LibraryVideoPlayerWithTools
            metadata={EMPTY_METADATA}
            overrideFilePath={`${videoDir}/clips/${activeClip.fileName}`}
            convertFormatOptions={convertFormatOptions}
            standaloneClipping
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

              <Divider />

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

              <Divider />

              {convertingClip &&
                <LinearProgressWithLabel value={convertClipProgress} valueBuffer={convertClipProgress} />}
              {convertClipError &&
                <Typography variant="caption" color="error">{convertClipError}</Typography>}

              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" sx={{ flexGrow: 1 }}>Convert to</Typography>
                <Select
                  size="small"
                  variant="standard"
                  value={convertFormat}
                  onChange={(e) => setConvertFormat(e.target.value)}
                  disabled={convertClipDisabled}
                >
                  {convertFormatOptions.map((format) => (
                    <MenuItem key={format} value={format.toLowerCase()}>{format.toUpperCase()}</MenuItem>
                  ))}
                  <MenuItem value={OTHER_FORMAT_VALUE}>Other...</MenuItem>
                </Select>
                <Tooltip title="Convert">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="Convert clip to a different format"
                      onClick={handleConvert}
                      disabled={convertClipDisabled || !resolvedConvertFormat}
                    >
                      <SwapHorizIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              {convertFormat === OTHER_FORMAT_VALUE &&
                <TextField
                  size="small"
                  variant="standard"
                  placeholder="Format name"
                  value={otherFormatInput}
                  onChange={(e) => setOtherFormatInput(e.target.value)}
                  disabled={convertClipDisabled}
                  slotProps={{ htmlInput: { 'aria-label': 'Custom convert format name' } }}
                />}
              <FormControlLabel
                sx={{ ml: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={saveAsNewFile}
                    onChange={(e) => setSaveAsNewFile(e.target.checked)}
                    disabled={convertClipDisabled}
                  />
                }
                label={<Typography variant="body2">Save into new file</Typography>}
              />
              <Stack direction="row" spacing={0.5} alignItems="center">
                <FormControlLabel
                  sx={{ ml: 0 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={forceReencode}
                      onChange={(e) => setForceReencode(e.target.checked)}
                      disabled={convertClipDisabled}
                    />
                  }
                  label={<Typography variant="body2">Transcode on convert</Typography>}
                />
                <Tooltip title={TRANSCODE_ON_CONVERT_TOOLTIP}>
                  <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
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
                  primary={
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Typography variant="body2" component="span">{clip.title}</Typography>
                      <Chip label={getClipExtension(clip.fileName)} size="small" variant="outlined" sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: '0.65rem' } }} />
                    </Stack>
                  }
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
