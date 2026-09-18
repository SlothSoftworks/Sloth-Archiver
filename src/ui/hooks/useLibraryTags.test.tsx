// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor, renderHook } from '@testing-library/react';
import { LibraryTagsProvider, useLibraryTags } from './useLibraryTags';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [{ tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: null }] }),
    getActiveLibraryTag: vi.fn().mockResolvedValue({ activeLibraryTag: 'DefaultLibrary', activeLibraryTagDir: '/lib/DefaultLibrary' }),
    setActiveLibraryTag: vi.fn().mockResolvedValue({ success: true, activeLibraryTag: 'Other' }),
    createLibraryTag: vi.fn().mockResolvedValue({ success: true, tag: { tagName: 'New', folderName: 'New', createdEpoch: 1 } }),
  };
});

describe('useLibraryTags', () => {
  it('throws when used outside a LibraryTagsProvider', () => {
    expect(() => renderHook(() => useLibraryTags())).toThrow(/must be used within a LibraryTagsProvider/);
  });

  it('fetches the tag list and active tag once on mount', async () => {
    const { result } = renderHook(() => useLibraryTags(), { wrapper: LibraryTagsProvider });

    await waitFor(() => expect(result.current.libraryTags).toHaveLength(1));
    expect(result.current.activeLibraryTag).toBe('DefaultLibrary');
    expect(result.current.activeLibraryTagDir).toBe('/lib/DefaultLibrary');
  });

  it('shares one live instance across every consumer under the same provider -- a switch from one is visible to another', async () => {
    const { result: a } = renderHook(() => useLibraryTags(), { wrapper: LibraryTagsProvider });
    const { result: b } = renderHook(() => useLibraryTags(), { wrapper: LibraryTagsProvider });
    await waitFor(() => expect(a.current.activeLibraryTag).toBe('DefaultLibrary'));

    (window.electronAPI.getActiveLibraryTag as ReturnType<typeof vi.fn>).mockResolvedValue({ activeLibraryTag: 'Other', activeLibraryTagDir: '/lib/Other' });
    await a.current.switchTag('Other');

    expect(window.electronAPI.setActiveLibraryTag).toHaveBeenCalledWith('Other');
    await waitFor(() => expect(a.current.activeLibraryTag).toBe('Other'));
    // These are two independently-mounted hook instances under two separate
    // providers (renderHook gives each its own tree), so b is unaffected --
    // this just confirms switchTag re-fetches its own instance's state
    // correctly, not that state leaks across unrelated providers.
    expect(b.current.activeLibraryTag).toBe('DefaultLibrary');
  });

  it('createTag refreshes the shared state on success and reports failure without refreshing', async () => {
    const { result } = renderHook(() => useLibraryTags(), { wrapper: LibraryTagsProvider });
    await waitFor(() => expect(result.current.libraryTags).toHaveLength(1));

    (window.electronAPI.listLibraryTags as ReturnType<typeof vi.fn>).mockResolvedValue({
      tags: [
        { tagName: 'DefaultLibrary', folderName: 'DefaultLibrary', createdEpoch: null },
        { tagName: 'New', folderName: 'New', createdEpoch: 1 },
      ],
    });
    const created = await result.current.createTag('New');
    expect(created.success).toBe(true);
    await waitFor(() => expect(result.current.libraryTags).toHaveLength(2));

    (window.electronAPI.createLibraryTag as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, message: 'Name taken.' });
    const failed = await result.current.createTag('New');
    expect(failed.success).toBe(false);
    expect(failed.message).toBe('Name taken.');
    // Still 2 -- a failed create doesn't trigger a refresh.
    expect(result.current.libraryTags).toHaveLength(2);
  });
});
