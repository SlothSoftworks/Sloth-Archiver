# Releasing — versioning, CI builds, and the platform-selector suffix

This document explains how a code change turns into a downloadable installer:
what triggers a build, how a release actually gets published, and a
project-specific convention — a suffix on the version number — for building
only some platforms instead of all three. It's written for a contributor who
needs to cut a release or debug why one didn't happen, not for an end user.

The mechanism itself lives in `.github/workflows/build.yml`; this document is
the narrative explanation of what that file does and why, kept separate so the
workflow file itself doesn't have to carry a full essay in its comments.

## Index

1. [The two ways a build starts](#two-ways-a-build-starts)
2. [Version bump = release](#version-bump-equals-release)
3. [The platform-selector suffix](#platform-selector-suffix)
4. [Why two jobs, not one](#why-two-jobs)
5. [What you get afterward](#what-you-get-afterward)
6. [Cookbook](#cookbook)
7. [Repo-side prerequisites](#prerequisites)
8. [Current known limitations](#known-limitations)

<a id="two-ways-a-build-starts"></a>
## The two ways a build starts

The workflow triggers on a `push` to two different kinds of ref:

- **A merge to `master`.** Only `master`'s own HEAD actually moving triggers
  this — commits pushed to a PR's own branch while it's still open don't,
  since those aren't pushes to `master` at all. This is the normal, everyday
  path: open a PR, merge it, and — if the merge bumped the version (see
  below) — a release comes out the other end automatically.
- **A version tag pushed directly**, e.g. `git tag v0.25.1 && git push origin
  v0.25.1`. Same real build+release path as a merge, just without going
  through a PR — useful for re-cutting a release for an existing commit, or
  cutting one for a commit that never went through `master` at all.

A push that only touches `**/*.md` files or `LICENSE` is ignored by both
triggers (`paths-ignore`) — a docs-only change never starts a build.

<a id="version-bump-equals-release"></a>
## Version bump = release

Merging to `master` does **not** always produce a release. The workflow's
`plan` job (see [Why two jobs](#why-two-jobs)) checks whether a git tag
matching `v<package.json version>` already exists:

- **Tag doesn't exist yet** (the merge bumped `"version"` in `package.json`)
  → this is a real release. The commit gets tagged, a draft GitHub Release is
  created, and the selected platforms build and upload their installers to
  it.
- **Tag already exists** (the merge didn't touch `"version"`) → the entire
  build is skipped. No Node/Python setup, no `npm ci`, no packaging — the
  `plan` job's one cheap check is the only thing that runs.

Practical upshot: **if you want a merge to produce a release, bump
`"version"` in `package.json` as part of that PR.** If you don't, the merge
still goes through fine, it just doesn't spend CI minutes building an
installer nobody asked for.

<a id="platform-selector-suffix"></a>
## The platform-selector suffix

Sometimes a fix only matters to one platform — a Windows-specific NSIS
quirk, a macOS entitlement issue — and rebuilding all three OSes to ship it
wastes CI time on two builds that didn't change. Appending a letter suffix to
the version tells the workflow which platforms to actually build:

| Version | Builds |
|---|---|
| `0.25.1` | Windows + macOS + Linux (no suffix = everything, same as today) |
| `0.25.1-w` | Windows only |
| `0.25.1-m` | macOS only (both Apple Silicon and Intel) |
| `0.25.1-l` | Linux only |
| `0.25.1-wl` | Windows + Linux |
| `0.25.1-wml` | All three, spelled out explicitly (same effect as no suffix) |

**Rules:**
- Letters are `w` (Windows), `m` (macOS), `l` (Linux) — any combination, in
  **any order**, repeats allowed. `-wl` and `-lw` are identical; `-wwl` is the
  same as `-wl`.
- A suffix that isn't purely made of `w`/`m`/`l` (e.g. a real prerelease tag
  like `-beta`) is treated as "no selector" and builds everything — this
  convention is additive on top of normal semver, not a replacement for it.
- The suffix rides on the version string itself, so it's part of the exact
  same edit that triggers the release in the first place — there's nothing
  separate to remember to set, and nothing to remember to reset afterward.
  The next ordinary version bump (no suffix) naturally goes back to building
  everything.
- This applies to both trigger paths — a suffixed version bump merged to
  `master`, or a suffixed tag pushed directly (`git tag v0.25.1-w && git push
  origin v0.25.1-w`).

The parsing itself lives in the `plan` job's "Plan this run" step
(`.github/workflows/build.yml`) — a couple of small `bash` regex checks, not
a separate tool or config file.

<a id="why-two-jobs"></a>
## Why two jobs, not one

The workflow is split into a `plan` job and a `build` job (`needs: plan`),
rather than one job that does everything:

- **`plan`** runs on a plain Ubuntu runner with no Node/Python setup at all —
  it just checks out the repo, decides the tag and whether to release,
  parses the platform suffix, tags the commit if needed, and creates the
  draft GitHub Release itself, **empty, exactly once**.
- **`build`** is a 4-entry matrix (`windows-latest`, `macos-latest` for Apple
  Silicon, `macos-15-intel` for Intel, `ubuntu-latest`). Each entry's first step
  checks `plan`'s output to see if it was actually selected before doing
  anything else — an unselected platform exits almost immediately, before
  even checking out the repo. Selected platforms build and then run `gh
  release upload` (not `gh release create`) against the release `plan`
  already made.

The reason `plan` creates the release and `build`'s jobs only ever *upload*
to it, never create it, is a real bug this project hit earlier: when
multiple things race to create the same release at nearly the same instant,
each one can independently conclude "this release doesn't exist yet" and
create its own copy — resulting in duplicate releases with assets split
across them. That was originally an internal race inside `electron-builder`'s
own GitHub publisher within a single job; splitting into real parallel jobs
per platform would reintroduce the exact same failure mode if every job
tried to create the release itself. Having exactly one place (`plan`) own
release creation, and every build job only append to it, makes that race
structurally impossible rather than just less likely.

<a id="what-you-get-afterward"></a>
## What you get afterward

A real release always comes out as a **draft** on the repo's Releases page —
never auto-published. Review it, then click "Publish release" yourself. This
is deliberate: nothing should go live before someone's actually looked at it.

If you only bump the version without touching platforms, or explicitly write
`-wml`, you'll see the standard Windows installer + portable exe (+ its
blockmap), a macOS `.dmg` for each architecture, and a Linux `.AppImage` — all
on the one draft release.

<a id="cookbook"></a>
## Cookbook

**Cut a normal release, all platforms:**
```
# bump "version" in package.json, e.g. 0.25.0 -> 0.25.1
git add package.json
git commit -m "chore: bump version to 0.25.1"
# ...merge that PR into master...
```

**Cut a release for one platform only:**
```
# bump "version" to e.g. "0.25.2-w" for Windows-only
```
Same as above otherwise — merge it, or push a matching tag directly.

**Re-cut or hotfix-cut a release without going through a PR:**
```
git tag v0.25.1 && git push origin v0.25.1
# or, platform-scoped:
git tag v0.25.1-m && git push origin v0.25.1-m
```

**Just validate that a merge doesn't break the build, no release:**
Not currently supported as a separate path — the workflow either releases
(version bumped) or does nothing at all (version unchanged). See
[Known limitations](#known-limitations).

<a id="prerequisites"></a>
## Repo-side prerequisites

- **Settings → Actions → General → Workflow permissions → "Read and write
  permissions."** Required for the workflow's own `GITHUB_TOKEN` to push the
  tag and create/upload to the release. Without this, the `plan` job's tag
  push and release creation both fail with a permissions error.
- **Settings → Actions → General → Actions permissions** should allow the
  standard actions this workflow uses (`actions/checkout`,
  `actions/setup-node`, `actions/setup-python`) to run — the default "Allow
  all actions and reusable workflows" is fine.
- No code-signing secrets exist or are required today — every installer ships
  unsigned (`mac.identity: null`, no Windows certificate configured). Windows
  shows a SmartScreen "Unknown Publisher" warning and macOS shows a Gatekeeper
  warning as a result; there's no config-only fix for either, only a real paid
  code-signing certificate.

<a id="known-limitations"></a>
## Current known limitations

- **No build-only "smoke test" path.** Earlier versions of this workflow ran
  a full build on every merge (without publishing) specifically to catch
  build breakage immediately. That was deliberately removed to guarantee a
  no-version-bump merge costs nothing — the tradeoff is that a merge which
  breaks the build silently doesn't get caught until the next real version
  bump tries to release.
- **Portable Windows build is slow to start** — NSIS's portable target
  re-extracts the entire app on every launch, not just once at install time.
  Not a priority today.
- **Apple Silicon vs. Intel mac builds are two separate native jobs**, not
  one universal2 binary — a true universal binary needs more work than this
  (the PyInstaller-frozen `yt-dlp` binary can't cross-compile between
  architectures, so producing one means running that build twice and merging
  the results with `lipo`).
- **Linux support is new** — the `AppImage` target and the `ubuntu-latest`
  build job were both added the same day as this document; treat it as
  less battle-tested than the Windows/macOS paths until it's been through a
  few real releases.
