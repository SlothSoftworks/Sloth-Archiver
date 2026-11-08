import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Alert, Box, Button, Checkbox, CircularProgress, Dialog, DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, FormGroup,
  IconButton, InputLabel, MenuItem, Select, Stack, TextField, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import { useOmniSearch } from '../hooks/useOmniSearch';
import OmniSearchResults from './OmniSearchResults';

type Mode = 'text' | 'regex' | 'terms';
type Term = { text: string; op: 'and' | 'or' };
type SearchIn = { notes: boolean; clips: boolean; playlists: boolean; descriptions: boolean; transcripts: boolean };

const MAX_TERMS = 5;
const SEARCH_IN_OPTIONS: [keyof SearchIn, string][] = [
  ['notes', 'Notes'],
  ['clips', 'Clips'],
  ['playlists', 'Saved playlists'],
  ['descriptions', 'Descriptions'],
  ['transcripts', 'Transcripts'],
];

function regexProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, 'iu');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// The in-depth search: pick sublibraries, what to search in, and a search
// type (plain text, a regex, or up to five terms joined by AND/OR). It
// stays mounted while closed, so the last search and its results are still
// there when it's reopened. seedText fills an empty query when it opens
// (the quick search's text, when opened from there).
export default function AdvancedSearchDialog({ open, onClose, seedText = '' }: {
  open: boolean;
  onClose: () => void;
  seedText?: string;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [terms, setTerms] = useState<Term[]>([{ text: '', op: 'and' }, { text: '', op: 'and' }]);
  const [searchIn, setSearchIn] = useState<SearchIn>({ notes: true, clips: true, playlists: true, descriptions: false, transcripts: false });
  const [sublibraries, setSublibraries] = useState<{ tagName: string; folderName: string }[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const { status, results, descriptions, transcripts, error, building, search } = useOmniSearch();

  useEffect(() => {
    if (!open) return;
    window.electronAPI.listLibraryTags().then(({ tags }) => setSublibraries(tags));
    if (seedText && !text) setText(seedText);
    // Only on opening: the seed must not overwrite what's typed afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const problem = mode === 'regex' && text ? regexProblem(text) : null;
  const chosenTags = sublibraries.filter((s) => !excluded.has(s.folderName)).map((s) => s.folderName);
  const hasQuery = mode === 'terms' ? terms.some((t) => t.text.trim()) : !!text.trim();
  const canSearch = hasQuery && !problem && chosenTags.length > 0;

  const runSearch = () => {
    if (!canSearch) return;
    search(
      mode === 'terms' ? { mode, terms } : { mode, text },
      { ...searchIn, tags: excluded.size > 0 ? chosenTags : null },
    );
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') runSearch();
  };

  const updateTerm = (index: number, change: Partial<Term>) => {
    setTerms((prev) => prev.map((term, i) => (i === index ? { ...term, ...change } : term)));
  };

  const openResult = (path: string) => {
    onClose();
    navigate(path);
  };

  const nothingFound = status === 'done' && results
    && results.videos.total + results.clips.total + results.playlists.total === 0
    && (!descriptions || (descriptions.done && descriptions.matched === 0))
    && (!transcripts || (transcripts.done && transcripts.matched === 0));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" slotProps={{ paper: { sx: { height: '85vh' } } }}>
      <DialogTitle sx={{ pr: 6 }}>
        Advanced search
        <IconButton onClick={onClose} aria-label="Close advanced search" sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1.5} alignItems="flex-start">
            <FormControl size="small" sx={{ minWidth: 170 }}>
              <InputLabel id="advanced-search-type-label">Search type</InputLabel>
              <Select labelId="advanced-search-type-label" label="Search type" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <MenuItem value="text">Text</MenuItem>
                <MenuItem value="regex">Regex pattern</MenuItem>
                <MenuItem value="terms">Terms (AND / OR)</MenuItem>
              </Select>
            </FormControl>
            {mode !== 'terms' && (
              <TextField
                size="small"
                fullWidth
                autoFocus
                label={mode === 'regex' ? 'Pattern' : 'Search for'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onEnter}
                error={!!problem}
                helperText={problem ? `Invalid pattern: ${problem}` : mode === 'regex' ? 'Not case-sensitive. Example: episode\\s*\\d+' : 'Not case- or accent-sensitive.'}
              />
            )}
          </Stack>

          {mode === 'terms' && (
            <Stack spacing={1}>
              {terms.map((term, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="center">
                  {i === 0 ? <Box sx={{ width: 90, flexShrink: 0 }} /> : (
                    <Select
                      size="small"
                      value={term.op}
                      onChange={(e) => updateTerm(i, { op: e.target.value as Term['op'] })}
                      sx={{ width: 90, flexShrink: 0 }}
                      inputProps={{ 'aria-label': `Join term ${i + 1}` }}
                    >
                      <MenuItem value="and">AND</MenuItem>
                      <MenuItem value="or">OR</MenuItem>
                    </Select>
                  )}
                  <TextField
                    size="small"
                    fullWidth
                    label={`Term ${i + 1}`}
                    value={term.text}
                    onChange={(e) => updateTerm(i, { text: e.target.value })}
                    onKeyDown={onEnter}
                  />
                  <IconButton
                    size="small"
                    onClick={() => setTerms((prev) => prev.filter((_, j) => j !== i))}
                    disabled={terms.length === 1}
                    aria-label={`Remove term ${i + 1}`}
                  >
                    <RemoveCircleOutlineIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
              <Box>
                <Button size="small" startIcon={<AddIcon />} onClick={() => setTerms((prev) => [...prev, { text: '', op: 'and' }])} disabled={terms.length >= MAX_TERMS}>
                  Add term
                </Button>
              </Box>
              <Typography variant="caption" color="text.secondary">
                AND binds tighter than OR: "a OR b AND c" finds a, or b together with c. Terms can match in different fields.
              </Typography>
            </Stack>
          )}

          <Box>
            <Typography variant="subtitle2">Search in</Typography>
            <FormGroup row>
              <FormControlLabel control={<Checkbox size="small" checked disabled />} label="Titles & channels" />
              {SEARCH_IN_OPTIONS.map(([key, label]) => (
                <FormControlLabel
                  key={key}
                  control={<Checkbox size="small" checked={searchIn[key]} onChange={(e) => setSearchIn((prev) => ({ ...prev, [key]: e.target.checked }))} />}
                  label={label}
                />
              ))}
            </FormGroup>
            {(searchIn.descriptions || searchIn.transcripts) &&
              <Typography variant="caption" color="text.secondary">Descriptions and transcripts are read from disk, so they can take a while on big libraries.</Typography>}
          </Box>

          {sublibraries.length > 1 && (
            <Box>
              <Typography variant="subtitle2">Sublibraries</Typography>
              <FormGroup row>
                {sublibraries.map(({ tagName, folderName }) => (
                  <FormControlLabel
                    key={folderName}
                    control={
                      <Checkbox
                        size="small"
                        checked={!excluded.has(folderName)}
                        onChange={(e) => setExcluded((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.delete(folderName);
                          else next.add(folderName);
                          return next;
                        })}
                      />
                    }
                    label={tagName}
                  />
                ))}
              </FormGroup>
              {chosenTags.length === 0 && <Typography variant="caption" color="error">Pick at least one sublibrary.</Typography>}
            </Box>
          )}

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="contained" onClick={runSearch} disabled={!canSearch || status === 'searching'}>Search</Button>
          </Box>

          <Divider />

          {status === 'searching' && (
            <Stack alignItems="center" spacing={1} sx={{ py: 3 }} data-testid="advanced-search-spinner">
              <CircularProgress size={24} />
              {building && <Typography variant="caption" color="text.secondary">Indexing your library…</Typography>}
            </Stack>
          )}
          {status === 'error' && <Alert severity="error">{error}</Alert>}
          {status === 'done' && (nothingFound
            ? <Typography variant="body2" color="text.secondary">No matches.</Typography>
            : <OmniSearchResults results={results} descriptions={descriptions} transcripts={transcripts} onOpen={openResult} />)}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
