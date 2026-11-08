import { spawn as childSpawn } from 'child_process';
import crypto from 'crypto';
import { summarizeFfmpegError } from './ffmpegUtils.mjs';

// Live conversion: for a file whose video Chromium decodes but whose audio
// (or container) it can't, ffmpeg copies the video and converts the audio to
// AAC while it plays, the way media servers do, instead of the player
// waiting for a converted copy. The output is fragmented MP4, which the
// renderer feeds to the <video> element through MediaSource
// (liveTranscodeSource.ts); a seek past what's been converted starts a new
// ffmpeg run from there. Codec strings only need to name a codec family
// Chromium's MediaSource accepts: the real profile/level comes from the
// stream itself (a Main 10 HEVC file plays declared as Main).
const LIVE_VIDEO_CODECS = { h264: 'avc1.640028', vp9: 'vp09.00.40.08', av1: 'av01.0.08M.08' };
// Same macOS-only HEVC support as canPlayFileDirectly (previewCache.mjs).
const LIVE_MAC_VIDEO_CODECS = { hevc: 'hvc1.1.6.L93.B0' };
const AAC_CODEC = 'mp4a.40.2';

const SESSION_LIMIT = 200;
const STDERR_LIMIT = 8192;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function liveVideoCodec(streams, platform) {
    const video = streams.find((s) => s.codecType === 'video');
    if (!video) return null;
    return LIVE_VIDEO_CODECS[video.codecName]
        ?? (platform === 'darwin' ? LIVE_MAC_VIDEO_CODECS[video.codecName] : undefined)
        ?? null;
}

export function canPlayLive(streams, platform = process.platform) {
    return liveVideoCodec(streams, platform) !== null;
}

export function liveMimeType(streams, platform = process.platform) {
    const codecs = [liveVideoCodec(streams, platform)];
    if (streams.some((s) => s.codecType === 'audio')) codecs.push(AAC_CODEC);
    return `video/mp4; codecs="${codecs.join(',')}"`;
}

// -copyts/-start_at_zero plus delay_moov+frag_discont keep the source's own
// timestamps in the output (the fragmented MP4 muxer otherwise restarts every
// run at 0), so a run started mid-file lands at the right place on the
// player's timeline with no offset bookkeeping. -ss before -i starts the
// copied video at the keyframe before startSeconds. Only the first video
// and audio streams are mapped: that's the audio track Chromium would have
// played anyway. Downmixed to stereo, which every output device plays.
export function buildLiveTranscodeArgs({ filePath, startSeconds, streams }) {
    const video = streams.find((s) => s.codecType === 'video');
    const seek = startSeconds > 0 ? ['-ss', startSeconds.toFixed(3)] : [];
    return [
        '-v', 'error', '-nostdin',
        ...seek, '-copyts', '-start_at_zero', '-i', filePath,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'copy', ...(video?.codecName === 'hevc' ? ['-tag:v', 'hvc1'] : []),
        '-c:a', 'aac', '-ac', '2',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov+frag_discont',
        '-frag_duration', '2000000',
        'pipe:1',
    ];
}

// Each played file gets a random token, and app-live://stream/<token>?start=
// is the only way to reach it -- the renderer never names a path, so this
// can't be used to read anything main hasn't already decided to play. Every
// request is its own ffmpeg run, killed when the renderer drops the request
// (a seek, or the player closing).
export function createLivePlayback({ ffmpegBinaryPath, onLog, spawn = childSpawn }) {
    const sessions = new Map();
    const running = new Set();

    function register(filePath, streams) {
        const token = crypto.randomUUID();
        sessions.set(token, { filePath, streams });
        if (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value);
        return token;
    }

    function handleRequest(request) {
        const url = new URL(request.url);
        const session = sessions.get(url.pathname.slice(1));
        if (!session) return new Response('Not Found', { status: 404, headers: NO_STORE_HEADERS });
        const startSeconds = Math.max(0, Number(url.searchParams.get('start')) || 0);

        const proc = spawn(ffmpegBinaryPath, buildLiveTranscodeArgs({ ...session, startSeconds }));
        running.add(proc);
        let stderr = '';
        let finished = false;
        proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT); });

        const body = new ReadableStream({
            start(controller) {
                const finish = (err) => {
                    if (finished) return;
                    finished = true;
                    running.delete(proc);
                    if (err) controller.error(err);
                    else controller.close();
                };
                // Paused once the queue is full, so ffmpeg (blocked on a
                // full pipe) only runs as far ahead as the renderer reads.
                proc.stdout.on('data', (chunk) => {
                    if (finished) return;
                    controller.enqueue(new Uint8Array(chunk));
                    if (controller.desiredSize <= 0) proc.stdout.pause();
                });
                proc.on('error', (err) => finish(err));
                proc.on('close', (code) => {
                    if (finished) return;
                    if (code === 0) {
                        finish();
                        return;
                    }
                    const message = summarizeFfmpegError(stderr, code);
                    onLog?.(`[live] ffmpeg failed for ${session.filePath} at ${startSeconds}s: ${message}`);
                    finish(new Error(message));
                });
            },
            pull() {
                proc.stdout.resume();
            },
            cancel() {
                finished = true;
                running.delete(proc);
                proc.kill('SIGKILL');
            },
        }, { highWaterMark: 16 });

        return new Response(body, {
            headers: { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*', ...NO_STORE_HEADERS },
        });
    }

    function killAll() {
        for (const proc of running) proc.kill('SIGKILL');
        running.clear();
    }

    return { register, handleRequest, killAll };
}
