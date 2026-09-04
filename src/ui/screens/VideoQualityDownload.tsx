import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  FormGroup,
  Grid,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import DownloadDoneIcon from '@mui/icons-material/DownloadDone';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import CancelIcon from '@mui/icons-material/Cancel';
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined';
import { pink } from '@mui/material/colors';
import { buildAppVideoUrl, formatEpochLabel, isLongVideoForPostprocess } from '../../utils/utils.ts';
import LinearProgressWithLabel from '../components/LinearProgressWithLabel';
import VideoTagsPopover from '../components/VideoTagsPopover';
import type { LibraryVideoMetadata, Resolution } from '../../types';

type LibraryVideo = {
  videoFolderName: string;
  videoDir: string;
  latestEpoch: string | null;
  metadata: LibraryVideoMetadata;
  epochs: { epoch: string; metadata: LibraryVideoMetadata }[];
  thumbnailPath: string | null;
};

// Shared between the first-download and "download different quality" flows
// -- excludeResolution blocks re-picking whatever's already downloaded
// rather than hiding it, so it's clear why one button is greyed out instead
// of silently missing.
function ResolutionPicker({ resolutions, excludeResolution, onSelect, selectedFormat, onFormatChange, isError, errorKind, disabled }: {
  resolutions: Resolution[];
  excludeResolution?: string | null;
  onSelect: (resolution: string) => void;
  selectedFormat: string;
  onFormatChange: (format: string) => void;
  isError: boolean;
  errorKind: string | null;
  disabled?: boolean;
}) {
  return (
    <>
      {isError && errorKind === 'cancelled' ? (
        <Typography color="warning.main" variant="body2" fontWeight="bold" sx={{ mb: 1 }}>Cancelled.</Typography>
      ) : isError && (
        <Typography color="error" variant="body2" sx={{ mb: 1 }}>Download failed -- try again.</Typography>
      )}
      <Grid container spacing={1} columns={{ xs: 2, sm: 9, md: 12 }}>
        {resolutions.map((res, idx) => (
          <Grid size={{ xs: 1, sm: 3 }} key={idx}>
            <Button
              onClick={() => onSelect(res.resolution)}
              disabled={res.resolution === excludeResolution || disabled}
              sx={{ whiteSpace: 'pre-line' }}
              fullWidth
              variant="outlined"
            >
              <Stack spacing={0} direction="column" divider={<Divider flexItem sx={{ mx: 1 }} orientation="horizontal" />}>
                <Typography variant="button" textTransform="none">
                  {res.resolution}p{res.resolution === excludeResolution ? ' (current)' : ''}
                </Typography>
                <Typography variant="caption">{res.filesizeMb}Mb</Typography>
              </Stack>
            </Button>
          </Grid>
        ))}
      </Grid>
      <Divider sx={{ my: 1 }} />
      <FormGroup>
        <Select
          size="small"
          value={selectedFormat}
          onChange={(e) => onFormatChange(e.target.value)}
          variant="standard"
        >
          <MenuItem value="dflt">Default (keep origin format)</MenuItem>
          <MenuItem value="mp4">MP4</MenuItem>
          <MenuItem value="webm">WEBM</MenuItem>
          <MenuItem value="mkv">MKV</MenuItem>
        </Select>
      </FormGroup>
    </>
  );
}

// Shared by the three "a download is currently running" blocks below (video,
// quality swap, audio) -- they all read from the same single
// useDownloadVideo() instance, so cancel/retrying behave identically in all
// three.
function DownloadCancelControls({ isRetrying, onCancelDownload }: { isRetrying: boolean; onCancelDownload: () => void }) {
  return (
    <>
      <Button size="small" color="error" startIcon={<CancelIcon fontSize="small" />} onClick={onCancelDownload} sx={{ alignSelf: 'center' }}>
        Cancel
      </Button>
      {isRetrying &&
        <Typography variant="caption" color="warning.main" textAlign="center">
          Retrying after a download error...
        </Typography>}
    </>
  );
}

// Shared by the same three blocks as DownloadCancelControls above -- a
// persistent warning label (not just a tooltip, which is too easy to miss)
// shown below the progress bar for the whole download/postprocess span on a
// long recording, since yt-dlp's own merge step reports no real progress and
// can otherwise look stuck for a while on something this long. Only ever
// rendered while a download is actively in flight (all three call sites are
// already gated on that), so no separate isDone check is needed.
function LongVideoPostprocessWarning({ duration }: { duration: number | null }) {
  if (!isLongVideoForPostprocess(duration)) return null;
  return (
    <Typography variant="caption" color="warning.main" textAlign="center">
      This is a long video -- postprocessing may take a while with no visible progress.
    </Typography>
  );
}

// The version selector + video quality download/swap controls + MP3 audio
// sub-section -- everything in the instrument panel above the FFMPEG
// utilities divider. All state stays owned by LibraryVideoDetail (the
// version switch, the shared useDownloadVideo() instance, and ffmpegAction
// are each read by more than one panel -- e.g. the Audio section below
// shows ffmpeg's own "Extracting MP3" progress inline when
// extractAudioToLibrary is running), so this is a presentational component:
// it renders from props and calls back up rather than owning its own copy.
export default function VideoQualityDownload({
  video,
  metadata,
  selectedEpoch,
  onSelectEpoch,
  videoResolutions,
  mp3Resolution,
  selectedFormat,
  onFormatChange,
  selectedResolution,
  isError,
  downloadErrorKind,
  downloadStatus,
  downloadProgress,
  postprocessProgress,
  postprocessIndeterminate,
  swappingQuality,
  onCancelQualitySwap,
  isDownloading,
  isSwapDownloading,
  onDownload,
  onSwapDownload,
  isAudioActionActive,
  onOpenFileLocation,
  onOpenExternally,
  cacheBustKey,
  onAudioDownload,
  onOpenAudioFileLocation,
  onOpenAudioExternally,
  isVideoActionActive,
  isVideoDownloaded,
  ffmpegAction,
  ffmpegProgress,
  onExtractAudioToLibrary,
  isRetrying,
  onCancelDownload,
  videoTags,
  onVideoTagsChanged,
}: {
  video: LibraryVideo;
  metadata: LibraryVideoMetadata;
  selectedEpoch: string | null;
  onSelectEpoch: (epoch: string) => void;
  videoResolutions: Resolution[];
  mp3Resolution: Resolution | undefined;
  selectedFormat: string;
  onFormatChange: (format: string) => void;
  selectedResolution: string;
  isError: boolean;
  downloadErrorKind: string | null;
  downloadStatus: string;
  downloadProgress: number;
  postprocessProgress: number;
  postprocessIndeterminate: boolean;
  swappingQuality: boolean;
  onCancelQualitySwap: () => void;
  isDownloading: boolean;
  isSwapDownloading: boolean;
  onDownload: (resolution: string) => void;
  onSwapDownload: (resolution: string) => void;
  isAudioActionActive: boolean;
  onOpenFileLocation: () => void;
  onOpenExternally: () => void;
  cacheBustKey: number;
  onAudioDownload: () => void;
  onOpenAudioFileLocation: () => void;
  onOpenAudioExternally: () => void;
  isVideoActionActive: boolean;
  isVideoDownloaded: boolean;
  ffmpegAction: 'extractMp3' | 'convert' | 'clip' | 'embedMetadata' | 'extractAudioToLibrary' | 'extractClipMp3' | 'convertClip' | null;
  ffmpegProgress: number;
  onExtractAudioToLibrary: () => void;
  // Shared with LibraryVideoDetail's single useDownloadVideo() instance
  // (same as isDownloading/downloadStatus/etc above) -- applies to whichever
  // of the three downloading blocks below (video, quality swap, audio) is
  // currently showing, since only one can be active at a time.
  isRetrying: boolean;
  onCancelDownload: () => void;
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

  return (
    <>
      {(video.epochs.length > 1 || metadata.downloadedFilePath) &&
        <Stack spacing={1.5}>
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
              <Chip
                color="success"
                label={`${metadata.downloadedResolution}p`}
              />
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
          <Divider />
        </Stack>}

      {swappingQuality ? (
        isSwapDownloading ? (
          <Stack spacing={1} sx={{ p: 1 }}>
            <Typography variant="subtitle1" textAlign="center">
              {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : 'Downloading'}
              {selectedResolution && ` (${selectedResolution}${selectedResolution.toLowerCase() === 'mp3' ? '' : 'p'})`}
            </Typography>
            <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} indeterminate={postprocessIndeterminate} />
            <LongVideoPostprocessWarning duration={metadata.duration} />
            <DownloadCancelControls isRetrying={isRetrying} onCancelDownload={onCancelDownload} />
          </Stack>
        ) : (
          <>
            <ResolutionPicker
              resolutions={videoResolutions}
              excludeResolution={metadata.downloadedResolution}
              onSelect={onSwapDownload}
              selectedFormat={selectedFormat}
              onFormatChange={onFormatChange}
              isError={isError}
              errorKind={downloadErrorKind}
              disabled={isAudioActionActive}
            />
            <Button size="small" onClick={onCancelQualitySwap} sx={{ mt: 1 }}>
              Cancel
            </Button>
          </>
        )
      ) : metadata.downloadedFilePath ? (
        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<FolderOpenIcon />} onClick={onOpenFileLocation}>
            Open file location
          </Button>
          <Button size="small" startIcon={<OpenInNewIcon />} onClick={onOpenExternally}>
            Open in default player
          </Button>
        </Stack>
      ) : isDownloading ? (
        <Stack spacing={1} sx={{ p: 1 }}>
          <Typography variant="subtitle1" textAlign="center">
            {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : 'Downloading'}
            {selectedResolution && ` (${selectedResolution}p)`}
          </Typography>
          <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} indeterminate={postprocessIndeterminate} />
          <LongVideoPostprocessWarning duration={metadata.duration} />
          <DownloadCancelControls isRetrying={isRetrying} onCancelDownload={onCancelDownload} />
        </Stack>
      ) : videoResolutions.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
          No quality info was saved for this entry (it may have been added before this feature, or via testing) --
          re-add it from the Downloader tab to enable downloading here.
        </Typography>
      ) : (
        <ResolutionPicker
          resolutions={videoResolutions}
          onSelect={onDownload}
          selectedFormat={selectedFormat}
          onFormatChange={onFormatChange}
          isError={isError}
          errorKind={downloadErrorKind}
          disabled={isAudioActionActive}
        />
      )}

      {/* Audio (MP3) -- a separate, always-available download, independent
          of video quality. Shares the single download hook with the video
          controls above, so it's disabled rather than hidden during a video
          download/swap. */}
      {mp3Resolution &&
        <>
          <Divider sx={{ my: 1.5 }} />
          <Stack spacing={1}>
            <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
              Audio
            </Typography>
            {isAudioActionActive ? (
              <Stack spacing={1} sx={{ p: 1 }}>
                <Typography variant="subtitle1" textAlign="center">
                  {downloadStatus === 'Postprocessing...' ? 'Postprocessing' : 'Downloading'} (MP3)
                </Typography>
                <LinearProgressWithLabel value={postprocessProgress} valueBuffer={downloadProgress} indeterminate={postprocessIndeterminate} />
                <DownloadCancelControls isRetrying={isRetrying} onCancelDownload={onCancelDownload} />
              </Stack>
            ) : metadata.downloadedAudioFilePath ? (
              // Replaces the download button in place -- the player lives
              // in LibraryVideoPlayer, tied to its own download controls,
              // not alongside the video above.
              <Stack spacing={0.5}>
                <Box
                  component="audio"
                  controls
                  src={buildAppVideoUrl(metadata.downloadedAudioFilePath, cacheBustKey)}
                  sx={{ width: '100%', height: 32 }}
                />
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title="Open file location">
                    <IconButton size="small" onClick={onOpenAudioFileLocation} aria-label="Open audio file location">
                      <FolderOpenIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Open in default player">
                    <IconButton size="small" onClick={onOpenAudioExternally} aria-label="Open audio in default player">
                      <OpenInNewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Re-download MP3">
                    <span>
                      <IconButton
                        size="small"
                        onClick={onAudioDownload}
                        disabled={isVideoActionActive}
                        aria-label="Re-download MP3"
                      >
                        <CloudDownloadIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              </Stack>
            ) : ffmpegAction === 'extractAudioToLibrary' ? (
              <Stack spacing={1} sx={{ p: 1 }}>
                <Typography variant="subtitle1" textAlign="center">Extracting MP3</Typography>
                <LinearProgressWithLabel value={ffmpegProgress} valueBuffer={ffmpegProgress} />
              </Stack>
            ) : (
              <Stack direction="row" spacing={1} alignItems="center">
                <Button
                  size="small"
                  color="secondary"
                  variant="contained"
                  startIcon={<CloudDownloadIcon />}
                  onClick={onAudioDownload}
                  disabled={isVideoActionActive}
                >
                  Download MP3 ({mp3Resolution.filesizeMb}Mb)
                </Button>
                {isVideoDownloaded &&
                  <Tooltip title="Extract MP3 from the already-downloaded video (no re-download)">
                    <span>
                      <IconButton
                        size="small"
                        onClick={onExtractAudioToLibrary}
                        disabled={isVideoActionActive || ffmpegAction !== null}
                        aria-label="Extract MP3 from downloaded video"
                      >
                        <AudiotrackIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>}
              </Stack>
            )}
          </Stack>
        </>}
      <VideoTagsPopover
        open={!!tagsAnchorEl}
        anchorEl={tagsAnchorEl}
        onClose={() => setTagsAnchorEl(null)}
        allTags={allTagNames}
        appliedTags={appliedTagNames}
        onToggle={handleToggleTag}
        onCreate={(tagName) => handleToggleTag(tagName, true)}
      />
    </>
  );
}
