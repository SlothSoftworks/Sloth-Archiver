// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ThemeModeProvider, useThemeMode } from './useThemeMode';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getThemeMode: vi.fn().mockResolvedValue({ themeMode: 'dark' }),
    setThemeMode: vi.fn().mockResolvedValue({ success: true, themeMode: 'dark' }),
  };
});

describe('useThemeMode', () => {
  it('throws when used outside a ThemeModeProvider', () => {
    expect(() => renderHook(() => useThemeMode())).toThrow(/must be used within a ThemeModeProvider/);
  });

  it('starts at "light" and adopts the persisted mode once getThemeMode resolves', async () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper: ThemeModeProvider });

    expect(result.current.mode).toBe('light');
    await waitFor(() => expect(result.current.mode).toBe('dark'));
    expect(window.electronAPI.getThemeMode).toHaveBeenCalledTimes(1);
  });

  it('setMode updates state immediately and persists via electronAPI.setThemeMode', async () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper: ThemeModeProvider });
    await waitFor(() => expect(result.current.mode).toBe('dark'));

    act(() => result.current.setMode('light'));

    expect(result.current.mode).toBe('light');
    expect(window.electronAPI.setThemeMode).toHaveBeenCalledWith('light');
  });
});
