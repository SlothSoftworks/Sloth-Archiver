# How Arroxy Handles Download Failures

This document explains how Arroxy (an Electron app that downloads video from YouTube and other
sites via `yt-dlp`, with `ffmpeg`/`ffprobe` for post-processing) handles failure across its
download pipeline. It's written to stand on its own, as a reference for designing failure-handling
in other software — not just as internal documentation.

## 1. The pipeline these failures happen inside

Every download goes through four stages:

1. **Probe** — run `yt-dlp --dump-json` to fetch metadata and available formats *before* anything
   is queued.
2. **Queue** — a scheduler with lane-based concurrency (a "normal" lane and a "priority" lane)
   holds jobs in states: `pending → running → done | error | cancelled`, plus paused variants.
3. **Download (two phases)**:
   - **Phase 1 — video+audio.** Runs with subtitles explicitly disabled
     (`--no-write-subs --no-write-auto-subs`), except in "embed" mode where subtitles are
     requested inline so yt-dlp can mux them directly.
   - **Phase 2 — subtitles**, only attempted if phase 1 succeeded *and* the user requested
     subtitle languages. Fetches subtitle files (`--skip-download --write-subs --sub-langs ...`)
     and, in embed mode, muxes them into the already-saved video with a second, independent
     `ffmpeg` invocation.
4. **Finalize** — write analytics and a persisted job record with a terminal status.

The key design idea worth borrowing: **the pipeline is a chain of independent phases, each of
which reports its own outcome**, rather than one monolithic "download" step that either fully
succeeds or fully fails. This is what makes the more nuanced failure handling below possible.

## 2. Failures are classified by *cause*, not just detected

Instead of a single generic "download failed" state, every failure gets run through a
**closed error taxonomy** built from pattern-matching the tool's stderr output:

| Kind | Meaning |
|---|---|
| `botBlock` | Site's bot-protection challenged the request (e.g. "sign in to confirm you're not a bot") |
| `ipBlock` | Source IP itself is blocked |
| `rateLimit` | HTTP 429 / too many requests |
| `ageRestricted`, `geoBlocked`, `drmProtected`, `loginRequired`, `unavailable` | Content-level permanent blockers |
| `outOfDiskSpace` | Local disk is full |
| `chunkTransferFailure` | A network chunk failed mid-transfer |
| `network` | Generic connectivity failure |
| `parse` | Tool output couldn't be parsed (e.g. malformed JSON from a probe) |
| `postprocessFailure` | The post-processing step (muxing, conversion) failed |
| `missingDependency` | A required external binary is missing |
| `unknown` | Fallback when nothing matches |

One subtlety worth calling out: the underlying tool sometimes **masks the real cause**. A full
disk during post-processing surfaces from `ffmpeg` only as a generic "Postprocessing: Conversion
failed!" message. Arroxy detects this specific case by *actively re-checking free disk space*
whenever it sees a `postprocessFailure`, and re-labels it `outOfDiskSpace` if the disk is
actually full. **Lesson: don't trust a wrapped tool's own error message as the ground truth —
verify against the real system state when the message is known to be unreliable for a specific
failure mode.**

This classification step is what everything downstream (retry policy, UI messaging, whether to
even treat it as an error at all) branches on. Nothing downstream reacts to "it failed" — it
reacts to "it failed *because of X*."

## 3. Process-level failures are handled separately from application-level failures

Below the error taxonomy, there's a separate layer handling failures of the child process itself,
since a crashed/hung/unkillable process is a different problem than "yt-dlp ran and reported an
error":

- **Spawn failure** (executable missing, permission denied): caught on the process's `error`
  event. The app then **invalidates its cached "this binary works" memo** and forces
  re-resolution of the binary path next time — so a binary that suddenly stops working (deleted,
  corrupted, permissions changed) is detected and re-resolved automatically instead of being
  retried against a binary that will never work.
- **Non-zero exit**: routed into the error taxonomy above (classify stderr → error kind).
- **Hung process**: probes (which are expected to be fast) get a hard timeout; on timeout the
  process is killed and the failure resolves as a normal `unknown` error rather than hanging the
  whole app. Long-running downloads deliberately have *no* timeout — they're expected to take a
  while, and the corresponding safety valve is user-driven cancel, not an auto-timeout.
- **Cancellation**: uses an abort signal, and the actual kill is **process-tree-aware** (kills the
  whole process group, not just the immediate child) — necessary because the tool spawns its own
  child processes (e.g. `ffmpeg`) that would otherwise be orphaned.
- **Unbounded stderr**: buffered without a hard cap, but only the *last relevant line* is ever
  surfaced to the user or used for classification — so a noisy or huge stderr stream doesn't
  balloon memory usage in a way that matters, and doesn't need to be truncated defensively.

**Lesson: "the tool exited with an error" and "the tool never behaved like a well-formed process"
are different failure classes and deserve different handling.** Bundling them into one is how you
end up retrying a permission error forever, or hanging indefinitely on a stuck subprocess.

## 4. Retry policy is keyed to the error kind, not applied uniformly

Automatic retry is **opt-in per error kind**, not a blanket "retry N times on any failure":

- **Retried automatically**: `network`, `chunkTransferFailure`, `postprocessFailure`,
  `rateLimit` — failure modes where waiting and trying again plausibly changes the outcome.
- **Never retried automatically**: `botBlock`, `ipBlock` (retrying immediately with the same
  fingerprint just escalates a soft block into a harder one — you need a *different* strategy, not
  a repeat), `outOfDiskSpace` (retrying does nothing until the human frees space), and all
  permanent content-level blockers (`unavailable`, `drmProtected`, `geoBlocked`, etc. — retrying a
  thing that will never succeed just wastes cycles and looks broken to the user).

Backoff is a **fixed escalating ladder** (30s → 60s → 120s → 300s, capping at the last step) rather
than unbounded exponential backoff, with a user-configurable attempt budget (0 = disabled). Retry
state is persisted, so a scheduled retry survives an app restart.

Critically, a retry **resumes from partial progress** (partially-downloaded temp files) instead of
restarting the whole job from scratch — the retry mechanism carries forward enough context to know
what was already done.

There's also a **manual retry path**, available whenever a job is in a failed or cancelled state.
Manual retry resets the auto-retry budget — the reasoning being that a human deciding to intervene
shouldn't inherit whatever budget the automatic system had already burned through.

**Lesson: retry is a decision, not a default.** Ask "does retrying this specific failure change
the odds of success, or does it just repeat the same doomed action" before wiring up automatic
retry, and separate "the system retrying on its own" from "a human asking for one more attempt" —
they should have independent budgets.

## 5. Not every failure should be a failure — soft failure vs. hard failure

The subtitle phase (phase 2) is the clearest example of this idea: if it fails, the job is **not**
marked failed. It's finalized as **completed**, with a separate warning flag attached
(e.g. "subtitles failed") so the user can see it, but the overall job — and the video file the user
actually wanted — is still a success. No retry is scheduled for this either, since fixing
subtitles isn't worth re-running a whole download for.

This distinction is enforced structurally, not just by convention: each phase in the pipeline
reports one of a small set of outcomes (continue / completed / **soft-failed** / hard-failed /
cancelled / paused), and only `hard-failed` propagates up as an actual failure. `soft-failed`
routes through the same code path as a clean success.

**Lesson: define, up front, which parts of a multi-step operation are "must succeed for this to
count as a failure" versus "nice to have, warn if missing."** Baking that distinction into the
phase/step outcome type (rather than deciding it ad hoc in a catch block) keeps every phase honest
about its own importance.

## 6. Domain-specific adaptive behavior: the bot-protection ladder

Because this app specifically fights an adversarial, frequently-changing anti-bot system
(YouTube's), it layers a *strategy escalation* ladder on top of the generic retry system,
specifically for `botBlock`-classified failures:

1. Attempt with a fresh auth token.
2. If blocked, mint a *new* token and retry once.
3. If still blocked, drop the token requirement entirely and force a different, less-restricted
   access path that doesn't need one (a deliberate fallback strategy, at the cost of possibly lower
   quality/availability).

This is distinct from the generic backoff retry — it's not "wait and try the same thing again,"
it's "the same approach failed, try a *structurally different* approach." The app also throttles
bandwidth on real downloads (never on cheap probe/metadata calls) as an additional anti-detection
lever, and tracks + surfaces to the user whenever the degraded fallback path was used, so a
successful-but-degraded outcome is still visible rather than silently accepted as "fine."

The tool doing the actual downloading is deliberately **not bundled into the app** and is instead
fetched at runtime from an upstream source, specifically because this category of failure (an
external platform changing its bot-protection) gets fixed upstream on a roughly weekly cadence —
far faster than the app's own release cycle could track if the tool were pinned to a bundled
version.

**Lesson: for failures caused by an external adversarial system (rate limiters, bot walls,
fingerprinting), plan for *strategy escalation*, not just retry-with-delay — and make sure your
dependency on the thing most likely to need hot fixes (the scraper/client logic) isn't locked to
your own release cadence.**

## 7. Pacing to avoid causing the failures in the first place

Beyond reacting to failures, there's a proactive cooldown: after each job in the normal
concurrency lane finishes (success *or* failure), the scheduler enforces a brief pause before
starting the next one against the same class of target. This is separate from and in addition to
the per-item retry backoff — it's pacing normal operation, not recovering from an error.

**Lesson: some failure modes (rate limits, bot detection) are best addressed by not triggering them
as often, not just by handling them well when they occur.**

## Summary table

| Failure category | Detection | Response |
|---|---|---|
| Transient network / chunk / postprocess / rate-limit | stderr pattern match | Auto-retry, fixed backoff ladder, resumes from partial progress |
| Bot wall / IP block | stderr pattern match | Strategy escalation (re-auth → fallback path), never blind retry |
| Disk full | stderr pattern match + active disk check (to unmask a misleading upstream message) | Fail fast, no retry, clear message |
| Permanent content blockers (DRM, geo, age, unavailable) | stderr pattern match | Fail fast, no retry |
| Spawn error / bad binary | process `error` event | Invalidate cached binary verdict, force re-resolution |
| Hung probe | timeout | Hard-kill after timeout window |
| Hung download | — | No timeout; relies on user cancel |
| Cancellation | abort signal | Kill whole process tree, not just the immediate child |
| Optional sub-step failure (subtitles) | phase outcome = soft-failed | Finalize as success, surface a non-blocking warning, no retry |

## Takeaways to apply to our own software

1. Classify failures by root cause before deciding how to react — never branch on "it failed,"
   branch on "it failed because of X."
2. Separate process-supervision failures (crash, hang, spawn error) from application-level
   failures (the tool ran and reported an error) — they need different handling.
3. Make retry decisions per failure kind, with an explicit allow-list of what's worth retrying,
   not a global retry-on-any-error policy.
4. Give retries the ability to resume from partial progress instead of restarting from zero.
5. Keep separate budgets/state for automatic retries versus manual (human-initiated) retries.
6. Explicitly design which failures are "soft" (degrade gracefully, still counts as success) versus
   "hard" (must fail the whole operation) — bake this into the return type of each step, not into
   ad hoc catch-block logic.
7. For adversarial external systems, plan strategy escalation (try a fundamentally different
   approach) as a distinct concept from retry-with-backoff (try the same thing again later).
8. Where a wrapped tool's error messages are known to be unreliable for a specific failure, verify
   against real system state rather than trusting the message.
9. Pace normal operations to reduce how often certain failure classes occur in the first place,
   not just how well you recover from them.
10. Don't lock a dependency that fixes itself faster than you ship to your own release cadence —
    let it be independently updatable at runtime if that mismatch is real.
