import { useEffect, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Box, Button, Card, Link, Snackbar, Stack, Typography } from '@mui/material';
import VideoFileOutlinedIcon from '@mui/icons-material/VideoFileOutlined';
import LibraryVideoPlayerWithTools from '../components/LibraryVideoPlayerWithTools';
import FfmpegUtilitiesPanel, { OTHER_FORMAT_VALUE } from './FfmpegUtilitiesPanel';
import { POPULAR_CONVERT_FORMATS } from '../../utils/ffmpegFormats';
import { formatBytesApprox, formatDurationSeconds } from '../../utils/utils';
import type { LibraryVideoMetadata } from '../../types';
import type { VidToolsFile } from '../../types/electron-api';

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function metadataFor(file: VidToolsFile): LibraryVideoMetadata {
  return {
    downloadedFilePath: null, thumbnail: null, videoId: '', platform: 'local',
    title: baseName(file.name), fullTitle: baseName(file.name), duration: file.duration,
  } as LibraryVideoMetadata;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1}>
      <Typography variant="body2" color="text.secondary" sx={{ width: 90, flexShrink: 0 }}>{label}</Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{value}</Typography>
    </Stack>
  );
}

// Standalone player + ffmpeg tools for any local video, picked or dropped.
// The opened file lives in the caller (MainPage) so it survives a tab
// switch; on remount it's re-opened, which re-registers it with main and
// catches a file moved or deleted in the meantime.
export default function VidToolsScreen({ file, onFileChange }: {
  file: VidToolsFile | null;
  onFileChange: (file: VidToolsFile | null) => void;
}) {
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [customConvertFormats, setCustomConvertFormats] = useState<string[]>([]);
  const [convertFormat, setConvertFormat] = useState('mp4');
  const [otherFormatInput, setOtherFormatInput] = useState('');
  const [forceReencode, setForceReencode] = useState(false);
  const [ffmpegAction, setFfmpegAction] = useState<'extractMp3' | 'convert' | null>(null);
  const [ffmpegProgress, setFfmpegProgress] = useState(0);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [savedToastOpen, setSavedToastOpen] = useState(false);

  useEffect(() => {
    window.electronAPI.getCustomConvertFormats().then(({ customConvertFormats }) => setCustomConvertFormats(customConvertFormats));
    window.electronAPI.onFfmpegUtilityProgress(({ percent }) => {
      if (typeof percent === 'number') setFfmpegProgress(percent);
    });
    return () => window.electronAPI.removeFfmpegUtilityProgressListener();
  }, []);

  const openPath = async (filePath: string) => {
    setOpening(true);
    setOpenError(null);
    const result = await window.electronAPI.openVidToolsFile(filePath);
    setOpening(false);
    if (!result.success) {
      setOpenError(result.message);
      return false;
    }
    setFfmpegError(null);
    onFileChange(result);
    return true;
  };

  useEffect(() => {
    if (!file) return;
    openPath(file.filePath).then((ok) => { if (!ok) onFileChange(null); });
    // Mount-only: re-register the file kept from before the tab switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePick = async () => {
    const result = await window.electronAPI.openLocalVideoFile();
    const picked = result.filePaths?.[0];
    if (picked) await openPath(picked);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files[0];
    if (!dropped) return;
    const droppedPath = window.electronAPI.getPathForFile(dropped);
    if (!droppedPath) {
      setOpenError("Couldn't read the dropped file's location.");
      return;
    }
    await openPath(droppedPath);
  };

  const dropHandlers = {
    onDragOver: handleDragOver,
    onDragLeave: () => setDragActive(false),
    onDrop: handleDrop,
  };

  const runExport = async (
    action: 'extractMp3' | 'convert',
    extension: string,
    run: (outputPath: string) => Promise<{ success: boolean; outputPath?: string; message?: string }>,
    failureMessage: string,
  ) => {
    if (!file) return;
    const picked = await window.electronAPI.saveExportedFile({
      defaultName: `${baseName(file.name)}.${extension}`,
      extensions: [extension],
      inputPath: file.filePath,
    });
    if (picked.canceled || !picked.filePath) return;
    setFfmpegAction(action);
    setFfmpegError(null);
    setFfmpegProgress(0);
    const res = await run(picked.filePath);
    setFfmpegAction(null);
    if (!res.success) {
      setFfmpegError(res.message || failureMessage);
      return;
    }
    setSavedPath(res.outputPath || picked.filePath);
    setSavedToastOpen(true);
  };

  const handleExtractMp3 = () => runExport(
    'extractMp3', 'mp3',
    (outputPath) => window.electronAPI.extractMp3FromFile({ inputPath: file!.filePath, outputPath }),
    'Failed to extract MP3.',
  );

  const handleConvertFormat = () => {
    const targetFormat = (convertFormat === OTHER_FORMAT_VALUE ? otherFormatInput : convertFormat).trim().toLowerCase();
    if (!targetFormat) return;
    return runExport(
      'convert', targetFormat,
      (outputPath) => window.electronAPI.convertFileFormat({ inputPath: file!.filePath, outputPath, format: targetFormat, forceReencode }),
      'Failed to convert.',
    );
  };

  const convertFormatOptions = [
    ...POPULAR_CONVERT_FORMATS,
    ...customConvertFormats.filter((f) => !POPULAR_CONVERT_FORMATS.includes(f.toLowerCase())),
  ];

  if (!file) {
    return (
      <Stack spacing={2} alignItems="center">
        <Box
          {...dropHandlers}
          data-testid="vidtools-drop-zone"
          sx={{
            width: '100%', maxWidth: 720, minHeight: 280, p: 4,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
            border: 2, borderStyle: 'dashed', borderRadius: 2,
            borderColor: dragActive ? 'primary.main' : 'divider',
            bgcolor: dragActive ? 'action.hover' : 'transparent',
            textAlign: 'center',
          }}
        >
          <VideoFileOutlinedIcon sx={{ fontSize: 56, color: 'text.secondary' }} />
          <Typography variant="h6">Drop a video here</Typography>
          <Typography variant="body2" color="text.secondary">
            Play, clip, convert or extract audio from any video on your computer. Your original file is never changed.
          </Typography>
          <Button variant="contained" onClick={handlePick} disabled={opening}>Choose video</Button>
        </Box>
        {openError && <Alert severity="error" onClose={() => setOpenError(null)}>{openError}</Alert>}
      </Stack>
    );
  }

  const resolution = file.width && file.height ? `${file.width}×${file.height}` : '';
  const codecs = [file.videoCodec, file.audioCodec].filter(Boolean).join(' / ');

  return (
    <Box {...dropHandlers} sx={{ outline: dragActive ? 2 : 0, outlineStyle: 'dashed', outlineColor: 'primary.main', outlineOffset: 8, borderRadius: 1 }}>
      {openError && <Alert severity="error" onClose={() => setOpenError(null)} sx={{ mb: 2 }}>{openError}</Alert>}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <Stack spacing={2} sx={{ width: { xs: '100%', md: '70%' } }}>
          <LibraryVideoPlayerWithTools
            key={file.filePath}
            metadata={metadataFor(file)}
            overrideFilePath={file.filePath}
            convertFormatOptions={convertFormatOptions}
            standaloneClipping
            confirmPreview={file.needsPreview ? { kind: file.previewKind } : undefined}
            hideAddToQueue
          />
        </Stack>

        <Stack spacing={2} sx={{ width: { xs: '100%', md: '30%' } }}>
          <Card variant="outlined" sx={{ p: 1.5 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle1" sx={{ overflowWrap: 'anywhere' }}>{file.name}</Typography>
              <InfoRow label="Folder" value={file.dir} />
              <InfoRow label="Size" value={formatBytesApprox(file.sizeBytes)} />
              {file.duration != null && <InfoRow label="Duration" value={formatDurationSeconds(file.duration)} />}
              {resolution && <InfoRow label="Resolution" value={resolution} />}
              {codecs && <InfoRow label="Codecs" value={codecs} />}
              <Stack direction="row" spacing={1} sx={{ pt: 0.5, flexWrap: 'wrap' }}>
                <Button size="small" onClick={() => window.electronAPI.openFileInDirectory(file.filePath)}>Show in folder</Button>
                <Button size="small" onClick={() => navigate('/library', { state: { addLocalFilePath: file.filePath } })}>Add to library</Button>
                <Button size="small" color="inherit" onClick={() => onFileChange(null)} disabled={ffmpegAction !== null}>Close file</Button>
              </Stack>

              <FfmpegUtilitiesPanel
                ffmpegAction={ffmpegAction}
                ffmpegProgress={ffmpegProgress}
                ffmpegError={ffmpegError}
                isVideoDownloaded
                hasAudioFile={false}
                isGeneric={false}
                convertFormat={convertFormat}
                setConvertFormat={setConvertFormat}
                convertFormatOptions={convertFormatOptions}
                otherFormatInput={otherFormatInput}
                setOtherFormatInput={setOtherFormatInput}
                forceReencode={forceReencode}
                setForceReencode={setForceReencode}
                onExtractMp3={handleExtractMp3}
                onConvertFormat={handleConvertFormat}
              />
            </Stack>
          </Card>
        </Stack>
      </Stack>

      <Snackbar
        open={savedToastOpen}
        autoHideDuration={6000}
        onClose={() => setSavedToastOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSavedToastOpen(false)} severity="success" variant="filled">
          Saved
          <Link
            component="button"
            onClick={() => { if (savedPath) window.electronAPI.openFileInDirectory(savedPath); }}
            color="inherit"
            underline="always"
            sx={{ ml: 1, fontWeight: 'bold', cursor: 'pointer' }}
          >
            View
          </Link>
        </Alert>
      </Snackbar>
    </Box>
  );
}
