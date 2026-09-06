import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThemeMode, ThemeName } from '../theme';

// Single instance at the app root (see ThemeModeProvider below) -- both
// App.tsx (which picks the actual MUI theme object) and the Options tab's
// selectors need to read/drive the same values, not independent copies.
// Covers both the light/dark mode and the overall theme (name) -- kept in
// one hook/provider since both are read together to pick the final MUI
// theme object (see App.tsx's getTheme(mode, themeName)), not because
// they're otherwise related.
function useThemeModeState() {
  // Matches the main process's own fresh-install defaults (dark + SlothUI,
  // see settings.mjs's THEME_NAME_DEFAULT and main.mjs's getThemeMode
  // handler) so the very first paint, before getThemeMode/getThemeName
  // resolve, doesn't flash the old light/default look first.
  const [mode, setModeState] = useState<ThemeMode>('dark');
  const [themeName, setThemeNameState] = useState<ThemeName>('slothui');

  useEffect(() => {
    window.electronAPI.getThemeMode().then(({ themeMode }) => setModeState(themeMode));
    window.electronAPI.getThemeName().then(({ themeName }) => setThemeNameState(themeName));
  }, []);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    window.electronAPI.setThemeMode(next);
  };

  const setThemeName = (next: ThemeName) => {
    setThemeNameState(next);
    window.electronAPI.setThemeName(next);
  };

  return { mode, setMode, themeName, setThemeName };
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
