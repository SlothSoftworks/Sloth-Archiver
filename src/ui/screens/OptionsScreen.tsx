import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Grid,
  IconButton,
  Link,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useYtdlpUpdater, IN_PROGRESS_STAGES } from '../hooks/useYtdlpUpdater';
import { useThemeMode } from '../hooks/useThemeMode.tsx';
import { POPULAR_CONVERT_FORMATS, SUGGESTED_EXTRA_CONVERT_FORMATS } from '../../utils/ffmpegFormats.ts';
import { MAX_SIMULTANEOUS_DOWNLOADS_CEILING } from '../../utils/constants.ts';
import { formatEpochLabel } from '../../utils/utils.ts';
import BulkDeleteConfirmDialog from '../components/BulkDeleteConfirmDialog';

// Display labels for yt-dlp's --cookies-from-browser browser keys -- kept
// here rather than main.mjs's SUPPORTED_COOKIE_BROWSERS (the source of truth
// for the actual list), which is plain lowercase keyring names, not fit for
// a dropdown.
// The keys here do match a fixed, closed set (cookies.mjs's
// SUPPORTED_COOKIE_BROWSERS), but every lookup below indexes by a plain
// `browser`/`cookiesBrowser` string, not a narrowed union -- narrowing this
// properly means threading a dedicated CookieBrowser type through settings
// state too, out of scope here.
// oxlint-disable-next-line anti-slop/no-known-value-widening
const COOKIE_BROWSER_LABELS: Record<string, string> = {
  brave: 'Brave',
  chrome: 'Chrome',
  chromium: 'Chromium',
  edge: 'Edge',
  firefox: 'Firefox',
  opera: 'Opera',
  safari: 'Safari',
  vivaldi: 'Vivaldi',
  whale: 'Whale',
};

// Shared with useBulkAddQueue.tsx's own fixed download-hook pool size
// (utils/constants.ts); main.mjs keeps its own copy of the same number,
// since main-process and renderer never cross-import in this codebase.
const MAX_SIMULTANEOUS_DOWNLOADS_OPTIONS = Array.from({ length: MAX_SIMULTANEOUS_DOWNLOADS_CEILING }, (_, i) => i + 1);

// Divider styles for the 2-column option grids below -- a real border keeps
// each item visually distinct instead of relying on spacing alone. An item
// beside another needs a left border on sm+ (column neighbor) but a top
// border on xs (stacks below instead); a row-starting item always needs a
// top border, on every breakpoint.
const dividerLeftOnSmTopOnXs = {
  borderLeft: { xs: 'none', sm: '1px solid' },
  borderTop: { xs: '1px solid', sm: 'none' },
  borderColor: 'divider',
  pl: { xs: 0, sm: 3 },
  pt: { xs: 3, sm: 0 },
};
const dividerTop = { borderTop: '1px solid', borderColor: 'divider', pt: 3 };
const dividerTopAndLeftOnSm = {
  borderTop: '1px solid',
  borderColor: 'divider',
  pt: 3,
  borderLeft: { xs: 'none', sm: '1px solid' },
  pl: { xs: 0, sm: 3 },
};

// Each group (Media vs. General) renders as its own bordered Card rather
// than just a text label -- an inline overline heading was too easy to miss
// against the options below it, with nothing visually separating groups.
function OptionsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card variant="outlined" sx={{ p: 2.5, mb: 3 }}>
      <Typography variant="subtitle1" color="primary" sx={{ fontWeight: 700, letterSpacing: 0.5, mb: 2 }}>
        {label}
      </Typography>
      {children}
    </Card>
  );
}

export default function OptionsScreen() {
  // Progress/error while updating is shown by the shared full-view overlay
  // (YtdlpUpdateDialog, mounted once at MainPage level) regardless of which
  // tab triggered it -- this screen only needs to check/kick off the update.
  const { currentVersion, latestVersion, updateAvailable, checking, checkError, stage, checkForUpdate, startUpdate } = useYtdlpUpdater();
  const { mode: themeMode, setMode: setThemeMode, themeName, setThemeName } = useThemeMode();
  const isUpdating = IN_PROGRESS_STAGES.has(stage);
  const [cookieLoaded, setCookieLoaded] = useState(false);
  const [cookieCount, setCookieCount] = useState(0);
  const [cookiePath, setCookiePath] = useState('');
  const [cookieSavedAtEpoch, setCookieSavedAtEpoch] = useState<number | null>(null);
  const [offerDeleteCookieOpen, setOfferDeleteCookieOpen] = useState(false);
  const [deletingOfferedCookie, setDeletingOfferedCookie] = useState(false);
  // Set on the toggle-to-browser-mode click (handleModeChange), consumed by
  // handleSelectBrowser once a browser is actually picked -- that's the
  // point the mode switch is truly persisted (see its own comment) and the
  // only point this offer should fire, not on every later browser reselect.
  const arrivedAtBrowserModeFromFile = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [ytdlpInfoOpen, setYtdlpInfoOpen] = useState(false);
  const [cookieText, setCookieText] = useState('');
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  // Suffixed ...State on several setters below (not a React requirement) to keep
  // the raw useState setter distinct from the same-named window.electronAPI.setX
  // IPC bridge method (e.g. setDownloadDirState vs. electronAPI.setDownloadDir).
  const [cookiesMode, setCookiesModeState] = useState<'file' | 'browser'>('file');
  const [cookiesBrowser, setCookiesBrowserState] = useState('');
  const [supportedBrowsers, setSupportedBrowsers] = useState<string[]>([]);
  const [browserSavedMessage, setBrowserSavedMessage] = useState('');
  const [downloadDir, setDownloadDirState] = useState('');
  const [libraryDir, setLibraryDirState] = useState('');
  const [errorLogExists, setErrorLogExists] = useState(false);
  const [customConvertFormats, setCustomConvertFormatsState] = useState<string[]>([]);
  const [maxSimultaneousDownloads, setMaxSimultaneousDownloadsState] = useState(1);
  const [appVersion, setAppVersion] = useState('');

  const refreshStatus = async () => {
    const status = await window.electronAPI.getCookieStatus();
    setCookieLoaded(status.loaded);
    setCookieCount(status.cookieCount);
    setCookiePath(status.path || '');
    setCookieSavedAtEpoch(status.savedAtEpoch ?? null);
  };

  const refreshCookiesConfig = async () => {
    const config = await window.electronAPI.getCookiesConfig();
    setCookiesModeState(config.cookiesMode);
    setCookiesBrowserState(config.cookiesBrowser);
    setSupportedBrowsers(config.supportedBrowsers);
  };

  const refreshDownloadDir = async () => {
    const { downloadDir } = await window.electronAPI.getDownloadDir();
    setDownloadDirState(downloadDir);
  };

  const refreshLibraryDir = async () => {
    const { libraryDir } = await window.electronAPI.getLibraryDir();
    setLibraryDirState(libraryDir);
  };

  const refreshErrorLogInfo = async () => {
    const { exists } = await window.electronAPI.getErrorLogInfo();
    setErrorLogExists(exists);
  };

  const refreshCustomConvertFormats = async () => {
    const { customConvertFormats } = await window.electronAPI.getCustomConvertFormats();
    setCustomConvertFormatsState(customConvertFormats);
  };

  const refreshMaxSimultaneousDownloads = async () => {
    const { maxSimultaneousDownloads } = await window.electronAPI.getMaxSimultaneousDownloads();
    setMaxSimultaneousDownloadsState(maxSimultaneousDownloads);
  };

  useEffect(() => {
    refreshStatus();
    refreshCookiesConfig();
    refreshDownloadDir();
    refreshLibraryDir();
    refreshErrorLogInfo();
    refreshCustomConvertFormats();
    refreshMaxSimultaneousDownloads();
    window.electronAPI.getAppVersion().then(setAppVersion);
  }, []);

  // Value normalization (lowercasing, de-duping against the popular set)
  // happens here rather than in the Library view, so the persisted list is
  // already clean everywhere it's read from.
  const handleCustomConvertFormatsChange = async (formats: string[]) => {
    const cleaned = Array.from(new Set(
      formats.map((f) => f.trim().toLowerCase()).filter((f) => f && !POPULAR_CONVERT_FORMATS.includes(f)),
    ));
    setCustomConvertFormatsState(cleaned);
    await window.electronAPI.setCustomConvertFormats(cleaned);
  };

  // Comma-to-commit, tag-input style -- Enter already does this via MUI
  // Autocomplete's own freeSolo behavior, but comma isn't a built-in
  // trigger, so it's intercepted here: swallow the character and commit
  // whatever's typed as a new tag instead.
  const [convertFormatInput, setConvertFormatInput] = useState('');
  const commitConvertFormatInput = () => {
    if (!convertFormatInput.trim()) return;
    handleCustomConvertFormatsChange([...customConvertFormats, convertFormatInput]);
    setConvertFormatInput('');
  };

  const handleMaxSimultaneousDownloadsChange = async (value: number) => {
    setMaxSimultaneousDownloadsState(value);
    await window.electronAPI.setMaxSimultaneousDownloads(value);
  };

  const handleChooseDownloadDir = async () => {
    // Electron 43+ opens unset-defaultPath dialogs at Downloads instead of
    // remembering the last-picked folder -- pass the current setting
    // explicitly so re-opening this picker still starts where it's already
    // pointed, rather than silently regressing to always-Downloads.
    const result = await window.electronAPI.pickFolder({
      title: 'Select Default Download Folder',
      buttonLabel: 'Select',
      defaultPath: downloadDir || undefined,
    });
    if (result.canceled || !result.filePaths?.[0]) return;
    await window.electronAPI.setDownloadDir(result.filePaths[0]);
    await refreshDownloadDir();
  };

  const handleChooseLibraryDir = async () => {
    const result = await window.electronAPI.pickFolder({
      title: 'Select Library Folder',
      buttonLabel: 'Select',
      defaultPath: libraryDir || undefined,
    });
    if (result.canceled || !result.filePaths?.[0]) return;
    await window.electronAPI.setLibraryDir(result.filePaths[0]);
    await refreshLibraryDir();
  };

  const handleOpenDialog = () => {
    setCookieText('');
    setError('');
    setSavedMessage('');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!cookieText.trim()) {
      setError("Paste your cookie text before saving.");
      return;
    }
    try {
      const result = await window.electronAPI.saveCookie(cookieText);
      await refreshStatus();
      if (result.skipped > 0) {
        setError(`Saved ${result.cookieCount} cookie(s), but ${result.skipped} line(s) couldn't be parsed. Try re-copying the cookie text -- a long value may have picked up stray line breaks when copied.`);
        return;
      }
      setDialogOpen(false);
      setSavedMessage(`Saved ${result.cookieCount} cookie(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save cookie.');
    }
  };

  const handleDelete = async () => {
    await window.electronAPI.deleteCookie();
    await refreshStatus();
  };

  const handleThemeModeChange = (_e: MouseEvent<HTMLElement>, mode: 'light' | 'dark' | null) => {
    if (!mode) return;
    setThemeMode(mode);
  };

  const handleThemeNameChange = (name: 'default' | 'slothui') => {
    setThemeName(name);
  };

  // Switching to 'browser' mode alone doesn't need a browser picked yet --
  // only persisted once cookiesBrowser is also set, by handleSelectBrowser
  // below. Switching back to 'file' saves immediately.
  //
  // cookiesBrowser is explicitly cleared (both here and persisted) whenever
  // the user switches away from browser mode -- otherwise switching to
  // paste-cookie mode and back would show a stale "Using Firefox" value even
  // though nothing was actually selected.
  const handleModeChange = async (_e: MouseEvent<HTMLElement>, mode: 'file' | 'browser' | null) => {
    if (!mode || mode === cookiesMode) return;
    if (mode === 'browser' && cookiesMode === 'file') {
      arrivedAtBrowserModeFromFile.current = true;
    }
    setCookiesModeState(mode);
    setBrowserSavedMessage('');
    if (mode === 'file') {
      arrivedAtBrowserModeFromFile.current = false;
      setCookiesBrowserState('');
      await window.electronAPI.setCookiesConfig({ cookiesMode: 'file', cookiesBrowser: '' });
    }
  };

  const handleSelectBrowser = async (browser: string) => {
    setCookiesBrowserState(browser);
    await window.electronAPI.setCookiesConfig({ cookiesMode: 'browser', cookiesBrowser: browser });
    const label = COOKIE_BROWSER_LABELS[browser] || browser;
    setBrowserSavedMessage(`Downloads will now pull cookies live from ${label}.`);
    // Only offer once per genuine paste-mode -> browser-mode transition, not
    // on every later reselection between browsers while already in browser
    // mode -- see the ref's own comment.
    if (arrivedAtBrowserModeFromFile.current) {
      arrivedAtBrowserModeFromFile.current = false;
      if (cookieLoaded) setOfferDeleteCookieOpen(true);
    }
  };

  const handleConfirmOfferedDelete = async () => {
    setDeletingOfferedCookie(true);
    await window.electronAPI.deleteCookie();
    await refreshStatus();
    setDeletingOfferedCookie(false);
    setOfferDeleteCookieOpen(false);
  };

  // Explicit "Clear" -- reverts the selection back to none of the browsers
  // being selected, without leaving browser mode (unlike switching to paste
  // mode above, which also clears it as a side effect).
  const handleClearBrowserSelection = async () => {
    setCookiesBrowserState('');
    setBrowserSavedMessage('');
    await window.electronAPI.setCookiesConfig({ cookiesMode: 'browser', cookiesBrowser: '' });
  };

  return (
    <Box>
      {appVersion &&
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Version {appVersion}
        </Typography>}
      <OptionsGroup label="Media Options">
        <Grid container spacing={4}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Typography variant="h6" gutterBottom>Conversion Formats</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The Library view's "Convert to" tool always offers {POPULAR_CONVERT_FORMATS.map((f) => f.toUpperCase()).join(', ')}.
              Add more here for your own use -- pick a suggestion or type any ffmpeg format name.
            </Typography>
            <Autocomplete
              multiple
              freeSolo
              size="small"
              options={SUGGESTED_EXTRA_CONVERT_FORMATS}
              value={customConvertFormats}
              inputValue={convertFormatInput}
              onInputChange={(_e, newInputValue) => setConvertFormatInput(newInputValue)}
              onChange={(_e, newValue) => {
                handleCustomConvertFormatsChange(newValue);
                setConvertFormatInput('');
              }}
              onKeyDown={(e) => {
                if (e.key === ',') {
                  e.preventDefault();
                  commitConvertFormatInput();
                }
              }}
              getOptionLabel={(option) => option.toUpperCase()}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => {
                  const { key, ...tagProps } = getTagProps({ index });
                  return <Chip key={key} label={option.toUpperCase()} size="small" {...tagProps} />;
                })
              }
              renderInput={(params) => <TextField {...params} placeholder="Add a format, then comma or Enter" />}
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }} sx={dividerLeftOnSmTopOnXs}>
            <Typography variant="h6" gutterBottom>Default Download Folder</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              This folder is suggested as the starting location whenever the save dialog opens
              for a new download.
            </Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <Button variant="contained" onClick={handleChooseDownloadDir}>
                Choose folder
              </Button>
              <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                {downloadDir || 'Using system default'}
              </Typography>
            </Stack>
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }} sx={dividerTop}>
            <Typography variant="h6" gutterBottom>Library Folder</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Where videos added to the Library tab are tracked and stored. Unlike the download
              folder above, this isn't set to a default automatically -- choose it deliberately,
              since it's meant to be a persistent archive location.
            </Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <Button variant="contained" onClick={handleChooseLibraryDir}>
                Choose folder
              </Button>
              <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                {libraryDir || 'Not set'}
              </Typography>
            </Stack>
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }} sx={dividerTopAndLeftOnSm}>
            <Typography variant="h6" gutterBottom>Maximum Simultaneous Downloads</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              How many bulk-add items are allowed to download at the same time.
            </Typography>
            <TextField
              select
              size="small"
              value={maxSimultaneousDownloads}
              onChange={(e) => handleMaxSimultaneousDownloadsChange(Number(e.target.value))}
              sx={{ minWidth: 120, mb: 2 }}
            >
              {MAX_SIMULTANEOUS_DOWNLOADS_OPTIONS.map((n) => (
                <MenuItem key={n} value={n}>{n}</MenuItem>
              ))}
            </TextField>
            <Alert severity="warning" variant="outlined">
              Downloading too many videos at once increases the risk of YouTube flagging
              your connection as a bot. Keep this low if you run into that.
            </Alert>
          </Grid>
        </Grid>
      </OptionsGroup>

      <OptionsGroup label="General Options">
        <Grid container spacing={4}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Typography variant="h6" gutterBottom>Appearance</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Choose the app's color theme. Saved between sessions.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
              <TextField
                select
                label="Theme"
                size="small"
                value={themeName}
                // SAFETY: this TextField's only children are the two
                // MenuItems below (values "default"/"slothui"), so the
                // native select's value can only ever be one of those two.
                onChange={(e) => handleThemeNameChange(e.target.value as 'default' | 'slothui')}
                sx={{ minWidth: 140 }}
              >
                <MenuItem value="default">Default MUI</MenuItem>
                <MenuItem value="slothui">SlothUI</MenuItem>
              </TextField>
              <ToggleButtonGroup
                value={themeMode}
                exclusive
                onChange={handleThemeModeChange}
                size="small"
              >
                <ToggleButton value="light">Light</ToggleButton>
                <ToggleButton value="dark">Dark</ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }} sx={dividerLeftOnSmTopOnXs}>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography variant="h6" gutterBottom sx={{ mb: '0 !important' }}>yt-dlp Version</Typography>
              <Tooltip title="What is yt-dlp?">
                <IconButton size="small" onClick={() => setYtdlpInfoOpen(true)} aria-label="What is yt-dlp?">
                  <InfoOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              yt-dlp needs to change whenever YouTube does. Updating downloads and verifies
              yt-dlp's own signed release build -- this only takes a few seconds.
            </Typography>
            <Dialog open={ytdlpInfoOpen} onClose={() => setYtdlpInfoOpen(false)} maxWidth="xs" fullWidth>
              <DialogTitle>What is yt-dlp?</DialogTitle>
              <DialogContent>
                <DialogContentText component="div">
                  <Typography variant="body2" sx={{ mb: 1.5 }}>
                    yt-dlp is the tool this app uses behind the scenes to actually talk to
                    YouTube and download videos. It's separate from Sloth Archiver itself --
                    updating it here does <strong>not</strong> update the app.
                  </Typography>
                  <Typography variant="body2">
                    YouTube changes how it works fairly often, and when it does, yt-dlp can
                    stop working correctly until it's updated to keep up. Keeping this
                    current is what keeps downloads working reliably.
                  </Typography>
                </DialogContentText>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setYtdlpInfoOpen(false)}>Close</Button>
              </DialogActions>
            </Dialog>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              <Button variant="outlined" onClick={() => checkForUpdate()} disabled={checking || isUpdating}>
                Check for updates
              </Button>
              {updateAvailable &&
                <Button variant="contained" onClick={() => startUpdate()} disabled={isUpdating}>
                  Update to {latestVersion}
                </Button>}
              <Chip
                label={currentVersion ? `Current: ${currentVersion}` : 'Version unknown'}
                variant="outlined"
              />
              {!checking && !updateAvailable && !!currentVersion && !!latestVersion &&
                <Chip label="Up to date" color="success" variant="outlined" />}
              {!checking && checkError &&
                <Chip label={checkError} color="error" variant="outlined" />}
            </Stack>
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }} sx={dividerTop}>
            <Typography variant="h6" gutterBottom>Personal Cookie</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Most downloads don't need this. It's only necessary for age-restricted videos,
              members-only content, or once YouTube starts throwing a "Sign in to confirm
              you're not a bot" error at you.
            </Typography>
            <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
              This authenticates as your real account, so using it at a high volume can get that
              account flagged or suspended -- this applies whether you paste a cookie or pull
              live from a browser below. Use it in moderation, and consider a throwaway account's
              cookies instead of your main one if you expect to be downloading a lot. This matches
              {' '}
              <Link
                target="_blank"
                rel="noopener noreferrer"
                href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"
              >
                yt-dlp's own recommended cookie usage
              </Link>.
            </Alert>
            <ToggleButtonGroup
              value={cookiesMode}
              exclusive
              onChange={handleModeChange}
              size="small"
              sx={{ mb: 2 }}
            >
              <ToggleButton value="file">Paste cookie</ToggleButton>
              <ToggleButton value="browser">Pull from browser</ToggleButton>
            </ToggleButtonGroup>

            {cookiesMode === 'file' ? (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Paste either a Netscape-format cookies.txt export or the raw cookie header value
                  copied from your browser's developer tools.
                </Typography>
                <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Button variant="contained" onClick={handleOpenDialog}>
                    Load personal cookie
                  </Button>
                  <Button variant="outlined" color="error" onClick={handleDelete} disabled={!cookieLoaded}>
                    Delete cookie
                  </Button>
                  <Chip
                    label={cookieLoaded ? `Cookie loaded (${cookieCount})` : 'No cookie loaded'}
                    color={cookieLoaded ? 'success' : 'default'}
                    variant="outlined"
                  />
                </Stack>
                {cookieLoaded &&
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Stored at {cookiePath}
                    {cookieSavedAtEpoch != null && ` · saved ${formatEpochLabel(cookieSavedAtEpoch)}`}
                  </Typography>}
                {savedMessage &&
                  <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>{savedMessage}</Typography>}
              </>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Reads cookies directly from an installed browser's own profile on every request --
                  nothing to export or re-paste when they expire. The browser may need to be closed for
                  this to work, since some browsers lock their cookie database while running.
                </Typography>
                <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                  <TextField
                    select
                    size="small"
                    label="Browser"
                    value={cookiesBrowser}
                    onChange={(e) => handleSelectBrowser(e.target.value)}
                    sx={{ minWidth: 200 }}
                  >
                    {supportedBrowsers.map((browser) => (
                      <MenuItem key={browser} value={browser}>
                        {COOKIE_BROWSER_LABELS[browser] || browser}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Chip
                    label={cookiesBrowser ? `Using ${COOKIE_BROWSER_LABELS[cookiesBrowser] || cookiesBrowser}` : 'No browser selected'}
                    color={cookiesBrowser ? 'success' : 'default'}
                    variant="outlined"
                  />
                  <Button size="small" onClick={handleClearBrowserSelection} disabled={!cookiesBrowser}>
                    Clear
                  </Button>
                </Stack>
                {browserSavedMessage &&
                  <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>{browserSavedMessage}</Typography>}
              </>
            )}
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }} sx={dividerTopAndLeftOnSm}>
            <Typography variant="h6" gutterBottom>Error Log</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              If something crashes or behaves unexpectedly, this file has the details -- useful to
              check yourself or attach when reporting a bug.
            </Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <Button
                variant="outlined"
                onClick={() => window.electronAPI.openErrorLog()}
                disabled={!errorLogExists}
              >
                Open error log
              </Button>
              <Chip
                label={errorLogExists ? 'Errors have been logged' : 'No errors logged yet'}
                color={errorLogExists ? 'warning' : 'default'}
                variant="outlined"
              />
            </Stack>
          </Grid>
        </Grid>
      </OptionsGroup>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Load personal cookie</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Paste your YouTube cookie text below. This is stored locally and only used to
            authenticate your own download requests.
          </DialogContentText>
          <TextField
            autoFocus
            multiline
            minRows={6}
            fullWidth
            variant="outlined"
            placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t...\n\nor: CONSENT=YES+42; VISITOR_INFO1_LIVE=...; ..."}
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            error={!!error}
            helperText={error}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSave}>Save</Button>
        </DialogActions>
      </Dialog>

      <BulkDeleteConfirmDialog
        open={offerDeleteCookieOpen}
        title="Delete the stored cookie file?"
        description="Downloads now pull cookies live from your browser, so the pasted cookie file is no longer used. Delete it, or keep it in case you switch back to Paste mode later."
        deleting={deletingOfferedCookie}
        error={null}
        onCancel={() => setOfferDeleteCookieOpen(false)}
        onConfirm={handleConfirmOfferedDelete}
      />
    </Box>
  );
}
