import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const FFMPEG_BIN = '/fake/ffmpeg';
const FFPROBE_BIN = '/fake/ffprobe';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args) => spawnMock(...args) }));

const { createFfmpegRunner } = await import('./ffmpegUtils.mjs');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

// Resolves a fake child process on the next microtask, same shape every
// ffmpegUtils.mjs spawn call already expects: optional stdout payload, then
// a close event with the given exit code.
function respondAsync(proc, { stdout = '', code = 0 } = {}) {
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', code);
  });
}

// Feeds fixed, scenario-specific responses for each of the three distinct
// subprocess calls clipAndConvert can make (keyframe lookup, codec probe,
// the real trim/re-encode) -- discriminated by binary path and, for
// ffprobe, by which flag identifies the call, mirroring the exact args
// ffmpegUtils.mjs itself builds.
function stubSpawn({ keyframeTimes = [], streams = [] } = {}) {
  spawnMock.mockImplementation((bin, args) => {
    const proc = fakeProcess();
    if (bin === FFPROBE_BIN && args.includes('-read_intervals')) {
      respondAsync(proc, { stdout: keyframeTimes.map((t) => `${t}\n`).join('') });
    } else if (bin === FFPROBE_BIN && args.includes('-show_streams')) {
      respondAsync(proc, { stdout: JSON.stringify({ streams: streams.map((s) => ({ codec_type: s.codecType, codec_name: s.codecName })) }) });
    } else {
      // The actual trim/re-encode ffmpeg invocation -- always "succeeds"
      // here since these tests are about which codecArgs get chosen, not
      // ffmpeg's own success/failure handling (already covered elsewhere).
      respondAsync(proc, { code: 0 });
    }
    return proc;
  });
}

function ffmpegCallArgs() {
  const call = spawnMock.mock.calls.find(([bin]) => bin === FFMPEG_BIN);
  return call ? call[1] : undefined;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('clipAndConvert', () => {
  it('stream-copies (fast path) when the keyframe rounding error is negligible relative to the clip length', async () => {
    // 10-minute clip, nearest keyframe just 2s before the requested start --
    // 2/600 is nowhere near either risk threshold.
    stubSpawn({ keyframeTimes: [598], streams: [{ codecType: 'video', codecName: 'h264' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    await clipAndConvert({
      inputPath: '/in.mp4', outputPath: '/out.mp4', start: '00:10:00', startSeconds: 600,
      format: 'source', totalDurationSeconds: 600,
    });

    expect(ffmpegCallArgs()).toEqual(expect.arrayContaining(['-c', 'copy']));
    expect(ffmpegCallArgs()).not.toEqual(expect.arrayContaining(['-c:v']));
  });

  it('auto-upgrades to a re-encode when the keyframe rounding error would eat a large fraction of a short clip', async () => {
    // 12-second clip, nearest keyframe 8s before the requested start -- 8/12
    // is a large majority of the clip.
    stubSpawn({ keyframeTimes: [2], streams: [{ codecType: 'video', codecName: 'h264' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    await clipAndConvert({
      inputPath: '/in.mp4', outputPath: '/out.mp4', start: '00:00:10', startSeconds: 10,
      format: 'source', totalDurationSeconds: 12,
    });

    expect(ffmpegCallArgs()).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac']));
    expect(ffmpegCallArgs()).not.toEqual(expect.arrayContaining(['-c', 'copy']));
  });

  it('matches the source codec (not a fixed default) when auto-upgrading a "same as source" VP9 clip', async () => {
    stubSpawn({ keyframeTimes: [2], streams: [{ codecType: 'video', codecName: 'vp9' }, { codecType: 'audio', codecName: 'opus' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    await clipAndConvert({
      inputPath: '/in.webm', outputPath: '/out.webm', start: '00:00:10', startSeconds: 10,
      format: 'source', totalDurationSeconds: 12,
    });

    expect(ffmpegCallArgs()).toEqual(expect.arrayContaining(['-c:v', 'libvpx-vp9', '-c:a', 'libopus']));
  });

  it('goes straight to the format-specific re-encode (skipping the copy attempt) when auto-upgrading a format conversion', async () => {
    stubSpawn({ keyframeTimes: [2], streams: [{ codecType: 'video', codecName: 'h264' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    await clipAndConvert({
      inputPath: '/in.mp4', outputPath: '/out.webm', start: '00:00:10', startSeconds: 10,
      format: 'webm', totalDurationSeconds: 12,
    });

    const ffmpegCalls = spawnMock.mock.calls.filter(([bin]) => bin === FFMPEG_BIN);
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0][1]).toEqual(expect.arrayContaining(['-c:v', 'libvpx-vp9', '-c:a', 'libopus']));
  });

  it('never probes for keyframe risk when forceReencode is already set', async () => {
    stubSpawn({ keyframeTimes: [598], streams: [{ codecType: 'video', codecName: 'h264' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    await clipAndConvert({
      inputPath: '/in.mp4', outputPath: '/out.mp4', start: '00:10:00', startSeconds: 600,
      format: 'source', totalDurationSeconds: 600, forceReencode: true,
    });

    expect(spawnMock.mock.calls.some(([bin, args]) => bin === FFPROBE_BIN && args.includes('-read_intervals'))).toBe(false);
    expect(ffmpegCallArgs()).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac']));
  });

  it('skips the risk check entirely when startSeconds is not provided (backward-compatible callers)', async () => {
    stubSpawn({ keyframeTimes: [2], streams: [{ codecType: 'video', codecName: 'h264' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    await clipAndConvert({
      inputPath: '/in.mp4', outputPath: '/out.mp4', start: '00:00:10',
      format: 'source', totalDurationSeconds: 12,
    });

    expect(spawnMock.mock.calls.some(([bin, args]) => bin === FFPROBE_BIN && args.includes('-read_intervals'))).toBe(false);
    expect(ffmpegCallArgs()).toEqual(expect.arrayContaining(['-c', 'copy']));
  });
});
