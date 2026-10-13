import { spawn as spawnProcess } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import { ERROR_KINDS, classifyDownloadError } from './downloadErrors.mjs';
import { pickChannelAvatarUrl } from './thumbnails.mjs';

export const CHANNEL_SCAN_MAX_ENTRIES = 50_000;
export const CHANNEL_SCAN_STALL_TIMEOUT_MS = 90_000;
const COUNT_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 16 * 1024;
const MAX_JSON_STDOUT_CHARS = 8 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const ENTRY_PRINT_TEMPLATE = '%(.{id,title,duration,timestamp,availability,live_status})j';

function scanError(message, kind) {
    const err = new Error(message);
    err.kind = kind;
    return err;
}

function finiteNumberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// One line of the scan's --print output. Returns null for anything that is
// not an archivable regular video: an unparseable line, an id that is not a
// YouTube video id, or a premiere/live stream that has no recording yet.
export function parseChannelEntryLine(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.id !== 'string' || !YOUTUBE_VIDEO_ID_PATTERN.test(raw.id)) return null;
    if (raw.live_status === 'is_upcoming' || raw.live_status === 'is_live') return null;
    return {
        videoId: raw.id,
        title: typeof raw.title === 'string' ? raw.title : null,
        durationSeconds: finiteNumberOrNull(raw.duration),
        approxTimestamp: finiteNumberOrNull(raw.timestamp),
        membersOnly: raw.availability === 'subscriber_only',
    };
}

// A factory for the same reason as thumbnails.mjs's createThumbnailFetchers:
// the yt-dlp spawn dependencies are injected by main.mjs, so this stays a
// plain Node module. spawn and the timeouts are injectable for tests.
export function createChannelScanner({
    ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, ytdlpSpawnEnv, onLog = () => {},
    spawn = spawnProcess,
    stallTimeoutMs = CHANNEL_SCAN_STALL_TIMEOUT_MS,
    countTimeoutMs = COUNT_TIMEOUT_MS,
    maxEntries = CHANNEL_SCAN_MAX_ENTRIES,
}) {
    function spawnYtdlp(args, url) {
        return spawn(ytdlpPath, [...args, '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), ...jsRuntimeArgs(), '--', url], { env: ytdlpSpawnEnv() });
    }

    // Runs one yt-dlp call to completion and settles exactly once. `onStdout`
    // gets raw chunks; `onClose({ code, stderr })` decides the outcome by
    // returning a value to resolve with or throwing to reject. A timer that
    // restarts on every chunk of output kills a call that has gone silent.
    function runYtdlp({ args, url, timeoutMs, onChild, onStdout, onClose }) {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawnYtdlp(args, url);
            } catch (err) {
                const classified = classifyDownloadError({ spawnError: err });
                reject(scanError(classified.message, classified.kind));
                return;
            }
            let stderr = '';
            let settled = false;
            let stalled = false;
            let timer = null;
            const armTimer = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    stalled = true;
                    child.kill('SIGKILL');
                }, timeoutMs);
            };
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            };
            armTimer();
            onChild?.(child);
            child.on('error', (err) => {
                const classified = classifyDownloadError({ spawnError: err });
                settle(reject, scanError(classified.message, classified.kind));
            });
            child.stdout.on('data', (chunk) => {
                armTimer();
                onStdout(chunk, child);
            });
            child.stderr.on('data', (chunk) => {
                armTimer();
                stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
            });
            child.on('close', (code) => {
                if (stalled) {
                    settle(reject, scanError('YouTube stopped responding while the channel was being read.', ERROR_KINDS.STALLED));
                    return;
                }
                try {
                    settle(resolve, onClose({ code, stderr }));
                } catch (err) {
                    settle(reject, err);
                }
            });
        });
    }

    function failureFrom({ code, stderr }) {
        // A null exit code means a signal ended the process: a cancel from
        // the caller (the stall timer's own kill is handled before this).
        if (code === null) return scanError('The channel scan was stopped before it finished.', ERROR_KINDS.CANCELLED);
        const classified = classifyDownloadError({ stderr, exitCode: code });
        return scanError(classified.message, classified.kind);
    }

    function runJson({ args, url, timeoutMs, onChild }) {
        let data = '';
        return runYtdlp({
            args, url, timeoutMs, onChild,
            onStdout: (chunk, child) => {
                data += chunk.toString();
                if (data.length > MAX_JSON_STDOUT_CHARS) child.kill('SIGKILL');
            },
            onClose: ({ code, stderr }) => {
                if (code !== 0) throw failureFrom({ code, stderr });
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
                    return parsed;
                } catch {
                    throw scanError('Failed to parse channel data', ERROR_KINDS.UNKNOWN);
                }
            },
        });
    }

    async function resolveChannel(videosUrl, { onChild } = {}) {
        try {
            const info = await runJson({
                args: ['-J', '--no-warnings', '--flat-playlist', '--playlist-end', '1'],
                url: videosUrl, timeoutMs: stallTimeoutMs, onChild,
            });
            const channelId = typeof info.channel_id === 'string' && YOUTUBE_CHANNEL_ID_PATTERN.test(info.channel_id) ? info.channel_id : null;
            const name = [info.channel, info.uploader].find((v) => typeof v === 'string' && v);
            // The tab's own title is "<channel> - Videos".
            const tabTitle = typeof info.title === 'string' ? info.title.replace(/ - Videos$/, '') : '';
            return { channelId, title: name || tabTitle || null, avatarUrl: pickChannelAvatarUrl(info) };
        } catch (err) {
            onLog(`[channel-scan] resolving ${videosUrl} failed -- kind=${err.kind}: ${err.message}`);
            throw err;
        }
    }

    // The channel's "UULF" playlist is its public regular uploads, the same
    // set the /videos tab lists minus members-only videos, and reports its
    // size up front. Only an estimate for a progress display, so any failure
    // is just "unknown".
    async function fetchPublicVideoCount(channelId, { onChild } = {}) {
        if (typeof channelId !== 'string' || !YOUTUBE_CHANNEL_ID_PATTERN.test(channelId)) return null;
        try {
            const info = await runJson({
                args: ['-J', '--no-warnings', '--flat-playlist', '--playlist-end', '1'],
                url: `https://www.youtube.com/playlist?list=UULF${channelId.slice(2)}`,
                timeoutMs: countTimeoutMs, onChild,
            });
            const count = info.playlist_count;
            return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : null;
        } catch (err) {
            onLog(`[channel-scan] video count for ${channelId} unavailable -- ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    async function scanVideos({ videosUrl, onEntryCount, onChild }) {
        const entries = [];
        const seenIds = new Set();
        const decoder = new StringDecoder('utf8');
        let pending = '';
        let truncated = false;

        const takeLine = (line, child) => {
            if (truncated) return;
            const entry = parseChannelEntryLine(line);
            if (!entry || seenIds.has(entry.videoId)) return;
            seenIds.add(entry.videoId);
            entries.push(entry);
            if (entries.length >= maxEntries) {
                truncated = true;
                child?.kill('SIGKILL');
            }
        };

        try {
            return await runYtdlp({
                args: [
                    '--no-warnings', '--flat-playlist', '--lazy-playlist',
                    '--extractor-args', 'youtubetab:approximate_date',
                    '--print', ENTRY_PRINT_TEMPLATE,
                ],
                url: videosUrl, timeoutMs: stallTimeoutMs, onChild,
                onStdout: (chunk, child) => {
                    pending += decoder.write(chunk);
                    const lines = pending.split('\n');
                    pending = lines.pop();
                    const before = entries.length;
                    for (const line of lines) takeLine(line, child);
                    if (entries.length !== before) onEntryCount?.(entries.length);
                },
                onClose: ({ code, stderr }) => {
                    const lastLine = pending + decoder.end();
                    pending = '';
                    if (lastLine.trim()) takeLine(lastLine, null);
                    if (truncated) return { entries, truncated };
                    // A cancel must never look like a finished (short) list.
                    if (code === null) throw failureFrom({ code, stderr });
                    // yt-dlp exits non-zero when any single entry failed even
                    // though the rest of the listing is good.
                    if (code !== 0 && entries.length === 0) throw failureFrom({ code, stderr });
                    if (code !== 0) onLog(`[channel-scan] yt-dlp exited ${code} after listing ${entries.length} videos of ${videosUrl}`);
                    return { entries, truncated };
                },
            });
        } catch (err) {
            onLog(`[channel-scan] listing ${videosUrl} failed -- kind=${err.kind}: ${err.message}`);
            throw err;
        }
    }

    return { resolveChannel, fetchPublicVideoCount, scanVideos };
}

// The channelArchive:scan sequence (resolve -> count -> list) and its cancel
// bookkeeping, kept out of main.mjs so it can be tested with a fake scanner.
// Same idea as main.mjs's download bookkeeping: a scanId -> child map plus a
// cancelled set, because a killed child still reports a normal-looking close.
export function createChannelScanSession({ scanner, sendProgress, onLog = () => {}, now = Date.now, progressIntervalMs = PROGRESS_INTERVAL_MS }) {
    const activeChildren = new Map();
    const cancelledScanIds = new Set();

    function failure(scanId, kind, message) {
        return { success: false, kind, message, cancelled: cancelledScanIds.has(scanId) };
    }

    async function scan(scanId, videosUrl) {
        if (typeof scanId !== 'string' || !scanId || activeChildren.has(scanId)) {
            return { success: false, kind: ERROR_KINDS.UNKNOWN, message: 'Invalid channel scan request.', cancelled: false };
        }
        // Registered before the first child exists so a cancel (or the
        // updater's "is anything running" check) sees the scan between stages.
        activeChildren.set(scanId, null);
        const onChild = (child) => {
            activeChildren.set(scanId, child);
            if (cancelledScanIds.has(scanId)) child.kill('SIGKILL');
        };
        const throwIfCancelled = () => {
            if (cancelledScanIds.has(scanId)) throw Object.assign(new Error('Channel scan cancelled.'), { kind: ERROR_KINDS.CANCELLED });
        };
        try {
            sendProgress({ scanId, stage: 'resolving', found: 0, total: null });
            const { channelId, title, avatarUrl } = await scanner.resolveChannel(videosUrl, { onChild });
            throwIfCancelled();

            sendProgress({ scanId, stage: 'counting', found: 0, total: null });
            const total = await scanner.fetchPublicVideoCount(channelId, { onChild });
            throwIfCancelled();

            sendProgress({ scanId, stage: 'listing', found: 0, total });
            let lastSent = now();
            const { entries, truncated } = await scanner.scanVideos({
                videosUrl,
                onChild,
                onEntryCount: (found) => {
                    if (now() - lastSent < progressIntervalMs) return;
                    lastSent = now();
                    sendProgress({ scanId, stage: 'listing', found, total });
                },
            });
            throwIfCancelled();
            sendProgress({ scanId, stage: 'listing', found: entries.length, total });
            onLog(`[channel-scan] ${videosUrl}: ${entries.length} videos${truncated ? ' (truncated)' : ''}`);
            return { success: true, channel: { id: channelId, title, url: videosUrl, avatarUrl: avatarUrl ?? null }, total, entries, truncated };
        } catch (err) {
            if (cancelledScanIds.has(scanId)) return failure(scanId, ERROR_KINDS.CANCELLED, 'Channel scan cancelled.');
            return failure(scanId, err?.kind || ERROR_KINDS.UNKNOWN, err instanceof Error ? err.message : String(err));
        } finally {
            activeChildren.delete(scanId);
            cancelledScanIds.delete(scanId);
        }
    }

    function cancel(scanId) {
        if (!activeChildren.has(scanId)) return { cancelled: false };
        cancelledScanIds.add(scanId);
        activeChildren.get(scanId)?.kill('SIGKILL');
        return { cancelled: true };
    }

    function hasActiveScans() {
        return activeChildren.size > 0;
    }

    function killAll() {
        for (const scanId of activeChildren.keys()) cancel(scanId);
    }

    return { scan, cancel, hasActiveScans, killAll };
}
