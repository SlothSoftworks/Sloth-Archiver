# Clean Code Analysis — Pre-Public-Repo Review

**Date:** 2026-08-19 · **Version reviewed:** 0.11.2 · **Commit:** `21ec03d` (base) ·
**Branch:** `claude/yt-archiver-security-analysis-1i3kp3`

A readability/maintainability pass ahead of making the repository public — separate from
`reports/SecurityAnalysis.md` (risk/vulnerabilities) and `reports/TechnicalDebt.md` (known
shortcuts). This is about what a first-time outside contributor sees on landing in the code:
comment signal-to-noise, duplication, file/function size, naming consistency, dead code, and
type organization. Findings use stable sequential IDs (`CC-NNN`), same convention as the other
two reports. Nothing here is a bug or a security issue — several items *are* referenced from
the security report where they overlap (noted inline), but the framing here is purely
readability and maintenance cost.

**Method:** line/comment-density metrics computed directly over `src/`; the two largest,
most complex areas (`src/ui/screens/`, and `src/ui/hooks/` + `src/ui/components/`) were each
given a dedicated deep pass; every citation below was checked against the current file content
before being written down. No code was changed.

---

## 1. Summary

| ID | Title | Area | Impact |
|---|---|---|---|
| CC-001 | Comment density is high enough to bury the signal in several files | Comments | High |
| CC-002 | `main.js` is a 1998-line, 95-definition god-file spanning ~9 unrelated domains | Structure | High |
| CC-003 | `LibraryVideoDetail.tsx` is a 1296-line god-component (26 `useState`, 6 `useEffect`) | Structure | High |
| CC-004 | The exact same path-containment check is copy-pasted six times across two files | Duplication | Medium |
| CC-005 | `isYouTubeUrl` is independently defined and maintained in two files | Duplication | Medium |
| CC-006 | `types.ts` is underused; the same domain shapes are redeclared per-file, some now drifting | Types | Medium |
| CC-007 | A Vite-boilerplate leftover component/route with a dead unused import ships in the app | Dead code | Medium |
| CC-008 | An unreachable UI status branch (`'done'`) is never actually set | Dead code | Low |
| CC-009 | Test/mock scaffolding lives directly in a production component's initial state | Dead code | Medium |
| CC-010 | The same small helper/pattern is duplicated 3–4× across sibling components | Duplication | Medium |
| CC-011 | The same numeric/status constant is independently declared in three files | Duplication | Low |
| CC-012 | Naming is inconsistent for the same concept across files (URL, list-item, setter) | Naming | Low |
| CC-013 | ESLint is configured to lint only `.ts`/`.tsx` — the entire Electron main process is unlinted | Tooling | Medium |
| CC-014 | `README.md` is a single boilerplate line with no setup/build/run instructions | Docs | Medium |
| CC-015 | Inconsistent `.js`/`.mjs` extension use for functionally identical ESM modules | Consistency | Low |

---

## 2. Findings

### CC-001 — 2026-08-19 — Comment density is high enough to bury the signal in several files

**Where (measured — lines starting with `//`, `/*`, or `*`, as a % of file length):**

| File | Comment % | Comment / total lines |
|---|---|---|
| `src/utils/ffmpegFormats.ts` | 80% | 12 / 15 |
| `src/ui/hooks/useLibrarySearch.tsx` | 41% | 13 / 31 |
| `src/ui/hooks/useBulkAddQueue.tsx` | 33% | 160 / 484 |
| `src/electron/library.mjs` | 32% | 278 / 851 |
| `src/utils/utils.ts` | 30% | 25 / 82 |
| `src/ui/components/LibraryVideoPlayer.tsx` | 29% | 47 / 158 |
| `src/electron/main.js` | 28% | 562 / 1998 |

**What this is (this is your own starting observation, confirmed with numbers, not just
impression):** the codebase's comment style is almost entirely *rationale* comments — "why is
this here", "what did we try before this", "what bug did this fix" — rather than
what-does-this-line-do comments. That's the right instinct in isolation: a comment explaining a
non-obvious constraint is exactly what should exist. The problem is density and placement, not
content: many of these comments restate something the code already makes clear (a well-named
function, an obvious branch), and long rationale blocks sit directly above one-line, self-evident
statements — e.g. `library.mjs`'s `sanitizeForFilesystem` carries a 15-line comment above a
6-line function; `useBulkAddQueue.tsx`'s `pickClosestResolution` carries an 8-line comment above
an 8-line function. At current density, a reader has to move past several sentences of history
to reach almost every function, which is exactly backwards from "comment only when it's not
obvious" — the obvious parts are what's getting the most words.

**Why it matters for a public repo:** outside contributors skim before they read. A file that's
30%+ comment lines reads slower at a glance, and — more importantly — buries the comments that
*do* carry load-bearing information (there are real ones: TD-004/TD-008/TD-010 references, the
Windows `MAX_PATH` reasoning, the Referer/loopback-server rationale) among ones that don't.

**Recommended fix:** a pass per file, not a blanket rule: keep comments that explain *why*
something non-obvious was done (a workaround, a rejected alternative, a platform quirk, a
cross-reference to `TechnicalDebt.md`); cut or shorten comments that describe *what* the next
line does when the code already says so. `ffmpegFormats.ts` (80%) and `library.mjs` (32%, the
largest offender by absolute line count — 278 comment lines) are the highest-value places to
start.

---

### CC-002 — 2026-08-19 — `main.js` is a 1998-line, 95-definition god-file spanning ~9 unrelated domains

**Where:** `src/electron/main.js`, entire file.

**What happens today:** counting every top-level `function`, `export function`, and
`ipcMain.handle(...)`, the file defines **95 top-level things**. They span: app settings
(get/set × 7 different settings), the video-info cache, library CRUD delegation, channel/video/
playlist thumbnail fetching (including its own redirect-following HTTP image downloader),
playlist snapshot/reconciliation delegation, cookie parsing/normalization/storage/config (three
different formats handled), native dialogs, video-info fetch and reshaping (with its own
dead-video classification heuristic), download orchestration (yt-dlp spawn + progress parsing),
four separate ffmpeg utility handlers (extract MP3, convert format, clip, embed metadata) with
their own error-message-friendliness translator, the yt-dlp updater trigger, and app-lifecycle/
shell/error-log utilities. `library.mjs` and `updater.mjs` were already split out of this file at
some point (both exist and are appropriately scoped) — but everything else that's accumulated
since has landed back in `main.js` rather than following that precedent.

**Why it matters:** this is the single biggest "where do I even start reading" obstacle in the
codebase for a new contributor. It also means an unrelated change (say, a cookie-format fix) sits
in the same file, same diff-blast-radius, as the download pipeline — `git blame`/PR review both
get noisier than they need to. (Cross-reference: `reports/SecurityAnalysis.md` SEC-003 already
recommends extracting a shared path-containment helper out of this file for a different,
security-flavored reason — that extraction would also start this split.)

**Recommended fix:** split along the domain boundaries already implicit in the code, following
the `library.mjs`/`updater.mjs` precedent this file itself set: `settings.mjs` (the ~10
settings get/set handlers + `readSettings`/`writeSettings`), `cookies.mjs` (parsing,
normalization, validation, the IPC handlers), `thumbnails.mjs` (`downloadImageToFile`,
`ensureChannelIcon`, `ensureVideoThumbnail`, `ensurePlaylistThumbnail`, `fetchChannelAvatarUrl`),
`ffmpegUtils.mjs` (the four `library:*` ffmpeg handlers + `runFfmpegWithProgress`/
`convertWithFallback`/`summarizeFfmpegError`), and `videoInfo.mjs` (`reshapeVideoInfo`,
`buildResolutions`, `isDeadVideoInfo`, `classifyDeadYouTubeVideo`, the cache). `main.js` would
then be closer to what its name implies: app bootstrap + IPC handler *registration*, delegating
to these modules the way it already delegates to `library.mjs`.

---

### CC-003 — 2026-08-19 — `LibraryVideoDetail.tsx` is a 1296-line god-component

**Where:** `src/ui/screens/LibraryVideoDetail.tsx`, entire file (component body `L224`–end).

**What happens today:** one component owns video playback (YouTube-embed vs. local-file
branching), version history (add/switch/refresh/rollback), quality-swap re-downloads, MP3
download, four separate ffmpeg utilities (extract MP3, convert format, clip trim, embed
metadata), and deletion — 26 `useState` hooks (`L231`–`297`) and 6 `useEffect`s, with a JSX
return block spanning roughly `L758`–`1296` (~540 lines) rendering at least seven distinct
sub-panels plus three dialogs/snackbars. Inside that return, `L898`–`954` is a five-branch-deep
nested ternary choosing what the download-quality panel shows.

**Why it matters:** this is the component most likely to get a merge conflict between two
unrelated feature PRs (an MP3 fix and a clip-trim fix touch the same file, same nearby state
block), and the component most likely to intimidate a first-time contributor who opens it looking
for one specific piece of behavior. `PlaylistsSection.tsx` (428 lines, 13 `useState`,
list-view/detail-view/refresh/undo/delete all in one function) and `useBulkAddQueue.tsx` (484
lines — worker-pool scheduling, retry-stage inference, playlist enrichment, and resolution-
picking business logic all in one hook, `L195`–`354`) show the same pattern one size class down.

**Recommended fix:** extract along the feature seams that already exist as comment-delimited
sections in the file: a `VideoVersionHistory` panel, a `VideoQualityDownload` panel, and an
`FfmpegUtilitiesPanel` (mp3/convert/clip/embed) each as their own component receiving `video`/
`metadata` and callback props, with `LibraryVideoDetail` itself reduced to composition + the
state that's genuinely shared across all of them (e.g. `selectedEpoch`). This mirrors what
`LibraryScreen.tsx` already does correctly by splitting into `VideoGrid`/`ChannelList`/`VideoCard`
— that split is the pattern to extend here, not a new one to invent.

---

### CC-004 — 2026-08-19 — The exact same path-containment check is copy-pasted six times

**Where:** `library.mjs:143`, `172`, `226`, `280`, `844`, and `main.js:218` — each is:

```js
const resolvedX = path.resolve(x || '');
const relative = path.relative(resolvedLibraryDir, resolvedX);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(/* ... */);
}
```

**Why it matters:** this is the app's one real safety-critical invariant (never operate outside
the configured library folder) implemented identically six separate times with no shared name to
search for or reason about as a single concept. A future fix to the check itself (e.g. the
symlink-resolution gap noted in `reports/SecurityAnalysis.md` SEC-010) has to be applied at all
six sites by hand, and it's easy to add a seventh call site that "looks like" the pattern but gets
one line wrong.

**Recommended fix:** extract `assertInsideLibrary(libraryDir, targetPath)` (or a
non-throwing `isInsideLibrary` for the one boolean-context caller) into `library.mjs`, export it,
and replace all six sites. This is also exactly what `reports/SecurityAnalysis.md` SEC-003
recommends doing anyway to close the ffmpeg-handler path-validation gap — one extraction serves
both reports.

---

### CC-005 — 2026-08-19 — `isYouTubeUrl` is independently defined and maintained in two files

**Where:** `src/electron/main.js:1181` and `src/utils/utils.ts:19` — same hostname allowlist
(`youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`), same `try { new URL(...) }`
structure, same `www.` stripping, implemented twice from scratch. `main.js:1176`–`1180` even
carries a comment explaining that this *is* a deliberate duplicate ("this process and the
renderer are different worlds in this codebase") rather than an oversight.

**Why it matters:** the comment is honest about why it exists, but the cost is still real —
adding a new YouTube domain (there have been several historically: `youtube-nocookie.com`,
regional TLDs) requires remembering both locations, and nothing enforces that. This is a small,
narrow instance of a broader pattern worth naming: main-process and renderer code in this app
never share logic, even when the logic (a pure string check) has no dependency on which process
it runs in.

**Recommended fix:** move the pure hostname check into a small shared module with no
Electron/DOM dependency (e.g. `src/shared/youtube.ts`), imported by both `main.js` and
`utils.ts`. Vite already bundles the renderer independently and `main.js` runs under plain
Node/ESM, so a dependency-free `.ts`/`.mjs` file with no imports of its own is safe to share
between them without merging "different worlds."

---

### CC-006 — 2026-08-19 — `types.ts` is underused; the same domain shapes are redeclared per-file, some now drifting

**Where:** `src/types.ts` (54 lines, 3 exported types) vs. independently-declared, same-named
shapes in `src/types/electron-api.d.ts:16-35` and `52-92`, `src/ui/screens/LibraryScreen.tsx:54`,
`src/ui/screens/LibraryVideoDetail.tsx:55` (exported), and `src/ui/components/
PlaylistsSection.tsx:49-87`.

**What happens today:** `LibraryVideoMetadata` exists as three separately-maintained shapes:
one inside `types/electron-api.d.ts`'s `declare global` block (not importable — that file does
`export {}` then declares globally), one in `LibraryScreen.tsx` (with `channelId`/`addedEpoch`
fields the others don't have), and one exported from `LibraryVideoDetail.tsx` that
`LibraryVideoPlayer.tsx:4` imports from. `PlaylistSummary`/`PlaylistEntry`/`PlaylistSnapshot` are
similarly redeclared in `PlaylistsSection.tsx:49-87`, and this pair has already drifted:
`schemaVersion` is optional in `PlaylistsSection.tsx:75` but required in the "canonical" version
in `types/electron-api.d.ts:78`.

**Why it matters:** two things. First, `LibraryVideoPlayer.tsx` — a reusable component under
`components/` — importing a type from `screens/LibraryVideoDetail.tsx` is a backwards dependency:
a screen should depend on shared components, not the other way around, and it means moving or
renaming `LibraryVideoDetail.tsx` breaks an unrelated component. Second, and more concretely, the
`schemaVersion` drift is exactly the kind of silent divergence duplicated types produce — the two
copies are meant to describe the same on-disk JSON shape and no longer agree on what's optional.

**Recommended fix:** promote the handful of shapes that are genuinely shared (`LibraryVideoMetadata`,
`PlaylistSummary`, `PlaylistEntry`, `PlaylistSnapshot`, the `Resolution` shape currently
hand-declared separately in both `VideoDetailCard.tsx` and `LibraryVideoDetail.tsx`) into
`types.ts`, and have every consumer — including `electron-api.d.ts`'s `declare global` block —
import from there instead of redeclaring. This turns `types.ts` into what its name already
promises to be.

---

### CC-007 — 2026-08-19 — A Vite-boilerplate leftover ships in the app

**Where:** `src/ui/other.tsx` (entire file), routed at `src/ui/App.tsx:65`
(`<Route path="/other" element={<Other />}/>`, importing `Other` at `App.tsx:8`).

**What happens today:**

```tsx
import { useState } from 'react'
import './App.css'

function Other() {
  return (
    <>
      KAGAO
    </>
  )
}

export default Other;
```

`useState` is imported and never used. The component renders the literal string `KAGAO`. It is
wired into the router at `/other` but not linked to from anywhere in the app's own navigation
(`MainPage.tsx` has no reference to it) — reachable only by typing the path directly.

**Why it matters:** this is the single most visible piece of leftover scaffolding in the
codebase — the kind of thing a new contributor (or a curious member of the public, once the repo
is open) finds within minutes and reasonably wonders what else was left half-cleaned-up. It also
has a real unused-import lint violation sitting in it.

**Recommended fix:** delete `src/ui/other.tsx`, its test file, and the route/import in `App.tsx`.
If it was being kept as a scratch route for local testing, a `.gitignore`d local file serves that
purpose without shipping in the public history.

---

### CC-008 — 2026-08-19 — An unreachable UI status branch is never actually set

**Where:** `src/ui/screens/DownloaderScreen.tsx:47` declares
`libraryAddStatus: 'idle' | 'saving' | 'done' | 'error'`, and the JSX branches on `=== 'done'`
at `L226` and `L245`/`247` for tooltip text and button color. But grepping every
`setLibraryAddStatus` call in the file (`L80`, `93`, `96`, `103`, `109`, `116`, `128`, `139`,
`142`, `153`, `164`, `167`, `183`) shows every success path sets `'idle'` directly (`L93`, `109`,
`139`, `164`) — `'done'` is never assigned anywhere in the file.

**Why it matters:** small on its own, but it's the kind of dead branch that actively misleads a
reader — the type signature and the JSX both imply a `'done'` state exists and is reachable,
and a contributor debugging "why doesn't the button turn green after adding" will spend time
looking for a code path that isn't there before realizing it was never wired up.

**Recommended fix:** either wire `'done'` in (set it in each success path, then transition back
to `'idle'` after a short delay or on next input change) or remove it from the union and the JSX
branches that reference it. Either is a five-minute fix; the report's job here is just flagging
that it's currently neither.

---

### CC-009 — 2026-08-19 — Test/mock scaffolding lives directly in a production component's initial state

**Where:** `src/ui/App.tsx:74-80` and `src/ui/screens/DownloaderScreen.tsx:44`.

**What happens today:**

```tsx
// App.tsx
function App() {
  if (!window.electronAPI) {
    window.mockingElectron = "yes";
    window.electronAPI = electronAPIMock;
    window.electronAPIPythonDownload = electronAPIPythonDownloadMock;
  }
  ...
```

```tsx
// DownloaderScreen.tsx:44
const [videoInfo, setVideoInfo] = useState(window.mockingElectron !== "yes" ? null : videoResponseMock.data.response); // TODO change this after testing
```

Any environment where `window.electronAPI` is absent (a plain browser preview of the Vite dev
server, for instance) silently falls back to a bundled mock API *and* seeds `DownloaderScreen`
with canned mock video data, guarded by a global flag rather than a build-time/env-based dev
flag. The inline `// TODO change this after testing` comment confirms this was meant to be
temporary.

**Why it matters:** two separate concerns. First, readability: a contributor reading
`DownloaderScreen.tsx`'s very first `useState` line has to already know about a global
`window.mockingElectron` convention set 190+ lines away in a different file to understand why the
initial state isn't simply `null`. Second, robustness-adjacent: because this triggers on the
*absence* of `window.electronAPI` rather than an explicit dev/test flag, a genuinely broken
packaged build (preload failed to attach `electronAPI` for some real reason) would silently
render fake data instead of failing visibly — the opposite of what you'd want in a shipped app.

**Recommended fix:** gate this behind an explicit build-time flag (Vite's `import.meta.env.DEV`,
or a dedicated `VITE_MOCK_ELECTRON` env var) rather than an implicit runtime absence-check, and
move the mock-seeding out of `DownloaderScreen`'s own initial state into whatever sets up the
mock API in the first place (`App.tsx` or a dedicated dev-only bootstrap module) so the component
itself has no knowledge that mocking exists.

---

### CC-010 — 2026-08-19 — The same small helper/pattern is duplicated 3–4× across sibling components

**Where, grouped:**

- **`LinearProgressWithLabel`** — near-identical copies in `LibraryVideoDetail.tsx:155-167`,
  `VideoDetailCard.tsx:53-69`, and `OtherPlatformDownloadCard.tsx:39-52`.
- **`formatEpochLabel`** — defined at `LibraryVideoDetail.tsx:87-89` (accepts `string`) and again
  at `PlaylistsSection.tsx:93-95` (accepts `number`), with `PlaylistsSection.tsx:89-92`'s own
  comment explicitly acknowledging it's a copy kept separate rather than shared.
- **The download-card shell** — `VideoDetailCard.tsx` and `OtherPlatformDownloadCard.tsx`
  (316 lines each) independently implement near-identical `beginDownload`/overwrite-dialog/
  bug-report-dialog logic (`VideoDetailCard.tsx:103-128` & `274-311` vs.
  `OtherPlatformDownloadCard.tsx:113-169` & `271-302`) — two forks of what reads as one
  "download card" concept.
- **The "reset form on success" block** — the same six-statement sequence
  (`setVideoUrl(''); setVideoInfo(null); setVideoInfoError(null); setVideoInfoFromCache(false);
  setIsUrlError(false); setLibraryAddStatus('idle');`) appears verbatim in
  `DownloaderScreen.tsx`'s `performAddToLibrary` (`L88-93`), `handleOverrideAdd` (`L134-139`), and
  `handleAddVersion` (`L159-164`).
- **The "run action, handle `{success, message}`" block** — `PlaylistsSection.tsx`'s
  `handleRefresh` (`L168-181`), `handleDeletePlaylist` (`L187-199`), and `handleUndo`
  (`L201-213`) each hand-check `result.success`/`result.message || 'default'` independently.

**Why it matters:** none of these is large individually, but together they're a pattern: this
codebase reaches for copy-paste over extraction fairly often at the "small React helper" scale,
even where the copies are genuinely identical (`LinearProgressWithLabel`) or drift risk is real
(two `formatEpochLabel`s with different parameter types for what is, per the comment, meant to
be the same concept).

**Recommended fix:** `LinearProgressWithLabel` → one shared component in `components/`.
`formatEpochLabel` → one function accepting `string | number` (or normalize the epoch type
app-wide, see CC-006). The download-card duplication is the largest of the group and the best
candidate for a shared `useDownloadCard`-style hook once someone is touching that area anyway.
The two "handle result" patterns → a small `runLibraryAction(fn, { onSuccess, onError })` helper.

---

### CC-011 — 2026-08-19 — The same numeric/status constant is independently declared in three files

**Where:** `main.js:375` (`MAX_SIMULTANEOUS_DOWNLOADS_CEILING = 5`),
`OptionsScreen.tsx:49` (`MAX_SIMULTANEOUS_DOWNLOADS_OPTIONS = [1, 2, 3, 4, 5]`), and
`useBulkAddQueue.tsx:69` (`MAX_DOWNLOAD_SLOTS = 5`). Each carries a comment explicitly
cross-referencing the other two by name (`useBulkAddQueue.tsx:62-64`,
`OptionsScreen.tsx:45-46`) — the duplication is acknowledged, not accidental, but there is no
shared import connecting them.

**Why it matters:** three independently-maintained "5"s held in sync only by comments a future
editor has to notice and honor. If the app's real concurrency ceiling ever needs to change,
that's three files to edit correctly, with nothing enforcing it beyond a code comment. This is
the same shape of issue as CC-005/CC-004 at a smaller scale — a value or logic that's
conceptually one thing, expressed three times.

**Recommended fix:** since one of the three lives in the main process and two in the renderer,
a literal shared import isn't available across that boundary today — but the two renderer-side
copies (`OptionsScreen.tsx`, `useBulkAddQueue.tsx`) can share one constant immediately, and the
main-process value could be surfaced to the renderer at startup (it's already exposed indirectly
via `settings:getMaxSimultaneousDownloads`) rather than hand-duplicated.

---

### CC-012 — 2026-08-19 — Naming is inconsistent for the same concept across files

**Where, representative examples (not exhaustive):**

- **A video's source URL**: `videoUrl` (`DownloaderScreen.tsx`), `originalUrl` (accessed as
  `metadata.originalUrl` in `LibraryVideoDetail.tsx`, `videoMetaData.originalUrl` in
  `VideoDetailCard.tsx`/`OtherPlatformDownloadCard.tsx`) — three spellings for what's meant to be
  the same field as it moves through the app.
- **"One video in a list"**: `BulkAddEntry` (`BulkAddDialog.tsx:81`) is converted into
  `BulkAddItem` partway through its lifecycle (`useBulkAddQueue.tsx:379-396`) — two type names
  for one object's life, alongside the already-distinct `PlaylistEntry` and `LibraryVideo` shapes
  for adjacent-but-different concepts.
- **State setters in `OptionsScreen.tsx`**: most follow the plain `setX` convention
  (`setDialogOpen`, `setError`), but five are suffixed `...State` specifically to avoid colliding
  with a same-named handler function — `setCookiesModeState` (`L112`), `setDownloadDirState`
  (`L116`), `setLibraryDirState` (`L117`), `setCustomConvertFormatsState` (`L119`),
  `setMaxSimultaneousDownloadsState` (`L120`). The convention is real and consistent *within*
  this one file, but isn't explained anywhere, and nothing distinguishes at the call site which
  pattern a given piece of state follows.
- **Status string unions**: `BulkAddStatus` (`useBulkAddQueue.tsx:4`) and
  `libraryAddStatus: 'idle' | 'saving' | 'done' | 'error'` (`DownloaderScreen.tsx:47`) are two
  independently-invented small status enums for the same general "is this async thing
  pending/done/failed" shape, each with its own label/color mapping nearby.

**Why it matters:** none of these cause bugs, but each one costs a new reader a small "wait, is
this the same thing?" moment, and they add up across a codebase this size. Naming consistency is
one of the cheapest wins available before going public — it costs a rename, not a redesign.

**Recommended fix:** not urgent enough to batch into one PR — worth fixing opportunistically
whenever one of these areas is touched for another reason. Where it's cheap now: standardize on
`originalUrl` (already the more common of the two spellings) and document the `OptionsScreen.tsx`
`...State` convention with a one-line comment where the pattern starts, so a reader isn't left to
infer it.

---

### CC-013 — 2026-08-19 — ESLint is configured to lint only `.ts`/`.tsx` — the entire Electron main process is unlinted

**Where:** `eslint.config.js:11` — `files: ['**/*.{ts,tsx}']`, the only `files` scope declared in
the config.

**What happens today:** `npm run lint` (`eslint .`) only ever applies rules to renderer-side
TypeScript/TSX files. `src/electron/main.js`, `library.mjs`, `updater.mjs`, `preload.mjs`,
`src/electron/utils/constants.mjs`, and all four `scripts/*.mjs` build scripts — together
roughly 3,000 lines, including every file this and the security report spent the most time on —
receive **zero** automated lint coverage. There is no unused-variable check, no consistency
check, nothing, on the entire main process.

**Why it matters:** this is the highest-leverage, cheapest fix in this whole report. It's also
the part of the codebase where a public contributor is most likely to introduce something an
even-minimal lint config would have caught for free (an unused import, a shadowed variable, an
accidental `var`), because it's currently the one part of the codebase with no safety net at all.

**Recommended fix:** add a second `files` block to `eslint.config.js` covering `**/*.{js,mjs}`
(excluding `dist`, already ignored, and probably `scripts/` if its style is meant to differ),
using `js.configs.recommended` — already imported in the config — at minimum. This can be a
five-line addition to the existing config, not a new toolchain.

---

### CC-014 — 2026-08-19 — `README.md` is a single boilerplate line with no setup/build/run instructions

**Where:** `README.md`, entire file (37 bytes):

```
# React + TypeScript + Vite + yt-dlp
```

**What happens today:** there is no description of what the app does, no prerequisites (Node
version, platform-specific build tools for the PyInstaller/Python side documented in
`scripts/build-ytdlp-bin.sh`), no `npm install && npm run dev`-equivalent quickstart, no mention
of the `dist:`/`build:all`/`electron-build` scripts already defined in `package.json`, and no
license statement.

**Why it matters:** for a repo about to go public, the README is the first thing anyone —
contributor or curious user — reads, before any code. Right now it tells them nothing the
directory listing wouldn't. This is documentation rather than code, but it's squarely within
"readable codebase" for a first-time visitor's experience, and it's the cheapest high-visibility
fix available in this whole report.

**Recommended fix:** at minimum — one paragraph on what yt-archiver is and does, prerequisites
(Node version, Python 3.11+ for the local yt-dlp build step, platform build tools), the actual
dev loop (`npm install`, `npm run dev` + `npm run dev:electron`), how to produce a packaged build
(`npm run dist`), and a pointer to `reports/TechnicalDebt.md` for anyone who wants deeper context
on non-obvious decisions already made. A license file/section too, if the repo doesn't already
have one at the root — worth confirming before the repo goes public regardless of this report.

---

### CC-015 — 2026-08-19 — Inconsistent `.js`/`.mjs` extension use for functionally identical ESM modules

**Where:** `src/electron/main.js` (and `main.test.js`) vs. `library.mjs`, `updater.mjs`,
`preload.mjs`, `utils/constants.mjs` (and their `.test.mjs` counterparts) in the same directory.

**What happens today:** `package.json` declares `"type": "module"` at the project root, so `.js`
files here are already parsed as ES modules exactly like the `.mjs` ones — confirmed by
`main.js`'s own top-level `import { app, BrowserWindow, ... } from 'electron'`. The `.js`/`.mjs`
split therefore carries no functional meaning in this codebase; it's an inconsistent naming
convention rather than a real distinction between module systems.

**Why it matters:** low severity, but it's the kind of small inconsistency that prompts an
unnecessary question ("does `.mjs` mean something special here that `.js` doesn't?") for anyone
new to the repo, with no real answer.

**Recommended fix:** pick one extension for main-process source files and apply it uniformly —
`.mjs` is the more explicit/self-documenting choice given `main.js` is the only holdout, but
either is fine as long as it's consistent. Low priority; bundle with an unrelated main-process
change rather than doing it standalone.

---

## 3. What's already right

Worth stating plainly, so this report doesn't read as only criticism:

- **The rationale-comment habit, at the right density, would be a real strength.** The comments
  that explain *why* (TD-004/TD-008/TD-010 cross-references, the Referer/loopback-server
  reasoning, the Windows `MAX_PATH` reasoning in `library.mjs`) are genuinely good writing and
  genuinely useful — CC-001 is about dose, not about the practice being wrong.
- **`library.mjs` and `updater.mjs` already show the right instinct** — both were split out of
  `main.js` at some point into focused, single-purpose modules. CC-002's recommendation is simply
  to keep applying that same instinct to what's accumulated in `main.js` since.
- **`LibraryScreen.tsx` already demonstrates the right component-splitting pattern**
  (`VideoGrid`/`ChannelList`/`VideoCard` as separate pieces) — CC-003's recommendation for
  `LibraryVideoDetail.tsx` is to extend a pattern that already exists in this codebase, not invent
  one.
- **Two of the three status-duplication cases in CC-011 already carry explicit
  cross-referencing comments** naming the other locations to keep in sync — evidence the
  duplication is a known, deliberate tradeoff rather than an oversight, which makes it low-risk
  to consolidate.
- **No dead git history or committed secrets** were found during this pass (consistent with the
  security report's git-history check).
- **Pure helper functions are already pulled out and unit-tested** in the electron layer
  (`buildResolutions`, `reshapeVideoInfo`, `cookiesArgs`, `convertHeaderCookiesToNetscape`, etc.,
  all exported from `main.js` and covered in `main.test.js`) — the extraction pattern CC-002
  recommends for whole IPC-handler groups is already the norm for logic within them.

---

## 4. Suggested priority

**P0 — cheap, high-visibility, do before the repo goes public**

- CC-007 — delete `other.tsx`/its route (five minutes, and it's the first thing a curious visitor
  will stumble on).
- CC-013 — extend ESLint to `.js`/`.mjs` (five-line config change, immediate ongoing payoff).
- CC-014 — write a real README.
- CC-009 — gate mock-Electron behind an explicit dev flag rather than an implicit absence-check.

**P1 — meaningful readability wins, worth a dedicated pass**

- CC-001 — comment-density pass, starting with `ffmpegFormats.ts` and `library.mjs`.
- CC-004 — extract the shared path-containment helper (do this alongside
  `reports/SecurityAnalysis.md` SEC-003, one extraction serves both).
- CC-002 / CC-003 — split `main.js` and `LibraryVideoDetail.tsx` along the seams identified above.
  Larger efforts; don't need to happen before the repo goes public, but are the biggest
  contributor-experience wins available.

**P2 — backlog, fix opportunistically when touching nearby code**

- CC-005, CC-006, CC-010, CC-011, CC-012, CC-008, CC-015.

None of this blocks a public release on its own — the codebase is functional, reasonably well
organized at the module level, and (per the security report) sound in its core process/IPC
boundaries. This report is about first-impression readability and long-term maintenance cost for
outside contributors, which is exactly what's worth tightening up before, rather than after, the
repository becomes public.
