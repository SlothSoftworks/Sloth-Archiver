# Security Analysis — Pre-Public-Beta Review

**Date:** 2026-08-10 · **Version reviewed:** 0.11.2 · **Commit:** `21ec03d` · **Branch:** `claude/yt-archiver-security-analysis-1i3kp3`

A full-codebase security review done ahead of the public beta. Findings use stable sequential
IDs (`SEC-NNN`, never reused) in the same convention as `reports/TechnicalDebt.md`. Each entry
states **where**, **what happens today**, **why it's a risk**, **confidence**, **severity**, and
a **recommended fix**. Nothing in this pass changed application code.

Confidence is stated per finding and means exactly this:

- **Confirmed** — read directly out of this repository's code; the behavior is in the source.
- **Needs verification** — the code is as described, but the *impact* depends on third-party
  default behavior (Electron, yt-dlp, OS file modes) that could not be executed in the review
  environment. Each of these carries a concrete one-step check. **Do not act on a
  needs-verification finding's severity without running its check first.**

> **2026-08-24 update:** `reports/cleanCodeAnalysis.md`'s recommendations have since been applied
> in full (that report is now closed and removed). That was a readability/structure pass, not a
> security fix pass, and **no finding below changed severity or was resolved as a result** — but
> two things did change and are reflected inline throughout this document:
> 1. `src/electron/main.js` was renamed to `main.mjs` and split into `settings.mjs`, `cookies.mjs`,
>    `thumbnails.mjs`, `ffmpegUtils.mjs`, and `videoInfo.mjs`. Every `main.js:NNN` citation below
>    has been updated to its new file and line.
> 2. The path-containment check duplicated six times (the subject of the old report's CC-004) is
>    now one function, `resolveInsideLibrary()` (`library.mjs:57`), exported and reused. This is
>    the extraction **SEC-003** and **SEC-010** both already called for as their first step — but
>    it was applied only within `library.mjs` itself and to the `app-video://` handler. SEC-003's
>    four ffmpeg handlers still don't call it (still open), and the two bugs SEC-010 describes
>    still live inside `resolveInsideLibrary()` itself (still open) — the practical effect is that
>    both fixes are now a one-function edit instead of a six-site hunt. See each finding for
>    specifics.

---

## 1. Scope, method, and threat model

### Reviewed

Whole repository at `21ec03d`. Read in full: `src/electron/main.js` (1947 lines, since split into
`main.mjs` + `settings.mjs`/`cookies.mjs`/`thumbnails.mjs`/`ffmpegUtils.mjs`/`videoInfo.mjs` — see
the 2026-08-24 update note above), `src/electron/library.mjs`, `src/electron/updater.mjs`,
`src/electron/preload.mjs`, `src/electron/utils/constants.mjs`, `src/python/ytdlp_entrypoint.py`, all four `scripts/*.mjs`,
`package.json` build config, `vite.config.ts`. Renderer code read selectively along the paths
where remote data becomes markup, a filesystem path, or a subprocess argument:
`componentUtils.tsx`, `LibraryVideoPlayer.tsx`, `YouTubeEmbed.tsx`, `LibraryVideoDetail.tsx`,
`VideoDetailCard.tsx`, `DownloaderScreen.tsx`, `OptionsScreen.tsx`, `BulkAddDialog.tsx`,
`useBulkAddQueue.tsx`, `useDownloadVideo.tsx`, `utils/utils.ts`, `types.ts`.
Also checked: git history for committed secrets (none found), `npm audit` (clean).

### Threat model

Findings are rated on the assumption that **the renderer process is untrusted**. That is not a
statement that the renderer *is* compromised today — it's the standard Electron posture, and it
is the right one here because the renderer:

- renders text authored by third parties (YouTube video titles, descriptions, uploader names,
  thumbnail URLs) that this app has no control over;
- embeds remote content (`youtube-nocookie.com` iframe);
- ships with **no Content-Security-Policy**, **no `will-navigate` guard**, **no
  `setWindowOpenHandler`**, and `sandbox: false`.

Under that model, every `ipcMain.handle` is attack surface, and a handler that accepts an
arbitrary path or an arbitrary subprocess argument is a finding, not a style note. SEC-002
describes a plausible concrete route from attacker-authored YouTube metadata to renderer control;
if that route is confirmed, the "untrusted renderer" premise stops being precautionary.

Three attacker positions are considered throughout:

| Position | Example | Relevant findings |
|---|---|---|
| **Content author** | Anyone who can upload a video, name a channel, or craft a link the user pastes | SEC-001, SEC-002, SEC-008, SEC-009 |
| **Local process / local user** | Malware or another account on the same machine | SEC-004, SEC-010, SEC-011, SEC-016 |
| **Supply-chain / network** | Compromise of PyPI, a GitHub release, or the network path | SEC-012, SEC-013 |

### Out of scope

Distribution signing is noted in §6 but not expanded into findings, per the agreed scope.
No exploitation was attempted, no dependencies were changed, no code was modified.

---

## 2. Summary

| ID | Title | Severity | Confidence | Area |
|---|---|---|---|---|
| SEC-001 | No `--` end-of-options separator before URLs passed to yt-dlp | **High** | Confirmed | IPC / subprocess |
| SEC-002 | No window-open / navigation guards; child windows may inherit the preload | **High** | Needs verification | Electron config |
| SEC-003 | ffmpeg utility IPC handlers accept arbitrary read/write paths | **High** | Confirmed | IPC / filesystem |
| SEC-012 | yt-dlp self-updater fetches and executes unverified, unpinned code | **High** | Confirmed | Supply chain |
| SEC-004 | `cookies.txt` written with default (group/world-readable) permissions | **Medium** | Needs verification | Cookies / privacy |
| SEC-005 | Pasted cookies re-scoped to all of `.google.com` with a 5-year expiry | **Medium** | Confirmed | Cookies |
| SEC-006 | One cookie jar shared across all sites and up to 5 concurrent yt-dlp runs | **Medium** | Needs verification | Cookies |
| SEC-008 | Remote-supplied image URLs fetched with no allowlist, size cap, or timeout | **Medium** | Confirmed | Cloud data → local |
| SEC-015 | `shell.openPath` on renderer-supplied paths | **Medium** | Confirmed | IPC / OS |
| SEC-007 | Cookie lifecycle: no expiry, no clear-on-exit, file persists after mode switch | **Low–Medium** | Confirmed | Cookies / privacy |
| SEC-010 | `app-video://` containment degrades to cwd; no symlink resolution | **Low–Medium** | Confirmed | Protocol handler |
| SEC-013 | Bundled binary provenance is unverified (ffmpeg/ffprobe/deno) | **Low–Medium** | Confirmed | Supply chain |
| SEC-009 | Residual remote-metadata injection surfaces (ffmpeg tags, iframe src, CSS) | **Low** | Confirmed | Cloud data → local |
| SEC-011 | Loopback renderer server has no `Host` header check | **Low** | Confirmed | Local network |
| SEC-014 | Unvalidated settings and dialog-option IPC | **Low** | Confirmed | IPC |
| SEC-016 | Unbounded, unrotated `main.log`; raw tool stderr surfaced to UI | **Low** | Confirmed | Diagnostics |

Nothing here is an active, remotely-triggered compromise of a default install. The two items
that most deserve to be closed before the code is public are **SEC-001** (a free one-token fix
that removes an entire injection class) and **SEC-012** (the updater is the one code path that
downloads and executes new code on a user's machine).

---

## 3. Cookie path — end-to-end review

This section traces the personal-cookie feature completely, because it handles the most
sensitive data the app touches: a live, authenticated Google/YouTube session. Findings raised
here are SEC-004 through SEC-007; this is the narrative that connects them.

### 3.1 The path

1. **Entry (renderer).** `OptionsScreen.tsx` offers two modes. *Paste* mode collects cookie text
   in React state (`cookieText`) and calls `electronAPI.saveCookie`. *Browser* mode stores only a
   browser name. The pasted text is held in component state for the life of the dialog and
   cleared on close; it is never written to `localStorage`/`sessionStorage` (neither is used
   anywhere in this codebase) and never leaves the app.
2. **IPC.** `cookies:save` (`main.mjs:682`). Input is a single string.
3. **Normalization.** `looksLikeNetscapeFormat` (`cookies.mjs:31`) decides whether the paste is
   already a Netscape `cookies.txt` export or a raw `name=value; …` request header. Header input
   goes through `convertHeaderCookiesToNetscape` (`cookies.mjs:35`).
4. **Validation.** `validateNetscapeLines` (`cookies.mjs:74`) requires 7 tab-separated fields per
   non-comment line and counts *distinct cookie names*. Zero valid cookies → the write is
   refused.
5. **At rest.** `fs.writeFileSync(cookiesPath, content, 'utf-8')` (`main.mjs`, in the
   `cookies:save` handler) → `<userData>/cookies.txt`.
6. **Into yt-dlp.** `cookiesArgs()` (`cookies.mjs:17`, via `makeCookiesArgs`) returns
   `['--cookies', cookiesPath]` (file mode) or `['--cookies-from-browser', <browser>]` (browser
   mode), spliced into **every** `spawn(ytdlpPath, …)` call site: `thumbnails.mjs:51` (channel
   avatar), `main.mjs:456` (playlist listing), `videoInfo.mjs:129` (dead-video classification),
   `videoInfo.mjs:131`/`208` (video info), and `buildDownloadArgs` (`main.mjs:815`, `videoUrl`
   pushed at `main.mjs:869`, spawned at `main.mjs:945`).
7. **Read-back.** `cookies:status` (`main.mjs:706`) returns `{loaded, cookieCount}` — a count,
   never content.

### 3.2 What this path already gets right

These are worth stating explicitly, because they're the parts that matter most and they are done
correctly:

- **Cookie values are never readable back through IPC.** No handler returns file contents. A
  compromised renderer can ask *whether* cookies are loaded and *how many*, not what they are.
  This is the single most important property in the whole feature, and it holds.
- **The cookie file path is app-controlled**, derived from `app.getPath('userData')` — never
  supplied by the renderer. There is no "load cookies from this path" IPC, so no way to point
  yt-dlp at an arbitrary file or to have the app read one.
- **Browser mode is allowlist-validated on both sides.** `SUPPORTED_COOKIE_BROWSERS`
  (`cookies.mjs:7`) is checked in `cookies:setConfig` at write time (`main.mjs:723`, throws on an
  unsupported value) *and* again in `cookiesArgs()` at read time (`cookies.mjs:19`) — so a
  hand-edited `settings.json` can't inject an arbitrary `--cookies-from-browser` value either.
  This is exactly the right double-check, and it's the pattern SEC-001 is missing elsewhere.
- **Cookie values never reach logs or the renderer.** `log()` (`main.mjs:26`) is called with
  error strings and stack traces only; yt-dlp is never run with `--verbose`, and no code path
  reads `cookies.txt` into a message.
- **Argument construction is safe.** `--cookies` and its path are separate argv elements passed
  to `spawn` without a shell, so no quoting or injection concern exists on this specific argument.
- **Malformed input is rejected rather than half-written.** A paste that yields zero valid
  cookies throws before touching disk, so a bad paste can't silently destroy a working jar.

### 3.3 Where it's weaker

Four issues, in descending order of how much they matter:

- **The jar is shared across every site and every concurrent download** (SEC-006). This is the
  one with a plausible path to *losing the user's session*, not just exposing it.
- **The paste is re-scoped wider and longer-lived than the browser ever granted** (SEC-005).
  Every cookie is registered under `.google.com` with `includeSubdomains=TRUE` and a 5-year
  synthetic expiry.
- **File permissions are whatever the umask says** (SEC-004), on a file holding a live session.
- **Nothing ever expires or gets cleaned up** (SEC-007).

None of these is an injection into yt-dlp — the specific risk asked about. On that question the
answer is clean: the cookie data itself never becomes an argument, a path, or a shell string. It
is written to a file whose path the app controls, and yt-dlp is handed that path. The risks are
about *scope, lifetime, permissions, and concurrent access* to that file.

---

## 4. Findings

### SEC-001 — 2026-08-10 — No `--` end-of-options separator before URLs passed to yt-dlp

**Where:** every `spawn(ytdlpPath, …)` call site — `thumbnails.mjs:51` (channel avatar),
`main.mjs:456` (playlist listing), `videoInfo.mjs:129` (dead-video classification),
`videoInfo.mjs:131`/`208` (video info), and `buildDownloadArgs()`'s `args.push(videoUrl)` at
`main.mjs:869` (spawned at `main.mjs:945`). Still unfixed as of the 2026-08-24 refactor — these
are the same five call sites, just relocated by the `main.js` → `main.mjs` split.

**What happens today:** the URL is appended as the final argv element with no `--` separator
before it. yt-dlp therefore parses any value beginning with `-` as an option rather than a URL.
yt-dlp's option set includes several that read from or write to the local system — `--exec`
(runs a command on the downloaded file), `--config-locations` (loads an arbitrary config file,
which may itself contain `--exec`), `--paths`, `--load-info-json`, `--batch-file`.

**Why it's a risk:** it converts "a string that reaches the URL slot" into "arbitrary yt-dlp
option", and via `--exec`/`--config-locations` into command execution as the user. The renderer
does validate today — `isValidUrl()` (`utils/utils.ts:4`) is applied in `DownloaderScreen.tsx:65`,
and `BulkAddDialog.tsx:62` rejects non-URL lines — and `new URL()` does reject a leading `-`
because a WHATWG scheme must start with a letter. So this is **not reachable through the normal
UI today**. It is reachable by any caller that reaches the IPC handler directly (SEC-002), and
the mitigation is currently a renderer-side check protecting a main-process boundary — the wrong
place for the only line of defense.

**Confidence:** Confirmed (the missing separator is visible at all five sites; the reachability
caveat above is stated precisely).

**Severity:** High — trivially fixed, and it removes an entire class rather than one bug.

**Recommended fix:** insert `'--'` immediately before the URL at all five sites. Additionally,
validate in the main process rather than trusting the renderer: parse the incoming URL with
`new URL()` inside `getVideoInfoPython` (`main.mjs:776`, delegating to `fetchVideoInfo` in
`videoInfo.mjs`), `library:fetchPlaylistEntries` (`main.mjs:499`), and
`downloadVideoWithProgressUpdates` (`main.mjs:908`), and reject anything whose protocol isn't
`http:`/`https:`
(this also closes `file:`/`data:` URLs reaching yt-dlp's generic extractor). The
double-validation pattern in `cookiesArgs()` (§3.2) is the model to copy.

---

### SEC-002 — 2026-08-10 — No window-open or navigation guards; child windows may inherit the preload

**Where:** `main.mjs:743-756` (the only `BrowserWindow` construction) —
no `setWindowOpenHandler`, no `will-navigate` / `will-redirect` handler, no
`web-contents-created` hook, `sandbox: false` (`main.mjs:750`), and no Content-Security-Policy
anywhere in the app (`index.html`, `src/ui/index.html`, and no `onHeadersReceived` injection).
Unchanged as of the 2026-08-24 refactor.

**What happens today:** video descriptions are third-party text. `formatComment()`
(`componentUtils.tsx:3`) linkifies any `https?://…` run in them into
`<a href={chunk} target="_blank" rel="noopener noreferrer">`, rendered at
`VideoDetailCard.tsx:162` and `LibraryVideoDetail.tsx:636`. A `target="_blank"` click is a
window-open request. With no handler registered, Electron creates the child window itself, and by
default a child window is created with the opener's `webPreferences` — including
`preload: preload.mjs`, which exposes `electronAPI` and `electronAPIPythonDownload` on
`window`. The app never calls `shell.openExternal`, so external links have no path *out* of the
app; they open *inside* it.

**Why it's a risk:** if preload inheritance holds, then a page chosen by a video's uploader runs
inside the app with the full IPC surface — which includes arbitrary-path ffmpeg operations
(SEC-003), `shell.openPath` (SEC-015), the yt-dlp updater trigger, and the URL slot in SEC-001.
That is a chain from "user clicks a link in a video description" to code execution. Separately,
the absent `will-navigate` guard means any successful top-level navigation of the main window
turns the whole renderer into attacker-controlled content, and the absent CSP means there is no
second line of defense if attacker-controlled markup is ever reached.

`rel="noopener noreferrer"` on the anchor is good practice but does not affect any of this: it
severs the `window.opener` reference, it does not stop the child window from being created with
the opener's `webPreferences`.

**Confidence:** Needs verification. The missing guards, `sandbox: false`, and the absent CSP are
all confirmed by reading the code. What is *not* verified here is whether Electron 43 passes the
parent's `preload` to a `target="_blank"` child window by default.
**Check:** run the packaged app, open a library entry whose description contains a link, click
it, and in the child window's DevTools console evaluate `typeof window.electronAPI`. `"object"`
confirms the chain and makes this the top-priority finding; `"undefined"` downgrades it to
hardening (the missing `will-navigate` guard and CSP still stand on their own).

**Severity:** High if the check confirms; Medium as pure hardening if it doesn't.

**Recommended fix:** four changes, all small and all worth making regardless of the check's
outcome:
1. `mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); return { action: 'deny' }; })` — external links open in the
   user's real browser, which is also better behavior than an in-app window with no chrome.
2. A `will-navigate` handler that cancels any navigation away from the loopback origin.
3. `sandbox: true` on the `BrowserWindow` (verify the preload still functions — it uses only
   `contextBridge`/`ipcRenderer`, both sandbox-compatible).
4. A restrictive CSP for the renderer — served as a header from `startRendererServer`
   (`main.mjs:145`) rather than a `<meta>` tag, allowing `self`, `app-video:`, the YouTube embed
   frame, and image sources, with `script-src 'self'`.

---

### SEC-003 — 2026-08-10 — ffmpeg utility IPC handlers accept arbitrary read/write paths

**Where:** `main.mjs:1083` (`library:extractMp3`), `main.mjs:1099` (`library:convertFormat`),
`main.mjs:1123` (`library:extractClip`), `main.mjs:1150` (`library:embedMetadata`).

**What happens today:** all four take `inputPath` and `outputPath` (or, for `embedMetadata`, an
`inputPath` plus a derived temp path) straight from the IPC payload and hand them to ffmpeg with
no containment check. `embedMetadata` is the most destructive: it writes `<input>.new.<ext>`,
then deletes the original and renames the temp file into place — an unconditional delete-and-
replace of whatever path it was given. `library:extractClip` additionally passes `start` and `end`
directly into ffmpeg's `-ss`/`-to` argv slots (`main.mjs:1128`); the UI constrains these to digits
via `formatClipTimestampInput` (now `FfmpegUtilitiesPanel.tsx:31`, moved there by the CC-003
component split — was `LibraryVideoDetail.tsx:99`), but the handler does not.

**Why it's a risk:** arbitrary file read (any file ffmpeg can demux becomes an output the caller
chooses the location of), arbitrary file creation/overwrite anywhere the user can write, and — via
`embedMetadata` — destruction of an arbitrary file. This is notable precisely because the correct
pattern already exists in this codebase: `library.mjs` guards `addLibraryVersion` (`:140`),
`refreshLibraryEntryMetadata` (`:163`), `swapLibraryDownload` (`:208`), `deleteLibraryEntry`
(`:254`), and `deletePlaylistSnapshot` (`:777`) all via one shared helper,
`resolveInsideLibrary()` (`library.mjs:57`, exported) — and `handleAppVideoRequest`
(`main.mjs:186-191`) uses that same helper too. **Update (2026-08-24):** this shared helper is
exactly the extraction this finding's own recommended fix asked for — it now exists, is exported,
and is a one-line import away. These four handlers still don't call it, though; the extraction
happened as part of an unrelated readability pass (`reports/cleanCodeAnalysis.md`'s CC-004) that
stopped at `library.mjs`'s own call sites and never reached these four. Still open.

**Confidence:** Confirmed.

**Severity:** High under the untrusted-renderer model; not reachable through the UI on its own.

**Recommended fix:** import `resolveInsideLibrary` from `library.mjs` (already extracted and
exported — see the update above) and apply it to `inputPath` and `outputPath` in all four
handlers. Note that
`inputPath`/`outputPath` are legitimately allowed to point outside the library for the "export
to a user-chosen location" flows (`dialog:saveExportedFile`, `LibraryVideoDetail.tsx:533/551`) —
so the right guard is *input must be inside `libraryDir`; output must be either inside
`libraryDir` or a path the user just chose in a save dialog*. The cleanest way to enforce the
latter is to have the main process remember the last path returned by `dialog:saveExportedFile`
and accept only that, rather than trusting the renderer to echo it back honestly. Also validate
`start`/`end` against a timestamp regex in the handler, mirroring the renderer's own formatter.

---

### SEC-012 — 2026-08-10 — yt-dlp self-updater fetches and executes unverified, unpinned code

**Where:** `src/electron/updater.mjs` — `ensurePythonRuntime()` (`:227`), `ensurePyinstaller()`
(`:257`), `rebuildYtdlp()` (`:266`), `verifyAndSwap()` (`:320`); triggered from
`ipcMain.handle('ytdlp:startUpdate')` (`main.mjs:1217`).

**What happens today:** pressing "update yt-dlp" in the app performs this sequence (line numbers
current as of the 2026-08-24 refactor — `updater.mjs` itself wasn't restructured, but did shift
from unrelated comment-trimming and feature work since the original review):

1. `GET https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest`
   (`:237`) — the **latest** release, not a pinned one.
2. Downloads the matching CPython archive from `asset.browser_download_url` (`:240`) with **no
   checksum and no signature check**, following redirects to any host (`downloadFile`, `:146`).
3. Extracts it by spawning **`tar` resolved from `PATH`** (`:242`).
4. `pip install pyinstaller>=6.10,<7 certifi` (`:263`) and `pip install --upgrade yt-dlp[default]`
   (`:272`) — **unpinned**, latest-at-the-time, no hash pinning.
5. PyInstaller-freezes the result (`:286-298`) and swaps it into `liveYtdlpBinDir` (`:339`) — the
   exact binary the app spawns on every metadata fetch and every download.

The only verification performed is `verifyAndSwap`'s `--version` sanity check (`:322`), which
confirms the binary *runs*, not that it is authentic. Still unfixed.

**Why it's a risk:** this is the only path in the app that downloads new executable code and
installs it as something the app runs. A compromise anywhere in that chain — the GitHub release,
the PyPI packages, a `PATH`-shadowed `tar`, or the network path if TLS is intercepted (e.g. a
corporate MITM proxy whose CA the machine trusts) — results in code execution as the user, from a
single in-app button, with no signal that anything is wrong. The unpinned `--upgrade yt-dlp` also
means a malicious or simply broken yt-dlp release is picked up immediately and permanently
replaces the vetted bundled binary. Note that TD-010's resolution deliberately avoided runtime
remote code fetching (`--remote-components ejs:github`) for exactly this reason — the updater is
the remaining path that does it.

**Confidence:** Confirmed.

**Severity:** High. This is the highest-value target in the app for anyone attacking the
distribution rather than the user.

**Recommended fix:** in rough order of value:
- Pin the python-build-standalone release **tag** and verify the downloaded archive against a
  known SHA-256 recorded in the repo, rather than taking `releases/latest` on trust.
- Pin yt-dlp to an explicit version resolved from PyPI's JSON API (already fetched by
  `getLatestYtdlpVersionFromPyPI`, `updater.mjs:175`) and install with `pip install --require-hashes` against
  the hashes PyPI reports, instead of a bare `--upgrade`.
- Use an absolute path for `tar`, or extract in-process, rather than resolving it from `PATH`.
- Strongly consider whether the app should rebuild yt-dlp at all at runtime. yt-dlp publishes
  signed release binaries; downloading and verifying one is a far smaller trusted surface than
  running a full pip + PyInstaller toolchain on a user's machine. TD-002 chose the local build
  for startup-performance reasons that applied to the *bundled* binary — that reasoning should be
  re-examined for the *update* path specifically.
- At minimum: make the update flow state plainly what it is about to download and from where.

---

### SEC-004 — 2026-08-10 — `cookies.txt` written with default (group/world-readable) permissions

**Where:** `main.mjs`, in the `cookies:save` handler (`main.mjs:682`) —
`fs.writeFileSync(cookiesPath, content, 'utf-8')`, writing `<userData>/cookies.txt`. Still
unfixed; unaffected by the 2026-08-24 refactor beyond relocating from `main.js` to `main.mjs`.

**What happens today:** no `mode` is specified, so the file is created `0o666 & ~umask` — 0644
under a typical umask on macOS/Linux. Existing files' modes are never corrected. The file
contains live, authenticated Google/YouTube session cookies.

**Why it's a risk:** anything that can read the file can authenticate as the user to YouTube (and,
because of SEC-005, to Google subdomains) — a full account-access primitive, not just a "download
history" leak. Being honest about actual exposure: on macOS `~/Library` is `drwx------`, and on
Windows `%APPDATA%` carries per-user ACLs, so a same-machine *other user* generally cannot reach
it on those platforms. What is genuinely exposed regardless: any process running **as the user**
(the realistic malware case, which specifically hunts for files exactly like this), backups,
cloud-sync folders, and support bundles. And on Linux — which a "standalone and portable" tool
will end up on — 0644 in a readable home directory is plainly readable by other local accounts.

**Confidence:** Needs verification for the exact resulting mode per platform.
**Check:** save a cookie in each target OS and inspect (`ls -l` / `icacls`) the resulting file.

**Severity:** Medium.

**Recommended fix:** write with `{ mode: 0o600 }`, and `fs.chmodSync(cookiesPath, 0o600)` at
startup if the file already exists (so existing beta users are fixed on upgrade). Consider
Electron's `safeStorage` API (OS keychain-backed encryption) for at-rest protection: the cookie
text would be decrypted only when writing the temporary jar yt-dlp needs, which pairs naturally
with the per-run jar copy recommended in SEC-006. Also add a short line to the Options UI stating
where the file lives and what it grants — informed consent is part of the mitigation for a
feature like this.

---

### SEC-005 — 2026-08-10 — Pasted cookies are re-scoped to all of `.google.com` with a 5-year expiry

**Where:** `convertHeaderCookiesToNetscape()`, `cookies.mjs:35-64` — specifically the domain loop
at `cookies.mjs:56` and `farFutureExpiry` at `cookies.mjs:36`. Still unfixed; test coverage for
this function still lives in `main.test.mjs` per the original recommendation below.

**What happens today:** every cookie parsed out of a pasted request header is written to the jar
**twice** — once for `.youtube.com` and once for `.google.com` — each with
`includeSubdomains=TRUE`, `path=/`, `secure=TRUE`, and an expiry of **now + 5 years**:

```js
const farFutureExpiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5;
…
for (const domain of ['.youtube.com', '.google.com']) {
    lines.push([domain, 'TRUE', '/', 'TRUE', String(farFutureExpiry), name, value].join('\t'));
}
```

**Why it's a risk:** two independent widenings of the user's credentials beyond what their
browser granted.

*Scope*: the cookies were captured from a request to youtube.com. Registering them for
`.google.com` with `includeSubdomains` means the jar will attach them to **every** Google
subdomain yt-dlp is ever pointed at. Google hosts a large amount of third-party and user-authored
content on `*.google.com` subdomains, and this app accepts arbitrary URLs (`DownloaderScreen`,
bulk add) against 1800+ sites. A crafted URL on a Google-hosted subdomain therefore becomes a
plausible route to having the user's own session cookies sent somewhere the browser would never
have sent them. The in-code rationale — "Registering each cookie under both domains costs nothing
(cookie jars key by domain+path+name, so this can't conflict)" — is correct about *collisions*
and silent about *scope*, which is the actual cost.

*Lifetime*: session cookies, which a browser discards when it closes, are stamped with a five-year
expiry. A credential the user believed was ephemeral persists on disk for years, and keeps being
sent, long after they've forgotten the feature exists.

**Confidence:** Confirmed.

**Severity:** Medium.

**Recommended fix:** register for `.youtube.com` only, and add specific additional hosts only if a
real, observed yt-dlp failure requires them (`accounts.google.com` is the likely one; that's a
narrow host entry, not a subdomain wildcard over all of Google). Stop extending expiry — preserve
whatever the source expiry was, and for header-pasted cookies (which carry no expiry) use a short
horizon (e.g. 30 days) so a forgotten paste ages out. Both changes are in one function with
existing unit-test coverage in `main.test.mjs`.

---

### SEC-006 — 2026-08-10 — One cookie jar shared across every site and up to 5 concurrent yt-dlp runs

**Where:** `cookiesArgs()` (`cookies.mjs:17`) spliced unconditionally into `thumbnails.mjs:51`,
`main.mjs:456`, `videoInfo.mjs:129`, `videoInfo.mjs:131/208`, and `buildDownloadArgs`
(`main.mjs:815`); concurrency from `MAX_SIMULTANEOUS_DOWNLOADS_CEILING = 5` (now `settings.mjs:28`,
was `main.js:375`) and the 5-slot worker pool in `useBulkAddQueue.tsx` (`useBulkAddQueue.tsx:62`).
The renderer's own copy of this constant is no longer independently hand-typed in three places —
`OptionsScreen.tsx` and `useBulkAddQueue.tsx` now both import one shared `utils/constants.ts`
value — but that value is still a separate, manually-kept-in-sync `5` from the main-process
`settings.mjs` copy (the cross-process boundary this finding's own recommended fix already
anticipated). Doesn't change this finding's severity.

**What happens today:** the same single `cookies.txt` is passed to yt-dlp for *every* extraction,
regardless of target host — including the non-YouTube platforms the app explicitly supports
(SoundCloud, TikTok, Instagram, Facebook, X — see `KNOWN_PLATFORM_LABELS`, `utils.ts:33`). With
`maxSimultaneousDownloads` at its maximum, up to five yt-dlp processes hold that one file at once,
and bulk-add can add metadata fetches on top of that.

**Why it's a risk:** two consequences, one of which can cost the user their session.

*Cookie mixing*: yt-dlp writes its cookie jar back to the `--cookies` file at the end of a run.
If so, cookies set by unrelated third-party sites during a download get merged into the file the
user thinks of as "my YouTube cookie" — the file grows to hold credentials for sites they never
intended to store, and `cookies:status`'s count (`main.mjs:706`) silently starts reporting them.

*Corruption*: concurrent read-modify-write of a single jar file by five processes has no
coordination here. A lost update or an interleaved truncation destroys the user's pasted session
— which they cannot regenerate without going back to their browser and re-exporting. This is the
most user-visible failure in this report: it doesn't leak anything, it just breaks the feature in
a way that looks random.

**Confidence:** Needs verification — the sharing and concurrency are confirmed from this
codebase; yt-dlp's write-back behavior is documented/known but was not executed here.
**Check:** record `cookies.txt`'s mtime and SHA-256, run one download from a non-YouTube site
through the bundled binary, and re-check. If the file changed, both consequences above apply.

**Severity:** Medium.

**Recommended fix:** give each yt-dlp invocation its **own copy** of the jar in a temp directory
and delete it when the process exits — the user's canonical `cookies.txt` then becomes read-only
at runtime and can neither be corrupted nor polluted. If the write-back turns out to be wanted
(refreshed YouTube cookies extending session life), merge back deliberately from a single
serialized point rather than by five racing processes. Independently, consider attaching cookies
only for hosts the jar is actually scoped to — sending nothing at all to unrelated platforms is
both safer and closer to what the user expects from a feature labeled "personal YouTube cookie".

---

### SEC-008 — 2026-08-10 — Remote-supplied image URLs fetched with no allowlist, size cap, or timeout

**Where:** `downloadImageToFile()` (`thumbnails.mjs:11`), called from `ensureChannelIcon` and
`ensureVideoThumbnail` (both defined inside `createThumbnailFetchers()`, `thumbnails.mjs:82`), and
`library:embedMetadata` (`main.mjs:1165`).

**What happens today:** the URL comes from yt-dlp's info dict (`info.thumbnail` /
`thumbnails[].url`, reshaped in `reshapeVideoInfo`, `videoInfo.mjs:62`, or a channel-page avatar
via `fetchChannelAvatarUrl`, `thumbnails.mjs:48`) —
i.e. from remote metadata a content author influences. It is passed to `https.get` with:
no host or scheme allowlist; up to 5 redirects followed to any location (`thumbnails.mjs:11-16`); no
response size limit; no timeout. The body is streamed to disk inside the library folder
(`channel-icon.*`, `video-thumbnail.*`) or into `os.tmpdir()`.

**Why it's a risk:** *SSRF* — the app will issue GETs to whatever host the metadata names,
including loopback and LAN addresses, from the user's machine and network position. Because
`https.get` is used, plain-HTTP internal targets fail (a redirect to `http:` throws), which
meaningfully narrows this to HTTPS-speaking internal services; the response is written to disk
rather than returned to the caller, so this is a blind write-to-disk SSRF rather than a
read-back oracle. *Disk exhaustion* — with no size cap, a hostile or merely broken URL can write
until the volume is full, and with no timeout a stalled connection leaves the operation hanging.

**Confidence:** Confirmed.

**Severity:** Medium.

**Recommended fix:** validate before fetching — require `https:`, reject hosts that resolve to
loopback/private/link-local ranges (checked after DNS resolution, and re-checked on each
redirect, to avoid DNS-rebinding), and consider an allowlist of the CDN hosts that actually
appear in practice (`i.ytimg.com`, `yt3.ggpht.com`, `*.googleusercontent.com`). Add a byte cap
(a few MB is generous for a thumbnail) that destroys the stream when exceeded, plus a request
timeout. Reduce `redirectsLeft` and validate each hop rather than only the first URL.

---

### SEC-015 — 2026-08-10 — `shell.openPath` on renderer-supplied paths

**Where:** `main.mjs:1252` (`system:openFileInDirectory` → `shell.showItemInFolder`),
`main.mjs:1258` (`system:openDirectory` → `shell.openPath`), `main.mjs:1266`
(`system:openFileExternally` → `shell.openPath`). Still unfixed.

**What happens today:** the path is taken from the IPC payload and passed to the OS shell with no
validation of location or file type. `shell.openPath` asks the OS to open the file with its
registered default handler.

**Why it's a risk:** for executable or script-like file types (`.command`, `.desktop`, `.lnk`,
`.exe`, `.bat`, `.scpt`), "open with the default handler" is "execute". Combined with the app's
own ability to write files to attacker-influenced locations (SEC-003, SEC-008), a caller that
controls this handler has an execution primitive that never spawns anything itself. In normal use
the path always comes from library metadata the app generated, so this is only reachable given
renderer compromise.

**Confidence:** Confirmed.

**Severity:** Medium.

**Recommended fix:** constrain these three handlers to paths inside `libraryDir` or the
configured `downloadDir` using the shared containment helper from SEC-003, and refuse known
executable extensions outright. `showItemInFolder` (reveal in file manager, no execution) is the
safer primitive where it suffices.

---

### SEC-007 — 2026-08-10 — Cookie lifecycle: no expiry, no clear-on-exit, file persists after mode switch

**Where:** `cookies.mjs:9-24` (`makeCookiesArgs`'s documented precedence), `main.mjs:699`
(`cookies:delete`), `OptionsScreen.tsx:449-512` (the Options UI).

**What happens today:** switching from "paste cookie" to "cookies from browser" mode deliberately
leaves `cookies.txt` on disk — the code comment at `cookies.mjs:12-15` documents this as
intentional so that mode switching doesn't destroy the saved file. There is no expiry, no "clear on exit"
option, and no periodic prompt. The only removal path is the explicit "Delete cookie" button.
Browser mode reads the user's live browser profile on every single yt-dlp invocation.

**Why it's a risk:** a live session credential accumulates on disk indefinitely, including for
users who tried the paste flow once, moved to browser mode, and reasonably believe the pasted
credential is no longer in play. Combined with SEC-005's five-year expiry stamp, a cookie pasted
during beta can still be sitting in a user's profile years later. This is a consent and hygiene
problem more than an exploitable one — but it's the kind of thing that reads badly when a
security-conscious user reviews a newly-public tool.

**Confidence:** Confirmed.

**Severity:** Low–Medium.

**Recommended fix:** when the user switches to browser mode, offer to delete the stored file
(default yes) rather than silently keeping it. Surface the file's real location and age in
Options, alongside the existing "Cookie loaded (N)" chip. Consider an opt-in "forget cookies when
the app closes". Document in the README what the feature stores, where, and what it grants — for
a tool whose selling point is local, portable archiving, that transparency is a feature.

---

### SEC-010 — 2026-08-10 — `app-video://` containment degrades to cwd; no symlink resolution

**Where:** `handleAppVideoRequest()`, `main.mjs:186-191`, calling the shared
`resolveInsideLibrary()` (`library.mjs:57-65`).

**What happens today:**

```js
export function resolveInsideLibrary(libraryDir, targetPath) {
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedTarget = path.resolve(targetPath || '');
    const relative = path.relative(resolvedLibraryDir, resolvedTarget);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    return resolvedTarget;
}
```

When no library folder is configured, `path.resolve('')` returns the process's current working
directory, so the containment check becomes "anything under the app's cwd" instead of "nothing".
Separately, the check uses `path.resolve`, not `fs.realpathSync` — a symlink placed inside the
library that points outside it passes the check, and `fs.statSync`/`net.fetch` then follow it.

**Update (2026-08-24):** the readability-motivated CC-004 extraction (see the note at the top of
this document) moved this exact logic — unchanged — out of six duplicated inline copies into this
one shared, exported function, now also reused by `library.mjs`'s own five internal call sites
(`addLibraryVersion` `:140`, `refreshLibraryEntryMetadata` `:163`, `swapLibraryDownload` `:208`,
`deleteLibraryEntry` `:254`, `deletePlaylistSnapshot` `:777`) and by `handleAppVideoRequest`
itself. Both bugs described above are unchanged — they now live in exactly one place, which is a
meaningfully smaller fix than before (one function edit instead of six), but neither has actually
been made yet.

**Why it's a risk:** the protocol is registered with `corsEnabled` and `bypassCSP`
(`main.mjs:122-124`), so any page loaded in the renderer can fetch `app-video://` URLs. Under the
default-library-unset state, that becomes a read primitive over the app's working directory; via
symlinks, over anything the user can read. Impact is bounded (files must be reachable and the
attacker must already have script execution in the renderer — SEC-002), which is why this is
rated low, but the fix is two lines.

**Confidence:** Confirmed.

**Severity:** Low–Medium.

**Recommended fix:** in `resolveInsideLibrary()` (`library.mjs:57`), return `null` immediately
when `libraryDir` is unset or empty, rather than resolving `''`. Resolve both sides with
`fs.realpathSync` before the `path.relative` comparison so symlinks are normalized. Because this
is now one function shared by every call site (library.mjs's five plus `handleAppVideoRequest`),
this fix applies everywhere at once rather than needing six separate corrections.

---

### SEC-013 — 2026-08-10 — Bundled binary provenance is unverified

**Where:** `scripts/copy-ffmpeg.mjs`, `scripts/copy-deno.mjs`, `scripts/build-ytdlp-bin.mjs`,
`package.json` `build.extraResources`.

**What happens today:** the shipped app carries four third-party executables — yt-dlp (frozen
locally by PyInstaller), ffmpeg, ffprobe, and deno. The yt-dlp side is the strongest link:
`requirements-build.txt` pins `yt-dlp[default]==2026.7.4` exactly, and the build is reproducible
from that pin. ffmpeg/ffprobe/deno are copied out of `node_modules` from packages
(`ffmpeg-static`, `ffprobe-static`, `deno`) whose install scripts download platform binaries at
`npm install` time; the copy scripts verify only that the file exists (`copy-deno.mjs:23`). No
hashes of the shipped binaries are recorded anywhere in the repo.

**Why it's a risk:** the app's own integrity depends on four binaries it can't currently attest
to, and there is no way — for you or for a beta user — to check that a given build shipped the
expected ones. This is the build-time counterpart to SEC-012's runtime problem.

**Positive context, stated for balance:** `npm audit` reports **0 vulnerabilities across 614
dependencies** (89 prod / 526 dev) as of this review; `package-lock.json` is committed; the
runtime dependency tree is small and mainstream (React, MUI, dayjs, react-router); no committed
secrets were found anywhere in git history; and `main.mjs`/`preload.mjs` — and, as of the
2026-08-24 split, `settings.mjs`/`cookies.mjs`/`thumbnails.mjs`/`ffmpegUtils.mjs`/`videoInfo.mjs`
too — import zero third-party packages (only `electron` and Node built-ins), which is what makes
the tiny 524KB asar of TD-003 possible.

**Confidence:** Confirmed.

**Severity:** Low–Medium.

**Recommended fix:** record SHA-256 hashes of every binary placed in `extraResources` into a
checked-in manifest, generated by the copy scripts and verified during `build:all`, so an
unexpected binary fails the build rather than shipping. Publish those hashes with each beta
release so users can verify. Longer term, pin `ffmpeg-static`/`ffprobe-static`/`deno` to exact
versions (they're currently `^` ranges) so a build is reproducible from the lockfile alone.

---

### SEC-009 — 2026-08-10 — Residual remote-metadata injection surfaces

**Where:** grouped; each is individually low.

**What happens today — and what's already safe.** This is the question the review was
commissioned around: remote metadata (title, description, uploader, channel ID, thumbnail URL,
video ID) flowing into local binaries and the filesystem. The primary answer is that this path is
sound:

- **No shell is ever involved.** Every subprocess call in the app uses `spawn(cmd, argsArray)`
  with no `shell: true` anywhere (verified across `main.mjs` and its split-out modules,
  `updater.mjs`, `scripts/`). Shell
  metacharacters in a video title are inert — there is no command-injection vector via metadata.
- **Filesystem naming is properly sanitized.** `sanitizeForFilesystem()` (`library.mjs:33`)
  strips `< > : " / \ | ? *` and control characters `\x00-\x1F`, trims trailing dots/spaces,
  caps length at 100, and appends `_` to Windows reserved device names. Path traversal via a
  crafted title or channel name is not possible: separators are removed before the value is ever
  joined into a path. Video folders are keyed on `videoId` rather than title (`library.mjs:75`,
  `videoFolderName`), which narrows the surface further.
- **No dynamic code execution or raw HTML.** Zero occurrences of `eval`, `new Function`,
  `dangerouslySetInnerHTML`, `innerHTML`, or `srcdoc` in the entire codebase. React's default
  escaping handles titles and descriptions.
- **Linkification can't produce a dangerous scheme.** `formatComment`'s regex
  (`componentUtils.tsx:4`) matches only `https?://…`, so `javascript:`/`data:` URLs in a
  description can't become an `href`. (Where those links *go* is SEC-002's concern, not this one.)

**The residue**, all low:

1. **ffmpeg metadata keys are unvalidated.** `main.mjs:1159-1161` builds
   `['-metadata', `${key}=${value}`]` from `metadataTags` entries. Values are safe (one argv
   token, no shell). A key containing `=` or a newline produces a malformed tag rather than a new
   argument, since key and value share a single token — so this is a data-integrity nit, not an
   injection. Worth an allowlist of expected tag names anyway (`title`, `artist`, `date`, …).
2. **`videoId` is interpolated into an iframe URL.** `YouTubeEmbed.tsx:15` builds
   `https://www.youtube-nocookie.com/embed/${videoId}` with no encoding. A crafted id containing
   `../` or `?`/`#` can redirect the frame to a different path on that same origin. Contained to
   youtube-nocookie.com; fix with `encodeURIComponent` and an `^[A-Za-z0-9_-]{11}$` check.
3. **`channelId` is interpolated into a yt-dlp target URL.** `fetchChannelAvatarUrl`
   (`thumbnails.mjs:50`) builds `https://www.youtube.com/channel/${channelId}`. Because the value
   is embedded mid-string, it can't become a leading-dash argument (so SEC-001 doesn't apply), but
   it can alter which URL is fetched. Encode it.
4. **CSS injection via thumbnail URL.** `LibraryVideoPlayer.tsx:124` passes a remote URL to MUI's
   `CardMedia image={…}`, which emits `background-image: url("…")`. A URL containing `")` can
   break out of the `url()` and inject CSS declarations. No script execution results, and there is
   no CSP to backstop it (SEC-002); impact is limited to visual defacement of the app's own
   window. Validate that the URL parses and is `https:` before use.

**Confidence:** Confirmed.

**Severity:** Low (each item). All four unfixed as of the 2026-08-24 refactor.

**Recommended fix:** as noted per item. The broader recommendation is a single validation point
where yt-dlp's info dict is reshaped (`reshapeVideoInfo`, `videoInfo.mjs:62`) — assert types and
shapes there, so downstream consumers can rely on `videoId` being an id, `thumbnail` being an
https URL, and so on, rather than each call site defending itself.

---

### SEC-011 — 2026-08-10 — Loopback renderer server has no `Host` header check

**Where:** `startRendererServer()`, `main.mjs:145-178`.

**What happens today:** an HTTP server bound to `127.0.0.1` on an OS-assigned ephemeral port
serves the renderer bundle out of `rendererDir`. Path traversal *is* correctly prevented
(`main.mjs:150-153` uses the same `path.relative` guard as elsewhere — this specific instance is
a distinct, legitimate check against `rendererDir`, not one of the six library-containment copies
CC-004 consolidated). There is no `Host` header validation and no authentication.

**Why it's a risk:** any local process can enumerate the port and fetch the static bundle, and a
remote page can reach it via DNS-rebinding. What's served is only the app's own already-public
front-end assets — no IPC, no user data, no library files — so the practical impact is close to
nil. It's listed because it's a one-line fix and because a public repo invites the question.

**Confidence:** Confirmed.

**Severity:** Low.

**Recommended fix:** reject requests whose `Host` header isn't `127.0.0.1:<port>`. Optionally
generate a random path prefix or one-time token at startup and require it, which also makes the
server useless to any other local process.

---

### SEC-014 — 2026-08-10 — Unvalidated settings and dialog-option IPC

**Where:** `main.mjs:274` (`settings:setDownloadDir`), `main.mjs:289` (`settings:setLibraryDir`),
`main.mjs:343` (`settings:setCustomConvertFormats`), `main.mjs:757` (`dialog:openFolder`),
`main.mjs:764` (`dialog:saveVideoFile`).

**What happens today:** the settings setters persist whatever value they're given. Notably
`settings:setLibraryDir` accepts any path and that value becomes the root of the `app-video://`
containment check (SEC-010) — setting it to `/` would make the whole filesystem servable over
that protocol. The two dialog handlers spread a renderer-supplied `options` object into
`dialog.showOpenDialog`/`showSaveDialog`, letting a caller override `properties`, `defaultPath`,
`filters`, etc.

Not every setting is unguarded — `maxSimultaneousDownloads` is clamped in the main process
(`clampMaxSimultaneousDownloads`, now `settings.mjs:30`, was `main.js:377`), theme and view mode
are normalized to known values, and the cookie browser is allowlisted. Those are the right
patterns; the paths just don't follow them.

**Confidence:** Confirmed.

**Severity:** Low.

**Recommended fix:** validate directory settings — require an absolute path that exists and is a
directory, and reject filesystem roots. Rather than spreading a renderer-supplied `options` into
the dialog calls, accept a small set of named, validated fields.

---

### SEC-016 — 2026-08-10 — Unbounded, unrotated `main.log`; raw tool stderr surfaced to UI

**Where:** `log()` (`main.mjs:26`), `errorLog:report` (`main.mjs:1273`), `summarizeFfmpegError`
(now `ffmpegUtils.mjs:26`, was `main.js:1487`), the download error path (`main.mjs`, inside
`downloadVideoWithProgressUpdates` — `main.mjs:908`).

**What happens today:** `main.log` is appended to with `fs.appendFileSync` and never rotated,
trimmed, or size-capped. Renderer errors are forwarded into the same file. yt-dlp's accumulated
stderr is sent verbatim to the renderer on download failure; ffmpeg's stderr is summarized
(`summarizeFfmpegError` does a good job of extracting a root-cause line and translating common
cases) but still capped only at 300 characters of raw tool output.

**Why it's a risk:** unbounded growth on a long-lived install, and absolute filesystem paths
(which embed the OS username) plus raw tool diagnostics surfaced in the UI and stored on disk.
This matters mainly because beta users will be asked to share logs: whatever ends up in
`main.log` is what gets pasted into a public issue tracker. No credential material reaches it
today (see §3.2), which is the important part.

**Confidence:** Confirmed.

**Severity:** Low.

**Recommended fix:** cap `main.log` (rotate at a few MB, keep one previous file). Before beta,
re-check what a failed download's error text contains and consider redacting home-directory
prefixes in user-facing messages. Add a note in the Options tab's "open error log" affordance
that the log may contain file paths, so users know what they're sharing.

---

## 5. What's already right

Called out deliberately — the codebase gets several things right that are commonly wrong in
Electron apps, and a security report that lists only problems misrepresents the state of the
project.

- **Correct process isolation.** `contextIsolation: true`, `nodeIntegration: false`
  (`main.mjs:748-749`). The preload exposes a fixed, enumerated API surface — no raw `ipcRenderer`,
  no `require`, no channel-name passthrough. This is the single most important structural decision
  in an Electron app and it's right.
- **No dynamic code execution or raw HTML anywhere.** Zero `eval` / `new Function` /
  `dangerouslySetInnerHTML` / `innerHTML` / `srcdoc` across the whole codebase.
- **Subprocesses are always argv arrays, never shell strings** — no `shell: true` anywhere. This
  is what makes remote metadata safe to pass around (§SEC-009).
- **A real, reusable path-containment pattern exists** (`path.resolve` + `path.relative`) and is
  applied to the destructive library operations and the `app-video://` handler. SEC-003 and
  SEC-010 are about extending and tightening it, not inventing it.
- **The filesystem sanitizer is genuinely good** — cross-platform superset, control characters,
  Windows reserved device names, length cap, and keyed on stable video IDs rather than titles.
- **Cookie contents are never exposed back through IPC**, and browser selection is allowlisted at
  both write and read time — a deliberate double-check.
- **Bundled-rather-than-fetched dependencies.** TD-010's resolution explicitly rejected yt-dlp's
  `--remote-components ejs:github` (which would download and execute remote code at runtime) in
  favor of bundling deno. That was the right instinct, and SEC-012 is the argument for applying it
  to the updater too.
- **Crash-safe write patterns** — temp-then-rename for metadata (`library.mjs:763`,
  `main.mjs:1200` inside `library:embedMetadata`), backup-before-reconcile for playlists, and
  tolerant scanning that skips corrupt entries rather than failing a whole library scan.
- **Clean dependency posture** — 0 npm audit findings across 614 deps, committed lockfile, no
  secrets in git history, zero third-party imports in the main process.
- **The code is unusually well commented.** Nearly every non-obvious decision carries a rationale
  comment. That is a real security asset for a public repo: it makes review by outsiders possible,
  and it's why this analysis could reconstruct intent rather than guess at it.

---

## 6. Distribution integrity (brief)

Out of the agreed scope for full findings, but relevant to a public beta and recorded here so it
isn't lost:

macOS builds are configured with `identity: null` (`package.json:52`) — unsigned and
un-notarized. Windows NSIS output is unsigned. No Electron fuses are configured and ASAR
integrity is not enabled. Practically: beta users will see Gatekeeper/SmartScreen warnings and be
told to click through them, and they will have no way to verify that the binary they downloaded is
the one you built. Signing certificates cost money and add pipeline work (this was consciously
deferred earlier — see TD-002); the low-cost interim step is publishing SHA-256 hashes for each
release artifact alongside the download, which pairs with the manifest recommended in SEC-013.

---

## 7. Suggested priority

Ordering for the follow-up pass. Nothing here should be read as "the app is unsafe to release" —
it's the order in which fixing things buys the most.

**P0 — before the repository goes public**

- **SEC-002's verification check** (one console evaluation). It determines whether SEC-001 and
  SEC-003 are theoretical or a live chain, and therefore the shape of everything else.
- **SEC-001** — add `--` at five call sites plus main-process URL scheme validation. Perhaps an
  hour's work; removes a whole class.
- **SEC-012** — pin and verify the updater's downloads, or reconsider the runtime rebuild
  entirely.

**P1 — during beta**

- **SEC-002's hardening** regardless of the check's result: `setWindowOpenHandler` +
  `shell.openExternal`, `will-navigate` guard, CSP, `sandbox: true`.
- **SEC-003** and **SEC-015** — extend the existing containment helper to the ffmpeg and shell
  handlers.
- **SEC-004, SEC-005, SEC-006** — the cookie trio: file mode `0o600`, narrow the domain/expiry
  scope, per-run jar copies. These are small, independent, and all in code with existing tests.
- **SEC-008** — allowlist, size cap, and timeout on remote image fetches.

**P2 — backlog**

- SEC-007 (cookie lifecycle + documentation), SEC-009 (validation at `reshapeVideoInfo`),
  SEC-010, SEC-011, SEC-013, SEC-014, SEC-016, and the §6 signing question.

**Test coverage to add alongside the fixes.** The existing suite (287 tests as of 2026-08-24;
`main.test.mjs` covers the exported pure helpers, alongside sibling `*.test.mjs` files for the
modules split out of `main.js` since this report was written) is the natural home for most of
this: assert that
`buildDownloadArgs` emits `--` before the URL; that `convertHeaderCookiesToNetscape` emits only
the intended domains and doesn't extend expiry; and add direct tests for a shared path-containment
helper once SEC-003 introduces one. Each is a pure-function test, which is why these fixes are
cheap to land safely.
