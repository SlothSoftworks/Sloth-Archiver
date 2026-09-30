import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isBlockedAddress,
  assertFetchableImageUrl,
  guardedLookup,
  downloadImageToFile,
} from './thumbnails.mjs';

let destDir;

beforeEach(() => {
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-thumbs-'));
});

afterEach(() => {
  fs.rmSync(destDir, { recursive: true, force: true });
});

// A stand-in for https.get: each call pops the next scripted response off
// `responses` and records the URL it was asked for. `body` is a Buffer or an
// array of chunks; `stall` never delivers a response at all.
function fakeGet(responses) {
  const calls = [];
  function get(url, options, callback) {
    calls.push({ url: String(url), options });
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.setTimeout = (ms, onTimeout) => { request.onTimeout = onTimeout; };
    const next = responses.shift();
    if (next.stall) {
      setImmediate(() => request.onTimeout?.());
      return request;
    }
    const chunks = Array.isArray(next.body) ? next.body : [next.body ?? Buffer.alloc(0)];
    const res = Readable.from(chunks);
    res.statusCode = next.statusCode ?? 200;
    res.headers = next.headers ?? {};
    setImmediate(() => callback(res));
    return request;
  }
  return { get, calls };
}

function filesIn(dir) {
  return fs.readdirSync(dir).sort();
}

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast and unspecified IPv4', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('blocks loopback, ULA, link-local, multicast and IPv4-mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '142.250.72.14', '172.32.0.1', '2607:f8b0:4005:80b::200e']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it('treats a non-IP string as blocked', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertFetchableImageUrl', () => {
  it('accepts a normal https CDN URL', () => {
    expect(assertFetchableImageUrl('https://i.ytimg.com/vi/abc/maxresdefault.jpg').hostname).toBe('i.ytimg.com');
  });

  it('rejects non-https schemes and garbage', () => {
    expect(() => assertFetchableImageUrl('http://i.ytimg.com/a.jpg')).toThrow(/https/);
    expect(() => assertFetchableImageUrl('file:///etc/passwd')).toThrow(/https/);
    expect(() => assertFetchableImageUrl('not a url')).toThrow(/valid URL/);
  });

  it('rejects internal IP-literal hosts, including obfuscated IPv4 spellings', () => {
    for (const url of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://0x7f.1/x', 'https://2130706433/x', 'https://[::ffff:127.0.0.1]/x']) {
      expect(() => assertFetchableImageUrl(url)).toThrow(/not publicly routable/);
    }
  });
});

describe('guardedLookup', () => {
  it('fails a hostname that resolves to loopback', async () => {
    const err = await new Promise((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
    expect(err?.message).toMatch(/non-public address/);
  });

  it('fails when any address in an all:true answer is internal', async () => {
    const err = await new Promise((resolve) => guardedLookup('localhost', { all: true }, (e) => resolve(e)));
    expect(err?.message).toMatch(/non-public address/);
  });

  it('passes a public address through unchanged', async () => {
    const result = await new Promise((resolve) => guardedLookup('8.8.8.8', {}, (e, address, family) => resolve({ e, address, family })));
    expect(result).toEqual({ e: null, address: '8.8.8.8', family: 4 });
  });
});

describe('downloadImageToFile', () => {
  it('writes the image under the content-type extension and replaces a previous one', async () => {
    fs.writeFileSync(path.join(destDir, 'video-thumbnail.jpg'), 'old');
    const { get, calls } = fakeGet([{ headers: { 'content-type': 'image/webp' }, body: Buffer.from('new') }]);
    const dest = await downloadImageToFile('https://cdn.example.com/t.webp', destDir, 'video-thumbnail', { get });
    expect(dest).toBe(path.join(destDir, 'video-thumbnail.webp'));
    expect(filesIn(destDir)).toEqual(['video-thumbnail.webp']);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('new');
    expect(calls[0].options.lookup).toBe(guardedLookup);
  });

  it('follows a relative redirect, re-validating the next hop', async () => {
    const { get, calls } = fakeGet([
      { statusCode: 302, headers: { location: '/real.jpg' } },
      { headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('img') },
    ]);
    await downloadImageToFile('https://cdn.example.com/start', destDir, 'channel-icon', { get });
    expect(calls.map((c) => c.url)).toEqual(['https://cdn.example.com/start', 'https://cdn.example.com/real.jpg']);
  });

  it('refuses a redirect to an internal address without requesting it', async () => {
    const { get, calls } = fakeGet([{ statusCode: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }]);
    await expect(downloadImageToFile('https://cdn.example.com/start', destDir, 'x', { get })).rejects.toThrow(/not publicly routable/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a redirect that downgrades to http', async () => {
    const { get } = fakeGet([{ statusCode: 301, headers: { location: 'http://cdn.example.com/a.jpg' } }]);
    await expect(downloadImageToFile('https://cdn.example.com/start', destDir, 'x', { get })).rejects.toThrow(/https/);
  });

  it('gives up after the redirect budget', async () => {
    const hops = Array.from({ length: 5 }, (_, i) => ({ statusCode: 302, headers: { location: `/hop${i}` } }));
    const { get, calls } = fakeGet(hops);
    await expect(downloadImageToFile('https://cdn.example.com/start', destDir, 'x', { get, redirectsLeft: 2 })).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(3);
  });

  it('rejects a declared Content-Length over the cap before writing anything', async () => {
    const { get } = fakeGet([{ headers: { 'content-length': '999' }, body: Buffer.from('x') }]);
    await expect(downloadImageToFile('https://cdn.example.com/a.jpg', destDir, 'x', { get, maxBytes: 10 })).rejects.toThrow(/size limit/);
    expect(filesIn(destDir)).toEqual([]);
  });

  it('aborts a body that streams past the cap, keeping the previous image and no partial file', async () => {
    fs.writeFileSync(path.join(destDir, 'x.jpg'), 'old');
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(4, 1));
    const { get } = fakeGet([{ headers: {}, body: chunks }]);
    await expect(downloadImageToFile('https://cdn.example.com/a.jpg', destDir, 'x', { get, maxBytes: 10 })).rejects.toThrow(/size limit/);
    // Cleanup waits for the write stream to close; poll briefly rather
    // than assume a fixed delay is long enough.
    for (let i = 0; i < 50 && filesIn(destDir).length > 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(filesIn(destDir)).toEqual(['x.jpg']);
    expect(fs.readFileSync(path.join(destDir, 'x.jpg'), 'utf-8')).toBe('old');
  });

  it('fails on an idle timeout', async () => {
    const { get } = fakeGet([{ stall: true }]);
    await expect(downloadImageToFile('https://cdn.example.com/a.jpg', destDir, 'x', { get })).rejects.toThrow(/timed out/);
  });

  it('fails on a non-200 status', async () => {
    const { get } = fakeGet([{ statusCode: 404 }]);
    await expect(downloadImageToFile('https://cdn.example.com/a.jpg', destDir, 'x', { get })).rejects.toThrow(/HTTP 404/);
  });

  // End-to-end through the real https.get: both refusals happen before any
  // connection is attempted (port 1 would fail anyway, with a different error).
  it('refuses loopback through the real request path, by IP literal and by hostname', async () => {
    await expect(downloadImageToFile('https://127.0.0.1:1/a.jpg', destDir, 'x')).rejects.toThrow(/not publicly routable/);
    await expect(downloadImageToFile('https://localhost:1/a.jpg', destDir, 'x')).rejects.toThrow(/non-public address/);
  });
});
