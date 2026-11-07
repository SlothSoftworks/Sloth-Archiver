import { Fragment } from 'react';
import { Avatar, Box, ButtonBase, Chip, LinearProgress, List, ListItemButton, ListSubheader, Stack, Typography } from '@mui/material';
import OndemandVideoIcon from '@mui/icons-material/OndemandVideo';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import SubtitlesOutlinedIcon from '@mui/icons-material/SubtitlesOutlined';
import { buildAppVideoUrl, formatDurationSeconds } from '../../utils/utils';
import type { SearchMatch, SearchRange, SearchResults } from '../../types/electron-api';
import type { TranscriptSearchState } from '../hooks/useOmniSearch';
import { searchResultPath } from '../utils/searchLinks';

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  channel: 'Channel',
  notes: 'Notes',
  clipTitle: 'Clip title',
  clipNotes: 'Clip notes',
  playlistTitle: 'Playlist title',
  playlistUploader: 'Playlist by',
};

export function HighlightedRanges({ text, ranges }: { text: string; ranges: SearchRange[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, start)}</Fragment>);
    parts.push(<Box key={`m${i}`} component="mark" sx={{ bgcolor: 'warning.light', color: 'inherit', borderRadius: 0.5 }}>{text.slice(start, end)}</Box>);
    at = end;
  });
  if (at < text.length) parts.push(<Fragment key="rest">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}

function titleOf(text: string, matches: SearchMatch[], fieldName: string) {
  const match = matches.find((m) => m.field === fieldName);
  return match ? <HighlightedRanges text={match.text} ranges={match.ranges} /> : text;
}

// The first match outside the row's own title, e.g. "Notes: …rust…".
function OtherMatch({ matches, titleField }: { matches: SearchMatch[]; titleField: string }) {
  const match = matches.find((m) => m.field !== titleField && m.field !== 'channel');
  if (!match) return null;
  return (
    <Typography variant="caption" color="text.secondary" component="div" noWrap>
      {FIELD_LABELS[match.field] ?? match.field}: <HighlightedRanges text={match.text} ranges={match.ranges} />
    </Typography>
  );
}

function Thumb({ path, fallback }: { path: string | null; fallback: React.ReactNode }) {
  return (
    <Avatar variant="rounded" src={path ? buildAppVideoUrl(path) : undefined} sx={{ width: 48, height: 32, bgcolor: 'action.hover', color: 'text.secondary' }}>
      {fallback}
    </Avatar>
  );
}

function Row({ onClick, thumb, primary, secondary, tagName }: {
  onClick: () => void;
  thumb: React.ReactNode;
  primary: React.ReactNode;
  secondary: React.ReactNode;
  tagName: string;
}) {
  return (
    <ListItemButton onClick={onClick} sx={{ gap: 1.5, alignItems: 'flex-start' }}>
      {thumb}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" noWrap>{primary}</Typography>
        {secondary}
      </Box>
      <Chip size="small" variant="outlined" label={tagName} sx={{ maxWidth: 120 }} />
    </ListItemButton>
  );
}

function GroupHeader({ label, shown, total }: { label: string; shown: number; total: number }) {
  return (
    <ListSubheader disableSticky sx={{ lineHeight: '32px', bgcolor: 'transparent' }}>
      {label} ({total}){total > shown ? ` · showing ${shown}` : ''}
    </ListSubheader>
  );
}

// The grouped results of one omni-search, shared by the header's quick
// search and the advanced search dialog. onOpen gets the path to navigate to.
export default function OmniSearchResults({ results, transcripts, onOpen }: {
  results: SearchResults | null;
  transcripts: TranscriptSearchState | null;
  onOpen: (path: string) => void;
}) {
  const videos = results?.videos ?? { items: [], total: 0 };
  const clips = results?.clips ?? { items: [], total: 0 };
  const playlists = results?.playlists ?? { items: [], total: 0 };

  return (
    <List dense disablePadding>
      {videos.total > 0 && <GroupHeader label="Videos" shown={videos.items.length} total={videos.total} />}
      {videos.items.map((video) => (
        <Row
          key={video.videoDir}
          onClick={() => onOpen(searchResultPath(video))}
          thumb={<Thumb path={video.thumbnailPath} fallback={<OndemandVideoIcon fontSize="small" />} />}
          primary={titleOf(video.title, video.matches, 'title')}
          secondary={
            <>
              <Typography variant="caption" color="text.secondary" component="div" noWrap>{titleOf(video.channel, video.matches, 'channel')}</Typography>
              <OtherMatch matches={video.matches} titleField="title" />
            </>
          }
          tagName={video.tagName}
        />
      ))}

      {clips.total > 0 && <GroupHeader label="Clips" shown={clips.items.length} total={clips.total} />}
      {clips.items.map((clip) => (
        <Row
          key={`${clip.videoDir}:${clip.clipId}`}
          onClick={() => onOpen(searchResultPath(clip))}
          thumb={<Thumb path={clip.thumbnailPath} fallback={<ContentCutIcon fontSize="small" />} />}
          primary={titleOf(clip.clipTitle, clip.matches, 'clipTitle')}
          secondary={
            <>
              <Typography variant="caption" color="text.secondary" component="div" noWrap>Clip of {clip.title}</Typography>
              <OtherMatch matches={clip.matches} titleField="clipTitle" />
            </>
          }
          tagName={clip.tagName}
        />
      ))}

      {playlists.total > 0 && <GroupHeader label="Playlists" shown={playlists.items.length} total={playlists.total} />}
      {playlists.items.map((playlist) => (
        <Row
          key={`${playlist.tag}:${playlist.playlistId}`}
          onClick={() => onOpen(searchResultPath(playlist))}
          thumb={<Thumb path={null} fallback={<PlaylistPlayIcon fontSize="small" />} />}
          primary={titleOf(playlist.title, playlist.matches, 'playlistTitle')}
          secondary={
            <Typography variant="caption" color="text.secondary" component="div" noWrap>
              Playlist{playlist.uploader ? ' by ' : ''}{titleOf(playlist.uploader, playlist.matches, 'playlistUploader')}
            </Typography>
          }
          tagName={playlist.tagName}
        />
      ))}

      {transcripts && (
        <>
          <GroupHeader label="Transcripts" shown={transcripts.items.length} total={transcripts.matched} />
          {!transcripts.done && (
            <Stack spacing={0.5} sx={{ px: 2, pb: 1 }} data-testid="transcript-search-progress">
              <Typography variant="caption" color="text.secondary">
                Searching transcripts… {transcripts.scanned} / {transcripts.total}
              </Typography>
              <LinearProgress variant={transcripts.total ? 'determinate' : 'indeterminate'} value={transcripts.total ? (transcripts.scanned / transcripts.total) * 100 : 0} />
            </Stack>
          )}
          {transcripts.done && transcripts.matched === 0 &&
            <Typography variant="caption" color="text.secondary" component="div" sx={{ px: 2, pb: 1 }}>No transcript matches.</Typography>}
          {transcripts.items.map((hit) => (
            <Box key={`${hit.videoDir}:${hit.epoch}:${hit.language}`} sx={{ px: 2, py: 0.75 }}>
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Thumb path={hit.thumbnailPath} fallback={<SubtitlesOutlinedIcon fontSize="small" />} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" noWrap>{hit.title}</Typography>
                  <Typography variant="caption" color="text.secondary" component="div" noWrap>
                    {hit.languageName} transcript{hit.isLatest ? '' : ' · older version'} · {hit.lineCount} {hit.lineCount === 1 ? 'line' : 'lines'}
                  </Typography>
                  {hit.lines.map((line) => (
                    <ButtonBase
                      key={line.start}
                      onClick={() => onOpen(searchResultPath(hit, line))}
                      sx={{ display: 'flex', width: '100%', justifyContent: 'flex-start', alignItems: 'baseline', gap: 1, px: 0.5, py: 0.25, borderRadius: 1, textAlign: 'left', '&:hover': { bgcolor: 'action.hover' } }}
                    >
                      <Typography variant="caption" color="primary" sx={{ fontFamily: 'monospace', flexShrink: 0 }}>{formatDurationSeconds(line.start)}</Typography>
                      <Typography variant="caption"><HighlightedRanges text={line.text} ranges={line.ranges} /></Typography>
                    </ButtonBase>
                  ))}
                </Box>
                <Chip size="small" variant="outlined" label={hit.tagName} sx={{ maxWidth: 120 }} />
              </Stack>
            </Box>
          ))}
        </>
      )}
    </List>
  );
}
