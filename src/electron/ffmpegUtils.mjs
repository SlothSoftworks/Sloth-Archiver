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
export function createFfmpegRunner({ ffmpegBinaryPath, ffprobeBinaryPath, onLog, isDev = false }) {
    function getMediaDurationSeconds(filePath) {
        return new Promise((resolve, reject) => {
            onLog?.(`[ffmpeg] probing duration: ${filePath}`);
            const proc = spawn(ffprobeBinaryPath, ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            proc.on('error', (err) => {
                onLog?.(`[ffmpeg] ffprobe failed to start for ${filePath}: ${err.message}`);
                reject(err);
            });
            proc.on('close', (code) => {
                if (code !== 0) {
                    onLog?.(`[ffmpeg] ffprobe exited with code ${code} for ${filePath}: ${stderr}`);
                    reject(new Error(stderr || `ffprobe exited with code ${code}`));
                    return;
                }
                try {
                    const duration = parseFloat(JSON.parse(stdout).format.duration);
                    resolve(Number.isFinite(duration) ? duration : 0);
                } catch {
                    onLog?.(`[ffmpeg] failed to parse ffprobe output for ${filePath}`);
                    reject(new Error('Failed to parse ffprobe output'));
                }
            });
        });
    }

    // Bypasses yt-dlp's own postprocessing entirely: its postprocessing
    // subprocess only reads output after the process exits, so it can never
    // report real progress; spawning ffmpeg ourselves with -progress pipe:1
    // gives a genuine, continuous percentage.
    function runFfmpegWithProgress({ inputPath, outputPath, codecArgs, totalDurationSeconds, onProgress, extraInputArgs = [], preInputArgs = [] }) {
        return new Promise((resolve, reject) => {
            const args = [...preInputArgs, '-i', inputPath, ...extraInputArgs, ...codecArgs, '-progress', 'pipe:1', '-y', outputPath];
            onLog?.(`[ffmpeg] running: ${ffmpegBinaryPath} ${args.join(' ')}`);
            const proc = spawn(ffmpegBinaryPath, args);
            let stderr = '';
            let buffer = '';
            let lastDevProgressLogAt = 0;
            const DEV_PROGRESS_LOG_INTERVAL_MS = 30 * 1000;

            proc.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    const match = line.match(/^out_time_us=(\d+)/);
                    if (match && totalDurationSeconds > 0) {
                        const percent = Math.min(100, (Number(match[1]) / (totalDurationSeconds * 1_000_000)) * 100);
                        onProgress?.(percent);
                        // Same rationale as main.mjs's own download-progress
                        // throttle: -progress pipe:1 emits several lines per
                        // second, dev-only and sampled to keep main.log readable.
                        if (isDev && Date.now() - lastDevProgressLogAt >= DEV_PROGRESS_LOG_INTERVAL_MS) {
                            lastDevProgressLogAt = Date.now();
                            onLog?.(`[ffmpeg] ${outputPath}: ${percent.toFixed(1)}%`);
                        }
                    }
                }
            });
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            proc.on('error', (err) => {
                onLog?.(`[ffmpeg] failed to start: ${err.message}`);
                reject(err);
            });
            proc.on('close', (code) => {
                onLog?.(`[ffmpeg] exited with code ${code}: ${outputPath}`);
                if (code !== 0) {
                    onLog?.(`[ffmpeg] stderr for ${outputPath}: ${stderr}`);
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
    //
    // forceReencode skips the remux attempt entirely. A remux is a container
    // swap only -- it happily "succeeds" whenever the target container is
    // capable of holding whatever codec the source already used, even if
    // that's not the codec the format nominally implies (e.g. WebM's spec
    // now also permits AV1 alongside VP8/VP9, so remuxing an AV1 source into
    // .webm succeeds and silently produces an AV1-in-WebM file instead of the
    // VP9 a "convert to WebM" request actually implies). The Library view's
    // user-invoked "Convert to"/clip-convert features pass forceReencode:true
    // so their output's *codec*, not just its container, always matches what
    // was actually requested; the download-time postprocess step (fresh from
    // yt-dlp, not a user "convert" action) keeps the default remux-first
    // behavior, since forcing a re-encode on every single download would be a
    // real, unwanted performance/quality cost for no benefit in that case.
    async function convertWithFallback({ inputPath, outputPath, format, totalDurationSeconds, onProgress, forceReencode = false }) {
        // WebM is spec'd to hold VP8/VP9/AV1 video + Vorbis/Opus audio --
        // falling back to libx264/aac universally would produce a file
        // labeled .webm that isn't actually valid WebM. VP9 (not AV1) is the
        // one actually meant by "convert to WebM" here, matching what sites
        // that only claim VP8/VP9 support expect.
        const reencodeCodecArgs = (format || '').toLowerCase() === 'webm'
            ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']
            : ['-c:v', 'libx264', '-c:a', 'aac'];
        if (forceReencode) {
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: reencodeCodecArgs, totalDurationSeconds, onProgress });
            return;
        }
        try {
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: ['-c', 'copy'], totalDurationSeconds, onProgress });
        } catch (err) {
            onLog?.(`[ffmpeg] remux failed for ${outputPath}, falling back to re-encode: ${err instanceof Error ? err.message : String(err)}`);
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: reencodeCodecArgs, totalDurationSeconds, onProgress });
        }
    }

    // ffmpeg's -version output starts with a single banner line like
    // "ffmpeg version 7.0.2 Copyright (c) 2000-2024 the FFmpeg developers" --
    // this pulls out just the version token, same idea as
    // updater.mjs's getCurrentYtdlpVersion for the yt-dlp binary. Used by the
    // About dialog (MainPage.tsx) so a bug report can name the exact bundled
    // build, not just "ffmpeg" with no version.
    function getFfmpegVersion() {
        return new Promise((resolve) => {
            const proc = spawn(ffmpegBinaryPath, ['-version']);
            let stdout = '';
            proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            proc.on('error', () => resolve(null));
            proc.on('close', () => {
                const match = stdout.match(/^ffmpeg version (\S+)/m);
                resolve(match ? match[1] : null);
            });
        });
    }

    // Per-stream codec info (not just container/duration) -- used by
    // previewCache.mjs to decide whether a non-native file's video/audio
    // codecs are already Chromium-compatible (a fast remux suffices) or need
    // a real re-encode to preview. Normalizes ffprobe's snake_case fields to
    // this codebase's own camelCase convention, same as reshapeVideoInfo does
    // for yt-dlp's raw JSON elsewhere.
    function probeMediaStreams(filePath) {
        return new Promise((resolve, reject) => {
            const proc = spawn(ffprobeBinaryPath, ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath]);
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
                    const streams = JSON.parse(stdout).streams || [];
                    resolve(streams.map((s) => ({ codecType: s.codec_type, codecName: s.codec_name })));
                } catch {
                    reject(new Error('Failed to parse ffprobe stream output'));
                }
            });
        });
    }

    // How far before the requested point to look for a keyframe. Bounds the
    // probe to a fixed-size window regardless of how deep into the file
    // `atSeconds` is -- see this function's own comment for why that matters.
    // Real downloaded content's actual keyframe intervals, confirmed via
    // packet-level inspection of real library files, run anywhere from ~2s up
    // past 10s; this is a deliberately generous multiple of that.
    const KEYFRAME_SEARCH_WINDOW_SECONDS = 30;

    // Finds the last keyframe at or before `atSeconds` -- -ss before -i (see
    // clipAndConvert's own comment) can only ever start a stream-copied clip
    // there, never exactly on the requested timestamp.
    //
    // Uses -show_packets (container-level packet flags), not -show_frames --
    // confirmed directly against a real library file where -show_frames's own
    // key_frame field reported false for every single frame (including ones
    // -show_packets correctly flagged as keyframes at the exact same
    // timestamp), and -skip_frame nokey silently failed to skip anything
    // alongside it. The practical effect: what was meant to be a cheap
    // keyframe-only scan instead force-decoded every single frame from
    // wherever it started, undetected until this bug -- a real, working
    // MP4 file, one hour into which was catastrophically slow to probe this
    // way (still hadn't finished a small fraction of the way through after
    // two minutes). Packet-level flags need no decoding at all (confirmed:
    // ~0.1s for a bounded window on that same file, ~1.25s to scan its
    // entire ~944-keyframe, 67-minute length), and reflect what the demuxer
    // itself will actually use to seek, unlike frame-level metadata that can
    // apparently misreport for a given file/stream.
    //
    // -read_intervals bounds the read to [atSeconds - KEYFRAME_SEARCH_WINDOW_SECONDS,
    // atSeconds] -- a real seek to the window's start (not a scan from the
    // start of the file), so this stays fast and O(window size), not
    // O(how deep into the file atSeconds is). Resolves the window's own
    // start (not 0) when no keyframe is found in it or the probe errors --
    // callers treat that as "at least this much offset," a safe
    // underestimate-never, not "assume no risk."
    function findLastKeyframeAtOrBefore(inputPath, atSeconds) {
        return new Promise((resolve) => {
            const windowStart = Math.max(0, atSeconds - KEYFRAME_SEARCH_WINDOW_SECONDS);
            const proc = spawn(ffprobeBinaryPath, [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_packets',
                '-show_entries', 'packet=pts_time,flags',
                '-read_intervals', `${windowStart}%${atSeconds}`,
                '-of', 'csv=p=0',
                inputPath,
            ]);
            let stdout = '';
            proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            // Drained and discarded, never left unread -- an unread stderr
            // pipe fills and blocks the child process from making further
            // progress at all once full (a real Node child_process footgun),
            // not just a leak. -v error should keep this stream near-empty
            // regardless, but that's not a reason to skip draining it.
            proc.stderr.on('data', () => {});
            proc.on('error', () => resolve(windowStart));
            proc.on('close', () => {
                let last = NaN;
                for (const line of stdout.trim().split('\n')) {
                    const [ptsTimeStr, flags] = line.split(',');
                    if (!flags || !flags.startsWith('K')) continue;
                    const t = parseFloat(ptsTimeStr);
                    if (Number.isFinite(t)) last = t;
                }
                resolve(Number.isFinite(last) ? last : windowStart);
            });
        });
    }

    // Below this fraction of the clip's own length, or this many seconds in
    // absolute terms, a keyframe-rounded start is a rounding error nobody
    // will notice (a 2s-early start on a 10-minute clip is 0.3% of it).
    // Above it, a real, perceptible chunk of what the user asked for would
    // be missing (that same 2s on a 3-second clip is 65% of it) -- these
    // numbers aren't tuned against real user reports, just chosen to
    // separate those two cases by a wide margin.
    const KEYFRAME_RISK_RATIO_THRESHOLD = 0.1;
    const KEYFRAME_RISK_ABSOLUTE_FLOOR_SECONDS = 0.5;

    async function isKeyframeRoundingRisky(inputPath, startSeconds, totalDurationSeconds) {
        if (!(totalDurationSeconds > 0)) return false;
        const keyframeBefore = await findLastKeyframeAtOrBefore(inputPath, startSeconds);
        const offset = Math.max(0, startSeconds - keyframeBefore);
        return offset > KEYFRAME_RISK_ABSOLUTE_FLOOR_SECONDS
            && (offset / totalDurationSeconds) > KEYFRAME_RISK_RATIO_THRESHOLD;
    }

    // "Same as source" (format 'source') means don't change the codec, only
    // stop stream-copying -- so when a keyframe-risk re-encode is needed
    // there, it still has to re-encode into *something* resembling the
    // source rather than a fixed target. Only VP8/VP9 (-> WebM's own codecs)
    // is special-cased, matching convertWithFallback/the reencodeCodecArgs
    // below -- anything else (including codecs this bundled ffmpeg can't
    // encode) falls back to the same libx264/aac default those use, which is
    // already correct for the overwhelmingly common case (yt-dlp downloads
    // are forced to --merge-output-format mp4, i.e. already h264/aac).
    async function reencodeCodecArgsMatchingSource(inputPath) {
        const streams = await probeMediaStreams(inputPath).catch(() => []);
        const isVp8or9 = streams.some((s) => s.codecType === 'video' && /^vp[89]$/.test(s.codecName || ''));
        return isVp8or9 ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'] : ['-c:v', 'libx264', '-c:a', 'aac'];
    }

    // Clip [start,end] and, optionally, convert format in one pass -- not a
    // trim then a separate convert (two ffmpeg invocations, two temp files).
    // 'source' (or falsy) keeps the source container: fast lossless -c copy
    // trim only, same as the plain "export a clip" flow. Any other format
    // mirrors convertWithFallback's own forceReencode option: a remux that
    // happens to succeed just keeps whatever codec the source already used,
    // which can silently produce e.g. an AV1-in-WebM clip when VP9 was
    // actually requested -- forceReencode:true skips that risk entirely by
    // going straight to a real re-encode into the target format's codec.
    //
    // -ss is placed BEFORE -i (an input-side seek), not after (output-side)
    // -- this is the fix for a well-documented ffmpeg quirk: an output-side
    // -ss combined with -c copy can't decode/re-cut the video stream, so the
    // copied video track can only start at the next keyframe *after* the
    // requested point, while the audio track (no such restriction) starts
    // exactly on time. The result is a frozen last video frame playing
    // alongside audio until the next keyframe arrives -- exactly the "first
    // few seconds have no video" symptom. Seeking on the input side instead
    // makes the demuxer jump to the keyframe *at or before* the requested
    // point, so video and audio both start together at that same boundary --
    // zero re-encoding, zero quality/frame loss, just a clip that may start
    // up to one GOP length earlier than the exact requested timestamp (the
    // standard, universally-recommended tradeoff for lossless trimming).
    // startSeconds (plain seconds, separate from the HH:MM:SS `start` string
    // ffmpeg itself takes) drives isKeyframeRoundingRisky below -- when that
    // tradeoff would actually cost a noticeable chunk of a short clip, this
    // skips straight to a real re-encode (frame-accurate, since re-encoding
    // decodes every frame rather than copying packets) instead of accepting
    // it, without paying that re-encode cost on the vast majority of clips
    // where the rounding error is negligible.
    // -to (an absolute output timestamp) is replaced with -t (a duration):
    // once the input has been seeked, -to's "absolute timestamp" meaning is
    // no longer relative to the original file, but -t's plain duration is
    // unambiguous regardless of where the seek landed.
    async function clipAndConvert({ inputPath, outputPath, start, startSeconds, format, totalDurationSeconds, onProgress, forceReencode = false }) {
        const preInputArgs = ['-ss', start];
        const durationArgs = ['-t', String(totalDurationSeconds)];
        const isSourceFormat = !format || format === 'source';
        // Keyframe rounding is a video-only concern (GOP/keyframe boundaries
        // don't exist for audio the same way) -- findLastKeyframeAtOrBefore
        // selects only the video stream (-select_streams v:0), so on an
        // audio-only source it finds no packets and falls back to the probe
        // window's own start, which reads as a large, near-guaranteed-risky
        // offset for any startSeconds past the window size. That spuriously
        // forces a re-encode on audio clips that never had a keyframe problem
        // to begin with, so skip the check entirely once there's no video
        // stream to be at risk.
        const hasVideoStream = (await probeMediaStreams(inputPath).catch(() => []))
            .some((s) => s.codecType === 'video');
        const risky = hasVideoStream && !forceReencode && startSeconds != null
            // Fails open toward re-encoding (slower, but always correct)
            // rather than silently trusting the fast path if the probe
            // itself errors out for some reason.
            && await isKeyframeRoundingRisky(inputPath, startSeconds, totalDurationSeconds).catch(() => true);

        if (isSourceFormat) {
            if (forceReencode || risky) {
                const sourceReencodeCodecArgs = await reencodeCodecArgsMatchingSource(inputPath);
                await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: [...durationArgs, ...sourceReencodeCodecArgs], totalDurationSeconds, onProgress, preInputArgs });
                return;
            }
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: [...durationArgs, '-c', 'copy'], totalDurationSeconds, onProgress, preInputArgs });
            return;
        }
        const reencodeCodecArgs = format.toLowerCase() === 'webm'
            ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']
            : ['-c:v', 'libx264', '-c:a', 'aac'];
        if (forceReencode || risky) {
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: [...durationArgs, ...reencodeCodecArgs], totalDurationSeconds, onProgress, preInputArgs });
            return;
        }
        try {
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: [...durationArgs, '-c', 'copy'], totalDurationSeconds, onProgress, preInputArgs });
        } catch {
            await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: [...durationArgs, ...reencodeCodecArgs], totalDurationSeconds, onProgress, preInputArgs });
        }
    }

    return { getMediaDurationSeconds, getFfmpegVersion, probeMediaStreams, runFfmpegWithProgress, convertWithFallback, clipAndConvert };
}
