import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { previewCachePathFor, ensurePlayablePreview, canPlayFileDirectly, planPlayback, createCachedProbe } from './previewCache.mjs';

let workDir;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-preview-test-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function fakeRunner(overrides = {}) {
  return {
    probeMediaStreams: vi.fn().mockResolvedValue([
      { codecType: 'video', codecName: 'h264' },
      { codecType: 'audio', codecName: 'aac' },
    ]),
    getMediaDurationSeconds: vi.fn().mockResolvedValue(120),
    runFfmpegWithProgress: vi.fn().mockImplementation(({ outputPath }) => {
      fs.writeFileSync(outputPath, 'fake preview bytes');
      return Promise.resolve();
    }),
    ...overrides,
  };
}

describe('previewCachePathFor', () => {
  it('places a same-named .mp4 in a .preview sibling subfolder', () => {
    const result = previewCachePathFor('/a/b/video.mkv');
    expect(result).toBe(path.join('/a/b/.preview/video.mp4'));
  });
});

describe('ensurePlayablePreview', () => {
  it('generates a fast remux (-c copy) when every stream codec is already Chromium-compatible', async () => {
    const sourcePath = path.join(workDir, 'video.avi');
    fs.writeFileSync(sourcePath, 'fake avi bytes');
    const runner = fakeRunner();

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(result).toEqual({ success: true, previewPath: previewCachePathFor(sourcePath), generated: true });
    expect(fs.existsSync(result.previewPath)).toBe(true);
    expect(runner.runFfmpegWithProgress).toHaveBeenCalledWith(expect.objectContaining({ codecArgs: ['-c', 'copy', '-movflags', '+faststart'] }));
  });

  it('writes to an explicit previewPath instead of a .preview sibling when given one', async () => {
    const sourcePath = path.join(workDir, 'src', 'video.avi');
    fs.mkdirSync(path.dirname(sourcePath));
    fs.writeFileSync(sourcePath, 'fake avi bytes');
    const previewPath = path.join(workDir, 'temp-previews', 'abc.mp4');

    const result = await ensurePlayablePreview({ filePath: sourcePath, previewPath, ffmpegRunner: fakeRunner() });

    expect(result).toEqual({ success: true, previewPath, generated: true });
    expect(fs.existsSync(previewPath)).toBe(true);
    expect(fs.existsSync(previewCachePathFor(sourcePath))).toBe(false);
    expect(fs.readdirSync(path.dirname(sourcePath))).toEqual(['video.avi']);
  });

  it('falls back to a real re-encode when a stream codec is not Chromium-compatible', async () => {
    const sourcePath = path.join(workDir, 'video.avi');
    fs.writeFileSync(sourcePath, 'fake avi bytes');
    const runner = fakeRunner({
      probeMediaStreams: vi.fn().mockResolvedValue([
        { codecType: 'video', codecName: 'mpeg4' },
        { codecType: 'audio', codecName: 'aac' },
      ]),
    });

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(result.success).toBe(true);
    expect(runner.runFfmpegWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({ codecArgs: ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'] }),
    );
  });

  it('reuses an existing preview whose mtime is at least as new as the source (cache hit)', async () => {
    const sourcePath = path.join(workDir, 'video.avi');
    fs.writeFileSync(sourcePath, 'fake avi bytes');
    const runner = fakeRunner();

    const first = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });
    expect(first.generated).toBe(true);
    runner.runFfmpegWithProgress.mockClear();

    const second = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(second).toEqual({ success: true, previewPath: first.previewPath, generated: false });
    expect(runner.runFfmpegWithProgress).not.toHaveBeenCalled();
  });

  it('regenerates when the source file is newer than a stale cached preview (e.g. after a re-download)', async () => {
    const sourcePath = path.join(workDir, 'video.avi');
    fs.writeFileSync(sourcePath, 'fake mkv bytes v1');
    const runner = fakeRunner();
    const first = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    // Simulate a re-download: a newer source file replacing the old one,
    // strictly after the stale preview's own mtime.
    const staleMtime = fs.statSync(first.previewPath).mtime;
    fs.writeFileSync(sourcePath, 'fake mkv bytes v2');
    fs.utimesSync(sourcePath, new Date(staleMtime.getTime() + 5000), new Date(staleMtime.getTime() + 5000));

    const second = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(second.generated).toBe(true);
  });

  it('returns a failure result without throwing when the source file does not exist', async () => {
    const result = await ensurePlayablePreview({ filePath: path.join(workDir, 'missing.mkv'), ffmpegRunner: fakeRunner() });
    expect(result.success).toBe(false);
  });

  it('cleans up a partial output file and returns a failure result when ffmpeg itself fails', async () => {
    const sourcePath = path.join(workDir, 'video.avi');
    fs.writeFileSync(sourcePath, 'fake avi bytes');
    const runner = fakeRunner({
      runFfmpegWithProgress: vi.fn().mockImplementation(({ outputPath }) => {
        fs.writeFileSync(outputPath, 'partial garbage');
        return Promise.reject(new Error('ffmpeg exploded'));
      }),
    });

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(result).toEqual({ success: false, message: 'ffmpeg exploded' });
    expect(fs.existsSync(previewCachePathFor(sourcePath))).toBe(false);
  });
});

describe('deciding how a file plays', () => {
  const streams = (video, audio) => [
    ...(video ? [{ codecType: 'video', codecName: video }] : []),
    ...(audio ? [{ codecType: 'audio', codecName: audio }] : []),
  ];

  it('returns the file itself, without running ffmpeg, when its codecs play', async () => {
    const sourcePath = path.join(workDir, 'video.mkv');
    fs.writeFileSync(sourcePath, 'fake mkv bytes');
    const runner = fakeRunner({ probeMediaStreams: vi.fn().mockResolvedValue(streams('vp9', 'opus')) });

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(result).toEqual({ success: true, previewPath: sourcePath, generated: false, direct: true });
    expect(runner.runFfmpegWithProgress).not.toHaveBeenCalled();
    expect(fs.existsSync(previewCachePathFor(sourcePath))).toBe(false);
  });

  it('checks an mp4 too, and returns it as it is when its codecs play', async () => {
    const sourcePath = path.join(workDir, 'video.mp4');
    fs.writeFileSync(sourcePath, 'fake mp4 bytes');
    const runner = fakeRunner();

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner, startLive: vi.fn() });

    expect(result).toEqual({ success: true, previewPath: sourcePath, generated: false, direct: true });
    expect(runner.probeMediaStreams).toHaveBeenCalledWith(sourcePath);
  });

  it('leaves an mp4 ffprobe can\'t read to the browser', async () => {
    const sourcePath = path.join(workDir, 'video.mp4');
    fs.writeFileSync(sourcePath, 'fake mp4 bytes');
    const runner = fakeRunner({ probeMediaStreams: vi.fn().mockRejectedValue(new Error('ffprobe exited with code 1')) });

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(result).toEqual({ success: true, previewPath: sourcePath, generated: false, direct: true });
  });

  it('reports why when another file can\'t be probed', async () => {
    const sourcePath = path.join(workDir, 'video.mkv');
    fs.writeFileSync(sourcePath, 'fake mkv bytes');
    const runner = fakeRunner({ probeMediaStreams: vi.fn().mockRejectedValue(new Error('ffprobe exited with code 1')) });

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(result).toEqual({ success: false, message: 'ffprobe exited with code 1' });
  });

  it.each([
    ['video.mp4', 'h264', 'ac3'],
    ['video.mkv', 'h264', 'dts'],
    ['video.avi', 'h264', 'mp3'],
  ])('plays %s with %s video and %s audio through a live conversion', async (fileName, video, audio) => {
    const sourcePath = path.join(workDir, fileName);
    fs.writeFileSync(sourcePath, 'fake bytes');
    const probed = streams(video, audio);
    const runner = fakeRunner({ probeMediaStreams: vi.fn().mockResolvedValue(probed) });
    const live = { url: 'app-live://stream/t1', mimeType: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', duration: 120 };
    const startLive = vi.fn().mockResolvedValue(live);

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner, startLive });

    expect(result).toEqual({ success: true, live });
    expect(startLive).toHaveBeenCalledWith(sourcePath, probed);
    expect(runner.runFfmpegWithProgress).not.toHaveBeenCalled();
  });

  it('still makes a copy when the video itself doesn\'t play (e.g. ProRes)', async () => {
    const sourcePath = path.join(workDir, 'video.mov');
    fs.writeFileSync(sourcePath, 'fake mov bytes');
    const runner = fakeRunner({ probeMediaStreams: vi.fn().mockResolvedValue(streams('prores', 'aac')) });
    const startLive = vi.fn();

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner, startLive });

    expect(result).toMatchObject({ success: true, previewPath: previewCachePathFor(sourcePath), generated: true });
    expect(startLive).not.toHaveBeenCalled();
    expect(runner.runFfmpegWithProgress).toHaveBeenCalledWith(expect.objectContaining({ codecArgs: ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'] }));
  });

  it('makes a copy anyway with forcePreview, keeping video that plays and converting only the audio', async () => {
    const sourcePath = path.join(workDir, 'video.mkv');
    fs.writeFileSync(sourcePath, 'fake mkv bytes');
    const runner = fakeRunner({ probeMediaStreams: vi.fn().mockResolvedValue(streams('h264', 'ac3')) });
    const startLive = vi.fn();

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner, startLive, forcePreview: true });

    expect(result).toMatchObject({ success: true, previewPath: previewCachePathFor(sourcePath), generated: true });
    expect(startLive).not.toHaveBeenCalled();
    expect(runner.runFfmpegWithProgress).toHaveBeenCalledWith(expect.objectContaining({ codecArgs: ['-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart'] }));
  });

  it.each([
    ['video.mp4', streams('h264', 'aac'), true],
    ['video.webm', streams('vp9', 'opus'), true],
    ['video.mp4', streams('h264', 'ac3'), false],
    ['video.mkv', streams('h264', 'aac'), true],
    ['video.MOV', streams('h264', 'pcm_s16le'), true],
    ['video.m4v', streams('av1', 'flac'), true],
    ['video.3gp', streams('h264', 'mp3'), true],
    ['video.ogv', streams('vp8', 'vorbis'), true],
    ['video.mkv', streams('h264', null), true],
    ['video.mkv', streams('h264', 'ac3'), false],
    ['video.mkv', streams('h264', 'dts'), false],
    ['video.mov', streams('prores', 'aac'), false],
    ['video.mkv', streams('ffv1', 'flac'), false],
    ['video.mkv', streams(null, 'aac'), false],
    ['video.avi', streams('h264', 'aac'), false],
    ['video.ts', streams('h264', 'aac'), false],
    ['video.flv', streams('h264', 'aac'), false],
  ])('%s with %j: %s', (fileName, probed, expected) => {
    expect(canPlayFileDirectly(`/x/${fileName}`, probed, 'linux')).toBe(expected);
  });

  it('plays HEVC directly only on macOS', () => {
    expect(canPlayFileDirectly('/x/video.mkv', streams('hevc', 'aac'), 'darwin')).toBe(true);
    expect(canPlayFileDirectly('/x/video.mkv', streams('hevc', 'aac'), 'win32')).toBe(false);
    expect(canPlayFileDirectly('/x/video.mkv', streams('hevc', 'aac'), 'linux')).toBe(false);
  });
});

describe('planPlayback', () => {
  const streams = (video, audio) => [
    ...(video ? [{ codecType: 'video', codecName: video }] : []),
    ...(audio ? [{ codecType: 'audio', codecName: audio }] : []),
  ];

  it.each([
    ['video.mp4', streams('h264', 'aac'), 'linux', 'direct'],
    ['video.mp4', streams('h264', 'eac3'), 'linux', 'live'],
    ['video.mkv', streams('vp9', 'truehd'), 'linux', 'live'],
    ['video.mkv', streams('av1', 'dts'), 'linux', 'live'],
    ['video.avi', streams('h264', 'mp3'), 'linux', 'live'],
    ['video.mkv', streams('hevc', 'ac3'), 'darwin', 'live'],
    ['video.mkv', streams('hevc', 'ac3'), 'win32', 'preview'],
    ['video.mkv', streams('vp8', 'ac3'), 'linux', 'preview'],
    ['video.avi', streams('mpeg4', 'mp3'), 'linux', 'preview'],
    ['video.mkv', streams(null, 'ac3'), 'linux', 'preview'],
  ])('%s with %j on %s: %s', (fileName, probed, platform, expected) => {
    expect(planPlayback(`/x/${fileName}`, probed, platform)).toBe(expected);
  });
});

describe('createCachedProbe', () => {
  it('probes an unchanged file once, and again after it changes', async () => {
    const filePath = path.join(workDir, 'video.mp4');
    fs.writeFileSync(filePath, 'v1');
    const probe = vi.fn().mockResolvedValue([{ codecType: 'video', codecName: 'h264' }]);
    const cachedProbe = createCachedProbe(probe);

    await cachedProbe(filePath);
    expect(await cachedProbe(filePath)).toEqual([{ codecType: 'video', codecName: 'h264' }]);
    expect(probe).toHaveBeenCalledTimes(1);

    fs.writeFileSync(filePath, 'version 2');
    await cachedProbe(filePath);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('doesn\'t keep a failed probe', async () => {
    const filePath = path.join(workDir, 'video.mp4');
    fs.writeFileSync(filePath, 'v1');
    const probe = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue([]);
    const cachedProbe = createCachedProbe(probe);

    await expect(cachedProbe(filePath)).rejects.toThrow('busy');
    expect(await cachedProbe(filePath)).toEqual([]);
  });
});
