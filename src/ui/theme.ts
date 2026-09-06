import { createTheme } from '@mui/material/styles';

export type ThemeMode = 'light' | 'dark';
// 'default' is this app's original plain-MUI look; 'slothui' is the palette
// pulled from SlothArchiver-info's landing page (see the dossier's own
// potentialThemes.md for the full color-by-color derivation and caveats).
export type ThemeName = 'default' | 'slothui';

const defaultLightTheme = createTheme();
const defaultDarkTheme = createTheme({ palette: { mode: 'dark' } });

const SLOTHUI_FONT_FAMILY = "'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif";
// The landing page's card radius -- its separate pill (999px) button radius
// isn't representable as a single global `shape.borderRadius`, so it's left
// as a future per-component (MuiButton) override rather than approximated
// here.
const SLOTHUI_BORDER_RADIUS = 14;

// The landing page's button/link hover goes *lighter* on the dark background
// (accent -> accent-strong, `#9ad24a` -> `#b8e368`) but *darker* on the light
// background (`#5f8f22` -> `#4c7519`) -- the opposite of MUI's own
// mode-independent light/dark convention. Modeling that faithfully means
// dark mode's hover state lives in `primary.light` and light mode's in
// `primary.dark`, rather than just mirroring the same pair of colors.
const slothUILightTheme = createTheme({
  palette: {
    mode: 'light',
    background: { default: '#faf9f4', paper: '#ffffff' },
    divider: '#e2e0d2',
    text: { primary: '#1b1d16', secondary: '#4d5142', disabled: '#82866f' },
    primary: { main: '#5f8f22', dark: '#4c7519', contrastText: '#ffffff' },
    // No true error/info color exists in the source palette (see
    // potentialThemes.md's caveats) -- left at MUI's own defaults rather
    // than guessed at.
    success: { main: '#9ad24a' },
    warning: { main: '#b25a34' },
  },
  typography: { fontFamily: SLOTHUI_FONT_FAMILY },
  shape: { borderRadius: SLOTHUI_BORDER_RADIUS },
});

const slothUIDarkTheme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#10120f', paper: '#191c17' },
    divider: '#2a2e24',
    text: { primary: '#eef0e6', secondary: '#b7bca9', disabled: '#7d8172' },
    primary: { main: '#9ad24a', light: '#b8e368', contrastText: '#10120f' },
    success: { main: '#9ad24a' },
    warning: { main: '#e08a5e' },
  },
  typography: { fontFamily: SLOTHUI_FONT_FAMILY },
  shape: { borderRadius: SLOTHUI_BORDER_RADIUS },
});

const THEMES: Record<ThemeName, Record<ThemeMode, ReturnType<typeof createTheme>>> = {
  default: { light: defaultLightTheme, dark: defaultDarkTheme },
  slothui: { light: slothUILightTheme, dark: slothUIDarkTheme },
};

export function getTheme(mode: ThemeMode, themeName: ThemeName = 'default') {
  return (THEMES[themeName] ?? THEMES.default)[mode];
}
