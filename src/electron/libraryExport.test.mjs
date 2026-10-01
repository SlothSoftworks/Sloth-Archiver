import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeLibraryEntry,
  addLibraryVersion,
  recordLibraryDownload,
  writePlaylistSnapshot,
  createLibraryTag,
  setVideoTag,
  scanLibrary,
  listLibraryTags,
  listVideoTags,
  listPlaylistSnapshots,
  getPlaylistSnapshot,
  DEFAULT_LIBRARY_DIR_NAME,
} from './library.mjs';
import {
  buildLibraryExport,
  parseLibraryExport,
  importLibraryExport,
  summarizeExport,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
} from './libraryExport.mjs';

let root;
let mockNow;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-export-'));
  mockNow = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function meta(id, overrides = {}) {
  return {
    id,
    title: `Title ${id}`,
    fullTitle: `Title ${id}`,
    description: `Description of ${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hq.jpg`,
    originalUrl: `https://www.youtube.com/watch?v=${id}`,
    uploader: 'Some Channel',
    channelId: 'UCsome',
    uploadDate: '20260101',
    resolutions: [{ resolution: '720', filesizeMb: '10' }],
    ...overrides,
  };
}

// A source library with two sublibraries, a downloaded video, a
// multi-version video, a non-YouTube entry, a local-file entry, a label and
// a saved playlist.
function buildSourceLibrary(dir) {
  const a = writeLibraryEntry({ libraryDir: dir, videoMetaData: meta('aaaaaaaaaaa') });
  const mediaPath = path.join(a.epochDir, 'video.mp4');
  fs.writeFileSync(mediaPath, 'media');
  recordLibraryDownload({ videoDir: a.videoDir, epoch: String(a.metadata.addedEpoch), filePath: mediaPath, resolution: '720', format: 'mp4' });
  const b = writeLibraryEntry({ libraryDir: dir, videoMetaData: meta('bbbbbbbbbbb') });
  addLibraryVersion({ libraryDir: dir, videoDir: b.videoDir, videoMetaData: meta('bbbbbbbbbbb', { title: 'Re-upload' }) });
  writeLibraryEntry({ libraryDir: dir, videoMetaData: meta('sc-track-1', { platform: 'soundcloud', extractorKey: 'Soundcloud', uploader: 'artist', originalUrl: 'https://soundcloud.com/a/b' }) });
  writeLibraryEntry({ libraryDir: dir, videoMetaData: meta('localhash', { platform: 'local', extractorKey: 'local', originalUrl: null }) });
  setVideoTag({ libraryDir: dir, tagName: 'favorites', videoId: 'aaaaaaaaaaa', applied: true });
  writePlaylistSnapshot({
    libraryDir: dir,
    playlistId: 'PLtest',
    title: 'Test playlist',
    entries: [{ videoId: 'aaaaaaaaaaa', title: 'Title aaaaaaaaaaa', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }],
    index: { channels: [] },
  });
  const music = createLibraryTag(dir, 'Music');
  writeLibraryEntry({ libraryDir: dir, libraryTag: music.folderName, videoMetaData: meta('ccccccccccc', { uploader: 'Band' }) });
  return { mediaPath };
}

async function exportRoundTrip(dir) {
  const data = await buildLibraryExport(dir, '1.5.0');
  return parseLibraryExport(JSON.stringify(data));
}

async function allVideos(dir, tag = DEFAULT_LIBRARY_DIR_NAME) {
  return (await scanLibrary(dir, tag)).channels.flatMap((c) => c.videos);
}

describe('buildLibraryExport', () => {
  it('describes every sublibrary, version and playlist, with no local file paths', async () => {
    const source = path.join(root, 'source');
    const { mediaPath } = buildSourceLibrary(source);
    const data = await buildLibraryExport(source, '1.5.0');
    expect(data.format).toBe(EXPORT_FORMAT);
    expect(data.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(summarizeExport(data)).toEqual({ sublibraries: 2, videos: 5, versions: 6, playlists: 1 });
    const text = JSON.stringify(data);
    expect(text).not.toContain(mediaPath);
    expect(text).not.toContain(source);
    const def = data.sublibraries.find((s) => s.folderName === DEFAULT_LIBRARY_DIR_NAME);
    expect(def.videoTags).toEqual({ favorites: ['aaaaaaaaaaa'] });
    expect(def.playlists[0].metadata.localFiles).toBeUndefined();
  });

  it('refuses without a library folder', async () => {
    await expect(buildLibraryExport('', '1.5.0')).rejects.toThrow(/No library folder/);
  });
});

describe('importLibraryExport', () => {
  it('recreates the library in an empty folder, minus local-file entries and downloaded files', async () => {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    buildSourceLibrary(source);
    const data = await exportRoundTrip(source);

    const { summary, touchedTags, followUps } = await importLibraryExport(target, data);
    expect(summary).toMatchObject({ sublibrariesCreated: 2, videosAdded: 4, versionsAdded: 5, localFilesSkipped: 1, playlistsAdded: 1, labelsApplied: 1, invalidSkipped: 0 });
    expect(touchedTags.sort()).toEqual([DEFAULT_LIBRARY_DIR_NAME, 'Music']);
    expect(followUps.videos).toHaveLength(4);
    expect(followUps.videos.find((v) => v.channelId === null)).toBeTruthy(); // the NonYT entry gets no channel icon

    expect(listLibraryTags(target).map((t) => t.tagName).sort()).toEqual([DEFAULT_LIBRARY_DIR_NAME, 'Music']);
    const sourceVideos = await allVideos(source);
    const targetVideos = await allVideos(target);
    expect(targetVideos.map((v) => v.metadata.videoId).sort()).toEqual(sourceVideos.map((v) => v.metadata.videoId).filter((id) => id !== 'localhash').sort());
    for (const video of targetVideos) {
      const original = sourceVideos.find((v) => v.metadata.videoId === video.metadata.videoId);
      expect(path.relative(target, video.videoDir)).toBe(path.relative(source, original.videoDir));
      expect(video.epochs.map((e) => e.epoch)).toEqual(original.epochs.map((e) => e.epoch));
      expect(video.metadata.title).toBe(original.metadata.title);
      expect(video.metadata.downloadedFilePath).toBeNull();
      expect(video.metadata.downloadedResolution).toBeNull();
    }
    expect((await allVideos(target, 'Music')).map((v) => v.metadata.videoId)).toEqual(['ccccccccccc']);
    expect(listVideoTags(target)).toEqual({ favorites: ['aaaaaaaaaaa'] });

    const [playlist] = listPlaylistSnapshots({ libraryDir: target });
    expect(playlist.playlistId).toBe('PLtest');
    const snapshot = await getPlaylistSnapshot({ libraryDir: target, playlistId: 'PLtest' });
    expect(snapshot.localFiles.aaaaaaaaaaa).toBe(targetVideos.find((v) => v.metadata.videoId === 'aaaaaaaaaaa').videoDir);
  });

  it('changes nothing when importing a library into itself', async () => {
    const source = path.join(root, 'source');
    buildSourceLibrary(source);
    const before = JSON.stringify(await buildLibraryExport(source, '1.5.0')).replace(/"exportedAt":"[^"]*"/, '');
    const data = await exportRoundTrip(source);
    const { summary } = await importLibraryExport(source, data);
    expect(summary).toMatchObject({ sublibrariesCreated: 0, videosAdded: 0, versionsAdded: 0, videosAlreadyPresent: 4, playlistsAdded: 0, playlistsAlreadyPresent: 1 });
    const after = JSON.stringify(await buildLibraryExport(source, '1.5.0')).replace(/"exportedAt":"[^"]*"/, '');
    expect(after).toBe(before);
    // The real download record is untouched -- import never overwrites.
    const [video] = (await allVideos(source)).filter((v) => v.metadata.videoId === 'aaaaaaaaaaa');
    expect(video.metadata.downloadedFilePath).toMatch(/video\.mp4$/);
  });

  it('adds only the versions an existing video is missing', async () => {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const a = writeLibraryEntry({ libraryDir: source, videoMetaData: meta('aaaaaaaaaaa') });
    await importLibraryExport(target, await exportRoundTrip(source));
    addLibraryVersion({ libraryDir: source, videoDir: a.videoDir, videoMetaData: meta('aaaaaaaaaaa', { title: 'Edited' }) });

    const { summary } = await importLibraryExport(target, await exportRoundTrip(source));
    expect(summary).toMatchObject({ videosAdded: 0, versionsAdded: 1, videosAlreadyPresent: 0 });
    const [video] = await allVideos(target);
    expect(video.epochs).toHaveLength(2);
    expect(video.metadata.title).toBe('Edited');
  });

  it('matches an existing video wherever it lives, rather than duplicating it', async () => {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    writeLibraryEntry({ libraryDir: source, videoMetaData: meta('aaaaaaaaaaa', { uploader: 'Old Name' }) });
    writeLibraryEntry({ libraryDir: target, videoMetaData: meta('aaaaaaaaaaa', { uploader: 'New Name' }) });
    const { summary } = await importLibraryExport(target, await exportRoundTrip(source));
    expect(summary.videosAdded).toBe(0);
    expect(summary.versionsAdded).toBe(1);
    const videos = await allVideos(target);
    expect(videos).toHaveLength(1);
    expect(videos[0].epochs).toHaveLength(2);
  });

  it('dry run reports the same plan and writes nothing', async () => {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    buildSourceLibrary(source);
    const data = await exportRoundTrip(source);
    fs.mkdirSync(target);
    const preview = await importLibraryExport(target, data, { dryRun: true });
    expect(fs.readdirSync(target)).toEqual([]);
    expect(preview.followUps).toBeNull();
    const real = await importLibraryExport(target, data);
    expect(preview.summary).toEqual(real.summary);
  });

  it('imports beside a plain folder that happens to share a sublibrary name instead of adopting it', async () => {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    buildSourceLibrary(source);
    fs.mkdirSync(path.join(target, 'Music'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Music', 'my-notes.txt'), 'not a library');
    await importLibraryExport(target, await exportRoundTrip(source));
    expect(fs.readdirSync(path.join(target, 'Music'))).toEqual(['my-notes.txt']);
    expect((await allVideos(target, 'Music (imported)')).map((v) => v.metadata.videoId)).toEqual(['ccccccccccc']);
  });

  it('never writes outside the library for crafted paths, epochs or playlist folders', async () => {
    const target = path.join(root, 'library');
    const epochs = [{ epoch: '1700000000000', metadata: { videoId: 'x', title: 'x' } }];
    const data = parseLibraryExport(JSON.stringify({
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      sublibraries: [{
        folderName: '../../escaped',
        videos: [
          { path: ['..', '..', 'evil'], epochs },
          { path: ['NonYT', '..', 'evil'], epochs },
          { path: ['playlists', 'x'], epochs },
          { path: ['Channel'], epochs },
          { path: ['Channel', 'vid'], epochs: [{ epoch: '../../../evil', metadata: { videoId: 'y' } }] },
          { path: ['Channel', 'ok'], epochs },
        ],
        playlists: [{ folderName: '../../../evil-playlist', epoch: '../x', metadata: { playlistId: 'PL', entries: [] } }],
      }],
    }));
    const { summary } = await importLibraryExport(target, data);
    expect(fs.readdirSync(root).sort()).toEqual(['library']);
    // The ../ in folder/playlist names is neutralized by the sanitizer, not
    // just rejected: everything that was written is inside the library.
    const written = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); written.push(p); if (e.isDirectory()) walk(p); } };
    walk(target);
    expect(written.every((p) => path.relative(target, p).split(path.sep)[0] !== '..')).toBe(true);
    expect(fs.readdirSync(target).sort()).toEqual(['.._.._escaped']);
    expect(summary.videosAdded).toBe(2); // ['..','..','evil'] sanitizes to a plain 2-segment path, plus 'ok'
    expect(summary.invalidSkipped).toBe(4);
    expect(summary.playlistsAdded).toBe(1);
  });
});

describe('parseLibraryExport', () => {
  it('rejects invalid JSON, other files and future format versions with a readable message', () => {
    expect(() => parseLibraryExport('{ nope')).toThrow(/isn't valid JSON/);
    expect(() => parseLibraryExport('{"hello":1}')).toThrow(/isn't a SlothArchiver library export/);
    expect(() => parseLibraryExport(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 99, sublibraries: [] }))).toThrow(/newer version/);
    expect(() => parseLibraryExport(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1 }))).toThrow(/damaged/);
    expect(() => parseLibraryExport(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1, sublibraries: [{ folderName: 3, videos: [] }] }))).toThrow(/damaged/);
  });
});
