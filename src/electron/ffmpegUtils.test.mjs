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
      // Packet-level csv=p=0 output shape: "pts_time,flags" per line, "K_"
      // for a keyframe packet -- see findLastKeyframeAtOrBefore's own
      // comment for why this is packet-, not frame-, level.
      respondAsync(proc, { stdout: keyframeTimes.map((t) => `${t},K_\n`).join('') });
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

  // Regression test for a real hang: a keyframe lookup that scans from the
  // start of the file (a plain "%<atSeconds>" read_intervals with an
  // implicit start of 0) forces a full decode of everything up to atSeconds
  // whenever a file's frame-level metadata can't be trusted to skip
  // non-keyframes (confirmed against a real ~67-minute library file where
  // -show_frames's own key_frame field reported false for every frame, and
  // -skip_frame nokey silently skipped nothing) -- for a clip an hour into a
  // long recording, that's a multi-minute-or-longer freeze before ffmpeg
  // itself ever even starts. The fix bounds the probe to a fixed window
  // immediately before the requested point (a real seek, not a scan from
  // zero) using packet-level flags instead of frame-level metadata.
  it('bounds the keyframe probe to a fixed window before the requested point, not a scan from the start of the file', async () => {
    stubSpawn({ keyframeTimes: [3536.5], streams: [{ codecType: 'video', codecName: 'av1' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    // An hour into a long file -- the exact shape of the real bug report.
    await clipAndConvert({
      inputPath: '/in.mp4', outputPath: '/out.mp4', start: '00:58:57', startSeconds: 3537,
      format: 'source', totalDurationSeconds: 44,
    });

    const probeCall = spawnMock.mock.calls.find(([bin, args]) => bin === FFPROBE_BIN && args.includes('-read_intervals'));
    expect(probeCall).toBeDefined();
    const [, probeArgs] = probeCall;
    // Uses packet-level flags, not frame-level metadata (see this test's own
    // comment for why the latter can't be trusted).
    expect(probeArgs).toEqual(expect.arrayContaining(['-show_packets']));
    expect(probeArgs).not.toEqual(expect.arrayContaining(['-show_frames', '-skip_frame']));
    // The interval's start must not be 0/omitted (a scan from the beginning
    // of the file) -- it has to be a bounded window ending at the requested
    // point, close to it, regardless of how deep into the file that point is.
    const interval = probeArgs[probeArgs.indexOf('-read_intervals') + 1];
    const [intervalStart, intervalEnd] = interval.split('%').map(Number);
    expect(intervalEnd).toBe(3537);
    expect(intervalStart).toBeGreaterThan(3000);
    // Negligible real offset (3537 - 3536.5 = 0.5s) -- stays on the fast copy
    // path, exactly as it should once the probe itself is fast and correct.
    expect(ffmpegCallArgs()).toEqual(expect.arrayContaining(['-c', 'copy']));
  });

  // The keyframe-risk check is video-only (findLastKeyframeAtOrBefore
  // selects only the video stream) -- on an audio-only source it would find
  // no packets and fall back to the probe window's own start, reading as a
  // large, near-guaranteed-risky offset and spuriously forcing a re-encode
  // that was never needed. clipAndConvert must skip the risk check entirely
  // (and never even issue the -read_intervals keyframe probe) once
  // probeMediaStreams reports no video stream, regardless of how large an
  // offset that fallback would otherwise compute.
  it('skips the keyframe-risk probe entirely and stays on the fast copy path for an audio-only clip', async () => {
    stubSpawn({ streams: [{ codecType: 'audio', codecName: 'mp3' }] });
    const { clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath: FFMPEG_BIN, ffprobeBinaryPath: FFPROBE_BIN });

    // A short clip deep into the file -- exactly the shape that would trip
    // both risk thresholds for a video file, per the fallback-to-window-start
    // behavior findLastKeyframeAtOrBefore has when it finds no packets.
    await clipAndConvert({
      inputPath: '/in.mp3', outputPath: '/out.mp3', start: '00:10:00', startSeconds: 600,
      format: 'source', totalDurationSeconds: 12,
    });

    expect(spawnMock.mock.calls.some(([bin, args]) => bin === FFPROBE_BIN && args.includes('-read_intervals'))).toBe(false);
    expect(ffmpegCallArgs()).toEqual(expect.arrayContaining(['-c', 'copy']));
  });
});
