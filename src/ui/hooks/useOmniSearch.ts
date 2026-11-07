import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchQuery, SearchResults, SearchScope, SearchTranscriptResult } from '../../types/electron-api';

export type TranscriptSearchState = {
  items: SearchTranscriptResult[];
  matched: number;
  scanned: number;
  total: number;
  done: boolean;
};

// Runs omni-searches (main's search:query) and collects the transcript
// results that stream in afterwards. Only the latest search counts: a newer
// one, or clear(), makes anything still arriving for an older one ignored.
export function useOmniSearch() {
  const [status, setStatus] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptSearchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const currentIdRef = useRef<string | null>(null);

  useEffect(() => {
    const listener = window.electronAPI.onSearchProgress((progress) => {
      if (progress.searchId !== currentIdRef.current) return;
      setTranscripts((prev) => ({
        items: [...(prev?.items ?? []), ...progress.items],
        matched: progress.matched,
        scanned: progress.scanned,
        total: progress.total,
        done: progress.done,
      }));
    });
    return () => window.electronAPI.removeSearchProgressListener(listener);
  }, []);

  const search = useCallback(async (query: SearchQuery, scope: SearchScope = {}) => {
    const searchId = crypto.randomUUID();
    currentIdRef.current = searchId;
    setStatus('searching');
    setError(null);
    setTranscripts(scope.transcripts ? { items: [], matched: 0, scanned: 0, total: 0, done: false } : null);
    window.electronAPI.getSearchStatus().then(({ building: isBuilding }) => {
      if (currentIdRef.current === searchId) setBuilding(isBuilding);
    });
    const response = await window.electronAPI.searchLibrary({ searchId, query, scope });
    if (currentIdRef.current !== searchId) return;
    setBuilding(false);
    if (!response.success) {
      if (response.cancelled) return;
      setResults(null);
      setTranscripts(null);
      setError(response.message ?? 'The search failed.');
      setStatus('error');
      return;
    }
    setResults(response.results);
    setStatus('done');
  }, []);

  const clear = useCallback(() => {
    if (currentIdRef.current) window.electronAPI.cancelSearch(currentIdRef.current);
    currentIdRef.current = null;
    setStatus('idle');
    setResults(null);
    setTranscripts(null);
    setError(null);
    setBuilding(false);
  }, []);

  return { status, results, transcripts, error, building, search, clear };
}
