import { useMemo, useState } from 'react';
import { useDebounce } from '../../utils/useDebounce.tsx';

// Backs every search bar in the Library tab (channel view, video view,
// playlist view, video-inside-channel view) -- one shared hook rather than
// four copies of the same debounce-then-filter logic.
//
// v1 only matches whatever single string getSearchText pulls out of each
// item (titles, per the spec) -- kept generic on purpose: getSearchText is a
// plain per-item string extractor, and the filter itself is a single
// `.includes()` check against it. Widening this later (matching description/
// uploader/date too, weighting matches, etc.) only ever means changing what
// getSearchText returns at each call site, or swapping the match check
// itself here in one place -- neither requires touching the search-bar UI
// or any of the four call sites' own rendering code.
export function useLibrarySearch<T>(items: T[], getSearchText: (item: T) => string, delay = 300) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, delay);
  const isSearching = debouncedQuery.trim().length > 0;

  const filtered = useMemo(() => {
    const trimmed = debouncedQuery.trim().toLowerCase();
    if (!trimmed) return items;
    return items.filter((item) => getSearchText(item).toLowerCase().includes(trimmed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, debouncedQuery]);

  const clear = () => setQuery('');

  return { query, setQuery, isSearching, filtered, clear };
}
