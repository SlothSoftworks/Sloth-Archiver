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
}
