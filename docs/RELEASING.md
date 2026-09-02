# Releasing — versioning and CI builds

This document explains how a code change turns into a downloadable installer:
what triggers a build, and how a release actually gets published. It's
written for a contributor who needs to cut a release or debug why one didn't
happen, not for an end user.

The mechanism itself lives in `.github/workflows/build.yml`; this document is
the narrative explanation of what that file does and why, kept separate so the
workflow file itself doesn't have to carry a full essay in its comments. Pull
request validation (lint + tests, no packaging) is a separate, much lighter
workflow, `.github/workflows/ci.yml` — see `CONTRIBUTING.md` for that one;
this document is about the release path specifically.

## Index

1. [The two ways a build starts](#two-ways-a-build-starts)
2. [Version bump = release](#version-bump-equals-release)
3. [Why two jobs, not one](#why-two-jobs)
4. [What you get afterward](#what-you-get-afterward)
5. [Release notes and checksums](#release-notes-and-checksums)
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
  created, and all three platforms build and upload their installers to it.
- **Tag already exists** (the merge didn't touch `"version"`) → the entire
  build is skipped. No Node/Python setup, no `npm ci`, no packaging — the
  `plan` job's one cheap check is the only thing that runs.

Practical upshot: **if you want a merge to produce a release, bump
`"version"` in `package.json` as part of that PR.** If you don't, the merge
still goes through fine, it just doesn't spend CI minutes building an
installer nobody asked for.

<a id="why-two-jobs"></a>
## Why two jobs, not one

The workflow is split into a `plan` job and a `build` job (`needs: plan`),
rather than one job that does everything. (A third job, `checksums`, runs
after `build` for a related but separate reason — see [Release notes and
checksums](#release-notes-and-checksums).)

- **`plan`** runs on a plain Ubuntu runner with no Node/Python setup at all —
  it just checks out the repo, decides the tag and whether to release, tags
  the commit if needed, and creates the draft GitHub Release itself, **empty,
  exactly once**.
- **`build`** is a 4-entry matrix (`windows-latest`, `macos-latest` for Apple
  Silicon, `macos-15-intel` for Intel, `ubuntu-latest`) — every entry always
  builds. Each one builds and then runs `gh release upload` (not `gh release
  create`) against the release `plan` already made.

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

Every version bump builds all three platforms — you'll see the standard
Windows installer + portable exe (+ its blockmap), a macOS `.dmg` for each
architecture, and a Linux `.AppImage`, all on the one draft release.

<a id="release-notes-and-checksums"></a>
## Release notes and checksums

The draft release's notes aren't just GitHub's auto-generated commit list —
the `plan` job assembles them by hand, in this order:

1. **A per-OS download table**, same content as the README's own Download
   section, so someone who lands on the release page directly (not via the
   README) still knows which asset is theirs.
2. **This version's own `CHANGELOG.md` section**, under a `## What's new`
   heading — extracted by matching the `## [<version>]` heading and copying
   everything up to the next version heading. Missing on purpose before
   `CHANGELOG.md` has an entry for a version — just drops this section
   rather than failing the release; a `::warning::` in the job log flags it
   either way.
3. **GitHub's auto-generated notes** (the PR/commit list `--generate-notes`
   would have produced on its own) — fetched separately via `gh api
   .../releases/generate-notes` so it can be appended after the two sections
   above instead of being the entire body.

Separately, a `checksums` job runs after `build` finishes (`needs: [plan,
build]`) — one job, not per-platform, so two matrix entries can't race to
publish their own partial checksums file. It downloads every asset already on
the release, hashes them with `sha256sum`, and uploads the result as
`SHA256SUMS`.

A tag pushed directly (not created by this workflow off `master`) also gets
verified before anything else happens: the `plan` job's "Verify tag matches
package.json and points at master" step confirms the tag's version matches
`package.json`'s `"version"`, and that the tagged commit is reachable from
`origin/master` — catching a stray or mistagged release before it builds
anything. Skipped on the ordinary branch-push path, since that tag is built
from `package.json` itself, on the same commit this job is already running
on.

<a id="cookbook"></a>
## Cookbook

**Cut a normal release:**
```
# bump "version" in package.json, e.g. 0.25.0 -> 0.25.1
git add package.json
git commit -m "chore: bump version to 0.25.1"
# ...merge that PR into master...
```

**Re-cut or hotfix-cut a release without going through a PR:**
```
git tag v0.25.1 && git push origin v0.25.1
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
  `actions/setup-node`) to run — the default "Allow all actions and reusable
  workflows" is fine.
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
  breaks the *packaging* build (electron-builder, fetching/verifying the
  `yt-dlp` release binary, etc.) silently doesn't get caught until the next
  real version bump tries to release. `.github/workflows/ci.yml` covers a
  different, cheaper gap —
  lint + the Vitest suite on every pull request — which catches broken code
  well before merge, but it never runs `npm run dist`, so a packaging-only
  failure can still slip through.
- **Portable Windows build is slow to start** — NSIS's portable target
  re-extracts the entire app on every launch, not just once at install time.
  Not a priority today.
- **Apple Silicon vs. Intel mac builds are two separate native jobs**, not
  one universal2 binary. `yt-dlp`'s own official macOS release is already a
  universal2 binary, so that's no longer what's blocking this — the
  remaining work is auditing `ffmpeg-static`/`ffprobe-static`'s per-arch
  bundling and switching electron-builder over to its own universal-build
  mode. Tracked as a must-fix item before this project stops using separate
  mac jobs.
- **Linux support is new** — the `AppImage` target and the `ubuntu-latest`
  build job were both added the same day as this document; treat it as
  less battle-tested than the Windows/macOS paths until it's been through a
  few real releases.
