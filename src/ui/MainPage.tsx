import * as React from 'react';
import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router';
import Button from '@mui/material/Button';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Badge from '@mui/material/Badge';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CookieIcon from '@mui/icons-material/Cookie';
import CancelIcon from '@mui/icons-material/Cancel';
import './App.css';
import './MainPage.css';
import DownloaderScreen from './screens/DownloaderScreen';
import OptionsScreen from './screens/OptionsScreen';
import LibraryScreen from './screens/LibraryScreen';
import YtdlpUpdateDialog from './components/YtdlpUpdateDialog';
import BulkAddSidePanel, { BulkAddToggleButton } from './components/BulkAddSidePanel';
import { useLibraryNotification } from './hooks/useLibraryNotifications';
import { useCookiesChange } from './hooks/useCookiesChange';
import { useYtdlpUpdater } from './hooks/useYtdlpUpdater';
import buttonIcon from '../../assets/button_icon.png';

const REPO_URL = 'https://github.com/SlothSoftworks/Sloth-Archiver';

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
  // Opt-in for a screen that needs a definite height to lay content out
  // against, e.g. a bottom bar that must stay pinned at the tab's bottom.
  // Deliberately unpadded so a full-bleed bar can span the tab's actual
  // width -- the screen itself is responsible for padding whichever inner
  // region needs it.
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
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    window.electronAPI.getAppVersion().then(setAppVersion);
  }, []);
  // ffmpeg has no separate "check for update" flow (it's only ever replaced
  // by rebuilding the app itself), so this is fetched directly for display
  // rather than through useYtdlpUpdater's update-check machinery.
  const [ffmpegVersion, setFfmpegVersion] = useState<string | null>(null);
  useEffect(() => {
    window.electronAPI.getFfmpegVersion().then(setFfmpegVersion);
  }, []);
  const { currentVersion: ytdlpVersion } = useYtdlpUpdater();
  const { count: libraryNotificationCount, reset: resetLibraryNotifications } = useLibraryNotification();

  // "Loaded" mirrors cookies.mjs's own makeCookiesArgs() precedence, the
  // function that actually decides what yt-dlp receives -- browser mode
  // wins whenever a browser is configured there, file mode only matters
  // otherwise, so this checks whichever one is actually live rather than
  // just whether a cookies.txt happens to exist on disk.
  const [cookiesMode, setCookiesMode] = useState<'file' | 'browser'>('file');
  const [cookiesBrowser, setCookiesBrowser] = useState('');
  const [cookieFileLoaded, setCookieFileLoaded] = useState(false);
  const { version: cookiesChangeVersion, notifyChanged: notifyCookiesChanged } = useCookiesChange();
  const refreshCookieIndicator = () => {
    window.electronAPI.getCookiesConfig().then((config) => {
      setCookiesMode(config.cookiesMode);
      setCookiesBrowser(config.cookiesBrowser);
    });
    window.electronAPI.getCookieStatus().then((status) => setCookieFileLoaded(status.loaded));
  };
  // Re-fetches whenever OptionsScreen bumps this shared signal after saving,
  // deleting, or switching cookies -- without it, this only ever refetched
  // once on mount, so the header stayed stuck at whatever cookie state
  // existed when the app launched until the next restart.
  useEffect(() => {
    refreshCookieIndicator();
  }, [cookiesChangeVersion]);
  const cookiesLoaded = cookiesMode === 'browser' ? !!cookiesBrowser : cookieFileLoaded;
  // Same bare one-click clear Options' own "Delete cookie"/"Clear" buttons
  // already do (handleDelete/handleClearBrowserSelection, OptionsScreen.tsx)
  // -- no confirmation dialog, just reuse the same two calls and refresh.
  const handleClearCookiesFromHeader = async () => {
    if (cookiesMode === 'browser') {
      await window.electronAPI.setCookiesConfig({ cookiesMode: 'browser', cookiesBrowser: '' });
    } else {
      await window.electronAPI.deleteCookie();
    }
    refreshCookieIndicator();
    // So OptionsScreen (if open) picks up the clear too, same as this
    // header picks up a save/delete/switch made there.
    notifyCookiesChanged();
  };
  // Bumped to force LibraryScreen to remount (see its `key` below) -- every
  // other tab gets this reset for free, since CustomTabPanel only renders a
  // tab's content while active. Library's own drill-down and Videos/
  // Playlists toggle are local state, not URL-driven, so re-navigating to
  // the already-active Library tab is normally a no-op that leaves them
  // untouched -- this key bump makes clicking Library while on it behave
  // like any other tab: back to its own start.
  const [libraryResetKey, setLibraryResetKey] = useState(0);

  const handleChange = (_event: React.SyntheticEvent, newValue: number) => {
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
          {cookiesLoaded &&
            <Badge
              overlap="circular"
              anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
              // MUI's default badge chrome (min-width/height 20px, pill
              // padding, its own background) is built for a number/dot --
              // overridden here since badgeContent is a real interactive
              // element (the clear button) sized to just fit it instead.
              sx={{ '& .MuiBadge-badge': { padding: 0, minWidth: 16, height: 16, borderRadius: '50%' } }}
              badgeContent={
                <Tooltip title="Clear cookies">
                  <IconButton
                    size="small"
                    onClick={handleClearCookiesFromHeader}
                    aria-label="Clear cookies"
                    sx={{ width: 16, height: 16, padding: 0, backgroundColor: 'background.paper', '&:hover': { backgroundColor: 'background.paper' } }}
                  >
                    <CancelIcon sx={{ fontSize: 16 }} color="error" />
                  </IconButton>
                </Tooltip>
              }
            >
              <Tooltip title="Cookies are loaded and being sent to yt-dlp">
                <IconButton size="small" aria-label="Cookies loaded">
                  <CookieIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Badge>}
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
        <DialogTitle>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <span>About</span>
            <Chip
              size="small"
              variant="outlined"
              label={appVersion ? `v${appVersion}` : 'Version unknown'}
              sx={{ fontFamily: 'monospace' }}
            />
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
            <Box component="img" src={buttonIcon} alt="" sx={{ width: 64, height: 64 }} />
          </Box>
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              Dependencies
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                variant="outlined"
                label={ytdlpVersion ? `yt-dlp: ${ytdlpVersion}` : 'yt-dlp version unknown'}
                sx={{ fontFamily: 'monospace' }}
              />
              <Chip
                size="small"
                variant="outlined"
                label={ffmpegVersion ? `ffmpeg: ${ffmpegVersion}` : 'ffmpeg version unknown'}
                sx={{ fontFamily: 'monospace' }}
              />
            </Stack>
          </Box>
          <DialogContentText sx={{ mb: 2 }}>
            Sloth Archiver is under active construction -- features, behavior, and data
            formats are all still subject to change.
          </DialogContentText>
          <DialogContentText>
            For news and bug reports visit:{' '}
            <Link href={REPO_URL} target="_blank" rel="noopener noreferrer">
              {REPO_URL}
            </Link>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInfoOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}