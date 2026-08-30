import fs from 'fs';
import path from 'path';

// Matches yt-dlp's own real error strings for a genuinely dead video.
// Deliberately distinct from a bot-check failure (e.g. "Sign in to confirm
// you're not a bot"), which is a transient request-level block, not a fact
// about the video itself.
export const DEAD_VIDEO_ERROR_PATTERNS = [
    /private video/i,
    /video (is |has been )?(unavailable|removed|deleted)/i,
    /this video is no longer available/i,
    /video does not exist/i,
    /account associated with this video has been terminated/i,
    /removed by the uploader/i,
    /removed for violating/i,
    /copyright grounds/i,
    /content is not available/i,
    /members-only|join this channel/i,
];

// Closed taxonomy for yt-dlp download-path failures (reports/ErrorHandling.md
// section 2). Deliberately smaller than that report's own list: `ipBlock`,
// `drmProtected`, and `parse` weren't meaningfully distinct from `botBlock`/
// `network`/`unknown` for our own stderr-matching purposes -- can be split out
// later if real-world patterns show a need. `stalled` and `cancelled` are
// never pattern-matched: the caller (main.mjs) assigns them directly since
// they're detected by our own supervision, not by reading yt-dlp's stderr.
export const ERROR_KINDS = {
    BOT_BLOCK: 'botBlock',
    NETWORK: 'network',
    CHUNK_TRANSFER_FAILURE: 'chunkTransferFailure',
    RATE_LIMIT: 'rateLimit',
    AGE_RESTRICTED: 'ageRestricted',
    GEO_BLOCKED: 'geoBlocked',
    LOGIN_REQUIRED: 'loginRequired',
    UNAVAILABLE: 'unavailable',
    OUT_OF_DISK_SPACE: 'outOfDiskSpace',
    MISSING_DEPENDENCY: 'missingDependency',
    STALLED: 'stalled',
    CANCELLED: 'cancelled',
    UNKNOWN: 'unknown',
};

// Checked in order -- first match wins, so more specific patterns (bot block,
// rate limit) are listed before generic ones (network) they could otherwise
// be swallowed by.
const KIND_PATTERNS = [
    [ERROR_KINDS.BOT_BLOCK, /sign in to confirm you.?re not a bot/i],
    [ERROR_KINDS.RATE_LIMIT, /http error 429|too many requests/i],
    [ERROR_KINDS.AGE_RESTRICTED, /sign in to confirm your age|age.restricted/i],
    [ERROR_KINDS.LOGIN_REQUIRED, /login required|available for registered users only/i],
    [ERROR_KINDS.GEO_BLOCKED, /not available in your country|geo.?restrict/i],
    [ERROR_KINDS.OUT_OF_DISK_SPACE, /no space left on device/i],
    [ERROR_KINDS.CHUNK_TRANSFER_FAILURE, /fragment \d+ not found|giving up after \d+ fragment retries|did not get any data blocks/i],
    [ERROR_KINDS.UNAVAILABLE, DEAD_VIDEO_ERROR_PATTERNS],
    [ERROR_KINDS.NETWORK, /unable to download webpage|network is unreachable|getaddrinfo|econnreset|connection reset|timed out|temporary failure in name resolution/i],
];

// yt-dlp prefixes its own real error lines with "ERROR:" -- take the last one
// (most specific/final cause), same "last relevant line, not the whole noisy
// stream" idea as ffmpegUtils.mjs's summarizeFfmpegError.
function extractErrorMessage(stderr, exitCode) {
    const lines = (stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const errorLines = lines.filter((l) => /^ERROR:/i.test(l));
    const line = errorLines.at(-1) || lines.at(-1) || '';
    const message = line.replace(/^ERROR:\s*/i, '').trim();
    return message || `yt-dlp exited with code ${exitCode}`;
}

// Single entry point: classify a finished/failed download attempt into one
// error kind + a user-facing message. spawnError takes priority (the process
// never ran at all, so stderr is meaningless); otherwise pattern-match stderr.
export function classifyDownloadError({ stderr, exitCode, spawnError } = {}) {
    if (spawnError) {
        const kind = spawnError.code === 'ENOENT' ? ERROR_KINDS.MISSING_DEPENDENCY : ERROR_KINDS.UNKNOWN;
        return { kind, message: `Failed to start yt-dlp: ${spawnError.message}` };
    }
    const message = extractErrorMessage(stderr, exitCode);
    for (const [kind, pattern] of KIND_PATTERNS) {
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        if (patterns.some((p) => p.test(stderr || ''))) {
            return { kind, message };
        }
    }
    return { kind: ERROR_KINDS.UNKNOWN, message };
}

// Failure modes where waiting and trying again plausibly changes the outcome
// (reports/ErrorHandling.md section 4). Deliberately excludes botBlock --
// retrying blind against a soft block just escalates it into a harder one;
// that needs a different strategy, not a repeat (tracked as Phase 3 in
// reports/ErrorHandlingRoadmap.md, not built here).
const AUTO_RETRYABLE_KINDS = new Set([
    ERROR_KINDS.NETWORK,
    ERROR_KINDS.CHUNK_TRANSFER_FAILURE,
    ERROR_KINDS.RATE_LIMIT,
    ERROR_KINDS.STALLED,
]);

export function isAutoRetryable(kind) {
    return AUTO_RETRYABLE_KINDS.has(kind);
}

// Fixed escalating ladder, not unbounded exponential backoff (last step
// repeats once the attempt count runs past the ladder's length). Hardcoded
// starting constants, same as MAX_SIMULTANEOUS_DOWNLOADS_CEILING and similar
// values elsewhere in this app before they became user-configurable -- not
// exposed as an Options-tab setting yet (reports/ErrorHandlingRoadmap.md
// Phase 4).
export const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
export const MAX_AUTO_RETRIES = 3;

export function getBackoffMs(attempt) {
    return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
}

// yt-dlp/ffmpeg sometimes surface a full disk only as a generic failure
// message (reports/ErrorHandling.md section 2's own "don't trust the wrapped
// tool's message" lesson) -- actively re-check real free space whenever a
// failure's kind is ambiguous, and relabel it if the disk actually is full.
export async function recheckDiskSpaceIfAmbiguous(kind, outputPath) {
    if (kind !== ERROR_KINDS.UNKNOWN) return kind;
    try {
        const stats = await fs.promises.statfs(path.dirname(outputPath));
        const freeBytes = stats.bavail * stats.bsize;
        if (freeBytes < 50 * 1024 * 1024) return ERROR_KINDS.OUT_OF_DISK_SPACE;
    } catch {
        // Can't stat (e.g. the directory doesn't exist yet) -- leave the
        // original classification alone rather than guessing.
    }
    return kind;
}
