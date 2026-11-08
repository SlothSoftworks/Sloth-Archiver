import fs from 'fs';
import path from 'path';
import { canPlayLive } from './livePlayback.mjs';

// A dotfile-prefixed sibling subfolder next to whichever file it's derived
// from -- same "reserved, scan-excludable name" idea as library.mjs's
// CLIPS_DIR_NAME/PLAYLISTS_DIR_NAME, just scoped one level deeper (next to
// the actual media file, not the video/library root) so it's inherently
// per-epoch (and per-clip) rather than needing to know about either concept
// itself: whatever directory currently holds the real file is where its own
// preview derivative lives too.
const PREVIEW_DIR_NAME = '.preview';

// Every generated preview is a same-named .mp4 -- the container Chromium can
// always play once the codecs inside are already compatible (the common
// case, see isChromiumCompatible below) or have been re-encoded into.
export function previewCachePathFor(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    return path.join(dir, PREVIEW_DIR_NAME, `${base}.mp4`);
}

// Chromium's native <video> element's own decodable set. A remux (just a container swap, no re-encoding) is
// only valid when every stream's codec is already in this set; anything else
// needs a real re-encode to preview at all.
const CHROMIUM_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const CHROMIUM_AUDIO_CODECS = new Set(['aac', 'opus', 'vorbis', 'mp3']);

export function isChromiumCompatible(streams) {
    const video = streams.find((s) => s.codecType === 'video');
    const audio = streams.find((s) => s.codecType === 'audio');
    return (!video || CHROMIUM_VIDEO_CODECS.has(video.codecName))
        && (!audio || CHROMIUM_AUDIO_CODECS.has(audio.codecName));
}

// Containers that play as they are once the codecs inside do. Every file is
// checked (ffprobe) first, mp4/webm included: an mp4 can hold AC-3 or DTS,
// which Chromium plays without sound and without any error. AVI, MPEG-TS,
// FLV, .mpg and WMV won't open at all, whatever they hold. Both lists, and
// the codec lists below, come from playing test clips in Electron 43 (Nov
// 2026); re-check after an Electron upgrade.
const DIRECT_PLAY_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', '3gp', 'ogv']);
const NATIVE_EXTENSIONS = new Set(['mp4', 'webm']);
const DIRECT_PLAY_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
// HEVC decodes through the OS: verified on macOS only (Windows needs the
// HEVC extension plus hardware support, Linux usually lacks it).
const DIRECT_PLAY_MAC_VIDEO_CODECS = new Set(['hevc']);
const DIRECT_PLAY_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le']);

export function canPlayFileDirectly(filePath, streams, platform = process.platform) {
    if (!DIRECT_PLAY_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase())) return false;
    const video = streams.find((s) => s.codecType === 'video');
    const audio = streams.find((s) => s.codecType === 'audio');
    if (!video) return false;
    const videoOk = DIRECT_PLAY_VIDEO_CODECS.has(video.codecName)
        || (platform === 'darwin' && DIRECT_PLAY_MAC_VIDEO_CODECS.has(video.codecName));
    return videoOk && (!audio || DIRECT_PLAY_AUDIO_CODECS.has(audio.codecName));
}

// 'direct': plays as it is. 'live': the video plays but the audio or the
// container doesn't, so it's converted while it plays (livePlayback.mjs).
// 'preview': the video itself needs converting, so a playable copy is made
// first.
export function planPlayback(filePath, streams, platform = process.platform) {
    if (canPlayFileDirectly(filePath, streams, platform)) return 'direct';
    if (canPlayLive(streams, platform)) return 'live';
    return 'preview';
}

// Every play probes the file, so repeat plays of an unchanged file reuse the
// last answer.
export function createCachedProbe(probeMediaStreams, limit = 500) {
    const cache = new Map();
    return async (filePath) => {
        const stat = fs.statSync(filePath);
        const key = `${filePath}\0${stat.size}\0${stat.mtimeMs}`;
        if (cache.has(key)) return cache.get(key);
        const streams = await probeMediaStreams(filePath);
        cache.set(key, streams);
        if (cache.size > limit) cache.delete(cache.keys().next().value);
        return streams;
    };
}

// Generates (or reuses a cached) playback-only derivative of `filePath` for
// the embedded player to preview -- never touches the original file, which
// stays exactly as downloaded. Idempotent and cheap on a cache hit: a
// previously-generated preview whose mtime is at least as new as the
// source's own is served as-is, so repeat plays don't re-invoke ffmpeg.
// Invalidation is deliberately mtime-based rather than a separate cache-key
// file -- correctly handles a re-download (swapLibraryDownload) replacing
// the source out from under an already-generated preview, since the fresh
// source file's mtime is always newer than the stale preview's.
// previewPath overrides the .preview/ sibling, for a source outside the
// library whose folder this app shouldn't write into (VidTools). Only a file
// planPlayback sends to 'preview' gets one: a 'direct' file comes back as
// its own previewPath with direct: true, and a 'live' one with whatever
// startLive returns. forcePreview skips both, for a file that failed to
// play that way. A file ffprobe can't read is left to the browser when it's
// an mp4/webm, as before every file was probed.
export async function ensurePlayablePreview({ filePath, previewPath = previewCachePathFor(filePath), ffmpegRunner, onProgress = () => {}, startLive, forcePreview = false }) {
    let sourceStat;
    try {
        sourceStat = fs.statSync(filePath);
    } catch {
        return { success: false, message: 'Source file could not be found.' };
    }

    let probeError = null;
    const streams = await ffmpegRunner.probeMediaStreams(filePath).catch((err) => { probeError = err; return null; });
    if (!forcePreview) {
        const unprobedPlan = NATIVE_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase()) ? 'direct' : 'preview';
        const plan = streams ? planPlayback(filePath, streams) : unprobedPlan;
        if (plan === 'direct') {
            return { success: true, previewPath: filePath, generated: false, direct: true };
        }
        if (plan === 'live' && startLive) {
            return { success: true, live: await startLive(filePath, streams) };
        }
    }

    if (fs.existsSync(previewPath)) {
        const cacheStat = fs.statSync(previewPath);
        if (cacheStat.mtimeMs >= sourceStat.mtimeMs) {
            return { success: true, previewPath, generated: false };
        }
    }

    if (!streams) {
        return { success: false, message: probeError instanceof Error ? probeError.message : String(probeError) };
    }

    // +faststart moves the moov atom (container index/duration metadata) to
    // the front of the file. A plain -c copy remux otherwise leaves it where
    // the source had it -- typically the end, since that's where an
    // in-progress recording/download only knows the final duration -- which
    // left Chromium unable to show a first-frame poster or get a real
    // duration until it had read the *entire* file, rendering as a black
    // frame (LibraryVideoPlayer's own <Poster> covers the main video view,
    // which has a real thumbnail; a clip has no separate poster by design,
    // so it depended on this natural first-frame render entirely). Costs
    // ffmpeg a second, fast rewrite pass; zero quality impact either way.
    // Only what Chromium can't decode is re-encoded: a forcePreview copy of a
    // file whose audio was the problem keeps its video as it is.
    const video = streams.find((s) => s.codecType === 'video');
    const codecArgs = isChromiumCompatible(streams)
        ? ['-c', 'copy', '-movflags', '+faststart']
        : [...(CHROMIUM_VIDEO_CODECS.has(video?.codecName) ? ['-c:v', 'copy'] : ['-c:v', 'libx264']), '-c:a', 'aac', '-movflags', '+faststart'];

    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    const totalDurationSeconds = await ffmpegRunner.getMediaDurationSeconds(filePath).catch(() => 0);
    try {
        await ffmpegRunner.runFfmpegWithProgress({
            inputPath: filePath,
            outputPath: previewPath,
            codecArgs,
            totalDurationSeconds,
            onProgress,
        });
    } catch (err) {
        // Never leave a partial/corrupt file behind masquerading as a valid
        // cache entry for the next play attempt.
        fs.rmSync(previewPath, { force: true });
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }

    return { success: true, previewPath, generated: true };
}
