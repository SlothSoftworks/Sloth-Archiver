import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { EventEmitter } from 'events';
import {
  mapPlatformToAssetName,
  detectMusl,
  verifyDetachedSignature,
  findChecksumForAsset,
  unzip,
  renameLauncherToCanonicalName,
  YTDLP_PUBLIC_KEY_ARMORED,
} from './ytdlpRelease.mjs';

const fixturesDir = path.join(import.meta.dirname, '__fixtures__', 'ytdlp-release');
// Real assets captured from yt-dlp's own 2026.08.19 GitHub release -- never
// fetched live in a test run (offline, fast, deterministic). See
// ytdlpRelease.mjs's own header comment for why the public key these verify
// against is committed rather than fetched at verification time.
const realSums = fs.readFileSync(path.join(fixturesDir, 'SHA2-256SUMS'), 'utf-8');
const realSig = fs.readFileSync(path.join(fixturesDir, 'SHA2-256SUMS.sig'));

describe('mapPlatformToAssetName', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64' }, 'yt-dlp_macos.zip'],
    [{ platform: 'darwin', arch: 'x64' }, 'yt-dlp_macos.zip'], // universal2 -- one asset for both
    [{ platform: 'win32', arch: 'x64' }, 'yt-dlp_win.zip'],
    [{ platform: 'win32', arch: 'arm64' }, 'yt-dlp_win_arm64.zip'],
    [{ platform: 'win32', arch: 'ia32' }, 'yt-dlp_win_x86.zip'],
    [{ platform: 'linux', arch: 'x64' }, 'yt-dlp_linux.zip'],
    [{ platform: 'linux', arch: 'arm64' }, 'yt-dlp_linux_aarch64.zip'],
    [{ platform: 'linux', arch: 'x64', isMusl: true }, 'yt-dlp_musllinux.zip'],
    [{ platform: 'linux', arch: 'arm64', isMusl: true }, 'yt-dlp_musllinux_aarch64.zip'],
  ])('%j -> %s', (input, expected) => {
    expect(mapPlatformToAssetName(input)).toBe(expected);
  });

  it('never returns a bare onefile name or a curl_cffi-less variant', () => {
    const allAssets = [
      mapPlatformToAssetName({ platform: 'darwin', arch: 'arm64' }),
      mapPlatformToAssetName({ platform: 'win32', arch: 'x64' }),
      mapPlatformToAssetName({ platform: 'linux', arch: 'x64' }),
    ];
    for (const asset of allAssets) {
      expect(asset.endsWith('.zip')).toBe(true);
      expect(asset).not.toBe('yt-dlp');
      expect(asset).not.toBe('yt-dlp_x86.exe');
    }
  });

  it.each([
    ['linux', 'ia32'],
    ['win32', 'mips'],
    ['freebsd', 'x64'],
  ])('throws for unsupported %s/%s', (platform, arch) => {
    expect(() => mapPlatformToAssetName({ platform, arch })).toThrow();
  });
});

describe('detectMusl', () => {
  function withPlatform(platform, fn) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  }

  function withReport(report, fn) {
    const original = Object.getOwnPropertyDescriptor(process, 'report');
    Object.defineProperty(process, 'report', { value: report, configurable: true });
    try {
      return fn();
    } finally {
      if (original) Object.defineProperty(process, 'report', original);
      else delete process.report;
    }
  }

  it('is false on non-Linux platforms regardless of process.report', () => {
    withPlatform('darwin', () => {
      withReport({ getReport: () => ({ header: {} }) }, () => {
        expect(detectMusl()).toBe(false);
      });
    });
  });

  it('is false on Linux when glibcVersionRuntime is present (a real glibc host)', () => {
    withPlatform('linux', () => {
      withReport({ getReport: () => ({ header: { glibcVersionRuntime: '2.35' } }) }, () => {
        expect(detectMusl()).toBe(false);
      });
    });
  });

  it('is true on Linux when glibcVersionRuntime is absent (implies musl)', () => {
    withPlatform('linux', () => {
      withReport({ getReport: () => ({ header: {} }) }, () => {
        expect(detectMusl()).toBe(true);
      });
    });
  });
});

describe('resolveLatestRelease', () => {
  it('returns the pinned tag with no network call', async () => {
    const httpsGet = vi.fn();
    vi.doMock('https', () => ({ default: { get: httpsGet } }));
    vi.resetModules();
    const { resolveLatestRelease: freshResolve } = await import('./ytdlpRelease.mjs');

    await expect(freshResolve({ pin: '2026.08.19' })).resolves.toEqual({ tag: '2026.08.19' });
    expect(httpsGet).not.toHaveBeenCalled();

    vi.doUnmock('https');
    vi.resetModules();
  });

  it('fetches and returns the real latest release tag/assets when unpinned', async () => {
    vi.doMock('https', () => ({
      default: {
        get: (url, options, callback) => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.resume = vi.fn();
          callback(res);
          queueMicrotask(() => {
            res.emit('data', JSON.stringify({ tag_name: '2026.08.19', assets: [{ name: 'yt-dlp_macos.zip' }] }));
            res.emit('end');
          });
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { resolveLatestRelease: freshResolve } = await import('./ytdlpRelease.mjs');

    await expect(freshResolve()).resolves.toEqual({
      tag: '2026.08.19',
      assets: [{ name: 'yt-dlp_macos.zip' }],
    });

    vi.doUnmock('https');
    vi.resetModules();
  });
});

describe('findChecksumForAsset', () => {
  it('finds the checksum line for a real asset name', () => {
    expect(findChecksumForAsset(realSums, 'yt-dlp_macos.zip')).toBe('07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8');
  });

  it('returns null for a filename with no matching line', () => {
    expect(findChecksumForAsset(realSums, 'not-a-real-asset')).toBeNull();
  });
});

describe('verifyDetachedSignature', () => {
  it('accepts the real signature over the real data with the real key', () => {
    expect(verifyDetachedSignature({ data: Buffer.from(realSums), signature: realSig, publicKeyArmored: YTDLP_PUBLIC_KEY_ARMORED })).toBe(true);
  });

  it('rejects when the signed data has been tampered with', () => {
    const tampered = Buffer.from(realSums);
    tampered[0] ^= 0xff;
    expect(verifyDetachedSignature({ data: tampered, signature: realSig, publicKeyArmored: YTDLP_PUBLIC_KEY_ARMORED })).toBe(false);
  });

  it('rejects a corrupted signature rather than throwing or accepting it', () => {
    const corrupted = Buffer.from(realSig);
    corrupted[300] ^= 0xff;
    expect(verifyDetachedSignature({ data: Buffer.from(realSums), signature: corrupted, publicKeyArmored: YTDLP_PUBLIC_KEY_ARMORED })).toBe(false);
  });

  it('throws on a truncated signature rather than silently accepting it', () => {
    expect(() => verifyDetachedSignature({
      data: Buffer.from(realSums),
      signature: realSig.subarray(0, 100),
      publicKeyArmored: YTDLP_PUBLIC_KEY_ARMORED,
    })).toThrow();
  });

  it('rejects when verified against a different key', () => {
    const wrongKey = YTDLP_PUBLIC_KEY_ARMORED.replace('mQINBGP78C4BEAD0', 'mQINBGP78C4BEAD1');
    expect(() => verifyDetachedSignature({ data: Buffer.from(realSums), signature: realSig, publicKeyArmored: wrongKey })).not.toThrow();
    expect(verifyDetachedSignature({ data: Buffer.from(realSums), signature: realSig, publicKeyArmored: wrongKey })).toBe(false);
  });
});

// A minimal, hand-built ZIP (not yt-dlp's real multi-MB asset -- that's
// exercised manually against a real download instead) covering exactly the
// two compression methods (stored, deflate) and the Unix-permission-bits
// path unzip() actually needs to handle, confirmed against yt-dlp's real
// asset this session.
function buildTestZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const isDir = entry.name.endsWith('/');
    const rawContent = isDir ? Buffer.alloc(0) : Buffer.from(entry.content ?? '', 'utf-8');
    const method = entry.method ?? 8; // deflate by default
    const compressed = isDir ? Buffer.alloc(0) : (method === 8 ? zlib.deflateRawSync(rawContent) : rawContent);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(isDir ? 0 : method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc32(rawContent), 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawContent.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localParts.push(localHeader, nameBuf, compressed);

    const mode = entry.mode ?? (isDir ? 0o40755 : 0o100644);
    const externalAttrs = (mode << 16) >>> 0;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix host
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(isDir ? 0 : method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(crc32(rawContent), 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawContent.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(externalAttrs, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// Node has no built-in CRC32 -- zlib exposes it only via the compression
// output's own trailer for gzip, not as a standalone primitive, so this
// implements the standard table-free bit-by-bit CRC32 (IEEE 802.3), used
// only by this test's own fixture builder. unzip() itself, per the real
// yt-dlp ZIP structure it's built against, never needs to *compute* a CRC --
// only compressed/uncompressed size are checked (see its size-mismatch
// guard) -- so this stays test-only code, not something the production
// module carries.
function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

describe('unzip', () => {
  it('extracts stored and deflated files with correct content and permissions', () => {
    const zipBuf = buildTestZip([
      { name: 'dir/', },
      { name: 'dir/stored.txt', content: 'hello stored', method: 0, mode: 0o100644 },
      { name: 'dir/deflated.txt', content: 'hello deflated, '.repeat(50), method: 8, mode: 0o100644 },
      { name: 'launcher', content: '#!/bin/sh\necho hi\n', method: 8, mode: 0o100755 },
    ]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-unzip-'));
    const zipPath = path.join(tmpDir, 'test.zip');
    const destDir = path.join(tmpDir, 'out');
    fs.writeFileSync(zipPath, zipBuf);

    try {
      unzip(zipPath, destDir);

      expect(fs.readFileSync(path.join(destDir, 'dir', 'stored.txt'), 'utf-8')).toBe('hello stored');
      expect(fs.readFileSync(path.join(destDir, 'dir', 'deflated.txt'), 'utf-8')).toBe('hello deflated, '.repeat(50));
      expect(fs.readFileSync(path.join(destDir, 'launcher'), 'utf-8')).toBe('#!/bin/sh\necho hi\n');
      // Windows has no real POSIX mode bits -- fs.chmodSync there only ever
      // toggles the read-only flag, so unzip()'s exec-bit restoration (itself
      // best-effort there, see its own comment) can never reproduce an exact
      // 0o755/0o644 on this platform. Skip the octal assertion on win32
      // rather than asserting a mode Windows is structurally unable to hold.
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(destDir, 'launcher')).mode & 0o777).toBe(0o755);
        expect(fs.statSync(path.join(destDir, 'dir', 'stored.txt')).mode & 0o777).toBe(0o644);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a ZIP entry that would escape the destination directory', () => {
    const zipBuf = buildTestZip([
      { name: '../escape.txt', content: 'pwned', method: 0 },
    ]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-unzip-escape-'));
    const zipPath = path.join(tmpDir, 'test.zip');
    fs.writeFileSync(zipPath, zipBuf);

    try {
      expect(() => unzip(zipPath, path.join(tmpDir, 'out'))).toThrow(/escapes destination/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on a non-ZIP file rather than silently doing nothing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-unzip-invalid-'));
    const notAZip = path.join(tmpDir, 'not-a-zip.bin');
    fs.writeFileSync(notAZip, 'this is not a zip file');

    try {
      expect(() => unzip(notAZip, path.join(tmpDir, 'out'))).toThrow(/end-of-central-directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('renameLauncherToCanonicalName', () => {
  it('renames the one non-_internal entry to the canonical name', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-rename-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '_internal'));
      fs.writeFileSync(path.join(tmpDir, 'yt-dlp_macos'), 'fake launcher');

      renameLauncherToCanonicalName(tmpDir, 'yt-dlp');

      expect(fs.existsSync(path.join(tmpDir, 'yt-dlp'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'yt-dlp_macos'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '_internal'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the launcher is already named canonically', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-rename-noop-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '_internal'));
      fs.writeFileSync(path.join(tmpDir, 'yt-dlp'), 'fake launcher');

      renameLauncherToCanonicalName(tmpDir, 'yt-dlp');

      expect(fs.existsSync(path.join(tmpDir, 'yt-dlp'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws rather than guessing when the directory shape is unexpected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-rename-bad-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '_internal'));
      fs.writeFileSync(path.join(tmpDir, 'launcher-one'), 'x');
      fs.writeFileSync(path.join(tmpDir, 'launcher-two'), 'x');

      expect(() => renameLauncherToCanonicalName(tmpDir, 'yt-dlp')).toThrow(/Expected exactly one launcher/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
