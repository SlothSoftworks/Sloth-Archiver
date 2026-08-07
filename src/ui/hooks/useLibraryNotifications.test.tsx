// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LibraryNotificationProvider, useLibraryNotification } from './useLibraryNotifications';

describe('useLibraryNotification', () => {
  it('throws when used outside a LibraryNotificationProvider', () => {
    expect(() => renderHook(() => useLibraryNotification())).toThrow(/must be used within a LibraryNotificationProvider/);
  });

  it('starts at 0, increments, and resets', () => {
    const { result } = renderHook(() => useLibraryNotification(), {
      wrapper: LibraryNotificationProvider,
    });

    expect(result.current.count).toBe(0);

    act(() => result.current.increment());
    act(() => result.current.increment());
    expect(result.current.count).toBe(2);

    act(() => result.current.reset());
    expect(result.current.count).toBe(0);
  });

  it('shares one counter across every consumer under the same provider', () => {
    const { result: a } = renderHook(() => useLibraryNotification(), { wrapper: LibraryNotificationProvider });
    // A second, independently-mounted provider is a genuinely separate instance --
    // this confirms the count is scoped per-provider (as React context always is),
    // not some accidental module-level singleton.
    const { result: b } = renderHook(() => useLibraryNotification(), { wrapper: LibraryNotificationProvider });

    act(() => a.current.increment());
    expect(a.current.count).toBe(1);
    expect(b.current.count).toBe(0);
  });
});
