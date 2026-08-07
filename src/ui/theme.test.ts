import { describe, it, expect } from 'vitest';
import { getTheme } from './theme';

describe('getTheme', () => {
  it('returns a dark-mode palette for "dark"', () => {
    expect(getTheme('dark').palette.mode).toBe('dark');
  });

  it('returns a light-mode palette for "light"', () => {
    expect(getTheme('light').palette.mode).toBe('light');
  });
});
