import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Alert, Box, Checkbox, CircularProgress, ClickAwayListener, FormControlLabel, IconButton, InputAdornment, Paper, Popper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import CloseIcon from '@mui/icons-material/Close';
import { useDebounce } from '../../utils/useDebounce';
import { useOmniSearch } from '../hooks/useOmniSearch';
import OmniSearchResults from './OmniSearchResults';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 200;

// The header's quick search across every sublibrary. The Search icon opens
// the field; once it's open the icon turns into ManageSearch, which opens
// the advanced search. Titles, channels, notes, clips and playlists are
// searched as you type; with "Also search transcripts" on, the search waits
// for Enter, since that one reads files.
export default function OmniSearchField({ onOpenAdvanced }: { onOpenAdvanced?: (seedText: string) => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [includeTranscripts, setIncludeTranscripts] = useState(false);
  const [popperOpen, setPopperOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const { status, results, transcripts, error, building, search, clear } = useOmniSearch();
  const query = useDebounce(value, DEBOUNCE_MS).trim();

  useEffect(() => {
    if (includeTranscripts) return;
    if (query.length < MIN_QUERY_LENGTH) clear();
    else search({ mode: 'text', text: query });
  }, [query, includeTranscripts, search, clear]);

  const close = () => {
    setOpen(false);
    setPopperOpen(false);
    setValue('');
    clear();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (popperOpen) setPopperOpen(false);
      else close();
    } else if (e.key === 'Enter' && includeTranscripts && value.trim().length >= MIN_QUERY_LENGTH) {
      setPopperOpen(true);
      search({ mode: 'text', text: value.trim() }, { transcripts: true });
    }
  };

  const openResult = (path: string) => {
    setPopperOpen(false);
    navigate(path);
  };

  const nothingFound = status === 'done' && results
    && results.videos.total + results.clips.total + results.playlists.total === 0
    && (!transcripts || (transcripts.done && transcripts.matched === 0));

  return (
    <ClickAwayListener onClickAway={() => setPopperOpen(false)}>
      <Box ref={anchorRef} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {open && (
          <TextField
            size="small"
            autoFocus
            placeholder="Search all libraries"
            value={value}
            onChange={(e) => { setValue(e.target.value); setPopperOpen(true); }}
            onFocus={() => setPopperOpen(true)}
            onKeyDown={handleKeyDown}
            sx={{ width: 260 }}
            slotProps={{
              htmlInput: { 'aria-label': 'Search all libraries' },
              input: {
                startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton size="small" edge="end" onClick={close} aria-label="Close search">
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
        )}
        {open ? (
          <Tooltip title="Advanced search">
            <span>
              <IconButton
                size="small"
                onClick={() => { setPopperOpen(false); onOpenAdvanced?.(value.trim()); }}
                disabled={!onOpenAdvanced}
                aria-label="Advanced search"
              >
                <ManageSearchIcon />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title="Search all libraries">
            <IconButton size="small" onClick={() => setOpen(true)} aria-label="Search all libraries">
              <SearchIcon />
            </IconButton>
          </Tooltip>
        )}
        <Popper
          open={open && popperOpen && (value.trim().length >= MIN_QUERY_LENGTH || status !== 'idle')}
          anchorEl={anchorRef.current}
          placement="bottom-end"
          disablePortal
          sx={{ zIndex: 'modal' }}
        >
          <Paper elevation={8} sx={{ width: 480, maxWidth: '90vw', maxHeight: '70vh', overflowY: 'auto', mt: 1 }}>
            <Box sx={{ px: 2, pt: 1, pb: 0.5, borderBottom: 1, borderColor: 'divider' }}>
              <FormControlLabel
                control={<Checkbox size="small" checked={includeTranscripts} onChange={(e) => setIncludeTranscripts(e.target.checked)} />}
                label={<Typography variant="body2">Also search transcripts</Typography>}
              />
              {includeTranscripts &&
                <Typography variant="caption" color="text.secondary" component="div" sx={{ pb: 0.5 }}>
                  Can take a while on big libraries. Press Enter to search.
                </Typography>}
            </Box>
            {status === 'searching' && (
              <Stack alignItems="center" spacing={1} sx={{ py: 3 }} data-testid="omni-search-spinner">
                <CircularProgress size={24} />
                {building && <Typography variant="caption" color="text.secondary">Indexing your library…</Typography>}
              </Stack>
            )}
            {status === 'error' && <Alert severity="error" sx={{ m: 1 }}>{error}</Alert>}
            {status === 'done' && (nothingFound
              ? <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>No matches for "{value.trim()}".</Typography>
              : <OmniSearchResults results={results} transcripts={transcripts} onOpen={openResult} />)}
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
