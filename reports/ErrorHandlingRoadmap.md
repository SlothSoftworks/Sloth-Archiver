# Resilient Download Error Handling — Roadmap

Source material: [`ErrorHandling.md`](ErrorHandling.md) (analysis of how Arroxy, a
competing yt-dlp-based downloader, handles failures) and
[`TechnicalDebt.md`](TechnicalDebt.md) TD-012 (the original ask: testers see
intermittent download failures, comparable tools recover better). Re-read
`ErrorHandling.md` before picking up any phase below — this file tracks scope and
status, not the underlying reasoning.

## Phase 1 — Classification + auto-retry + stall timeout
**Status: done** (2026-08-29)

Build a shared stderr-based error classifier (`src/electron/downloadErrors.mjs`) and
wire it into `downloadVideoWithProgressUpdates` (`src/electron/main.mjs`): an
allow-list of auto-retryable error kinds, a fixed escalating backoff ladder
(30s/60s/120s/300s), and a stall timeout (no progress for N minutes — deliberately
not a fixed total-duration cap, since this app's own differentiator is handling very
long downloads). Retry is centralized in the main process so both the single-download
flow and the bulk queue share it without duplicated logic. Structured error info
(`kind`, `retryable`) threads through `DownloadProgressMessage` to both
`useDownloadVideo.tsx` and `useBulkAddQueue.tsx`, replacing the bulk queue's current
hardcoded `'Download failed.'` message.

## Phase 2 — Cancellation
**Status: done** (2026-08-29)

User-initiated cancellation, built on the same process-tracking map Phase 1 needs for
stall-timeout kills. Process-tree-aware kill (yt-dlp spawns ffmpeg as a merge
sub-child) via a new `cancelDownload(requestId)` IPC handler, exposed through
`preload.mjs`, with a cancel affordance on the single-download progress UI and each
bulk-queue item.

**Known gap**: no Windows dev environment exists for this project, so the Windows
tree-kill path (`taskkill /T /F`) needs a tester to confirm no orphaned `ffmpeg`/
`yt-dlp` processes remain after cancelling.

**Fixes from first-round manual testing (2026-08-29):**
- The Library view's download panel showed "Download failed -- try again." for a
  deliberate cancellation (indistinguishable from a real failure). `useDownloadVideo`
  now exposes a clean `downloadErrorKind`, and the Library view / Downloader tab /
  Other-platform card / bulk-add panel all show "Cancelled" instead when
  `kind === 'cancelled'`.
- The metadata-fetch (probe) stage -- `getVideoInfoPython`/`fetchVideoInfo` in
  `videoInfo.mjs` -- was never wired into the Phase 1 classifier at all, since Phase 1
  only covered the download path. In practice this is where testers hit the most
  confusing errors (e.g. an age-restricted video surfacing as the generic bot-block
  message, wrapped in Electron's own "Error invoking remote method..." prefix, with
  nothing useful in `main.log`). Fixed: the empty-formats probe re-check
  (`classifyEmptyFormatsFailure`, formerly `classifyDeadYouTubeVideo`) now runs the
  same `classifyDownloadError` taxonomy instead of a single dead-video-or-not check,
  produces a kind-specific message (`describeEmptyFormatsFailure`), and every
  info-fetch failure path now logs `kind` + message via `main.log` (threaded in as
  `onLog`, same pattern as `updater.mjs`).

## Phase 3 — YouTube bot-block strategy escalation
**Status: not started**

Deferred out of Phase 1/2 because it needs live adversarial testing against a moving
target (YouTube's bot-protection), not just code review. Per `ErrorHandling.md`
section 6: on a `botBlock` classification, escalate strategy rather than blind-retry
— attempt with a fresh auth token, mint a new token and retry once if still blocked,
then drop the token requirement entirely for a less-restricted fallback path. Also
covers: bandwidth throttling on real downloads (not probes) as an anti-detection
lever, and surfacing to the user whenever a degraded fallback path was used rather
than silently accepting it.

## Phase 4 — Backlog
**Status: not started, no immediate driver**

- Persist retry/queue state across app restarts (blocked on: the bulk queue is
  currently pure in-memory React state with no persistence layer at all).
- Expose retry attempt budget / stall timeout as user-configurable Options-tab
  settings (currently hardcoded constants in `downloadErrors.mjs`).
- Full soft-failure-vs-hard-failure phase-outcome type refactor
  (`ErrorHandling.md` section 5) — not needed yet since our download pipeline
  doesn't have an optional sub-step analogous to Arroxy's subtitle phase.
