import { defineConfig } from "oxlint";

// anti-slop (https://github.com/dmmulroy/anti-slop) vendored at
// tools/oxlint/anti-slop -- generic rule group only, since this project
// doesn't use the Effect framework. Per the upstream README this is meant
// to be vendored and maintained locally, not tracked as a live dependency,
// so treat tools/oxlint/anti-slop as project source to review and adjust
// over time rather than something to re-sync from upstream automatically.
export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    // Off, deliberately -- each fights this codebase's actual conventions
    // rather than catching a real problem here (see PR discussion/first
    // lint run for the full reasoning):
    //
    // - no-shape-in-symbol-names: its only hit is `reshapeVideoInfo`
    //   (videoInfo.mjs/main.mjs), an ordinary verb unrelated to the
    //   schema-shape confusion this rule guards against.
    // - no-runtime-typeof: wants boundary-parsed input over ad hoc `typeof`
    //   narrowing, which presumes a validation-library boundary layer this
    //   app doesn't have. Every current hit is a plain, correct null/type
    //   guard on an already-narrow union (e.g. `number | null | undefined`).
    // - no-module-mocking: wants DI over `vi.mock`, but mocking
    //   `window.electronAPI` via `vi.mock`/module mocks is how this
    //   project's whole test suite isolates the renderer from Electron's
    //   main process -- enabling this would mean redesigning the test
    //   architecture, not fixing a lint error.
    "anti-slop/no-shape-in-symbol-names": "off",
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-module-mocking": "off",
  },
});
