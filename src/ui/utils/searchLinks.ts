import type { SearchResult } from '../../types/electron-api';

// Where a result opens: the library deep links LibraryScreen.tsx handles.
// A transcript line also names the version, the second and the language.
export function searchResultPath(result: SearchResult, line?: { start: number }): string {
  const tag = `tag=${encodeURIComponent(result.tag)}`;
  if (result.kind === 'playlist') return `/library?${tag}&section=playlists&playlist=${encodeURIComponent(result.playlistId)}`;
  const base = `/library/video/${encodeURIComponent(result.videoId)}?${tag}`;
  if (result.kind === 'clip') return `${base}&view=clips&clip=${encodeURIComponent(result.clipId)}`;
  if (result.kind === 'transcript') {
    const seconds = Math.floor(line?.start ?? result.lines[0]?.start ?? 0);
    return `${base}&epoch=${encodeURIComponent(result.epoch)}&t=${seconds}&lang=${encodeURIComponent(result.language)}`;
  }
  return base;
}
