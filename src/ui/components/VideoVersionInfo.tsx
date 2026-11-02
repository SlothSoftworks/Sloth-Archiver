import { useState } from 'react';
import { Chip, FormControl, IconButton, InputLabel, MenuItem, Select, Stack, Tooltip } from '@mui/material';
import DownloadDoneIcon from '@mui/icons-material/DownloadDone';
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined';
import { pink } from '@mui/material/colors';
import { formatEpochLabel } from '../../utils/utils.ts';
import VideoTagsPopover from './VideoTagsPopover';
import type { LibraryVideo, LibraryVideoMetadata } from '../../types';

// The version selector, downloaded quality and tags -- sits above the side
// panel's Tools / Transcript tabs so it stays visible on either one.
export default function VideoVersionInfo({ video, metadata, selectedEpoch, onSelectEpoch, videoTags, onVideoTagsChanged }: {
  video: LibraryVideo;
  metadata: LibraryVideoMetadata;
  selectedEpoch: string | null;
  onSelectEpoch: (epoch: string) => void;
  // The active sublibrary's whole tag map -- this video's own applied tags
  // are derived from it below, same shape LibraryScreen.tsx already loads
  // for the bulk "Tag selected" dialog and the library grid's own chips.
  videoTags: Record<string, string[]>;
  onVideoTagsChanged: () => Promise<void> | void;
}) {
  const [tagsAnchorEl, setTagsAnchorEl] = useState<HTMLElement | null>(null);
  const allTagNames = Object.keys(videoTags);
  const appliedTagNames = allTagNames.filter((name) => videoTags[name].includes(metadata.videoId));

  const handleToggleTag = async (tagName: string, applied: boolean) => {
    await window.electronAPI.setVideoTag(tagName, metadata.videoId, applied);
    await onVideoTagsChanged();
  };

  if (video.epochs.length <= 1 && !metadata.downloadedFilePath) return null;

  return (
    <Stack spacing={1.5} sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
      {video.epochs.length > 1 &&
        <FormControl size="small" fullWidth>
          <InputLabel id="library-version-select-label">Version</InputLabel>
          <Select
            labelId="library-version-select-label"
            label="Version"
            value={selectedEpoch || ''}
            onChange={(e) => onSelectEpoch(e.target.value)}
          >
            {video.epochs.map(({ epoch, metadata: epochMetadata }) => (
              <MenuItem key={epoch} value={epoch}>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  {(epochMetadata.downloadedFilePath || epochMetadata.downloadedAudioFilePath) &&
                    <DownloadDoneIcon fontSize="small" color="success" />}
                  <span>
                    {formatEpochLabel(epoch)}{epoch === video.latestEpoch ? ' (latest)' : ''}
                  </span>
                </Stack>
              </MenuItem>
            ))}
          </Select>
        </FormControl>}
      {metadata.downloadedFilePath &&
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Chip
              color="success"
              label={metadata.downloadedResolution === 'MP3' ? 'MP3' : `${metadata.downloadedResolution}p`}
            />
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap flexWrap="wrap" sx={{ justifyContent: 'flex-end' }}>
            {appliedTagNames.map((tag) => (
              <Chip key={tag} size="small" label={tag} sx={{ bgcolor: pink[700], color: '#fff' }} />
            ))}
            <Tooltip title="Edit tags">
              <IconButton size="small" onClick={(e) => setTagsAnchorEl(e.currentTarget)} aria-label="Edit tags">
                <LocalOfferOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>}
      <VideoTagsPopover
        open={!!tagsAnchorEl}
        anchorEl={tagsAnchorEl}
        onClose={() => setTagsAnchorEl(null)}
        allTags={allTagNames}
        appliedTags={appliedTagNames}
        onToggle={handleToggleTag}
        onCreate={(tagName) => handleToggleTag(tagName, true)}
      />
    </Stack>
  );
}
