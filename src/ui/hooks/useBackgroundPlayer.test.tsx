// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { BackgroundPlayerProvider, useBackgroundPlayer, videoDetailPathFor, nativelyPlayableSource, type BackgroundPlayerVideo } from './useBackgroundPlayer';

function makeVideo(overrides: Partial<BackgroundPlayerVideo> = {}): BackgroundPlayerVideo {
  return {
    videoId: 'v1', title: 'Video One', channel: 'Some Channel',
    thumbnailPath: '/lib/c/v1/thumb.jpg', sourcePath: '/lib/c/v1/1/video.mp4', mimeType: 'video/mp4',
    ...overrides,
  };
}

describe('videoDetailPathFor', () => {
  it('links to the plain video route by default', () => {
    expect(videoDetailPathFor(makeVideo({ videoId: 'abc123' }))).toBe('/library/video/abc123');
  });

  it('links into Clip Collection with the clip pre-selected when clipId is set', () => {
    expect(videoDetailPathFor(makeVideo({ videoId: 'abc123', clipId: 'clip1' })))
      .toBe('/library/video/abc123?view=clips&clip=clip1');
  });
});

describe('nativelyPlayableSource', () => {
  it('returns null for a missing or non-native file', () => {
    expect(nativelyPlayableSource(null)).toBeNull();
    expect(nativelyPlayableSource(undefined)).toBeNull();
    expect(nativelyPlayableSource('/lib/c/v1/1/video.mkv')).toBeNull();
  });

  it('resolves mp4/webm to their source path and mime type', () => {
    expect(nativelyPlayableSource('/lib/c/v1/1/video.mp4')).toEqual({ sourcePath: '/lib/c/v1/1/video.mp4', mimeType: 'video/mp4' });
    expect(nativelyPlayableSource('/lib/c/v1/1/video.webm')).toEqual({ sourcePath: '/lib/c/v1/1/video.webm', mimeType: 'video/webm' });
  });
});

describe('useBackgroundPlayer', () => {
  it('throws when used outside a BackgroundPlayerProvider', () => {
    expect(() => renderHook(() => useBackgroundPlayer())).toThrow(/must be used within a BackgroundPlayerProvider/);
  });

  it('starts with an empty queue and nothing playing', () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    expect(result.current.queue).toEqual([]);
    expect(result.current.current).toBeNull();
    expect(result.current.paused).toBe(true);
  });

  it('enqueue() on an empty queue starts playing that item immediately', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    // jsdom's HTMLMediaElement.play() rejects ("not implemented") -- expected
    // and already swallowed by the hook itself (see its own .catch(() => {})).
    act(() => result.current.enqueue(makeVideo()));

    await waitFor(() => expect(result.current.current).toEqual(makeVideo()));
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.videoRef.current?.src).toContain('app-video://local/');
  });

  it('enqueue() while something is already playing appends without interrupting it', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    await waitFor(() => expect(result.current.current?.videoId).toBe('v1'));
    const srcAfterFirst = result.current.videoRef.current?.src;

    act(() => result.current.enqueue(makeVideo({ videoId: 'v2', title: 'Video Two' })));

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.current?.videoId).toBe('v1');
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.videoRef.current?.src).toBe(srcAfterFirst);
  });

  it('enqueue() refuses an exact repeat (same videoId and clipId), showing a toast instead', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1', title: 'Video One' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    expect(result.current.toastMessage).toBeNull();

    act(() => result.current.enqueue(makeVideo({ videoId: 'v1', title: 'Video One' })));

    expect(result.current.queue).toHaveLength(1);
    expect(result.current.toastMessage).toContain('Video One');

    act(() => result.current.dismissToast());
    expect(result.current.toastMessage).toBeNull();
  });

  it('enqueue() allows the same videoId with a different clipId (a clip vs. its parent video)', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1', clipId: null })));
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    act(() => result.current.enqueue(makeVideo({ videoId: 'v1', clipId: 'clip1' })));

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.toastMessage).toBeNull();
  });

  it('two enqueue() calls fired back to back (before either has re-rendered) both land correctly, with the video element matching the first item -- regression for the "added item stays gray, never plays" bug', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });

    // Both calls inside one act(): neither has had a chance to re-render
    // (and thus refresh `queue`/`currentIndex` in a plain closure) before
    // the second one runs -- exactly the "two clicks in quick succession"
    // scenario the bug report described ("adding individual items from
    // different playlists ... only sometimes").
    act(() => {
      result.current.enqueue(makeVideo({ videoId: 'v1', title: 'Video One', sourcePath: '/lib/c/v1/1/video.mp4' }));
      result.current.enqueue(makeVideo({ videoId: 'v2', title: 'Video Two', sourcePath: '/lib/c/v2/1/video.mp4' }));
    });

    expect(result.current.queue.map((v) => v.videoId)).toEqual(['v1', 'v2']);
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.current?.videoId).toBe('v1');
    // The real <video> element must be loaded with the FIRST item -- the
    // bug let the second enqueue's loadAndPlay silently win, leaving the
    // element pointed at v2 while every piece of state still said "v1 is
    // current," so it never actually started playing.
    expect(result.current.videoRef.current?.src).toContain('v1');
  });

  it('under StrictMode, enqueue() on an empty queue calls play() exactly once (regression: side effects used to live inside the setQueue updater, which StrictMode double-invokes)', async () => {
    function StrictWrapper({ children }: { children: ReactNode }) {
      return <StrictMode><BackgroundPlayerProvider>{children}</BackgroundPlayerProvider></StrictMode>;
    }
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: StrictWrapper });
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play');

    act(() => result.current.enqueue(makeVideo()));
    await waitFor(() => expect(result.current.current).not.toBeNull());

    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('next()/previous() move currentIndex and swap the underlying source, no-op at either boundary', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1', sourcePath: '/lib/c/v1/1/video.mp4' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v2', sourcePath: '/lib/c/v2/1/video.mp4' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    act(() => result.current.previous()); // already at index 0 -- no-op
    expect(result.current.currentIndex).toBe(0);

    act(() => result.current.next());
    expect(result.current.currentIndex).toBe(1);
    expect(result.current.current?.videoId).toBe('v2');
    expect(result.current.videoRef.current?.src).toContain('v2');

    act(() => result.current.next()); // already at the last item -- no-op
    expect(result.current.currentIndex).toBe(1);

    act(() => result.current.previous());
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.current?.videoId).toBe('v1');
  });

  it('playAt() jumps straight to an arbitrary queue entry, and no-ops on the already-current one', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v2' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v3' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(3));

    act(() => result.current.playAt(2));
    expect(result.current.currentIndex).toBe(2);
    expect(result.current.current?.videoId).toBe('v3');

    const srcAtV3 = result.current.videoRef.current?.src;
    act(() => result.current.playAt(2)); // already current -- no-op
    expect(result.current.currentIndex).toBe(2);
    expect(result.current.videoRef.current?.src).toBe(srcAtV3);

    act(() => result.current.playAt(0));
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.current?.videoId).toBe('v1');
  });

  it('removeAt() on an earlier item shifts currentIndex down without disturbing what\'s playing', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v2' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v3' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(3));
    act(() => result.current.playAt(2)); // now playing v3, at index 2

    act(() => result.current.removeAt(0)); // remove v1, which sat before it

    expect(result.current.queue.map((v) => v.videoId)).toEqual(['v2', 'v3']);
    expect(result.current.currentIndex).toBe(1);
    expect(result.current.current?.videoId).toBe('v3');
  });

  it('removeAt() on a later item leaves currentIndex and playback untouched', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v2' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    act(() => result.current.removeAt(1)); // remove v2, still on v1

    expect(result.current.queue.map((v) => v.videoId)).toEqual(['v1']);
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.current?.videoId).toBe('v1');
  });

  it('removeAt() on the currently-playing item plays whatever now sits in its place', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1', sourcePath: '/lib/c/v1/1/video.mp4' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v2', sourcePath: '/lib/c/v2/1/video.mp4' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v3', sourcePath: '/lib/c/v3/1/video.mp4' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(3));

    act(() => result.current.removeAt(0)); // remove v1, the one currently playing

    expect(result.current.queue.map((v) => v.videoId)).toEqual(['v2', 'v3']);
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.current?.videoId).toBe('v2');
    expect(result.current.videoRef.current?.src).toContain('v2');
  });

  it('removeAt() on the last remaining item stops playback and empties the queue', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    await waitFor(() => expect(result.current.current?.videoId).toBe('v1'));
    const el = result.current.videoRef.current!;
    const pauseSpy = vi.spyOn(el, 'pause');

    act(() => result.current.removeAt(0));

    expect(result.current.queue).toEqual([]);
    expect(result.current.current).toBeNull();
    expect(result.current.currentIndex).toBe(0);
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('auto-advances to the next item when the current one ends', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v2' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(2));
    const el = result.current.videoRef.current!;

    act(() => el.dispatchEvent(new Event('ended')));

    expect(result.current.currentIndex).toBe(1);
    expect(result.current.current?.videoId).toBe('v2');
  });

  it('stops (paused) instead of wrapping around when the last item in the queue ends', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    await waitFor(() => expect(result.current.current?.videoId).toBe('v1'));
    const el = result.current.videoRef.current!;
    act(() => el.dispatchEvent(new Event('play')));

    act(() => el.dispatchEvent(new Event('ended')));

    expect(result.current.currentIndex).toBe(0);
    expect(result.current.current?.videoId).toBe('v1');
    expect(result.current.paused).toBe(true);
  });

  it('pause()/resume() toggle paused, driven by the underlying element\'s own play/pause events', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo()));
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
    act(() => result.current.enqueue(makeVideo()));
    await waitFor(() => expect(result.current.current).not.toBeNull());

    act(() => result.current.seek(42));
    expect(result.current.videoRef.current?.currentTime).toBe(42);
  });

  it('stop() clears the whole queue and resets paused/currentTime/duration', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    act(() => result.current.enqueue(makeVideo({ videoId: 'v2' })));
    await waitFor(() => expect(result.current.queue).toHaveLength(2));
    const el = result.current.videoRef.current!;
    act(() => el.dispatchEvent(new Event('play')));

    act(() => result.current.stop());

    expect(result.current.queue).toEqual([]);
    expect(result.current.current).toBeNull();
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.paused).toBe(true);
    expect(result.current.currentTime).toBe(0);
    expect(result.current.duration).toBe(0);
  });

  it('starts at full volume, unmuted', () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    expect(result.current.volume).toBe(1);
    expect(result.current.muted).toBe(false);
  });

  it('setVolume() updates state and the underlying element\'s volume', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo()));
    await waitFor(() => expect(result.current.current).not.toBeNull());

    act(() => result.current.setVolume(0.4));

    expect(result.current.volume).toBe(0.4);
    expect(result.current.videoRef.current?.volume).toBe(0.4);
  });

  it('setMuted() updates state and the underlying element\'s muted flag', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo()));
    await waitFor(() => expect(result.current.current).not.toBeNull());

    act(() => result.current.setMuted(true));

    expect(result.current.muted).toBe(true);
    expect(result.current.videoRef.current?.muted).toBe(true);
  });

  it('applies the current volume/muted to a freshly-loaded source, not just the element already playing', async () => {
    const { result } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    act(() => result.current.enqueue(makeVideo({ videoId: 'v1' })));
    await waitFor(() => expect(result.current.current?.videoId).toBe('v1'));
    act(() => result.current.setVolume(0.2));
    act(() => result.current.setMuted(true));

    act(() => result.current.enqueue(makeVideo({ videoId: 'v2' })));
    act(() => result.current.playAt(1));

    expect(result.current.videoRef.current?.volume).toBe(0.2);
    expect(result.current.videoRef.current?.muted).toBe(true);
  });

  it('shares one live instance across every consumer under the same provider', async () => {
    const { result: a } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });
    // Two independently-mounted providers -- confirms state is scoped per
    // provider (real React context, not an accidental module singleton),
    // same shape as useLibraryNotification.test.tsx's own equivalent check.
    const { result: b } = renderHook(() => useBackgroundPlayer(), { wrapper: BackgroundPlayerProvider });

    act(() => a.current.enqueue(makeVideo()));
    await waitFor(() => expect(a.current.current).not.toBeNull());
    expect(b.current.current).toBeNull();
  });

  describe('visibleContainer -- reparenting the live <video> into QueueDrawer.tsx', () => {
    // A stand-in for QueueDrawer.tsx's own video-container Box: registers
    // its DOM node via setVisibleContainer on mount, unregisters (falling
    // back to the Provider's default hidden container) on unmount.
    function VisibleContainer() {
      const { setVisibleContainer } = useBackgroundPlayer();
      return <div ref={(el) => setVisibleContainer(el)} data-testid="visible-container" />;
    }

    it('moves the same <video> element into a registered container without resetting playback, and adds native controls', async () => {
      function Harness({ showContainer }: { showContainer: boolean }) {
        const { enqueue } = useBackgroundPlayer();
        return (
          <>
            <button onClick={() => enqueue(makeVideo())}>enqueue (test)</button>
            {showContainer && <VisibleContainer />}
          </>
        );
      }
      const { getByTestId, getByRole, rerender, container } = render(
        <BackgroundPlayerProvider><Harness showContainer={false} /></BackgroundPlayerProvider>,
      );
      await act(async () => { getByRole('button', { name: 'enqueue (test)' }).click(); });
      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toHaveAttribute('controls');
      act(() => { video.currentTime = 12; });

      rerender(<BackgroundPlayerProvider><Harness showContainer /></BackgroundPlayerProvider>);

      const visibleContainer = getByTestId('visible-container');
      const videoAfter = visibleContainer.querySelector('video') as HTMLVideoElement;
      // Same underlying element (React reparented it via the portal target
      // change, not a fresh mount) -- confirmed by both the DOM identity and
      // the playback position surviving the move.
      expect(videoAfter).toBe(video);
      expect(videoAfter.currentTime).toBe(12);
      expect(videoAfter).toHaveAttribute('controls');
    });

    it('falls back to the hidden container once the visible one unregisters', async () => {
      function Harness({ showContainer }: { showContainer: boolean }) {
        const { enqueue } = useBackgroundPlayer();
        return (
          <>
            <button onClick={() => enqueue(makeVideo())}>enqueue (test)</button>
            {showContainer && <VisibleContainer />}
          </>
        );
      }
      const { getByRole, rerender, container } = render(
        <BackgroundPlayerProvider><Harness showContainer /></BackgroundPlayerProvider>,
      );
      await act(async () => { getByRole('button', { name: 'enqueue (test)' }).click(); });
      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).toHaveAttribute('controls');

      rerender(<BackgroundPlayerProvider><Harness showContainer={false} /></BackgroundPlayerProvider>);

      const videoAfter = container.querySelector('video') as HTMLVideoElement;
      expect(videoAfter).toBe(video);
      expect(videoAfter).not.toHaveAttribute('controls');
    });
  });
});
