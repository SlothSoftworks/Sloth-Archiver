import * as React from 'react';
import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router';
import Button from '@mui/material/Button';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Badge from '@mui/material/Badge';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import './App.css';
import './MainPage.css';
import DownloaderScreen from './screens/DownloaderScreen';
import OptionsScreen from './screens/OptionsScreen';
import LibraryScreen from './screens/LibraryScreen';
import YtdlpUpdateDialog from './components/YtdlpUpdateDialog';
import BulkAddSidePanel, { BulkAddToggleButton } from './components/BulkAddSidePanel';
import { useLibraryNotification } from './hooks/useLibraryNotifications';
import ltxImage from '../assets/ltx.jpeg';

const LIBRARY_TAB_INDEX = 1;
const OPTIONS_TAB_INDEX = 2;
const TAB_PATHS = ['/', '/library', '/options'];

// The active tab is derived from the current location rather than its own
// local state -- lets an internal "hyperlink" (the add-success toast, a
// finished bulk-add item) switch tabs just by navigating, e.g. to
// /library/video/:videoId. Deep-link paths under /library still count as
// the Library tab being active.
function pathToTabIndex(pathname: string): number {
  if (pathname.startsWith('/library')) return LIBRARY_TAB_INDEX;
  if (pathname === '/options') return OPTIONS_TAB_INDEX;
  return 0;
}

function MainPage() {

  return (
    <>
      <BasicTabs/>
      <YtdlpUpdateDialog/>
    </>
  )
}

export default MainPage;


interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
  // Opt-in for a screen that needs a definite height to lay its own content
  // out against -- e.g. LibraryScreen's bottom options bar, which has to
  // stay pinned at the tab's bottom regardless of content length rather than
  // just being the last thing before .tabContainer's own scrollbar kicks in.
  // Deliberately unpadded (unlike the plain p:3 Box below) so a full-bleed
  // bottom bar can span the tab's actual width, the same way the top tab bar
  // above .tabContainer isn't padded either -- the screen itself is
  // responsible for padding whichever inner region needs it (its own
  // scrollable content, not the bar). Downloader/Options don't need any of
  // this and keep the plain auto-height, padded Box, scrolled via
  // .tabContainer as before.
  fill?: boolean;
}

function CustomTabPanel(props: TabPanelProps) {
  const { children, value, index, fill, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`simple-tabpanel-${index}`}
      aria-labelledby={`simple-tab-${index}`}
      className='tabContainer'
      {...other}
    >
      {value === index &&
        <Box sx={fill ? { height: '100%', display: 'flex', flexDirection: 'column' } : { p: 3 }}>
          {children}
        </Box>}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `simple-tab-${index}`,
    'aria-controls': `simple-tabpanel-${index}`,
  };
}

export function BasicTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const value = pathToTabIndex(location.pathname);
  const [infoOpen, setInfoOpen] = useState(false);
  // Statically shown in the top bar for the duration of alpha testing --
  // makes it trivial for a tester to say exactly which build they're
  // reporting a bug against. Options also shows this (OptionsScreen.tsx)
  // for after alpha, once this top-bar copy is removed.
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    window.electronAPI.getAppVersion().then(setAppVersion);
  }, []);
  const { count: libraryNotificationCount, reset: resetLibraryNotifications } = useLibraryNotification();
  // Bumped to force LibraryScreen to remount (see its `key` below) -- every
  // other tab gets this reset for free, since CustomTabPanel only renders a
  // tab's content while active. Library's own drill-down and Videos/
  // Playlists toggle are local state, not URL-driven, so re-navigating to
  // the already-active Library tab is normally a no-op that leaves them
  // untouched -- this key bump makes clicking Library while on it behave
  // like any other tab: back to its own start.
  const [libraryResetKey, setLibraryResetKey] = useState(0);

  const handleChange = (event: React.SyntheticEvent, newValue: number) => {
    navigate(TAB_PATHS[newValue]);
    if (newValue === LIBRARY_TAB_INDEX) {
      resetLibraryNotifications();
    }
  };

  // MUI's Tab only calls the Tabs-level onChange when the clicked tab isn't
  // already selected, so clicking the already-active Library tab never
  // reaches handleChange -- exactly the click this needs to catch. Tab's
  // own onClick fires unconditionally, so the reset lives here instead,
  // gated on "was already on Library" so it doesn't double-fire on a
  // genuine switch into Library (which already remounts via CustomTabPanel).
  const handleLibraryTabClick = () => {
    if (value === LIBRARY_TAB_INDEX) {
      setLibraryResetKey((prev) => prev + 1);
    }
  };

  return (
    <Box className="mainTabs" sx={{ width: '100%' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Tabs value={value} onChange={handleChange} aria-label="basic tabs example">
          <Tab label="Downloader" {...a11yProps(0)} />
          <Tab
            label={
              <Badge badgeContent={libraryNotificationCount} color="error" max={99} sx={{ px: libraryNotificationCount > 0 ? 1 : 0 }}>
                Library
              </Badge>
            }
            onClick={handleLibraryTabClick}
            {...a11yProps(LIBRARY_TAB_INDEX)}
          />
          <Tab label="Options" {...a11yProps(2)} />
        </Tabs>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mr: 1 }}>
          {appVersion &&
            <Chip size="small" variant="outlined" label={`v${appVersion}`} sx={{ fontFamily: 'monospace' }} />}
          <BulkAddToggleButton />
          <Tooltip title="About">
            <IconButton size="small" onClick={() => setInfoOpen(true)} aria-label="About">
              <InfoOutlinedIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>
      <CustomTabPanel value={value} index={0}>
        <DownloaderScreen/>
      </CustomTabPanel>
      <CustomTabPanel value={value} index={1} fill>
        <LibraryScreen key={libraryResetKey}/>
      </CustomTabPanel>
      <CustomTabPanel value={value} index={2}>
        <OptionsScreen/>
      </CustomTabPanel>

      <BulkAddSidePanel />

      <Dialog open={infoOpen} onClose={() => setInfoOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>About</DialogTitle>
        <DialogContent>
          <Box
            component="img"
            src={ltxImage}
            alt="LTX"
            sx={{ width: '100%', borderRadius: 2, mb: 2, display: 'block' }}
          />
          <DialogContentText>
            Alfa para uso exclusivo de LTX distribuir este software sin permiso resultarà en unos tablazos por qlo.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInfoOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}