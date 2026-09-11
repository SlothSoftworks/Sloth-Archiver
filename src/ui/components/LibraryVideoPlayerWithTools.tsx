import { useEffect, useRef, useState } from 'react';
import { Alert, Link, Snackbar } from '@mui/material';
import LibraryVideoPlayer, { type LibraryVideoPlayerHandle } from './LibraryVideoPlayer';
import SaveClipDialog from './SaveClipDialog';
import { formatSecondsAsClipTimestamp } from '../screens/FfmpegUtilitiesPanel';
import type { LibraryVideoMetadata, LibraryClip } from '../../types';

const PLAYBACK_POSITION_SAVE_INTERVAL_MS = 10_000;
const RESUME_OFFER_MIN_SECONDS = 5;
const RESUME_OFFER_END_BUFFER_SECONDS = 5;

// Self-contained wrapper around LibraryVideoPlayer: owns the entire
// clip-creation flow (start/end state, SaveClipDialog, the
// createClip/extractClipFromFile IPC calls) so a caller just drops this in
// and gets clipping for free with no state of its own to wire up.
export type LibraryVideoPlayerWithToolsProps = {
  metadata: LibraryVideoMetadata;
  thumbnailPath?: string | null;
  cacheBustKey?: number;
  // Takes priority over metadata.downloadedFilePath for both playback and
  // as the clip's input file.
  overrideFilePath?: string;
  // Library mode (default, standaloneClipping false/unset): clips are saved
  // permanently into this video's own clips/ folder + clips.json manifest.
  // Required in that mode; unused when standaloneClipping is true.
  videoDir?: string;
  // Which epoch's metadata.json to write playback position into -- required
  // alongside videoDir for the resume-position feature (see below), unused
  // in standaloneClipping mode (a clip has no epoch identity of its own).
  epoch?: string | null;
  existingClipTitles?: string[];
  convertFormatOptions: string[];
  // Unused in standaloneClipping mode (there's no LibraryClip record).
  onClipCreated?: (clip: LibraryClip) => void;
  // When true, clip creation never touches the library at all -- no
  // videoDir, no clips.json -- and instead always prompts for a save
  // location via a native file dialog.
  standaloneClipping?: boolean;
  onClipSavedToFile?: (outputPath: string) => void;
};

// "source" means keep the input file's own extension, mirroring the same
// fallback library:createClip's backend already applies.
function extensionForFormat(format: string, inputPath: string): string {
  if (format && format !== 'source') return format;
  const match = /\.([^./\\]+)$/.exec(inputPath);
  return match ? match[1] : 'mp4';
}

export default function LibraryVideoPlayerWithTools({
  metadata, thumbnailPath, cacheBustKey, overrideFilePath, videoDir, epoch, existingClipTitles, convertFormatOptions, onClipCreated,
  standaloneClipping = false, onClipSavedToFile,
}: LibraryVideoPlayerWithToolsProps) {
  const playerRef = useRef<LibraryVideoPlayerHandle>(null);
  const [clipStartSeconds, setClipStartSeconds] = useState<number | null>(null);
  const [clipEndSeconds, setClipEndSeconds] = useState<number | null>(null);
  const [saveClipDialogOpen, setSaveClipDialogOpen] = useState(false);
  const [savingClip, setSavingClip] = useState(false);
  const [saveClipError, setSaveClipError] = useState<string | null>(null);
  const [savedFilePath, setSavedFilePath] = useState<string | null>(null);

  const canTrackPosition = !standaloneClipping && !!videoDir && !!epoch;
  const [resumeToastOpen, setResumeToastOpen] = useState(false);
  const [shouldSavePosition, setShouldSavePosition] = useState(false);
  const saveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!canTrackPosition) return;
    let cancelled = false;
    Promise.all([
      window.electronAPI.getResumeTrackingMode(),
      window.electronAPI.getResumeMinDurationSeconds(),
    ]).then(([{ resumeTrackingMode }, { resumeMinDurationSeconds }]) => {
      if (cancelled) return;
      const duration = metadata.duration;
      const shouldTrack = resumeTrackingMode === 'always'
        || (resumeTrackingMode === 'custom' && duration != null && duration >= resumeMinDurationSeconds);
      setShouldSavePosition(shouldTrack);
    });
    const position = metadata.lastPlaybackPositionSeconds;
    if (
      typeof position === 'number' && position > RESUME_OFFER_MIN_SECONDS
      && (metadata.duration == null || position < metadata.duration - RESUME_OFFER_END_BUFFER_SECONDS)
    ) {
      setResumeToastOpen(true);
    }
    return () => { cancelled = true; };
    // Deliberately mount-only per epoch -- this component's caller remounts
    // it on every epoch switch (see LibraryVideoDetail.tsx's key={selectedEpoch}),
    // so re-running this on every metadata change would re-offer the toast
    // after the position that triggered it has already moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canTrackPosition]);

  const savePosition = (positionSeconds: number) => {
    if (!canTrackPosition || !shouldSavePosition) return;
    window.electronAPI.savePlaybackPosition({ videoDir: videoDir!, epoch: epoch!, positionSeconds: Math.floor(positionSeconds) });
  };

  const handlePlaybackStateChange = (playing: boolean) => {
    if (!canTrackPosition) return;
    if (playing) {
      if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);
      saveIntervalRef.current = setInterval(() => {
        const time = playerRef.current?.getCurrentTime();
        if (time != null) savePosition(time);
      }, PLAYBACK_POSITION_SAVE_INTERVAL_MS);
    } else {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
        saveIntervalRef.current = null;
      }
      const time = playerRef.current?.getCurrentTime();
      if (time != null) savePosition(time);
    }
  };

  // Covers navigating away while still playing -- the interval above would
  // otherwise just get torn down with no final save.
  useEffect(() => () => {
    if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);
  }, []);

  const handleResumePlayback = () => {
    const position = metadata.lastPlaybackPositionSeconds;
    setResumeToastOpen(false);
    if (position == null) return;
    playerRef.current?.seekTo(position);
    playerRef.current?.play();
  };

  const inputPath = overrideFilePath ?? metadata.downloadedFilePath;
  const clipRangeInvalid = clipStartSeconds != null && clipEndSeconds != null && clipEndSeconds < clipStartSeconds + 1;
  const saveDisabled = !inputPath || clipStartSeconds == null || clipEndSeconds == null || clipRangeInvalid;

  const handleSetStart = () => {
    const time = playerRef.current?.getCurrentTime();
    if (time == null) return;
    setClipStartSeconds(Math.floor(time));
  };

  const handleSetEnd = () => {
    const time = playerRef.current?.getCurrentTime();
    if (time == null) return;
    setClipEndSeconds(Math.floor(time));
  };

  const handleClear = () => {
    setClipStartSeconds(null);
    setClipEndSeconds(null);
  };

  const handleOpenSave = () => {
    if (saveDisabled) return;
    setSaveClipError(null);
    setSaveClipDialogOpen(true);
  };

  const handleSubmitSaveClip = async (
    { clipName, start, end, format, forceReencode, saveAsFile }:
      { clipName: string; start: string; end: string; format: string; forceReencode: boolean; saveAsFile: boolean },
  ) => {
    if (!inputPath) return;
    setSavingClip(true);
    setSaveClipError(null);

    // standaloneClipping means every save takes this path; the dialog's own
    // "Save as file" checkbox lets a normal library-mode save opt into it
    // for one clip at a time.
    if (standaloneClipping || saveAsFile) {
      const ext = extensionForFormat(format, inputPath);
      const picked = await window.electronAPI.saveExportedFile({
        defaultName: `${clipName}.${ext}`,
        extensions: [ext],
        inputPath,
      });
      if (picked.canceled || !picked.filePath) {
        setSavingClip(false);
        return;
      }
      const res = await window.electronAPI.extractClipFromFile({
        inputPath, outputPath: picked.filePath, start, end, format, forceReencode,
      });
      setSavingClip(false);
      if (!res.success) {
        setSaveClipError(res.message || 'Failed to save clip.');
        return;
      }
      const savedPath = res.outputPath || picked.filePath;
      onClipSavedToFile?.(savedPath);
      setSavedFilePath(savedPath);
      setSaveClipDialogOpen(false);
      setClipStartSeconds(null);
      setClipEndSeconds(null);
      return;
    }

    const res = await window.electronAPI.createClip({
      videoDir: videoDir!, inputPath, start, end, format, clipName, forceReencode,
    });
    setSavingClip(false);
    if (!res.success || !res.clip) {
      setSaveClipError(res.message || 'Failed to save clip.');
      return;
    }
    onClipCreated?.(res.clip);
    setSaveClipDialogOpen(false);
    setClipStartSeconds(null);
    setClipEndSeconds(null);
  };

  return (
    <>
      <LibraryVideoPlayer
        ref={playerRef}
        metadata={metadata}
        thumbnailPath={thumbnailPath}
        cacheBustKey={cacheBustKey}
        overrideFilePath={overrideFilePath}
        onPlaybackStateChange={handlePlaybackStateChange}
        clipMarkers={{
          startSeconds: clipStartSeconds,
          endSeconds: clipEndSeconds,
          onSetStart: handleSetStart,
          onSetEnd: handleSetEnd,
          onStartSecondsChange: (seconds) => setClipStartSeconds(Math.floor(seconds)),
          onEndSecondsChange: (seconds) => setClipEndSeconds(Math.floor(seconds)),
          onSave: handleOpenSave,
          saveDisabled,
          onClear: handleClear,
          clearDisabled: clipStartSeconds == null && clipEndSeconds == null,
        }}
      />
      <SaveClipDialog
        open={saveClipDialogOpen}
        onClose={() => setSaveClipDialogOpen(false)}
        title={standaloneClipping ? 'Save clip to file' : 'Save clip'}
        defaultClipStart={clipStartSeconds != null ? formatSecondsAsClipTimestamp(clipStartSeconds) : ''}
        defaultClipEnd={clipEndSeconds != null ? formatSecondsAsClipTimestamp(clipEndSeconds) : ''}
        convertFormatOptions={convertFormatOptions}
        existingClipTitles={standaloneClipping ? [] : existingClipTitles || []}
        offerSaveAsFile={!standaloneClipping}
        submitting={savingClip}
        // createClip's progress reports over the same shared
        // ffmpegUtilityProgress channel LibraryVideoDetail.tsx's own listener
        // already owns; that bridge only supports one live subscriber at a
        // time (removeFfmpegUtilityProgressListener is a blunt
        // removeAllListeners), so standing up a second listener here would
        // silently kill that one. Deferred until this component is the
        // *only* thing using the channel.
        progress={0}
        error={saveClipError}
        onSubmit={handleSubmitSaveClip}
      />
      <Snackbar
        open={savedFilePath != null}
        autoHideDuration={6000}
        onClose={() => setSavedFilePath(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSavedFilePath(null)} severity="success" variant="filled">
          Clip saved
          <Link
            component="button"
            onClick={() => {
              if (savedFilePath) window.electronAPI.openFileInDirectory(savedFilePath);
            }}
            color="inherit"
            underline="always"
            sx={{ ml: 1, fontWeight: 'bold', cursor: 'pointer' }}
          >
            View
          </Link>
        </Alert>
      </Snackbar>
      <Snackbar
        open={resumeToastOpen}
        autoHideDuration={8000}
        onClose={() => setResumeToastOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setResumeToastOpen(false)} severity="info" variant="filled">
          Resume where you left off?
          <Link
            component="button"
            onClick={handleResumePlayback}
            color="inherit"
            underline="always"
            sx={{ ml: 1, fontWeight: 'bold', cursor: 'pointer' }}
          >
            Resume
          </Link>
        </Alert>
      </Snackbar>
    </>
  );
}
