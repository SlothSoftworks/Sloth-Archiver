# Vendored: anti-slop (generic rules only)

Source: https://github.com/dmmulroy/anti-slop
Vendored from commit `e8c4880471b23ab7f216fba7b27d173a6ef07d4c` (v0.1.2), 2026-09-05.

This is a vendored copy, not a dependency — per upstream's own README, anti-slop
is meant to be copied in and maintained locally, not tracked as a live package.
There's no automated re-sync; if you want a newer upstream version, re-copy
`src/` from the anti-slop repo and re-diff against this directory by hand.

**Dropped from upstream**: the `effect/` rule group (`no-service-constructor-imports`),
since this project doesn't use the Effect framework. If that ever changes, it's
a straightforward re-copy of `effect/index.ts` and `effect/rules/` from upstream,
registered as a second `jsPlugins` entry per the upstream README.

**Kept as-is**: the `*.test.ts` files alongside each rule. They're upstream's own
`RuleTester` suites for the rules themselves (run via `tsx`, not this project's
Vitest), useful if these vendored rules are ever edited. They're excluded from
this project's own lint/test runs via `oxlint.config.ts`'s `ignorePatterns` and
aren't wired into `npm test`.

See `../../../oxlint.config.ts` for how this is registered, and the top-level
`npm run lint:anti-slop` script to run it.
