import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Only matters for jsdom-environment (renderer) test files -- unmounts
// whatever React Testing Library rendered after each test so components
// (and their effects/timers/subscriptions) don't leak between tests. A
// no-op, harmless import for the electron-side (node-environment) tests.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement real media playback -- HTMLMediaElement.play()/
// pause() throw "Not implemented" by default, which breaks any component
// (e.g. LibraryVideoPlayer's play-button overlay) that calls videoRef.play()
// in a test. Only matters in jsdom; harmless no-op under the node
// environment since HTMLMediaElement doesn't exist there at all.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  // Same "not implemented" gap as play/pause above -- Vidstack calls this
  // itself after (re)assigning the <source> child's src (see the
  // IntersectionObserver stub below for why that assignment happens at all).
  HTMLMediaElement.prototype.load = () => {};
  // jsdom's canPlayType always returns '' (no real codec support), which
  // Vidstack's native-provider loader treats as "this browser can't play
  // mp4/webm at all" and refuses to mount a <video> element -- a jsdom gap,
  // not a real compatibility question, since every test file exercising the
  // player already assumes mp4/webm are playable (same assumption the real
  // browser confirms in production).
  HTMLMediaElement.prototype.canPlayType = (type: string) => (
    type.startsWith('video/mp4') || type.startsWith('video/webm') ? 'probably' : ''
  );
}

// jsdom has no real viewport/media-query engine -- Vidstack's player queries
// window.matchMedia (e.g. for pointer/orientation state) during setup, which
// jsdom doesn't implement at all (not even a stub), unlike most of the other
// gaps here.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}

// jsdom implements neither observer API -- Vidstack's player (LibraryVideoPlayer)
// uses both internally and throws a ReferenceError attaching either without
// some stub. ResizeObserver only tracks player dimensions for CSS vars --
// never calling back is harmless. IntersectionObserver is load-bearing,
// though: Vidstack's default "visible" load strategy uses it to defer
// actually assigning the provider's `src` until the player is deemed
// on-screen, so a stub that never invokes its callback leaves every test
// permanently stuck before real playback setup ever starts (no src, no
// canPlayQueue flush) -- this one fires back synchronously with a fully
// intersecting entry the moment `observe()` is called, so the player always
// behaves as if it's immediately visible.
if (typeof window !== 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

  class IntersectionObserverStub {
    #callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      const entry = {
        target, isIntersecting: true, intersectionRatio: 1,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null, time: 0,
      } as IntersectionObserverEntry;
      this.#callback([entry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  window.IntersectionObserver ??= IntersectionObserverStub as unknown as typeof IntersectionObserver;
}
