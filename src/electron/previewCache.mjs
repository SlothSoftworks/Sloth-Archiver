import fs from 'fs';
import path from 'path';

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

// Chromium's native <video> element's own decodable set -- deliberately the
// same codecs LibraryVideoPlayer's PLAYABLE_VIDEO_EXTENSIONS comment already
// documents as reliable. A remux (just a container swap, no re-encoding) is
// only valid when every stream's codec is already in this set; anything else
// needs a real re-encode to preview at all.
const CHROMIUM_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const CHROMIUM_AUDIO_CODECS = new Set(['aac', 'opus', 'vorbis', 'mp3']);

function isChromiumCompatible(streams) {
    const video = streams.find((s) => s.codecType === 'video');
    const audio = streams.find((s) => s.codecType === 'audio');
    return (!video || CHROMIUM_VIDEO_CODECS.has(video.codecName))
        && (!audio || CHROMIUM_AUDIO_CODECS.has(audio.codecName));
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
export async function ensurePlayablePreview({ filePath, ffmpegRunner, onProgress = () => {} }) {
    const previewPath = previewCachePathFor(filePath);

    let sourceStat;
    try {
        sourceStat = fs.statSync(filePath);
    } catch {
        return { success: false, message: 'Source file could not be found.' };
    }

    if (fs.existsSync(previewPath)) {
        const cacheStat = fs.statSync(previewPath);
        if (cacheStat.mtimeMs >= sourceStat.mtimeMs) {
            return { success: true, previewPath, generated: false };
        }
    }

    let streams;
    try {
        streams = await ffmpegRunner.probeMediaStreams(filePath);
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
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
    const codecArgs = isChromiumCompatible(streams)
        ? ['-c', 'copy', '-movflags', '+faststart']
        : ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'];

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
