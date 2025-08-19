import { useState, useEffect } from 'react';
import type { DownloadProgressMessage, DownloadVideoParams } from '../../types'

function useDownloadVideo() {
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState("Idle");
  const [finalFilePath, setFinalFilePath] = useState<string>('');
  const [isDone, setIsDone] = useState(false);
  const [isError, setIsError] = useState(false);
  const [downloadError, setDownloadError] = useState<object | null> ();

    
    const startDownload = (props: DownloadVideoParams) => {
        const { videoUrl, outputPath, format, resolution, additionalOptions } = props;

        setDownloadProgress(0);
        setDownloadStatus("Idle");
        setFinalFilePath('');
        setIsDone(false);
        setIsError(false);
        setDownloadError(null);

        window.electronAPIPythonDownload.startDownloadPython({ videoUrl, outputPath, format, resolution, additionalOptions })
    }

    useEffect(() => {
      window.electronAPIPythonDownload.onProgressUpdate((msg: DownloadProgressMessage) => {
        const { type, payload } = msg;
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
            break;
          case 'error':
            console.error('Download error', msg)
            setIsError(true);
            setDownloadError(msg);
            break;
            case 'downloadDone':
              setDownloadStatus('downloadDone');
              setDownloadProgress(99);
              break;
          case 'done':
            setDownloadStatus('Done');
            setFinalFilePath(payload.filename);
            setDownloadProgress(100);
            setIsDone(true);
            break;
        }
      });
  
      return () => {
        window.electronAPIPythonDownload.removeProgressListener();
      }
  
    })

  return {
    finalFilePath,
    downloadProgress,
    downloadStatus,
    isDone,
    isError,
    downloadError,
    startDownload
  };
}

export default useDownloadVideo;
