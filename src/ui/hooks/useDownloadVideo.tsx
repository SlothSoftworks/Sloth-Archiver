import { useState, useEffect, useRef } from 'react';
import type { DownloadProgressMessage, DownloadVideoParams } from '../../types'

function useDownloadVideo() {
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [postprocessProgress, setPostprocessProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState("Idle");
  const [finalFilePath, setFinalFilePath] = useState<string>('');
  const [isDone, setIsDone] = useState(false);
  const [isError, setIsError] = useState(false);
  const [downloadError, setDownloadError] = useState<object | null> ();
  // 'progressUpdate' is one shared broadcast channel, not scoped
  // per-download (TD-008) -- this hook can be mounted several times at
  // once, so every message must be checked against this instance's own
  // in-flight request first, or one download's progress bleeds into
  // another's UI. A ref, not state, since the listener closure needs the
  // current value without re-subscribing on every change.
  const requestIdRef = useRef<string | null>(null);


    const startDownload = (props: DownloadVideoParams) => {
        const { videoUrl, outputPath, format, resolution, overwriteMode, additionalOptions } = props;
        const requestId = crypto.randomUUID();
        requestIdRef.current = requestId;

        setDownloadProgress(0);
        setPostprocessProgress(0);
        setDownloadStatus("Idle");
        setFinalFilePath('');
        setIsDone(false);
        setIsError(false);
        setDownloadError(null);

        window.electronAPIPythonDownload.startDownloadPython({ videoUrl, outputPath, format, resolution, overwriteMode, additionalOptions, requestId })
    }

    useEffect(() => {
      const listener = window.electronAPIPythonDownload.onProgressUpdate((msg: DownloadProgressMessage) => {
        if (msg.requestId !== requestIdRef.current) return;
        const { type, payload } = msg;
        let accumErr = msg;
        switch(type) {
          case 'progress': {
            // yt-dlp reports progress per-stream, not for the whole download
            // -- a video+audio download runs as two separate 0-100%
            // sequences, so a naive assignment would jump back down when the
            // second stream starts. Simplest fix: never let the displayed
            // value decrease within a single download.
            const newPercent = parseInt(payload.percent.replace('%', ''));
            setDownloadProgress((prev) => Math.max(prev, newPercent));
            setDownloadStatus('progress');
            break;
          }
          case 'downloading':
            setDownloadStatus('Downloading...');
            break;
          case 'postprocessing':
            setDownloadStatus('Postprocessing...')
            if (typeof payload.postprocessPercent === 'number') {
              // A real, continuous percentage from our own direct ffmpeg pass
              // (TD-004). Deliberately NOT clamped non-decreasing like the
              // download case above: yt-dlp's own merge step (the else
              // branch) can leave postprocessProgress at 100 already, and
              // clamping here would stick our real, near-0-starting percent
              // at 100 instead of showing real progress.
              setPostprocessProgress(payload.postprocessPercent);
            } else {
              // yt-dlp's own merge-step postprocessing only ever reports
              // started/finished, never a real percentage -- a deliberate
              // 2-state approximation, fine here since a plain stream merge
              // is fast, not the slow re-encode case TD-004 is about.
              setPostprocessProgress(payload.stage === 'start' ? 50 : 100);
            }
            break;
          case 'error':
            console.error('Download error', msg)
            setIsError(true);
            if (downloadError != null) {
              accumErr = JSON.stringify(downloadError) + '\n' + JSON.stringify(msg);
            }
            setDownloadError(accumErr);
            break;
            case 'downloadDone':
              setDownloadStatus('downloadDone');
              setDownloadProgress(100);
              break;
          case 'done':
            setDownloadStatus('Done');
            setFinalFilePath(payload.filename);
            setDownloadProgress(100);
            setPostprocessProgress(100);
            setIsDone(true);
            break;
        }
      });

      return () => {
        window.electronAPIPythonDownload.removeProgressListener(listener);
      }

    }, [])

  return {
    finalFilePath,
    downloadProgress,
    postprocessProgress,
    downloadStatus,
    isDone,
    isError,
    downloadError,
    startDownload
  };
}

export default useDownloadVideo;
