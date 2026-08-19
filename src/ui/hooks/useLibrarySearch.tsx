import { useMemo, useState } from 'react';
import { useDebounce } from '../../utils/useDebounce.tsx';

// Backs every search bar in the Library tab (channel/video/playlist/
// video-inside-channel views) -- one shared hook instead of four copies of
// the same debounce-then-filter logic. getSearchText stays a generic
// per-item string extractor so widening the match later (description,
// uploader, date, ...) only means changing that function per call site, not
// touching this hook or any search-bar UI.
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
