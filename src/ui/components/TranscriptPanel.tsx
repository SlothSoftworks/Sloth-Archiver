import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, ButtonBase, Chip, CircularProgress, IconButton, InputAdornment, Menu, MenuItem, Snackbar, Stack, TextField, Tooltip, Typography } from '@mui/material';
import TranslateIcon from '@mui/icons-material/Translate';
import SearchIcon from '@mui/icons-material/Search';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import { formatDurationSeconds } from '../../utils/utils';
import type { Transcript } from '../../types';
import TranscriptLanguagesDialog from './TranscriptLanguagesDialog';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'i'));
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1
        ? <Box key={i} component="mark" sx={{ bgcolor: 'warning.light', color: 'inherit', borderRadius: 0.5 }}>{part}</Box>
        : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

const FOLLOW_POLL_MS = 300;

// The last line that has started by `seconds`, or -1 before the first one.
function findSegmentAt(segments: Transcript['segments'], seconds: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].start <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function sourceLabel(transcript: Transcript): string {
  return `${transcript.languageName} · ${transcript.source === 'auto' ? 'auto-generated' : 'uploader subtitles'}`;
}

// One version's transcript: fetch it, search it, click a line to seek.
// Reloads when main reports a fetch for this version (e.g. the auto-fetch
// after a download finishing while the view is open). With getCurrentTime
// it follows playback: the current line is highlighted and kept in view
// until the user scrolls the list themselves.
export default function TranscriptPanel({ videoDir, epoch, isLocal, onSeek, onFetched, getCurrentTime }: {
  videoDir: string;
  epoch: string;
  isLocal: boolean;
  onSeek: (seconds: number) => void;
  onFetched?: (transcript: Transcript) => void;
  // null while nothing local is playing (e.g. the YouTube embed), which
  // turns following off.
  getCurrentTime?: () => number | null;
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // null shows the version's default transcript.
  const [language, setLanguage] = useState<string | null>(null);
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [following, setFollowing] = useState(true);
  const [exportMenu, setExportMenu] = useState<{ anchor: HTMLElement; action: 'copy' | 'save' } | null>(null);
  const [exportMessage, setExportMessage] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await window.electronAPI.getTranscript({ videoDir, epoch, language: language ?? undefined });
      if (cancelled) return null;
      const loaded = result.success ? result.transcript ?? null : null;
      setTranscript(loaded);
      setLoading(false);
      return loaded;
    };
    setLoading(true);
    load();
    window.electronAPI.onTranscriptUpdated(async (updated) => {
      if (updated.videoDir !== videoDir || updated.epoch !== epoch) return;
      const loaded = await load();
      if (loaded && !language) onFetched?.(loaded);
    });
    return () => {
      cancelled = true;
      window.electronAPI.removeTranscriptUpdatedListener();
    };
    // onFetched is a fresh closure each render; the listener only needs the version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoDir, epoch, language]);

  useEffect(() => {
    if (!transcript || !getCurrentTime) return;
    const tick = () => {
      const seconds = getCurrentTime();
      setCurrentIndex(seconds === null ? -1 : findSegmentAt(transcript.segments, seconds));
    };
    tick();
    const interval = window.setInterval(tick, FOLLOW_POLL_MS);
    return () => window.clearInterval(interval);
  }, [transcript, getCurrentTime]);

  const fetchTranscript = async () => {
    setFetching(true);
    setFetchError(null);
    const result = await window.electronAPI.fetchTranscript({ videoDir, epoch });
    setFetching(false);
    if (!result.success) {
      setFetchError(result.message);
      return;
    }
    setTranscript(result.transcript);
    onFetched?.(result.transcript);
  };

  const trimmedQuery = query.trim();
  const visibleSegments = useMemo(() => {
    if (!transcript) return [];
    const indexed = transcript.segments.map((segment, index) => ({ segment, index }));
    if (!trimmedQuery) return indexed;
    const needle = trimmedQuery.toLowerCase();
    return indexed.filter(({ segment }) => segment.text.toLowerCase().includes(needle));
  }, [transcript, trimmedQuery]);

  // Not while searching: the list is then the user's results, not a timeline.
  useEffect(() => {
    if (!following || trimmedQuery || currentIndex < 0) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`);
    if (!list || !row) return;
    list.scrollTop = row.offsetTop - list.clientHeight / 3;
  }, [currentIndex, following, trimmedQuery]);

  const runExport = async (withTimestamps: boolean) => {
    const action = exportMenu?.action;
    setExportMenu(null);
    const shown = transcript?.language;
    if (action === 'copy') {
      const result = await window.electronAPI.copyTranscriptText({ videoDir, epoch, language: shown, withTimestamps });
      setExportMessage(result.success
        ? { severity: 'success', text: 'Transcript copied' }
        : { severity: 'error', text: result.message ?? "Couldn't copy the transcript." });
    } else if (action === 'save') {
      const result = await window.electronAPI.saveTranscriptText({ videoDir, epoch, language: shown, withTimestamps });
      if (result.canceled) return;
      setExportMessage(result.success
        ? { severity: 'success', text: 'Transcript saved' }
        : { severity: 'error', text: result.message ?? "Couldn't save the transcript." });
    }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>;
  }

  if (isLocal) {
    return <Typography variant="body2" color="text.secondary">Transcripts aren't available for local files.</Typography>;
  }

  const errorAlert = fetchError &&
    <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => fetchTranscript()}>Retry</Button>}>{fetchError}</Alert>;

  if (!transcript) {
    return (
      <Stack spacing={1.5} alignItems="flex-start">
        <Typography variant="body2" color="text.secondary">No transcript for this version yet.</Typography>
        <Button variant="outlined" size="small" onClick={() => fetchTranscript()} disabled={fetching}
          startIcon={fetching ? <CircularProgress size={16} /> : undefined}>
          {fetching ? 'Fetching transcript…' : 'Fetch transcript'}
        </Button>
        {errorAlert}
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Chip size="small" label={sourceLabel(transcript)} />
        <Tooltip title="Transcript languages">
          <IconButton size="small" aria-label="Transcript languages" onClick={() => setLanguagesOpen(true)}>
            <TranslateIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <TranscriptLanguagesDialog
          open={languagesOpen}
          onClose={() => setLanguagesOpen(false)}
          videoDir={videoDir}
          epoch={epoch}
          currentLanguage={transcript.language}
          onShow={setLanguage}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Copy transcript">
          <IconButton size="small" aria-label="Copy transcript" onClick={(e) => setExportMenu({ anchor: e.currentTarget, action: 'copy' })}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Save as .txt">
          <IconButton size="small" aria-label="Save transcript as text" onClick={(e) => setExportMenu({ anchor: e.currentTarget, action: 'save' })}>
            <SaveAltIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={exportMenu?.anchor} open={!!exportMenu} onClose={() => setExportMenu(null)}>
          <MenuItem onClick={() => runExport(true)}>With timestamps</MenuItem>
          <MenuItem onClick={() => runExport(false)}>Text only</MenuItem>
        </Menu>
      </Stack>
      <TextField
        size="small"
        placeholder="Search transcript"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        slotProps={{
          input: {
            startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
            endAdornment: trimmedQuery
              ? <InputAdornment position="end"><Typography variant="caption" color="text.secondary">{visibleSegments.length} {visibleSegments.length === 1 ? 'match' : 'matches'}</Typography></InputAdornment>
              : undefined,
          },
        }}
      />
      <Box sx={{ position: 'relative' }}>
        {/* Only real user input stops following -- a scroll event can't tell
            the user's scrolling from the auto-scroll's. pointerdown on the
            list itself (not a line) is its scrollbar being dragged. */}
        <Box
          ref={listRef}
          data-testid="transcript-lines"
          onWheel={() => setFollowing(false)}
          onTouchMove={() => setFollowing(false)}
          onPointerDown={(e) => { if (e.target === e.currentTarget) setFollowing(false); }}
          sx={{ position: 'relative', maxHeight: 360, overflowY: 'auto', scrollBehavior: 'smooth' }}
        >
          {visibleSegments.map(({ segment, index }) => {
            const current = index === currentIndex;
            return (
              <ButtonBase
                key={`${segment.start}:${segment.text}`}
                data-index={index}
                aria-current={current ? 'true' : undefined}
                onClick={() => { setFollowing(true); onSeek(segment.start); }}
                sx={{ display: 'flex', width: '100%', justifyContent: 'flex-start', alignItems: 'baseline', gap: 1.5, px: 1, py: 0.5, borderRadius: 1, textAlign: 'left', bgcolor: current ? 'action.selected' : undefined, '&:hover': { bgcolor: current ? 'action.selected' : 'action.hover' } }}
              >
                <Typography variant="caption" color="primary" sx={{ fontFamily: 'monospace', flexShrink: 0, minWidth: 44 }}>
                  {formatDurationSeconds(segment.start)}
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: current ? 600 : undefined }}><Highlighted text={segment.text} query={trimmedQuery} /></Typography>
              </ButtonBase>
            );
          })}
          {visibleSegments.length === 0 &&
            <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>No lines match "{trimmedQuery}".</Typography>}
        </Box>
        {!following && !trimmedQuery && currentIndex >= 0 &&
          <Button
            size="small"
            variant="contained"
            onClick={() => setFollowing(true)}
            sx={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)' }}
          >
            Back to current
          </Button>}
      </Box>
      <Snackbar
        open={!!exportMessage}
        autoHideDuration={3000}
        onClose={() => setExportMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setExportMessage(null)} severity={exportMessage?.severity ?? 'success'} variant="filled">
          {exportMessage?.text}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
