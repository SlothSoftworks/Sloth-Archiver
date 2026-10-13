// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useFullLibraryVideo } from './useFullLibraryVideo';
import type { LibraryVideo } from '../../types';

function summary(videoDir: string, title = 'T'): LibraryVideo {
  // SAFETY: test fixture -- only the fields the hook reads (videoDir) and the
  // assertions compare by identity matter here.
  return { videoDir, videoFolderName: videoDir, latestEpoch: '1', metadata: { title }, epochs: [], thumbnailPath: null, clipCount: 0 } as unknown as LibraryVideo;
}

let resolvers: Array<(value: { success: boolean; video?: LibraryVideo }) => void>;

beforeEach(() => {
  resolvers = [];
  window.electronAPI = {
    ...window.electronAPI,
    getLibraryVideo: vi.fn(() => new Promise<{ success: boolean; video?: LibraryVideo }>((resolve) => { resolvers.push(resolve); })),
  };
});

describe('useFullLibraryVideo', () => {
  it('returns null for no video, and null while the first full entry loads', async () => {
    const { result, rerender } = renderHook(({ video }) => useFullLibraryVideo(video), { initialProps: { video: null as LibraryVideo | null } });
    expect(result.current).toBeNull();
    const a = summary('/a');
    rerender({ video: a });
    expect(result.current).toBeNull();
    const fullA = summary('/a', 'full');
    resolvers[0]({ success: true, video: fullA });
    await waitFor(() => expect(result.current).toBe(fullA));
  });

  it('keeps the previous full entry while re-fetching the same video, then swaps', async () => {
    const a1 = summary('/a');
    const { result, rerender } = renderHook(({ video }) => useFullLibraryVideo(video), { initialProps: { video: a1 } });
    const full1 = summary('/a', 'v1');
    resolvers[0]({ success: true, video: full1 });
    await waitFor(() => expect(result.current).toBe(full1));

    rerender({ video: summary('/a') }); // refreshed summary, same video
    expect(result.current).toBe(full1);
    const full2 = summary('/a', 'v2');
    resolvers[1]({ success: true, video: full2 });
    await waitFor(() => expect(result.current).toBe(full2));
  });

  it('never shows one video\'s entry for another, even if an older fetch resolves late', async () => {
    const { result, rerender } = renderHook(({ video }) => useFullLibraryVideo(video), { initialProps: { video: summary('/a') } });
    const b = summary('/b');
    rerender({ video: b });
    resolvers[0]({ success: true, video: summary('/a', 'late') });
    expect(result.current).toBeNull();
    const fullB = summary('/b', 'full');
    resolvers[1]({ success: true, video: fullB });
    await waitFor(() => expect(result.current).toBe(fullB));
  });

  it('falls back to the summary when the full entry can\'t be loaded', async () => {
    const a = summary('/a');
    const { result } = renderHook(() => useFullLibraryVideo(a));
    resolvers[0]({ success: false });
    await waitFor(() => expect(result.current).toBe(a));
  });
});
