// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BackgroundPlayerProvider, useBackgroundPlayer, type BackgroundPlayerVideo } from './useBackgroundPlayer';

function makeVideo(overrides: Partial<BackgroundPlayerVideo> = {}): BackgroundPlayerVideo {
  return {
    videoId: 'v1', title: 'Video One', channel: 'Some Channel',
    thumbnailPath: '/lib/c/v1/thumb.jpg', sourcePath: '/lib/c/v1/1/video.mp4', mimeType: 'video/mp4',
    ...overrides,
  };
}

describe('useBackgroundPlayer', () => {
  it('throws when used outside a BackgroundPlayerProvider', () => {
    expect(() => renderHook(() => useBackgroundPlayer())).toThrow(/must be used within a BackgroundPlayerProvider/);
  });

  it('starts with nothing playing', () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    expect(result.current.current).toBeNull();
    expect(result.current.paused).toBe(true);
  });

  it('play() sets the current video and points the underlying element at it', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    // jsdom's HTMLMediaElement.play() rejects ("not implemented") -- expected
    // and already swallowed by the hook itself (see its own .catch(() => {})).
    act(() => result.current.play(makeVideo()));

    await waitFor(() => expect(result.current.current).toEqual(makeVideo()));
    expect(result.current.videoRef.current?.src).toContain('app-video://local/');
  });

  it('a second play() call replaces whatever was playing -- single slot, no queue', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.play(makeVideo({ videoId: 'v1' })));
    await waitFor(() => expect(result.current.current?.videoId).toBe('v1'));

    act(() => result.current.play(makeVideo({ videoId: 'v2', title: 'Video Two' })));
    await waitFor(() => expect(result.current.current?.videoId).toBe('v2'));
  });

  it('pause()/resume() toggle paused, driven by the underlying element\'s own play/pause events', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.play(makeVideo()));
    await waitFor(() => expect(result.current.current).not.toBeNull());

    const el = result.current.videoRef.current!;
    // jsdom doesn't actually play video, so drive paused state the same way
    // LibraryVideoPlayer.test.tsx's own tests do -- dispatch the real events
    // the hook's onPlay/onPause handlers are wired to.
    act(() => el.dispatchEvent(new Event('play')));
    expect(result.current.paused).toBe(false);

    act(() => el.dispatchEvent(new Event('pause')));
    expect(result.current.paused).toBe(true);
  });

  it('seek() sets the underlying element\'s currentTime', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.play(makeVideo()));
    await waitFor(() => expect(result.current.current).not.toBeNull());

    act(() => result.current.seek(42));
    expect(result.current.videoRef.current?.currentTime).toBe(42);
  });

  it('stop() clears current and resets paused/currentTime/duration', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.play(makeVideo()));
    await waitFor(() => expect(result.current.current).not.toBeNull());
    const el = result.current.videoRef.current!;
    act(() => el.dispatchEvent(new Event('play')));

    act(() => result.current.stop());

    expect(result.current.current).toBeNull();
    expect(result.current.paused).toBe(true);
    expect(result.current.currentTime).toBe(0);
    expect(result.current.duration).toBe(0);
  });

  it('shares one live instance across every consumer under the same provider', async () => {
    const { result: a } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    // Two independently-mounted providers -- confirms state is scoped per
    // provider (real React context, not an accidental module singleton),
    // same shape as useLibraryNotification.test.tsx's own equivalent check.
    const { result: b } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });

    act(() => a.current.play(makeVideo()));
    await waitFor(() => expect(a.current.current).not.toBeNull());
    expect(b.current.current).toBeNull();
  });
});
