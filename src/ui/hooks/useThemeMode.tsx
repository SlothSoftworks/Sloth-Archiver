import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThemeMode } from '../theme';

// Single instance at the app root (see ThemeModeProvider below) -- both
// App.tsx (which picks the actual MUI theme object) and the Options tab's
// selector need to read/drive the same value, not independent copies.
function useThemeModeState() {
  const [mode, setModeState] = useState<ThemeMode>('light');

  useEffect(() => {
    window.electronAPI.getThemeMode().then(({ themeMode }) => setModeState(themeMode));
  }, []);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    window.electronAPI.setThemeMode(next);
  };

  return { mode, setMode };
}

type ThemeModeContextValue = ReturnType<typeof useThemeModeState>;

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const value = useThemeModeState();
  return (
    <ThemeModeContext.Provider value={value}>
      {children}
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode() {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode must be used within a ThemeModeProvider');
  }
  return ctx;
}
