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
**Status: not started — scoped in more detail below after inspecting Arroxy's actual source**

Deferred out of Phase 1/2 because it needs live adversarial testing against a moving
target (YouTube's bot-protection), not just code review.

`ErrorHandling.md` section 6 describes this at the "auth token" level in the abstract.
The original plan assumed our own equivalent lever would be simple: switch yt-dlp's
`--extractor-args youtube:player_client=...` on a `botBlock` and retry. Having read
Arroxy's actual source (a local clone, not just its own write-up of itself), the real
mechanism is bigger than that assumption, and worth documenting precisely before
deciding whether/how much of it to build:

**What Arroxy actually does (not a login — an anonymous PoToken scrape):**
- `TokenService`/`HiddenWindowTokenProvider` spawn a hidden (`show:false`) real
  `BrowserWindow` pointed at `https://www.youtube.com` as an anonymous visitor — no
  account, no credentials.
- It polls that hidden page's own client-side JS for an obfuscated global YouTube
  ships in its bundle (currently named `bevasrs.wpc` — their own code comments call a
  missing find "the canary for the scrape just broke," since the real name changes
  whenever YouTube reshuffles their JS), then calls into it via `executeJavaScript` to
  mint a **PoToken (Proof-of-Origin Token)**, bound to the anonymous session's
  `VISITOR_DATA` (also read straight off the page's `window.ytcfg`) or the target
  video ID, with its own backoff loop for a `SDF:notready` transient state.
- The minted token + visitor data get passed to yt-dlp as
  `--extractor-args "youtube:po_token=web.gvs+<token>;visitor_data=<data>"`. Tokens
  are cached for ~5 hours (within the token's real ~6h lifetime).
- **The actual 3-step ladder** (`invokeWithRetry`, not the abstract description in
  `ErrorHandling.md`): (0) mint-or-reuse-cached PoT, try. (1) if `botBlock`, force a
  fresh mint (invalidate the cache first) and retry once. (2) if still `botBlock` (or
  if the very first mint attempt threw outright — hidden window failed, scrape
  broke), drop PoT entirely and use
  `--extractor-args "youtube:player_client=default,-web,-web_safari"` — explicitly
  excluding the client variants that require a PoT — as a final, unauthenticated,
  possibly-lower-quality/availability attempt.
- Gated per-site (only YouTube sets `needsPotToken: true`) and skipped for
  playlist-enumeration probes specifically, because the accompanying `visitor_data`
  param silently caps YouTube tab pagination at 100 entries regardless of
  `--playlist-end` — a real tradeoff they hit and documented in their own code.
- Also confirmed: bandwidth throttling (`--limit-rate`) is applied only to real media
  downloads, never probes or subtitle sidecar pulls — matches `ErrorHandling.md`'s
  lesson #7 as described.

**Why this changes the scope of this phase:** the no-PoT player-client fallback (their
final step) is a small, low-maintenance change — plausibly the same one we'd already
sketched. The PoT scrape (their steps 0-1, and the actual payoff of the ladder) is a
materially bigger and more fragile piece of engineering: it means reverse-engineering
and continuously tracking an obfuscated YouTube global that can silently rename itself
on any client-side deploy, plus running and maintaining a persistent hidden
Electron window. That's a real, open-ended maintenance cost, not a one-time
implementation.

**Open decision, to resume from here:** build the full PoT-scrape mechanism (higher
potential payoff, ongoing reverse-engineering maintenance burden), or ship just the
no-PoT `player_client` fallback as a smaller, lower-risk first iteration and revisit
the PoT scrape later only if that alone proves insufficient. Not yet decided —
picking this up is the next conversation.

## Phase 4 — Backlog
**Status: not started, no immediate driver**

- Persist retry/queue state across app restarts (blocked on: the bulk queue is
  currently pure in-memory React state with no persistence layer at all).
- Expose retry attempt budget / stall timeout as user-configurable Options-tab
  settings (currently hardcoded constants in `downloadErrors.mjs`).
- Full soft-failure-vs-hard-failure phase-outcome type refactor
  (`ErrorHandling.md` section 5) — not needed yet since our download pipeline
  doesn't have an optional sub-step analogous to Arroxy's subtitle phase.
