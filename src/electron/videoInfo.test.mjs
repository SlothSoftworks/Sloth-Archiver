import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildResolutions, reshapeVideoInfo } from './videoInfo.mjs';

// Real yt-dlp -J output captured per-platform, not hand-constructed --
// exercises reshapeVideoInfo's new fields (platform/extractorKey/license/
// timestamp/music) against what yt-dlp actually reports for each extractor.
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../0tempFiles/ytdlp-metadata-experiment',
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
