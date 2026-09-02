import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type YtdlpUpdateStage =
  | 'idle'
  | 'checking'
  | 'fetching'
  | 'installing'
  | 'verifying'
  | 'done'
  | 'error';

const STAGE_LABELS: Record<YtdlpUpdateStage, string> = {
  idle: '',
  checking: 'Checking for updates...',
  fetching: 'Downloading latest yt-dlp...',
  installing: 'Installing...',
  verifying: 'Verifying...',
  done: 'Update complete',
  error: 'Update failed',
};

// Every stage that means "an update is actively in flight" -- shared by
// YtdlpUpdateDialog.tsx (the full-view overlay) and OptionsScreen.tsx (the
// button/chip state), exported once here rather than each duplicating its
// own copy of this set.
export const IN_PROGRESS_STAGES = new Set<YtdlpUpdateStage>([
  'checking',
  'fetching',
  'installing',
  'verifying',
]);

// A single instance of this state lives at the app root (see
// YtdlpUpdaterProvider below) so there's exactly one 'ytdlpUpdateProgress'
// IPC listener -- the preload bridge's removeYtdlpUpdateProgressListener
// calls ipcRenderer.removeAllListeners, so two independent consumers
// (e.g. a startup dialog and the Options tab both mounted at once) would
// wipe out each other's listener on unmount if each held its own instance.
function useYtdlpUpdaterState() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [latestVersion, setLatestVersion] = useState('');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [stage, setStage] = useState<YtdlpUpdateStage>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);
  // Set from the 'error'-stage progress broadcast (see main.mjs's
  // ytdlp:startUpdate handler) rather than from the rejected startUpdate()
  // call below -- a thrown Error's own properties don't survive the IPC
  // trip, but this rides along on the same structured-cloned broadcast that
  // already carries `stage`.
  const [verificationFailure, setVerificationFailure] = useState(false);

  useEffect(() => {
    window.electronAPI.onYtdlpUpdateProgress(({ stage, verificationFailure }: { stage: string; verificationFailure?: boolean }) => {
      setStage(stage as YtdlpUpdateStage);
      if (stage === 'error') setVerificationFailure(!!verificationFailure);
    });
    return () => {
      window.electronAPI.removeYtdlpUpdateProgressListener();
    };
  }, []);

  const checkForUpdate = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const result = await window.electronAPI.checkForYtdlpUpdate();
      setCurrentVersion(result.current);
      setLatestVersion(result.latest ?? '');
      setUpdateAvailable(result.updateAvailable);
      setCheckError(result.latest === null ? 'Could not check for the latest version.' : null);
      return result;
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Failed to check for updates.');
      return null;
    } finally {
      setChecking(false);
    }
  };

  const startUpdate = async () => {
    setUpdateError(null);
    setVerificationFailure(false);
    setStage('checking');
    try {
      await window.electronAPI.startYtdlpUpdate();
      // No restart needed: ytdlpPath is just a path string re-read on every
      // spawn call, so the freshly swapped-in binary is already what the next
      // video-info/download call will use. Drop straight back to idle so the
      // app just renders as normal.
      setUpdateAvailable(false);
      setStage('idle');
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Failed to update yt-dlp.');
    }
  };

  const quit = () => {
    window.electronAPI.quitApp();
  };

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    checking,
    checkError,
    stage,
    stageLabel: STAGE_LABELS[stage],
    updateError,
    verificationFailure,
    checkForUpdate,
    startUpdate,
    quit,
  };
}

type YtdlpUpdaterContextValue = ReturnType<typeof useYtdlpUpdaterState>;

const YtdlpUpdaterContext = createContext<YtdlpUpdaterContextValue | null>(null);

export function YtdlpUpdaterProvider({ children }: { children: ReactNode }) {
  const value = useYtdlpUpdaterState();
  return (
    <YtdlpUpdaterContext.Provider value={value}>
      {children}
    </YtdlpUpdaterContext.Provider>
  );
}

export function useYtdlpUpdater() {
  const ctx = useContext(YtdlpUpdaterContext);
  if (!ctx) {
    throw new Error('useYtdlpUpdater must be used within a YtdlpUpdaterProvider');
  }
  return ctx;
}
