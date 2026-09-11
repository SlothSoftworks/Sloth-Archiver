import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { mapPlatformToAssetName, DENO_VERIFICATION_ERROR_CODE } from './denoRelease.mjs';

describe('mapPlatformToAssetName', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64' }, 'deno-aarch64-apple-darwin.zip'],
    [{ platform: 'darwin', arch: 'x64' }, 'deno-x86_64-apple-darwin.zip'],
    [{ platform: 'win32', arch: 'x64' }, 'deno-x86_64-pc-windows-msvc.zip'],
    [{ platform: 'win32', arch: 'arm64' }, 'deno-aarch64-pc-windows-msvc.zip'],
    [{ platform: 'linux', arch: 'x64' }, 'deno-x86_64-unknown-linux-gnu.zip'],
    [{ platform: 'linux', arch: 'arm64' }, 'deno-aarch64-unknown-linux-gnu.zip'],
  ])('%j -> %s', (input, expected) => {
    expect(mapPlatformToAssetName(input)).toBe(expected);
  });

  it.each([
    ['darwin', 'ia32'],
    ['win32', 'mips'],
    ['freebsd', 'x64'],
  ])('throws for unsupported %s/%s', (platform, arch) => {
    expect(() => mapPlatformToAssetName({ platform, arch })).toThrow();
  });
});

describe('resolveLatestRelease', () => {
  it('returns the pinned tag with no network call', async () => {
    const httpsGet = vi.fn();
    vi.doMock('https', () => ({ default: { get: httpsGet } }));
    vi.resetModules();
    const { resolveLatestRelease: freshResolve } = await import('./denoRelease.mjs');

    await expect(freshResolve({ pin: 'v2.9.5' })).resolves.toEqual({ tag: 'v2.9.5' });
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
            res.emit('data', JSON.stringify({ tag_name: 'v2.9.5', assets: [{ name: 'deno-x86_64-apple-darwin.zip' }] }));
            res.emit('end');
          });
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { resolveLatestRelease: freshResolve } = await import('./denoRelease.mjs');

    await expect(freshResolve()).resolves.toEqual({
      tag: 'v2.9.5',
      assets: [{ name: 'deno-x86_64-apple-darwin.zip' }],
    });

    vi.doUnmock('https');
    vi.resetModules();
  });
});

// A minimal hand-built ZIP containing exactly the shape Deno's own release
// assets have (confirmed directly against the real v2.9.5 asset this
// session: a single top-level entry, already named canonically, no wrapper
// directory) -- not yt-dlp's real multi-MB asset, this module doesn't need
// anything from ytdlpRelease.test.mjs's own onedir-shaped fixtures.
function buildDenoZip(binaryContent) {
  const name = 'deno';
  const nameBuf = Buffer.from(name, 'utf-8');
  const rawContent = Buffer.from(binaryContent, 'utf-8');
  const compressed = zlib.deflateRawSync(rawContent);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc32(rawContent), 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(rawContent.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const mode = 0o100755;
  const externalAttrs = (mode << 16) >>> 0;
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE((3 << 8) | 20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc32(rawContent), 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(rawContent.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(externalAttrs, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralDirStart = localHeader.length + nameBuf.length + compressed.length;
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, nameBuf, compressed, centralDir, eocd]);
}

// Same table-free CRC32 as ytdlpRelease.test.mjs's own fixture builder --
// test-only, unzip() never needs to compute one itself.
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

describe('fetchAndVerifyDenoRelease', () => {
  function withTmpDir(fn) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-deno-release-'));
    try {
      return fn(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('downloads, verifies by checksum, and extracts the single deno binary', async () => withTmpDir(async (tmpDir) => {
    const zipBuf = buildDenoZip('fake deno binary');
    const checksum = crypto.createHash('sha256').update(zipBuf).digest('hex');
    const assetName = 'deno-x86_64-apple-darwin.zip';

    vi.doMock('https', () => ({
      default: {
        get: (url, options, callback) => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.resume = vi.fn();
          if (url.endsWith('.sha256sum')) {
            callback(res);
            queueMicrotask(() => {
              res.emit('data', `${checksum}  ${assetName}\n`);
              res.emit('end');
            });
          } else {
            res.pipe = (dest) => {
              dest.write(zipBuf);
              dest.end();
            };
            callback(res);
          }
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { fetchAndVerifyDenoRelease: freshFetch } = await import('./denoRelease.mjs');

    const workDir = path.join(tmpDir, 'work');
    const extractDir = await freshFetch({ release: { tag: 'v2.9.5' }, assetName, workDir, platform: 'darwin' });

    expect(fs.readFileSync(path.join(extractDir, 'deno'), 'utf-8')).toBe('fake deno binary');

    vi.doUnmock('https');
    vi.resetModules();
  }));

  it('throws a DENO_VERIFICATION_FAILED error on a checksum mismatch, without extracting anything', async () => withTmpDir(async (tmpDir) => {
    const zipBuf = buildDenoZip('fake deno binary');
    const assetName = 'deno-x86_64-apple-darwin.zip';
    const wrongChecksum = crypto.createHash('sha256').update('not the real content').digest('hex');

    vi.doMock('https', () => ({
      default: {
        get: (url, options, callback) => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.resume = vi.fn();
          if (url.endsWith('.sha256sum')) {
            callback(res);
            queueMicrotask(() => {
              res.emit('data', `${wrongChecksum}  ${assetName}\n`);
              res.emit('end');
            });
          } else {
            res.pipe = (dest) => {
              dest.write(zipBuf);
              dest.end();
            };
            callback(res);
          }
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { fetchAndVerifyDenoRelease: freshFetch } = await import('./denoRelease.mjs');

    const workDir = path.join(tmpDir, 'work');
    await expect(freshFetch({ release: { tag: 'v2.9.5' }, assetName, workDir, platform: 'darwin' }))
      .rejects.toMatchObject({ code: DENO_VERIFICATION_ERROR_CODE, message: expect.stringContaining('Checksum mismatch') });
    expect(fs.existsSync(path.join(workDir, 'extracted'))).toBe(false);

    vi.doUnmock('https');
    vi.resetModules();
  }));

  it('throws when the checksum file has no entry for the asset', async () => withTmpDir(async (tmpDir) => {
    const zipBuf = buildDenoZip('fake deno binary');
    const assetName = 'deno-x86_64-apple-darwin.zip';

    vi.doMock('https', () => ({
      default: {
        get: (url, options, callback) => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.resume = vi.fn();
          if (url.endsWith('.sha256sum')) {
            callback(res);
            queueMicrotask(() => {
              res.emit('data', 'deadbeef  some-other-asset.zip\n');
              res.emit('end');
            });
          } else {
            res.pipe = (dest) => {
              dest.write(zipBuf);
              dest.end();
            };
            callback(res);
          }
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { fetchAndVerifyDenoRelease: freshFetch } = await import('./denoRelease.mjs');

    const workDir = path.join(tmpDir, 'work');
    await expect(freshFetch({ release: { tag: 'v2.9.5' }, assetName, workDir, platform: 'darwin' }))
      .rejects.toMatchObject({ code: DENO_VERIFICATION_ERROR_CODE, message: expect.stringContaining('no entry for') });

    vi.doUnmock('https');
    vi.resetModules();
  }));

  // Deno's Windows build step generates its .sha256sum companion with
  // PowerShell's `Get-FileHash | Format-List` instead of plain `sha256sum`
  // -- an entirely different, CRLF-terminated, labeled-field format with an
  // uppercase hash. Confirmed directly against the real v2.9.5
  // deno-x86_64-pc-windows-msvc.zip.sha256sum asset; this is the exact shape
  // that broke the real Windows CI build before parseWindowsSha256Sum
  // existed (findChecksumForAsset's line format never matches it).
  it('parses the Windows-shaped .sha256sum (PowerShell Get-FileHash | Format-List) correctly', async () => withTmpDir(async (tmpDir) => {
    const zipBuf = buildDenoZip('fake deno binary');
    const assetName = 'deno-x86_64-pc-windows-msvc.zip';
    const checksum = crypto.createHash('sha256').update(zipBuf).digest('hex');
    const windowsSumsText = '\r\nAlgorithm : SHA256\r\n'
      + `Hash      : ${checksum.toUpperCase()}\r\n`
      + `Path      : C:\\a\\deno\\deno\\target\\release\\${assetName}\r\n\r\n`;

    vi.doMock('https', () => ({
      default: {
        get: (url, options, callback) => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.resume = vi.fn();
          if (url.endsWith('.sha256sum')) {
            callback(res);
            queueMicrotask(() => {
              res.emit('data', windowsSumsText);
              res.emit('end');
            });
          } else {
            res.pipe = (dest) => {
              dest.write(zipBuf);
              dest.end();
            };
            callback(res);
          }
          const req = new EventEmitter();
          req.setTimeout = vi.fn();
          return req;
        },
      },
    }));
    vi.resetModules();
    const { fetchAndVerifyDenoRelease: freshFetch } = await import('./denoRelease.mjs');

    const workDir = path.join(tmpDir, 'work');
    const extractDir = await freshFetch({ release: { tag: 'v2.9.5' }, assetName, workDir, platform: 'win32' });

    expect(fs.readFileSync(path.join(extractDir, 'deno'), 'utf-8')).toBe('fake deno binary');

    vi.doUnmock('https');
    vi.resetModules();
  }));
});
