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
