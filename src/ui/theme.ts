import { createTheme } from '@mui/material/styles';

export type ThemeMode = 'light' | 'dark';

const lightTheme = createTheme();
const darkTheme = createTheme({ palette: { mode: 'dark' } });

export function getTheme(mode: ThemeMode) {
  return mode === 'dark' ? darkTheme : lightTheme;
}

export default lightTheme;
