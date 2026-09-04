import { useState, useEffect, useRef } from 'react';
import type { DownloadProgressMessage, DownloadVideoParams } from '../../types'

function useDownloadVideo() {
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [postprocessProgress, setPostprocessProgress] = useState(0);
  // True only for yt-dlp's own merge-step postprocessing (started, no real
  // percentage yet) -- distinct from postprocessProgress's 2-state 50/100
  // approximation below, so consumers can show an indeterminate bar instead
  // of a percentage that isn't actually measuring anything.
  const [postprocessIndeterminate, setPostprocessIndeterminate] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState("Idle");
  const [finalFilePath, setFinalFilePath] = useState<string>('');
  const [isDone, setIsDone] = useState(false);
  const [isError, setIsError] = useState(false);
  const [downloadError, setDownloadError] = useState<object | null> ();
  // Clean, single-purpose readout of the classified failure kind (see
  // src/electron/downloadErrors.mjs) -- 'cancelled' specifically lets
  // consumers show "Cancelled" instead of a generic "Download failed" for a
  // deliberate user action. downloadError above stays as-is for existing
  // consumers that read the raw message off it.
  const [downloadErrorKind, setDownloadErrorKind] = useState<string | null>(null);
  // Set while a retryable failure is auto-retrying in the main process (see
  // src/electron/downloadErrors.mjs) -- distinct from isError, which is only
  // set once retries are exhausted or the failure kind isn't retryable at all.
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; kind: string; nextAttemptInMs: number } | null>(null);
  // 'progressUpdate' is one shared broadcast channel, not scoped
  // per-download -- this hook can be mounted several times at once, so
  // every message must be checked against this instance's own in-flight
  // request first, or one download's progress bleeds into another's UI.
  // A ref, not state, since the listener closure needs the current value
  // without re-subscribing on every change.
  const requestIdRef = useRef<string | null>(null);


    const startDownload = (props: DownloadVideoParams) => {
        const { videoUrl, outputPath, format, resolution, overwriteMode, additionalOptions } = props;
        const requestId = crypto.randomUUID();
        requestIdRef.current = requestId;

        setDownloadProgress(0);
        setPostprocessProgress(0);
        setPostprocessIndeterminate(false);
        setDownloadStatus("Idle");
        setFinalFilePath('');
        setIsDone(false);
        setIsError(false);
        setDownloadError(null);
        setDownloadErrorKind(null);
        setIsRetrying(false);
        setRetryInfo(null);

        window.electronAPIPythonDownload.startDownloadPython({ videoUrl, outputPath, format, resolution, overwriteMode, additionalOptions, requestId })
    }

    // Only meaningful while this hook's own download is in flight -- the main
    // process looks up the process by requestId, so calling this for any
    // other/already-finished download is just a harmless no-op there.
    const cancelDownload = () => {
        if (!requestIdRef.current) return;
        window.electronAPIPythonDownload.cancelDownload(requestIdRef.current);
    }

    useEffect(() => {
      const listener = window.electronAPIPythonDownload.onProgressUpdate((msg: DownloadProgressMessage) => {
        if (msg.requestId !== requestIdRef.current) return;
        const { type, payload } = msg;
        let accumErr: object = msg;
        // A retry that starts making progress again (or finishes) is no
        // longer "retrying" -- only the 'retrying' case itself should leave
        // this true.
        if (type !== 'retrying') setIsRetrying(false);
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
              // A real, continuous percentage from our own direct ffmpeg
              // pass. Deliberately NOT clamped non-decreasing like the
              // download case above: yt-dlp's own merge step (the else
              // branch) can leave postprocessProgress at 100 already, and
              // clamping here would stick our real, near-0-starting percent
              // at 100 instead of showing real progress.
              setPostprocessIndeterminate(false);
              setPostprocessProgress(payload.postprocessPercent);
            } else {
              // yt-dlp's own merge-step postprocessing only ever reports
              // started/finished, never a real percentage. A stuck-at-50%
              // bar reads as broken (especially noticeable on a long
              // recording, where this step can legitimately run for a
              // while) -- consumers should render an indeterminate bar
              // instead while this is true, rather than trusting
              // postprocessProgress's 50/100 approximation as a real value.
              setPostprocessIndeterminate(payload.stage === 'start');
              setPostprocessProgress(payload.stage === 'start' ? 50 : 100);
            }
            break;
          case 'retrying':
            setIsRetrying(true);
            setDownloadStatus('Retrying...');
            setRetryInfo({ attempt: payload.attempt ?? 0, kind: payload.kind ?? 'unknown', nextAttemptInMs: payload.nextAttemptInMs ?? 0 });
            break;
          case 'error':
            console.error('Download error', msg)
            setIsError(true);
            setIsRetrying(false);
            setDownloadErrorKind(payload.kind ?? null);
            setPostprocessIndeterminate(false);
            if (downloadError != null) {
              accumErr = { previous: downloadError, current: msg };
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
            setPostprocessIndeterminate(false);
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
    postprocessIndeterminate,
    downloadStatus,
    isDone,
    isError,
    downloadError,
    downloadErrorKind,
    isRetrying,
    retryInfo,
    startDownload,
    cancelDownload,
  };
}

export default useDownloadVideo;
