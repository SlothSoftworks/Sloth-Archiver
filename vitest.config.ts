import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.ts on purpose -- that config's `root: 'src/ui'`
// is specific to building the renderer bundle and would break resolution of
// test files living outside src/ui (the electron side's tests). The react()
// plugin is still needed here too, independently, for .tsx test files to get
// the same JSX transform the real renderer build uses.
//
// Environment stays 'node' as the suite-wide default (the electron side's
// tests, and any future plain-Node src/utils tests) -- renderer/component
// tests opt into jsdom individually via a `// @vitest-environment jsdom`
// docblock comment at the top of the test file, rather than flipping the
// global default, so the fast electron-side suite doesn't pay jsdom's setup
// cost and the two suites can keep evolving independently.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,mjs,ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/electron/**/*.{js,mjs}', 'src/ui/**/*.{ts,tsx}', 'src/utils/**/*.{ts,tsx}'],
    },
  },
});
