import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LibraryTag } from '../../types/electron-api';

// Mirrors useLibraryNotifications.tsx's provider pattern -- a single
// instance lives at the app root so BulkAddDialog (permanently mounted in
// BulkAddSidePanel, outside any tab panel), DownloaderScreen, and
// LibraryScreen (both inside their own tab-switch-remounted CustomTabPanel)
// all share the same live libraryTags/activeLibraryTag instead of each
// holding an independent, fetch-once-on-mount copy. That independence was
// exactly the bug: BulkAddDialog's own copy never got a chance to re-run,
// so a sublibrary created after app launch never appeared there and its
// default target stayed stuck on whatever was active at launch.
function useLibraryTagsState() {
  const [libraryTags, setLibraryTags] = useState<LibraryTag[]>([]);
  const [activeLibraryTag, setActiveLibraryTag] = useState('');
  const [activeLibraryTagDir, setActiveLibraryTagDir] = useState('');

  const refresh = async () => {
    const [{ tags }, { activeLibraryTag: tag, activeLibraryTagDir: tagDir }] = await Promise.all([
      window.electronAPI.listLibraryTags(),
      window.electronAPI.getActiveLibraryTag(),
    ]);
    setLibraryTags(tags);
    setActiveLibraryTag(tag);
    setActiveLibraryTagDir(tagDir);
  };

  useEffect(() => {
    refresh();
  }, []);

  const switchTag = async (tag: string) => {
    await window.electronAPI.setActiveLibraryTag(tag);
    await refresh();
  };

  const createTag = async (name: string) => {
    const result = await window.electronAPI.createLibraryTag(name);
    if (result.success) {
      // createLibraryTag already switches the active tag server-side --
      // refresh() picks that up too, not just the new tag's presence in
      // the list.
      await refresh();
    }
    return result;
  };

  return { libraryTags, activeLibraryTag, activeLibraryTagDir, refresh, switchTag, createTag };
}

type LibraryTagsContextValue = ReturnType<typeof useLibraryTagsState>;

const LibraryTagsContext = createContext<LibraryTagsContextValue | null>(null);

export function LibraryTagsProvider({ children }: { children: ReactNode }) {
  const value = useLibraryTagsState();
  return (
    <LibraryTagsContext.Provider value={value}>
      {children}
    </LibraryTagsContext.Provider>
  );
}

export function useLibraryTags() {
  const ctx = useContext(LibraryTagsContext);
  if (!ctx) {
    throw new Error('useLibraryTags must be used within a LibraryTagsProvider');
  }
  return ctx;
}
