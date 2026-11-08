import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { previewCachePathFor, ensurePlayablePreview, canPlayFileDirectly } from './previewCache.mjs';

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
    runner.probeMediaStreams.mockClear();
    runner.runFfmpegWithProgress.mockClear();

    const second = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(second).toEqual({ success: true, previewPath: first.previewPath, generated: false });
    expect(runner.probeMediaStreams).not.toHaveBeenCalled();
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

describe('playing MKV/MOV/M4V/3GP/OGV as they are', () => {
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

  it('still makes a preview when the codecs inside don\'t play (e.g. Dolby audio, ProRes)', async () => {
    const sourcePath = path.join(workDir, 'video.mov');
    fs.writeFileSync(sourcePath, 'fake mov bytes');
    const runner = fakeRunner({ probeMediaStreams: vi.fn().mockResolvedValue(streams('h264', 'ac3')) });

    const result = await ensurePlayablePreview({ filePath: sourcePath, ffmpegRunner: runner });

    expect(result).toMatchObject({ success: true, previewPath: previewCachePathFor(sourcePath), generated: true });
    expect(runner.probeMediaStreams).toHaveBeenCalledTimes(1);
    expect(runner.runFfmpegWithProgress).toHaveBeenCalledWith(expect.objectContaining({ codecArgs: ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'] }));
  });

  it.each([
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
