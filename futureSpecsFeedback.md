# Future Specs — Difficulty Feedback

Read-only assessment of the specs in `futureSpecs.md`, ranked against the current
state of the codebase. Doesn't modify that file — just notes here.

## 1. Library view

**Overall: Very High** — this isn't one feature, it's a second subsystem. Today the
app has no persistence layer at all beyond the single cookie file main.js writes to
disk, no cross-tab shared state (Downloader/Library/Options are siloed local
`useState`), and no file-versioning concept anywhere. Everything below has to be
built from zero, not extended from something that exists.

Breaking the spec into its actual sub-problems and ranking those individually
(this is the useful part for prioritizing):

| Piece | Difficulty | Why |
|---|---|---|
| Library base-directory setting (Options tab) | **Low** | Reuses the folder-picker IPC that already exists; persisting one path follows the same "write a file to userData" pattern the cookie feature already established. |
| Per-video metadata persistence (`<base>/<channel>/<title>/<epoch>/metadata.json`) | **Medium-High** | Straightforward to write, but channel names and video titles are attacker-adjacent, uncontrolled strings — need real sanitization for illegal filesystem characters, duplicate-title collisions, unicode, and Windows' path-length limit (this one bit you already once this session, worth remembering for path depth here too). |
| Library mapping function (startup scan + reusable refresh) | **Medium** | *(New in this pass.)* Bounded, well-defined problem — recursive walk of a known 3-level structure (`channel/title/epoch`), parsing each `metadata.json` into an in-memory index. The real design work isn't the walk itself, it's building it as a reusable *service* rather than a one-shot boot script: it needs to (1) run async so it never blocks the UI on startup, (2) tolerate partial/corrupt folders (an interrupted download can leave a folder with no `metadata.json` or a half-written file), and (3) be callable on demand as the "refresh" you described, not just once at launch. Directly answers the scaling question I raised in the previous pass — see note below. |
| Channel-folder browsing UI (list → mini cards → full card) | **Medium** | Mostly composition of what already exists (`VideoDetailCard` pattern is reusable). This item got *easier* with the mapping function added above — the UI just renders whatever the map produces instead of doing its own ad hoc directory reads, so it's now closer to a pure rendering problem than an I/O problem. |
| Cross-tab "add to library" wiring + auto-navigate | **Medium** | The app has zero shared state today — this needs either a lifted-state/Context layer or an event bus between tabs. Small in isolation, but it's the first time this app needs cross-component state, so it sets a pattern the rest of the feature leans on. |
| Local file playback (`<video>` pointed at a downloaded file) | **Medium-High** | Electron renderers can't just point `<video src>` at an arbitrary local path under `contextIsolation`/sandbox — needs either a registered custom protocol or an IPC-read-to-blob bridge. Real Electron-specific plumbing, not a UI problem. |
| Embedded YouTube fallback player (not-yet-downloaded case) | **Low-Medium** | A YouTube `<iframe>` embed is well-trodden, but double-check there's no CSP in place that blocks iframing youtube.com before assuming it's a 10-minute job. |
| Download-status/quality badge on cards | **Low** | Pure rendering off already-persisted metadata. |
| Burger menu shell | **Low** | The three actions inside it are where the real cost is, not the menu itself. |
| "Download different quality" (safe swap: download-as-temp → verify → delete old → rename) | **High** | This is production file-safety logic: sequencing the temp download, confirming the process actually succeeded (reusing `findFinalFile`), then delete+rename, with a rollback path if the download fails partway so the old file is never lost. Easy to get subtly wrong under interruption/failure. |
| "Download new version" (new epoch folder + version hotswap) | **Very High** | This needs a metadata schema that supports *multiple* versions per video (not just one), plus UI to swap the active version and hot-reload the card without a full remount. This is the most architecturally open-ended piece in the whole spec. |
| "Delete video entry" | **Low-Medium** | Simple recursive delete, but needs a guard rail so it can only ever delete inside the configured library base directory — worth treating as a real safety check, not a one-liner. |
| Channel-based vs. video-based view toggle *(you already deferred this)* | **Medium** | Agree with deferring — it's a second navigation model on top of the first, not worth building until the first is proven out. |
| Rudimentary version control *(you already deferred this)* | **Very High** | Correctly identified as the hardest part — it's the same problem as "Download new version" above, generalized. Good instinct putting both of your "leave for the end" items on exactly the two hardest sub-problems here. |

**Suggested build order**, following the dependency you already called out (add-to-library
depends on the library tab existing): base-directory setting → metadata persistence →
mapping function → browsing UI (single-version only) → add-to-library wiring → status
badges → local/YouTube playback → delete → safe quality-swap → new-version/hotswap → the
two deferred items last, exactly where you already put them. The mapping function slots in
right after persistence and before the UI, since browsing now depends on it rather than
reading the filesystem directly.

**On your open question** (files vs. something else for metadata): given this project has
zero infra for a database today and archival/portability is a stated goal, one JSON file
per video-folder is a reasonable call — no new dependency, human-readable, greppable, and
trivially portable if someone copies the folder tree elsewhere. In the previous pass I
flagged that this only gets expensive if you ever need to *query* across videos, since a
flat per-folder JSON store means scanning the whole tree every time — the mapping function
you just added is exactly the fix for that (scan once, keep an in-memory index, refresh on
demand instead of on every read), so that concern is already covered as long as the rest of
the UI is built to consume the map rather than re-reading the filesystem on its own. The
one thing worth deciding when you get there: whether the mapping function's output also
gets persisted to a single cache file (e.g. `<base>/.index.json`) so a very large library
doesn't have to re-walk and re-parse every folder's `metadata.json` on every app launch —
not needed at small scale, but cheap to build in now versus retrofitting later.

## 2. yt-dlp updater

**Overall: Very High** — and this one is worth flagging as a design conversation before
implementation, not just a build task. The reason is a direct conflict with a decision this
project already made and tested on both platforms: yt-dlp isn't a live dependency the app
calls out to, it's a frozen PyInstaller onedir binary built at package time by
`build-ytdlp-bin.mjs` and shipped inside the app bundle. There's no pip/Python runtime on
the end user's machine to point an "update" at.

The check-for-update half is easy — ping yt-dlp's GitHub releases API and compare against
the bundled version, show a dialog. The *actually updating* half runs into one of three
options, none of them free:

- **Download yt-dlp's official prebuilt release binary and swap it in at runtime.** This
  re-introduces the exact problem TD-002 already fixed and closed — yt-dlp's official
  releases are PyInstaller `--onefile` builds, which is what caused the ~15s Gatekeeper-scan
  delay this project moved away from on purpose. Reversing that for the sake of live updates
  would trade one solved problem for another.
- **Re-run the onedir freeze on the user's machine.** Not viable — it needs Python, pip, and
  PyInstaller present, which is precisely what the original "make it shippable" work was
  trying to avoid requiring on end-user machines in the first place.
- **Ship yt-dlp updates as full app releases via `electron-updater`.** Architecturally the
  cleanest and most consistent with what's already built, but it means yt-dlp can only update
  as often as the whole app does — which cuts against your own note that yt-dlp "updates
  constantly."

There's also a quieter structural issue underneath whichever option you pick: `ytdlp-bin` is
currently placed under `extraResources` inside the app bundle (`Contents/Resources` on
macOS, the installed `resources` dir on Windows) — a location that's not reliably writable
without elevation, especially on a `Program Files` Windows install. Any true self-update
scheme needs the binary living somewhere user-writable (e.g. copied to `userData` on first
run) before it can safely overwrite itself. That's a real restructuring of how the app locates
`ytdlpPath`, not an add-on.

I'd treat this the same way the original bundling approach was handled — worth a short,
dedicated planning pass to pick one of the three paths above deliberately, rather than
starting to code against an assumption that turns out to conflict with TD-002 or the
no-preinstall-required goal.

### Small features and corrections

| Item | Difficulty | Why |
|---|---|---|
| 1. "Base download directory" option, used as the save-dialog's suggested folder | **Low** — ✅ done | Same settings-persistence pattern already established by the cookie feature; just needs passing through as `defaultPath` on Electron's existing save dialog call. |
| 2. Filter the file selector to video files on mac/Windows | **Low** — ✅ done | Turned out to be an actual bug, not just a missing feature: `getSupportedVideoFilters()` used `for...in` on an array, which walks indices instead of values, so the filter was silently broken. Fixed alongside the rest of this pass. |
| 3. Detect existing file, ask to replace, adjust the yt-dlp request | **Medium** — ✅ done | The mechanics (an `fs.existsSync` check + a confirm dialog) are simple, but this is the actual fix for **TD-001** (`reports/TechnicalDebt.md`), now marked resolved — the code used to hardcode `--force-overwrites` with no user choice at all. Implemented as an Overwrite/Resume dialog. |
| 4. Download buttons morph into progress indicator in place, revert on error | **Medium** — ✅ done | Pure `VideoDetailCard.tsx` state-driven rendering — `useDownloadVideo` already exposes `downloadStatus`/`isDone`/`isError`, so no new backend work, just conditionally swapping what renders in the same layout slot. |
| 5. Local cache for fetched video-info, 1-week TTL | **Low-Medium** — ✅ done | This is one of the easiest items in the whole spec — it's the exact same "write a JSON file to `userData`" pattern already used three times now (cookies, settings, and the overwrite work above), wrapped around the existing `getVideoInfoPython` handler with a plain epoch comparison for the TTL. Two things worth deciding, neither a blocker: (1) **cache key** — keying by the raw input URL is simplest, but different URL forms for the same video (`youtu.be/...` vs `youtube.com/watch?v=...`, extra `&t=`/playlist params) won't match each other and will just cause a harmless re-fetch, not incorrect data; keying by yt-dlp's own extracted `info.id` after the first fetch would be more robust but needs a small URL→id lookup layer on top. Fine to ship with raw-URL keying first and revisit only if it turns out to matter in practice. (2) **Unbounded growth** — expired entries are naturally overwritten on their next real fetch, but entries for URLs you never revisit just sit in the file forever; worth a periodic prune-expired-entries pass eventually, not needed for a first version. Also directly helps the thing you called out — fewer live yt-dlp calls during your own repeated testing means less chance of tripping YouTube's bot detection again. |

### Nice to haves

| Item | Difficulty | Why |
|---|---|---|
| 1. Resume a failed download instead of restarting from scratch | **Medium** | Good instinct — yt-dlp already resumes partial downloads by default (via `.part` files + range requests) when given the same output path, so the yt-dlp-level mechanics are essentially free. The catch: this app's current `--force-overwrites` flag (the same TD-001 flag from small-feature #3 above) unconditionally wipes any partial file before yt-dlp gets a chance to resume it — so today, resume can't actually be working even though yt-dlp supports it natively. This item, small-feature #3, and TD-001 are the same underlying flag; worth solving all three together in one pass instead of three separate times. |
