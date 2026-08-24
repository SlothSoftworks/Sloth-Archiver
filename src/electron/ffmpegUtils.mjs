import { spawn } from 'child_process';

// ffmpeg's stderr is a wall of banner/build-config/stream-metadata noise even
// on success, with the real failure cause buried in there as plain text.
// This strips the recognizable noise, then takes the *first* remaining line
// that looks like an actual error -- the first is the root cause, later
// ones tend to be consequences of it. Falls back to a generic message if
// nothing recognizable survives.
const FFMPEG_NOISE_LINE = /^(ffmpeg version|built with|configuration:|lib(avutil|avcodec|avformat|avdevice|avfilter|swscale|swresample|postproc)|Input #\d|Duration:|Stream #|Stream mapping:|Press \[q\]|frame=|size=|time=|bitrate=|speed=|\s*Metadata:$|\s*(major_brand|minor_version|compatible_brands|title|artist|date|encoder|description|handler_name|vendor_id|comment|composer|genre)\s*:)/i;
const FFMPEG_ERROR_KEYWORDS = /\b(error|invalid|cannot|could not|no such|permission denied|failed|unable|aborting|not found|no space|unknown|unrecognized)\b/i;
const FFMPEG_LINE_PREFIX = /^\[[^\]]*\]\s*/;

// Translates the handful of failure causes this app's ffmpeg invocations can
// actually hit into plain language -- the extracted root-cause line is still
// raw ffmpeg jargon otherwise. Matched against the already-extracted single
// line, so each pattern only needs to account for wording, not position.
const FFMPEG_FRIENDLY_ERRORS = [
    { pattern: /-to value smaller than -ss/i, message: 'The clip end time must be after the start time.' },
    { pattern: /permission denied/i, message: 'Permission denied while writing the output file -- check that the destination folder is writable.' },
    { pattern: /no space left on device/i, message: 'Not enough free disk space to finish this operation.' },
    { pattern: /(unknown output format|unable to find a suitable output format|unknown encoder|unknown codec)/i, message: 'This output format isn\'t supported by the bundled ffmpeg build -- try a different format.' },
    { pattern: /no such file or directory/i, message: 'A required file could not be found (it may have been moved or deleted).' },
    { pattern: /moov atom not found|invalid data found when processing input/i, message: 'The source file appears to be corrupted or incomplete.' },
];

export function summarizeFfmpegError(stderr, code) {
    const candidateLines = (stderr || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !FFMPEG_NOISE_LINE.test(line));
    const rootCause = candidateLines.find((line) => FFMPEG_ERROR_KEYWORDS.test(line));
    const message = (rootCause || candidateLines.at(-1) || '').replace(FFMPEG_LINE_PREFIX, '').trim();
    if (!message) return `ffmpeg failed to process this file (exit code ${code}).`;
    const friendly = FFMPEG_FRIENDLY_ERRORS.find(({ pattern }) => pattern.test(message));
    if (friendly) return friendly.message;
    return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

// A factory since getMediaDurationSeconds/runFfmpegWithProgress need the
// bundled ffprobe/ffmpeg binary paths -- injected by main.mjs rather than
// computed here, keeping this a pure Node module (same pattern as
// settings.mjs/cookies.mjs/thumbnails.mjs). onProgress stays a per-call
// parameter, not part of this factory: it's shared by two genuinely
// different callers (the main download pipeline's postprocess step, and the
// Library view's standalone ffmpeg utilities) that report progress over two
// different IPC channels.
export function createFfmpegRunner({ ffmpegBinaryPath, ffprobeBinaryPath }) {
    function getMediaDurationSeconds(filePath) {
        return new Promise((resolve, reject) => {
            const proc = spawn(ffprobeBinaryPath, ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            proc.on('error', reject);
            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(stderr || `ffprobe exited with code ${code}`));
                    return;
                }
                try {
                    const duration = parseFloat(JSON.parse(stdout).format.duration);
                    resolve(Number.isFinite(duration) ? duration : 0);
                } catch {
                    reject(new Error('Failed to parse ffprobe output'));
                }
            });
        });
    }

    // Bypasses yt-dlp's own postprocessing entirely (TD-004): its
    // postprocessing subprocess only reads output after the process exits,
    // so it can never report real progress; spawning ffmpeg ourselves with
    // -progress pipe:1 gives a genuine, continuous percentage.
    function runFfmpegWithProgress({ inputPath, outputPath, codecArgs, totalDurationSeconds, onProgress, extraInputArgs = [] }) {
        return new Promise((resolve, reject) => {
            const args = ['-i', inputPath, ...extraInputArgs, ...codecArgs, '-progress', 'pipe:1', '-y', outputPath];
            const proc = spawn(ffmpegBinaryPath, args);
            let stderr = '';
            let buffer = '';

            proc.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    const match = line.match(/^out_time_us=(\d+)/);
                    if (match && totalDurationSeconds > 0) {
                        const percent = Math.min(100, (Number(match[1]) / (totalDurationSeconds * 1_000_000)) * 100);
                        onProgress?.(percent);
                    }
                }
            });
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            proc.on('error', reject);
            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(summarizeFfmpegError(stderr, code)));
                } else {
                    resolve();
                }
            });
        });
    }

    // Try a fast remux first (no quality loss, just a container swap); fall
    // back to a full re-encode if the source codec isn't compatible with the
    // target container. Shared by the download-time format recode and the
    // Library view's standalone "Convert to" utility.
    async function convertWithFallback({ inputPath, outputPath, format, totalDurationSeconds, onProgress }) {
        try {
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: ['-c', 'copy'], totalDurationSeconds, onProgress });
        } catch {
            // WebM is spec'd to only hold VP8/VP9/AV1 video + Vorbis/Opus
            // audio -- falling back to libx264/aac universally would produce
            // a file labeled .webm that isn't actually valid WebM.
            const reencodeCodecArgs = (format || '').toLowerCase() === 'webm'
                ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']
                : ['-c:v', 'libx264', '-c:a', 'aac'];
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: reencodeCodecArgs, totalDurationSeconds, onProgress });
        }
    }

    return { getMediaDurationSeconds, runFfmpegWithProgress, convertWithFallback };
}
