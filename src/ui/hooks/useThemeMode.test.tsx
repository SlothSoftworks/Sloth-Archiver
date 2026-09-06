// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ThemeModeProvider, useThemeMode } from './useThemeMode';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    // Deliberately different from the hook's own initial state (dark +
    // slothui, see useThemeMode.tsx) so a test actually observes the
    // resolve-and-adopt transition rather than the mock coincidentally
    // matching the default already in place.
    getThemeMode: vi.fn().mockResolvedValue({ themeMode: 'light' }),
    setThemeMode: vi.fn().mockResolvedValue({ success: true, themeMode: 'light' }),
    getThemeName: vi.fn().mockResolvedValue({ themeName: 'default' }),
    setThemeName: vi.fn().mockResolvedValue({ success: true, themeName: 'default' }),
  };
});

describe('useThemeMode', () => {
  it('throws when used outside a ThemeModeProvider', () => {
    expect(() => renderHook(() => useThemeMode())).toThrow(/must be used within a ThemeModeProvider/);
  });

  it('starts at "dark"/"slothui" (the fresh-install defaults) and adopts the persisted values once they resolve', async () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper: ThemeModeProvider });

    expect(result.current.mode).toBe('dark');
    expect(result.current.themeName).toBe('slothui');
    await waitFor(() => expect(result.current.mode).toBe('light'));
    await waitFor(() => expect(result.current.themeName).toBe('default'));
    expect(window.electronAPI.getThemeMode).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.getThemeName).toHaveBeenCalledTimes(1);
  });

  it('setMode updates state immediately and persists via electronAPI.setThemeMode', async () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper: ThemeModeProvider });
    await waitFor(() => expect(result.current.mode).toBe('light'));

    act(() => result.current.setMode('dark'));

    expect(result.current.mode).toBe('dark');
    expect(window.electronAPI.setThemeMode).toHaveBeenCalledWith('dark');
  });

  it('setThemeName updates state immediately and persists via electronAPI.setThemeName', async () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper: ThemeModeProvider });
    await waitFor(() => expect(result.current.themeName).toBe('default'));

    act(() => result.current.setThemeName('slothui'));

    expect(result.current.themeName).toBe('slothui');
    expect(window.electronAPI.setThemeName).toHaveBeenCalledWith('slothui');
  });
});
