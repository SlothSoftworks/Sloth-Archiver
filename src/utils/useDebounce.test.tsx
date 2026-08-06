// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebounce, useDebouncedCallback } from './useDebounce';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebounce', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('first', 500));
    expect(result.current).toBe('first');
  });

  it('updates to the latest value only after the delay elapses', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
      initialProps: { value: 'first' },
    });

    rerender({ value: 'second' });
    expect(result.current).toBe('first'); // not yet -- delay hasn't elapsed

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current).toBe('first');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('second');
  });

  it('resets the timer on rapid changes, only committing the final value', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender({ value: 'c' }); // resets the 500ms window again
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe('a'); // still not committed -- only 300ms since the last change

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('c'); // 'b' was skipped entirely
  });
});

describe('useDebouncedCallback', () => {
  it('does not call the callback immediately', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 500));
    result.current('arg');
    expect(callback).not.toHaveBeenCalled();
  });

  it('calls the callback once, with the latest args, after the delay', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 500));

    result.current('first');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    result.current('second'); // resets the timer

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('second');
  });
});
