import { useState, useEffect } from 'react';
import type { DownloadProgressMessage, DownloadVideoParams } from '../../types'

function useDownloadVideo() {
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [postprocessProgress, setPostprocessProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState("Idle");
  const [finalFilePath, setFinalFilePath] = useState<string>('');
  const [isDone, setIsDone] = useState(false);
  const [isError, setIsError] = useState(false);
  const [downloadError, setDownloadError] = useState<object | null> ();


    const startDownload = (props: DownloadVideoParams) => {
        const { videoUrl, outputPath, format, resolution, overwriteMode, additionalOptions } = props;

        setDownloadProgress(0);
        setPostprocessProgress(0);
        setDownloadStatus("Idle");
        setFinalFilePath('');
        setIsDone(false);
        setIsError(false);
        setDownloadError(null);

        window.electronAPIPythonDownload.startDownloadPython({ videoUrl, outputPath, format, resolution, overwriteMode, additionalOptions })
    }

    useEffect(() => {
      window.electronAPIPythonDownload.onProgressUpdate((msg: DownloadProgressMessage) => {
        const { type, payload } = msg;
        let accumErr = msg;
        switch(type) {
          case 'progress':
            setDownloadProgress(parseInt(payload.percent.replace('%', '')));
            setDownloadStatus('progress');
            break;
          case 'downloading':
            setDownloadStatus('Downloading...');
            break;
          case 'postprocessing':
            setDownloadStatus('Postprocessing...')
            // yt-dlp's postprocess progress-template only reports discrete
            // started/finished events per processing step, never a real
            // percentage -- so this is a deliberate 2-state approximation
            // rather than fake precision.
            setPostprocessProgress(payload.stage === 'start' ? 50 : 100);
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
        window.electronAPIPythonDownload.removeProgressListener();
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
