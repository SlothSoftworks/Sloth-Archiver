import { Fragment, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, ButtonBase, Chip, CircularProgress, InputAdornment, Menu, MenuItem, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { formatDurationSeconds } from '../../utils/utils';
import type { Transcript } from '../../types';
import type { TranscriptLanguage } from '../../types/electron-api';

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

function sourceLabel(transcript: Transcript): string {
  return `${transcript.languageName} · ${transcript.source === 'auto' ? 'auto-generated' : 'uploader subtitles'}`;
}

// One version's transcript: fetch it, search it, click a line to seek.
// Reloads when main reports a fetch for this version (e.g. the auto-fetch
// after a download finishing while the view is open).
export default function TranscriptPanel({ videoDir, epoch, isLocal, onSeek, onFetched }: {
  videoDir: string;
  epoch: string;
  isLocal: boolean;
  onSeek: (seconds: number) => void;
  onFetched?: (transcript: Transcript) => void;
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [languageMenuAnchor, setLanguageMenuAnchor] = useState<HTMLElement | null>(null);
  const [languages, setLanguages] = useState<TranscriptLanguage[] | null>(null);
  const [languagesError, setLanguagesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await window.electronAPI.getTranscript({ videoDir, epoch });
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
      if (loaded) onFetched?.(loaded);
    });
    return () => {
      cancelled = true;
      window.electronAPI.removeTranscriptUpdatedListener();
    };
    // onFetched is a fresh closure each render; the listener only needs the version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoDir, epoch]);

  const fetchTranscript = async (language?: string) => {
    setLanguageMenuAnchor(null);
    setFetching(true);
    setFetchError(null);
    const result = await window.electronAPI.fetchTranscript({ videoDir, epoch, language });
    setFetching(false);
    if (!result.success) {
      setFetchError(result.message);
      return;
    }
    setTranscript(result.transcript);
    onFetched?.(result.transcript);
  };

  const openLanguageMenu = async (anchor: HTMLElement) => {
    setLanguageMenuAnchor(anchor);
    if (languages) return;
    setLanguagesError(null);
    const result = await window.electronAPI.listTranscriptLanguages({ videoDir, epoch });
    if (result.success) setLanguages(result.languages ?? []);
    else setLanguagesError(result.message ?? "Couldn't load the languages.");
  };

  const trimmedQuery = query.trim();
  const visibleSegments = useMemo(() => {
    if (!transcript) return [];
    if (!trimmedQuery) return transcript.segments;
    const needle = trimmedQuery.toLowerCase();
    return transcript.segments.filter((segment) => segment.text.toLowerCase().includes(needle));
  }, [transcript, trimmedQuery]);

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
        <Button size="small" onClick={(e) => openLanguageMenu(e.currentTarget)} disabled={fetching}
          startIcon={fetching ? <CircularProgress size={14} /> : undefined}>
          {fetching ? 'Fetching…' : 'Other language'}
        </Button>
        <Menu anchorEl={languageMenuAnchor} open={!!languageMenuAnchor} onClose={() => setLanguageMenuAnchor(null)}>
          {languagesError && <MenuItem disabled>{languagesError}</MenuItem>}
          {!languages && !languagesError && <MenuItem disabled>Loading…</MenuItem>}
          {languages?.length === 0 && <MenuItem disabled>No other languages</MenuItem>}
          {languages?.map((language) => (
            <MenuItem
              key={language.code}
              selected={language.code === transcript.language}
              onClick={() => fetchTranscript(language.code)}
            >
              {language.name}{language.source === 'auto' ? ' (auto-generated)' : ''}
            </MenuItem>
          ))}
        </Menu>
      </Stack>
      {errorAlert}
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
      <Box sx={{ maxHeight: 360, overflowY: 'auto' }} data-testid="transcript-lines">
        {visibleSegments.map((segment) => (
          <ButtonBase
            key={`${segment.start}:${segment.text}`}
            onClick={() => onSeek(segment.start)}
            sx={{ display: 'flex', width: '100%', justifyContent: 'flex-start', alignItems: 'baseline', gap: 1.5, px: 1, py: 0.5, borderRadius: 1, textAlign: 'left', '&:hover': { bgcolor: 'action.hover' } }}
          >
            <Typography variant="caption" color="primary" sx={{ fontFamily: 'monospace', flexShrink: 0, minWidth: 44 }}>
              {formatDurationSeconds(segment.start)}
            </Typography>
            <Typography variant="body2"><Highlighted text={segment.text} query={trimmedQuery} /></Typography>
          </ButtonBase>
        ))}
        {visibleSegments.length === 0 &&
          <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>No lines match "{trimmedQuery}".</Typography>}
      </Box>
    </Stack>
  );
}
