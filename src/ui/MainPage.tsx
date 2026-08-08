import * as React from 'react';
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router';
import Button from '@mui/material/Button';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Badge from '@mui/material/Badge';
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
// /library/video/:videoId, without a separate imperative "switch tab" call.
// Deep-link paths under /library (like the one above) still count as the
// Library tab being active.
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
}

function CustomTabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`simple-tabpanel-${index}`}
      aria-labelledby={`simple-tab-${index}`}
      className='tabContainer'
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
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
  const { count: libraryNotificationCount, reset: resetLibraryNotifications } = useLibraryNotification();

  const handleChange = (event: React.SyntheticEvent, newValue: number) => {
    navigate(TAB_PATHS[newValue]);
    if (newValue === LIBRARY_TAB_INDEX) {
      resetLibraryNotifications();
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
            {...a11yProps(LIBRARY_TAB_INDEX)}
          />
          <Tab label="Options" {...a11yProps(2)} />
        </Tabs>
        <Stack direction="row" alignItems="center" sx={{ mr: 1 }}>
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
      <CustomTabPanel value={value} index={1}>
        <LibraryScreen/>
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