# Contributing / Building SlothArchiver from source

SlothArchiver isn't accepting outside contributions or pull requests right
now — this is currently a solo project, with no contribution pipeline or
review process set up yet. This guide exists anyway, for anyone who wants to
build the app themselves, poke around the code, or verify what a release
actually contains.

## Prerequisites

- **Node.js 24** (matches what CI builds with — see `.github/workflows/build.yml`)
- **Python 3.11**, with `venv` available — used to freeze `yt-dlp` into a
  standalone binary as part of the build (see [What the build scripts
  do](#what-the-build-scripts-do) below)
- `npm`

## Setup

```
git clone <repo-url>
cd SlothArchiver
npm ci
```

## Running it locally

Electron's main process (`src/electron/main.mjs`) does **not** talk to
Vite's dev server at all, even in development — it serves the renderer from
its own small static file server, reading directly out of `dist/renderer/`.
That means a real build has to exist before Electron can show anything:

```
npm run build:all   # builds the renderer AND the electron/native pieces
npm run dev
```

`build:all` needs to be re-run whenever you change renderer source
(`src/ui/`) **or** main-process source (`src/electron/`) — there's no hot
reload here, `dev` just loads whatever was most recently built. `build:all`
is fast for a code-only change; it does *not* re-freeze `yt-dlp` or
re-copy `ffmpeg` unless you explicitly ask it to (see below) — those are
the slow, rarely-needed steps.

> `npm run dev:vite` also exists, but it's not a way to preview the real
> app — it's an isolated Vite dev server for hot-swapping visual/theme/design
> work only, with no Electron process or real IPC behind it at all.

## Testing and linting

```
npm test              # run the full Vitest suite once
npm run test:watch    # watch mode
npm run test:coverage # with coverage
npm run lint          # ESLint across the whole repo
```

Neither currently runs automatically in CI on every push — see
`docs/RELEASING.md` for what the CI workflow actually does and doesn't
enforce today.

## What the build scripts do

The full dependency chain, from `package.json`'s `scripts`:

| Script | What it does |
|---|---|
| `dev` | Launches Electron against whatever's currently in `dist/` — the normal way to run the app locally (see above). |
| `dev:vite` | Isolated visual/theme/design work only — not connected to the real app (see above). |
| `build:renderer` | Compiles the React UI with Vite into `dist/renderer/`. |
| `build:copy:electron` | Copies `src/electron/` (plain JS, no compile step) into `dist/electron/`. |
| `build:ytdlp:bin` | The slow one: creates a local Python venv, installs the exact `yt-dlp` version pinned in `src/python/requirements-build.txt`, and freezes `src/python/ytdlp_entrypoint.py` into a standalone native executable via PyInstaller. This is a real build from source, not a downloaded prebuilt binary — it's also what the app's own in-app "update yt-dlp" feature re-runs later on a user's machine. |
| `build:copy:ffmpeg` | Copies the `ffmpeg`/`ffprobe` binaries already fetched by the `ffmpeg-static`/`ffprobe-static` npm packages into `dist/ffmpeg/`. |
| `clean:venv` | Deletes the local Python venv `build:ytdlp:bin` creates, so the next build starts from a clean environment instead of a possibly-stale one. |
| `build:electron` | Runs `build:copy:electron` → `build:ytdlp:bin` → `build:copy:ffmpeg`, in order. |
| `build:all` | `build:renderer` + `build:electron` — everything needed to run the app locally via `dev`. |
| `build:all:deep` | `clean:venv` first, then `build:all` — a genuinely from-scratch build. This is what CI/`dist` uses; you shouldn't normally need it locally unless something in the venv is stuck. |
| `electron-build` | Runs `electron-builder` (packages `dist/` into a real installer for your current OS) without publishing anywhere. |
| `dist` | `build:all:deep` + `electron-build` — produces an actual installer in `dist/`, the same thing a release build does. See `docs/RELEASING.md` for how that connects to an actual GitHub release. |

If you only need to run the app locally, `build:all` is what you want — the
heavier `build:all:deep`/`dist` scripts exist for producing a real
installer, not for day-to-day development.
