import { createContext, useContext, useState, type ReactNode } from 'react';

// Mirrors useYtdlpUpdater.tsx's provider pattern -- a single instance lives
// at the app root so the Downloader tab (which increments) and the Library
// tab's badge (which reads/resets) share the same counter instead of each
// holding an independent, unsynced copy.
function useLibraryNotificationState() {
  const [count, setCount] = useState(0);

  const increment = () => setCount((c) => c + 1);
  const reset = () => setCount(0);

  return { count, increment, reset };
}

type LibraryNotificationContextValue = ReturnType<typeof useLibraryNotificationState>;

const LibraryNotificationContext = createContext<LibraryNotificationContextValue | null>(null);

export function LibraryNotificationProvider({ children }: { children: ReactNode }) {
  const value = useLibraryNotificationState();
  return (
    <LibraryNotificationContext.Provider value={value}>
      {children}
    </LibraryNotificationContext.Provider>
  );
}

export function useLibraryNotification() {
  const ctx = useContext(LibraryNotificationContext);
  if (!ctx) {
    throw new Error('useLibraryNotification must be used within a LibraryNotificationProvider');
  }
  return ctx;
}
