import fs from 'fs';
import { spawn } from 'child_process';
import { isYouTubeUrl } from './utils/youtube.mjs';

// Matches runFfmpegWithProgress's own '-b:a 192k' for the MP3 extraction
// pass -- the estimate has to agree with what really gets encoded.
const MP3_BITRATE_KBPS = 192;

export function buildResolutions(info) {
    const seen = new Set();
    const resolutions = [];

    // Every real download is bestvideo+bestaudio merged (see
    // buildDownloadArgs), so a video-only format's filesize understates the
    // merged output -- add the best available audio-only track's size to
    // every estimate below, same as yt-dlp's own "bestaudio" pick.
    const audioFormats = (info.formats || []).filter((fmt) => fmt.vcodec === 'none' && fmt.acodec && fmt.acodec !== 'none');
    const bestAudio = audioFormats.reduce((best, fmt) => ((fmt.abr || 0) > (best?.abr || 0) ? fmt : best), null);
    let bestAudioSize = bestAudio ? (bestAudio.filesize || bestAudio.filesize_approx) : null;
    if (!bestAudioSize && bestAudio?.abr && info.duration) {
        bestAudioSize = (bestAudio.abr * 1000 * info.duration) / 8;
    }

    for (const fmt of info.formats || []) {
        const height = fmt.height;
        if (fmt.vcodec === 'none' || !height) continue;
        if (seen.has(height)) continue;
        seen.add(height);

        let size = fmt.filesize || fmt.filesize_approx;
        // tbr is decimal kbps (per-thousand), not binary -- kilobits-to-bytes
        // is *1000/8, not *1024/8.
        if (!size && fmt.tbr && info.duration) {
            size = (fmt.tbr * 1000 * info.duration) / 8;
        }
        if (size != null && bestAudioSize) {
            size += bestAudioSize;
        }

        resolutions.push({
            resolution: String(height),
            filesizeMb: size != null ? Math.round((size / (1024 * 1024)) * 100) / 100 : null,
            ext: fmt.ext,
        });
    }

    // A real, audio-only estimate -- not a leftover clone of the smallest
    // video resolution's (video-track) byte count, which is what this used
    // to be and had nothing to do with an actual MP3's size.
    if (resolutions.length > 0) {
        const mp3Size = info.duration ? (MP3_BITRATE_KBPS * 1000 * info.duration) / 8 : null;
        resolutions.push({
            resolution: 'MP3',
            filesizeMb: mp3Size != null ? Math.round((mp3Size / (1024 * 1024)) * 100) / 100 : null,
            ext: 'mp3',
        });
    }

    return resolutions;
}

export function reshapeVideoInfo(info) {
    return {
        id: info.id,
        title: info.title,
        resolutions: buildResolutions(info),
        thumbnail: info.thumbnail,
        additionalThumbnails: info.thumbnails,
        description: info.description,
        channelId: info.channel_id,
        duration: info.duration,
        durationString: info.duration_string,
        originalUrl: info.original_url,
        categories: info.categories,
        tags: info.tags,
        releaseTimestamp: info.release_timestamp,
        uploader: info.uploader,
        uploaderId: info.uploader_id,
        uploaderUrl: info.uploader_url,
        uploadDate: info.upload_date,
        playlist: info.playlist,
        playlistIndex: info.playlist_index,
        fullTitle: info.fulltitle,
        sourceFormat: info.ext,
        language: info.language,
    };
}

// A video is effectively dead (unavailable/private/deleted/region-locked)
// even when yt-dlp exits 0 with a parseable info dict --
// --ignore-no-formats-error (below) lets that non-fatal case through rather
// than hard-failing. The remaining signal: no channel/uploader at all, since
// yt-dlp can't resolve who uploaded a video it can't actually load the page
// for.
//
// Does NOT also treat zero height-having resolutions as dead: that's the
// normal, valid shape of an audio-only source like SoundCloud, not a broken
// video. The genuinely-no-formats-at-all case is caught earlier (see the
// `info.formats.length === 0` check in fetchVideoInfo below), before this
// function even runs.
export function isDeadVideoInfo(response) {
    if (!response.channelId && !response.uploader) return true;
    return false;
}

// Matches yt-dlp's own real error strings for a genuinely dead video.
// Deliberately distinct from a bot-check failure (e.g. "Sign in to confirm
// you're not a bot"), which is a transient request-level block, not a fact
// about the video itself.
const DEAD_VIDEO_ERROR_PATTERNS = [
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

// getVideoInfoPython's main fetch always passes --ignore-no-formats-error,
// which swallows yt-dlp's real error message entirely -- exit 0, empty
// stderr, degraded JSON, whether the cause is a private/deleted video or a
// bot-check block. This makes one extra, short-lived call *without* that
// flag, purely to read yt-dlp's real error string -- only triggered on the
// already-unusual "formats came back empty" path for a YouTube URL.
function classifyDeadYouTubeVideo(url, { ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs }) {
    return new Promise((resolve) => {
        const script = spawn(ytdlpPath, ['-J', '--no-warnings', '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), ...jsRuntimeArgs(), url]);
        let stderrOutput = '';
        let settled = false;
        // Only runs on a path that already failed once, so a real dead-video
        // error should surface fast -- guards against this classification
        // call hanging the whole getVideoInfoPython response.
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            script.kill();
            resolve(false);
        }, 20000);
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(value);
        };
        script.on('error', () => finish(false));
        script.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
        script.on('close', (code) => {
            if (code === 0) {
                finish(false);
                return;
            }
            finish(DEAD_VIDEO_ERROR_PATTERNS.some((pattern) => pattern.test(stderrOutput)));
        });
    });
}

// A factory since the video-info cache needs a real on-disk path, injected
// by main.mjs (app.getPath('userData')) rather than resolved here -- same
// pattern as settings.mjs's createSettingsStore. Keyed by the raw input URL
// -- different forms for the same video (a youtu.be link vs. the canonical
// watch?v= form) won't match each other, an acceptable cache miss rather
// than a correctness problem.
export function createVideoInfoCache(videoInfoCachePath) {
    function readVideoInfoCache() {
        try {
            return JSON.parse(fs.readFileSync(videoInfoCachePath, 'utf-8'));
        } catch {
            return {};
        }
    }

    function writeVideoInfoCache(cache) {
        fs.writeFileSync(videoInfoCachePath, JSON.stringify(cache, null, 2), 'utf-8');
    }

    return { readVideoInfoCache, writeVideoInfoCache };
}

// The full getVideoInfoPython pipeline: cache check -> spawn yt-dlp -> dead-
// video classification -> reshape -> cache write. One function so main.mjs's
// IPC handler stays a thin wrapper, same shape as updater.mjs's
// performYtdlpUpdate.
export function fetchVideoInfo(url, { ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, readVideoInfoCache, writeVideoInfoCache, cacheTtlMs }) {
    const cache = readVideoInfoCache();
    const cached = cache[url];
    if (cached && Date.now() - cached.savedEpoch < cacheTtlMs) {
        // Self-healing: a dead-video response doesn't get served as valid
        // forever -- drop it and fall through to a fresh fetch.
        if (!isDeadVideoInfo(cached.response)) {
            return Promise.resolve({ success: true, data: { response: cached.response, fromCache: true } });
        }
        delete cache[url];
        writeVideoInfoCache(cache);
    }

    return new Promise((resolve, reject) => {
        // --ignore-no-formats-error matters here specifically: -J alone does
        // NOT skip format-selector resolution (only --list-formats/--simulate
        // do that), so even a pure metadata dump aborts with "Requested
        // format is not available" if the default selector doesn't match --
        // e.g. an authenticated session whose format list doesn't satisfy it.
        // Only the raw formats list is needed here, so this flag makes that
        // failure mode non-fatal.
        const script = spawn(ytdlpPath, ['-J', '--no-warnings', '--ignore-no-formats-error', '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), ...jsRuntimeArgs(), url]);
        let data = '';
        let error = '';

        script.on('error', (err) => {
            reject(new Error(`Failed to start yt-dlp: ${err.message}`));
        });

        script.stdout.on('data', (output) => {
            data += output.toString();
        });
        script.stderr.on('data', (err) => {
            error += err.toString();
        });

        script.on('close', async (code) => {
            if (code !== 0) {
                reject(new Error(error || `yt-dlp exited with code ${code}`));
            } else {
                try {
                    const info = JSON.parse(data);
                    // --ignore-no-formats-error makes yt-dlp swallow real
                    // extraction failures internally -- most commonly
                    // YouTube's bot-check with no cookies loaded -- as a
                    // degraded JSON blob (formats: [], but title/uploader
                    // still present) rather than a thrown error. A
                    // selector-mismatch (the case the flag is actually for)
                    // always leaves formats non-empty, so this only catches
                    // genuine extraction failures.
                    if (!info.formats || info.formats.length === 0) {
                        if (isYouTubeUrl(url) && await classifyDeadYouTubeVideo(url, { ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs })) {
                            reject(new Error('This video is unavailable on YouTube -- it may be private, deleted, or removed by the uploader.'));
                            return;
                        }
                        const message = isYouTubeUrl(url)
                            ? 'yt-dlp could not retrieve any downloadable formats for this video. This usually means YouTube blocked the request (e.g. "Sign in to confirm you\'re not a bot") -- load a cookie or enable "cookies from browser" in Options and try again.'
                            : 'yt-dlp could not retrieve any downloadable formats for this URL.';
                        reject(new Error(message));
                        return;
                    }
                    const response = reshapeVideoInfo(info);
                    // Reject before this gets cached or handed to a caller
                    // that would create a library folder with nothing to
                    // archive.
                    if (isDeadVideoInfo(response)) {
                        reject(new Error('No downloadable formats found for this video -- it may be unavailable, private, or region-locked.'));
                        return;
                    }
                    const freshCache = readVideoInfoCache();
                    freshCache[url] = { savedEpoch: Date.now(), response };
                    writeVideoInfoCache(freshCache);
                    resolve({ success: true, data: { response, fromCache: false } });
                } catch {
                    reject(new Error('Failed to parse video data'));
                }
            }
        });
    });
}
