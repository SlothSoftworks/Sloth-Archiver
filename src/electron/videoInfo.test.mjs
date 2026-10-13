import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildResolutions, reshapeVideoInfo, fetchVideoInfo, pruneExpiredVideoInfoCache } from './videoInfo.mjs';
import { ERROR_KINDS } from './downloadErrors.mjs';

// Trimmed down from real yt-dlp -J output captured per-platform, not
// hand-constructed from scratch -- exercises reshapeVideoInfo's new fields
// (platform/extractorKey/license/timestamp/music) against what yt-dlp
// actually reports for each extractor, keeping only the fields these tests
// read. Committed inside the repo (unlike the original full captures, which
// briefly lived outside it under 0tempFiles/ -- a sibling scratch folder
// that's never checked out on CI, so loading fixtures from there passed
// locally but failed every CI run trying to read a path that doesn't exist).
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/ytdlp-info',
);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf-8'));
}

describe('buildResolutions', () => {
  it('returns an MP3 entry for a pure-audio source (e.g. SoundCloud), not []', () => {
    // Shaped after real SoundCloud yt-dlp output: every format is
    // audio-only (vcodec: 'none', no height), so nothing survives the
    // per-height loop -- this is the exact case the MP3-fallback guard
    // used to miss.
    const info = {
      duration: 180,
      formats: [
        { format_id: '0', vcodec: 'none', acodec: 'mp3', abr: 128, filesize: 2_880_000 },
        { format_id: '1', vcodec: 'none', acodec: 'opus', abr: 64, filesize: 1_440_000 },
      ],
    };

    const resolutions = buildResolutions(info);

    expect(resolutions).not.toEqual([]);
    const mp3Entry = resolutions.find((r) => r.resolution === 'MP3');
    expect(mp3Entry).toBeDefined();
    expect(mp3Entry.ext).toBe('mp3');
    expect(mp3Entry.filesizeMb).toBeGreaterThan(0);
  });

  it('still returns [] when there is no audio at all', () => {
    const info = { duration: 180, formats: [] };
    expect(buildResolutions(info)).toEqual([]);
  });

  it('includes both video-height resolutions and the MP3 fallback for a normal video source', () => {
    const info = {
      duration: 120,
      formats: [
        { format_id: 'a', vcodec: 'none', acodec: 'aac', abr: 128, filesize: 1_920_000 },
        { format_id: 'v', vcodec: 'avc1', height: 720, ext: 'mp4', filesize: 20_000_000 },
      ],
    };

    const resolutions = buildResolutions(info);

    expect(resolutions.some((r) => r.resolution === '720')).toBe(true);
    expect(resolutions.some((r) => r.resolution === 'MP3')).toBe(true);
  });
});

describe('reshapeVideoInfo', () => {
  it('derives platform "youtube" from extractor_key "Youtube", carries extractorKey, license, timestamp', () => {
    const info = loadFixture('youtube');
    const response = reshapeVideoInfo(info);

    expect(response.extractorKey).toBe('Youtube');
    expect(response.platform).toBe('youtube');
    expect(response.license).toBe(info.license);
    expect(response.timestamp).toBe(info.timestamp);
    expect(response.music).toBeNull();
  });

  it('derives a sanitized/lowercased platform for a non-YouTube extractor (SoundCloud) and builds a music object', () => {
    const info = loadFixture('soundcloud');
    const response = reshapeVideoInfo(info);

    expect(response.extractorKey).toBe('Soundcloud');
    expect(response.platform).toBe('soundcloud');
    expect(response.music).toEqual({
      track: info.track,
      artist: info.artist,
      album: info.album || null,
      genre: info.genre,
    });
  });

  it('derives platform for Dailymotion, with no music object when track/artist/album/genre are all absent', () => {
    const info = loadFixture('dailymotion');
    const response = reshapeVideoInfo(info);

    expect(response.extractorKey).toBe('Dailymotion');
    expect(response.platform).toBe('dailymotion');
    expect(response.music).toBeNull();
    expect(response.uploaderId).toBe(info.uploader_id);
  });

  it('derives a filesystem-safe platform name for a multi-word extractor_key (PeerTube)', () => {
    const info = loadFixture('peertube');
    const response = reshapeVideoInfo(info);

    expect(response.extractorKey).toBe('PeerTube');
    expect(response.platform).toBe('peertube');
    expect(response.categories).toEqual(info.categories);
    expect(response.tags).toEqual(info.tags);
  });

  it('derives platform for archive.org (extractor_key "ArchiveOrg") and carries its license/timestamp', () => {
    const info = loadFixture('archive_org');
    const response = reshapeVideoInfo(info);

    expect(response.extractorKey).toBe('ArchiveOrg');
    expect(response.platform).toBe('archiveorg');
    expect(response.license).toBe(info.license);
    expect(response.timestamp).toBe(info.timestamp);
  });
});

const HOUR_MS = 60 * 60 * 1000;
const TTL_MS = 24 * HOUR_MS;
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const LIVE_INFO = { id: 'dQw4w9WgXcQ', title: 'T', channel_id: 'UC1', uploader: 'U', formats: [{ height: 720, vcodec: 'avc1', ext: 'mp4' }] };

describe('pruneExpiredVideoInfoCache', () => {
  it('keeps exactly the entries a cache hit would still serve', () => {
    const now = 1_000_000_000;
    const cache = {
      fresh: { savedEpoch: now - HOUR_MS, response: { id: 'a' } },
      justInside: { savedEpoch: now - TTL_MS + 1, response: { id: 'b' } },
      atTheLimit: { savedEpoch: now - TTL_MS, response: { id: 'c' } },
      old: { savedEpoch: now - 3 * TTL_MS, response: { id: 'd' } },
      noEpoch: { response: { id: 'e' } },
      notAnEntry: null,
    };
    expect(Object.keys(pruneExpiredVideoInfoCache(cache, TTL_MS, now))).toEqual(['fresh', 'justInside']);
    expect(Object.keys(cache)).toHaveLength(6);
  });
});

// A stand-in for child_process.spawn: each call pops the next scripted run
// ({ stdout, stderr, code } or { spawnError }) and plays it back on a fake
// child once the caller has had a chance to attach its listeners.
function scriptedSpawn(runs) {
  const calls = [];
  function spawn(command, args) {
    calls.push(args);
    const run = runs.shift();
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      if (run.spawnError) {
        child.emit('error', run.spawnError);
        return;
      }
      if (run.stdout) child.stdout.emit('data', Buffer.from(run.stdout));
      if (run.stderr) child.stderr.emit('data', Buffer.from(run.stderr));
      child.emit('close', run.code ?? 0);
    });
    return child;
  }
  return { spawn, calls };
}

function fetchWith(runs, { url = YOUTUBE_URL, cache = {} } = {}) {
  const { spawn, calls } = scriptedSpawn(runs);
  const store = { current: cache };
  const writeVideoInfoCache = vi.fn((next) => { store.current = next; });
  const promise = fetchVideoInfo(url, {
    ytdlpPath: '/bin/yt-dlp',
    ffmpegDir: '/ffmpeg',
    cookiesArgs: () => [],
    jsRuntimeArgs: () => [],
    ytdlpSpawnEnv: () => ({}),
    readVideoInfoCache: () => store.current,
    writeVideoInfoCache,
    cacheTtlMs: TTL_MS,
    spawn,
  });
  return { promise, calls, store, writeVideoInfoCache };
}

describe('fetchVideoInfo rejections', () => {
  it('carries the classified kind and the unchanged message on a non-zero exit', async () => {
    const { promise } = fetchWith([{ stderr: 'ERROR: [youtube] x: Sign in to confirm you\'re not a bot\n', code: 1 }]);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe(ERROR_KINDS.BOT_BLOCK);
    expect(err.message).toBe('[youtube] x: Sign in to confirm you\'re not a bot');
  });

  it('uses unknown for an unclassified non-zero exit', async () => {
    const { promise } = fetchWith([{ stderr: 'ERROR: something odd\n', code: 1 }]);
    await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.UNKNOWN, message: 'something odd' });
  });

  it('carries missingDependency when yt-dlp cannot be started', async () => {
    const { promise } = fetchWith([{ spawnError: Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }) }]);
    await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.MISSING_DEPENDENCY, message: 'Failed to start yt-dlp: spawn yt-dlp ENOENT' });
  });

  it('carries the kind found by the second, unsuppressed call when a YouTube video has no formats', async () => {
    const { promise, calls } = fetchWith([
      { stdout: JSON.stringify({ id: 'x', title: 'T', formats: [] }) },
      { stderr: 'ERROR: [youtube] x: Sign in to confirm your age\n', code: 1 },
    ]);
    await expect(promise).rejects.toMatchObject({
      kind: ERROR_KINDS.AGE_RESTRICTED,
      message: 'This video is age-restricted -- load a cookie from a signed-in account in Options and try again.',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain('--ignore-no-formats-error');
  });

  it('uses unknown for a non-YouTube URL with no formats', async () => {
    const { promise } = fetchWith([{ stdout: JSON.stringify({ id: 'x', formats: [] }) }], { url: 'https://example.com/v/1' });
    await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.UNKNOWN, message: 'yt-dlp could not retrieve any downloadable formats for this URL.' });
  });

  it('uses unknown for a dead video and for unparseable output', async () => {
    const dead = fetchWith([{ stdout: JSON.stringify({ id: 'x', title: 'T', formats: [{ height: 720, vcodec: 'avc1' }] }) }]);
    await expect(dead.promise).rejects.toMatchObject({ kind: ERROR_KINDS.UNKNOWN, message: expect.stringContaining('No downloadable formats found') });
    expect(dead.writeVideoInfoCache).not.toHaveBeenCalled();

    const garbage = fetchWith([{ stdout: 'not json' }]);
    await expect(garbage.promise).rejects.toMatchObject({ kind: ERROR_KINDS.UNKNOWN, message: 'Failed to parse video data' });
  });
});

describe('fetchVideoInfo cache', () => {
  it('drops expired entries when it writes a fresh one and keeps live ones', async () => {
    const liveEntry = { savedEpoch: Date.now() - HOUR_MS, response: { id: 'live', channelId: 'UC1' } };
    const { promise, store } = fetchWith([{ stdout: JSON.stringify(LIVE_INFO) }], {
      cache: {
        'https://example.com/live': liveEntry,
        'https://example.com/expired': { savedEpoch: Date.now() - 2 * TTL_MS, response: { id: 'old', channelId: 'UC1' } },
      },
    });
    const result = await promise;
    expect(result.data.fromCache).toBe(false);
    expect(Object.keys(store.current).sort()).toEqual(['https://example.com/live', YOUTUBE_URL].sort());
    expect(store.current['https://example.com/live']).toEqual(liveEntry);
    expect(store.current[YOUTUBE_URL].response.id).toBe('dQw4w9WgXcQ');
  });

  it('still serves a live entry from the cache without spawning or writing', async () => {
    const response = { id: 'dQw4w9WgXcQ', channelId: 'UC1' };
    const { promise, calls, writeVideoInfoCache } = fetchWith([], {
      cache: { [YOUTUBE_URL]: { savedEpoch: Date.now() - HOUR_MS, response } },
    });
    await expect(promise).resolves.toEqual({ success: true, data: { response, fromCache: true } });
    expect(calls).toHaveLength(0);
    expect(writeVideoInfoCache).not.toHaveBeenCalled();
  });
});
