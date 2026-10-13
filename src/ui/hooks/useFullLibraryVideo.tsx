import { useEffect, useState } from 'react';
import type { LibraryVideo } from '../../types';

// PERF-004: the library index the renderer receives is a summary -- the
// heavier metadata fields only the video detail view reads (description,
// available resolutions, tags/categories/music/license) are left out of it
// (summarizeLibraryIndex, library.mjs). This loads the full entry for the
// one video being shown, re-fetching whenever the summary object changes
// (i.e. after any library update), so the detail view always gets complete,
// current data.
//
// Returns null only while the *first* full entry for a video is loading;
// on later refreshes of the same video the previous full entry stays in
// place until the new one arrives, so the view never flickers. If the fetch
// fails, the summary itself is used -- the view still works, just without
// the detail-only fields.
export function useFullLibraryVideo(video: LibraryVideo | null): LibraryVideo | null {
  const [loaded, setLoaded] = useState<{ videoDir: string; video: LibraryVideo } | null>(null);

  useEffect(() => {
    if (!video) return;
    let cancelled = false;
    window.electronAPI.getLibraryVideo(video.videoDir)
      .then((result) => {
        if (!cancelled) setLoaded({ videoDir: video.videoDir, video: result.success && result.video ? result.video : video });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ videoDir: video.videoDir, video });
      });
    return () => { cancelled = true; };
  }, [video]);

  if (!video) return null;
  return loaded && loaded.videoDir === video.videoDir ? loaded.video : null;
}
