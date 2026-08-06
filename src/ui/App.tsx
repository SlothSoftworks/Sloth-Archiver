
import { useEffect } from 'react';
import { Route, Routes } from 'react-router';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import './App.css'
import MainPage from './MainPage';
import Other from './other';
import { electronAPIMock, electronAPIPythonDownloadMock } from '../../testing/mockData/electronAPIMocks.ts'
import { getTheme } from './theme';
import { YtdlpUpdaterProvider } from './hooks/useYtdlpUpdater';
import { LibraryNotificationProvider } from './hooks/useLibraryNotifications';
import { BulkAddProvider } from './hooks/useBulkAddQueue.tsx';
import { ThemeModeProvider, useThemeMode } from './hooks/useThemeMode.tsx';

// Forwards uncaught renderer errors to the same main.log a crashed main
// process already writes to (see errorLog:report in main.js) -- the renderer
// has no filesystem access of its own under contextIsolation/sandbox, so
// this is the only way a JS error here ends up somewhere the user can read.
function useRendererErrorLogging() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      window.electronAPI.reportRendererError({
        message: event.message,
        stack: event.error?.stack || `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      window.electronAPI.reportRendererError({
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);
}

// Split out from App() so useThemeMode() (which needs ThemeModeProvider as an
// ancestor) can pick the actual MUI theme object -- ThemeModeProvider has to
// wrap this, not live inside it.
function AppContent() {
  const { mode } = useThemeMode();

  return (
    <ThemeProvider theme={getTheme(mode)}>
      <CssBaseline />
      <YtdlpUpdaterProvider>
        <LibraryNotificationProvider>
          <BulkAddProvider>
            <Routes>
              <Route path="/" element={<MainPage />}></Route>
              <Route path="/other" element={<Other />}/>
            </Routes>
          </BulkAddProvider>
        </LibraryNotificationProvider>
      </YtdlpUpdaterProvider>
    </ThemeProvider>
  );
}

function App() {

  if (!window.electronAPI) {
    window.mockingElectron = "yes";
    window.electronAPI = electronAPIMock;
    window.electronAPIPythonDownload = electronAPIPythonDownloadMock;
  }

  useRendererErrorLogging();

  return (
    <ThemeModeProvider>
      <AppContent />
    </ThemeModeProvider>
  )
}

export default App
