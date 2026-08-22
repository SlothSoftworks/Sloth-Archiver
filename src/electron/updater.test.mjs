import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// child_process.spawn and https.get are mocked rather than exercised for
// real -- getCurrentYtdlpVersion/getLatestYtdlpVersionFromPyPI are thin
// wrappers around them, and this is the boundary where a fake process/
// response can stand in cheaply and deterministically. performYtdlpUpdate
// and its unexported helpers (rebuildYtdlp, ensurePythonRuntime,
// ensurePyinstaller, verifyAndSwap, findPythonRuntimeAsset) are a much
// bigger multi-step orchestration over spawn/https/fs together -- covering
// those meaningfully would mean re-implementing most of the module as a
// mock, for low return relative to the size of this pass. Left for a later,
// dedicated integration-style pass rather than force-fit here.
function makeFakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const { spawn } = await import('child_process');
const { isNewerVersion, getCurrentYtdlpVersion } = await import('./updater.mjs');

beforeEach(() => {
  spawn.mockReset();
});

describe('isNewerVersion', () => {
  it.each([
    ['2026.7.5', '2026.7.4', true],
    ['2026.7.4', '2026.7.5', false],
    ['2026.7.4', '2026.7.4', false],
    ['2026.7.4', '2026.07.04', false], // PyPI vs. yt-dlp's own zero-padded --version output
    ['2026.8.1', '2026.7.31', true],
    ['2027.1.1', '2026.12.31', true],
    ['2026.7', '2026.7.1', false], // missing trailing segment treated as 0
  ])('isNewerVersion(%s, %s) === %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });
});

describe('getCurrentYtdlpVersion', () => {
  it('resolves with the trimmed stdout on a successful --version probe', async () => {
    spawn.mockImplementation(() => {
      const child = makeFakeChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', '2026.7.4\n');
        child.emit('close', 0);
      });
      return child;
    });

    await expect(getCurrentYtdlpVersion('/path/to/yt-dlp')).resolves.toBe('2026.7.4');
    expect(spawn).toHaveBeenCalledWith('/path/to/yt-dlp', ['--version'], {});
  });

  it('throws when the probe exits non-zero', async () => {
    spawn.mockImplementation(() => {
      const child = makeFakeChildProcess();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });

    await expect(getCurrentYtdlpVersion('/path/to/yt-dlp')).rejects.toThrow(/Failed to read current yt-dlp version/);
  });

  it('throws when spawning the binary itself fails', async () => {
    spawn.mockImplementation(() => {
      const child = makeFakeChildProcess();
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    });

    await expect(getCurrentYtdlpVersion('/missing/yt-dlp')).rejects.toThrow(/Failed to read current yt-dlp version/);
  });
});

describe('getLatestYtdlpVersionFromPyPI', () => {
  it('parses the version out of a successful PyPI response', async () => {
    vi.doMock('https', () => ({
      default: {
        get: (url, options, callback) => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.resume = vi.fn();
          callback(res);
          queueMicrotask(() => {
            res.emit('data', JSON.stringify({ info: { version: '2026.7.4' } }));
            res.emit('end');
          });
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { getLatestYtdlpVersionFromPyPI: freshGetLatest } = await import('./updater.mjs');

    await expect(freshGetLatest()).resolves.toBe('2026.7.4');
    vi.doUnmock('https');
    vi.resetModules();
  });

  it('rejects on a non-200 status', async () => {
    vi.doMock('https', () => ({
      default: {
        get: (url, options, callback) => {
          const res = new EventEmitter();
          res.statusCode = 500;
          res.headers = {};
          res.resume = vi.fn();
          callback(res);
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { getLatestYtdlpVersionFromPyPI: freshGetLatest } = await import('./updater.mjs');

    await expect(freshGetLatest()).rejects.toThrow(/failed with status 500/);
    vi.doUnmock('https');
    vi.resetModules();
  });
});
