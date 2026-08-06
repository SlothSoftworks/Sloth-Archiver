import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose -- that config's `root: 'src/ui'`
// is specific to building the renderer bundle and would break resolution of
// test files living outside src/ui (the electron side's tests, for now).
// Electron-side modules (library.mjs, updater.mjs, preload.mjs) are plain
// Node -- 'node' is the right default environment for the whole suite until
// renderer/jsdom tests are added later, at which point per-directory
// environment overrides (or a projects/workspace split) can layer jsdom in
// for src/ui without disturbing this config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,mjs,ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/electron/**/*.{js,mjs}'],
    },
  },
});
