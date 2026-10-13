import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeLibraryEntry,
  addLibraryVersion,
  refreshLibraryEntryMetadata,
  recordLibraryDownload,
  savePlaybackPosition,
  deleteLibraryEntry,
  deleteLocalFiles,
  moveLibraryEntry,
  recordClip,
  deleteClip,
  createLibraryTag,
  scanLibrary,
  patchLibraryIndex,
  updateLibraryIndexForVideoDirs,
  refreshLibraryIndex,
  getLibraryIndex,
  DEFAULT_LIBRARY_DIR_NAME,
} from './library.mjs';

// PERF-002/008: the incremental index update has to be indistinguishable
// from a full rescan, or the Library tab drifts out of sync with disk. These
// tests drive a seeded random sequence of the same writes the app makes and,
// after every single one, check the patched index (carried forward from the
// previous step, so errors would accumulate) deep-equals a fresh scan.

let libraryDir;
let mockNow;

beforeEach(() => {
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-patch-'));
  mockNow = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHANNELS = ['Alpha', 'beta', 'Gamma', 'alpha', 'Zed', 'Same Name'];
const PLATFORMS = [['soundcloud', 'Soundcloud'], ['vimeo', 'Vimeo']];

function meta(id, random, overrides = {}) {
  const platform = random() < 0.2 ? PLATFORMS[Math.floor(random() * PLATFORMS.length)] : null;
  const base = {
    id,
    title: `Video ${id}`,
    uploader: CHANNELS[Math.floor(random() * CHANNELS.length)],
    channelId: 'UCx',
    originalUrl: `https://www.youtube.com/watch?v=${id}`,
    description: 'd',
    resolutions: [],
  };
  return platform ? { ...base, platform: platform[0], extractorKey: platform[1], originalUrl: `https://${platform[0]}.example/${id}` } : { ...base, ...overrides };
}

// Every video folder currently in a sublibrary, straight from disk.
function videoDirsOnDisk(tag) {
  const root = path.join(libraryDir, tag);
  const dirs = [];
  if (!fs.existsSync(root)) return dirs;
  for (const top of fs.readdirSync(root, { withFileTypes: true })) {
    if (!top.isDirectory() || top.name === 'playlists') continue;
    const groups = top.name === 'NonYT'
      ? fs.readdirSync(path.join(root, top.name), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, top.name, e.name))
      : [path.join(root, top.name)];
    for (const group of groups) {
      for (const v of fs.readdirSync(group, { withFileTypes: true })) if (v.isDirectory()) dirs.push(path.join(group, v.name));
    }
  }
  return dirs;
}

function epochsOf(videoDir) {
  return fs.existsSync(videoDir) ? fs.readdirSync(videoDir).filter((e) => /^\d+$/.test(e)) : [];
}

// One random write; returns { tag: [touched video dirs] } -- exactly what
// the main-process handlers pass to the index update.
function randomWrite(random, step, music) {
  const pick = (xs) => xs[Math.floor(random() * xs.length)];
  const defaultDirs = videoDirsOnDisk(DEFAULT_LIBRARY_DIR_NAME);
  const roll = random();
  if (defaultDirs.length < 3 || roll < 0.25) {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: meta(`v${step}`, random) });
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] };
  }
  const videoDir = pick(defaultDirs);
  const epochs = epochsOf(videoDir);
  const epoch = pick(epochs);
  let videoId = null;
  try {
    videoId = epoch ? JSON.parse(fs.readFileSync(path.join(videoDir, epoch, 'metadata.json'), 'utf-8')).videoId : null;
  } catch {
    videoId = null; // corrupted by an earlier step -- clean it up below
  }
  if (!epoch || !videoId) {
    fs.rmSync(videoDir, { recursive: true, force: true });
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] };
  }
  if (roll < 0.35) return (addLibraryVersion({ libraryDir, videoDir, videoMetaData: meta(videoId, random, { title: `Re-up ${step}` }) }), { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] });
  if (roll < 0.42) {
    // A metadata refresh that renames the uploader changes the channel's
    // displayName -- and therefore the channel sort order.
    refreshLibraryEntryMetadata({ libraryDir, videoDir, epoch, videoMetaData: meta(videoId, random, { uploader: `Renamed ${step}` }) });
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] };
  }
  if (roll < 0.52) {
    const filePath = path.join(videoDir, epoch, 'video.mp4');
    fs.writeFileSync(filePath, 'x');
    recordLibraryDownload({ videoDir, epoch, filePath, resolution: '720', format: 'mp4' });
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] };
  }
  if (roll < 0.58) return (savePlaybackPosition({ videoDir, epoch, positionSeconds: step }), { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] });
  if (roll < 0.64) return (deleteLocalFiles({ libraryDir, videoDir }), { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] });
  if (roll < 0.70) return (deleteLibraryEntry({ libraryDir, videoDir, epoch }), { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] });
  if (roll < 0.74) return (deleteLibraryEntry({ libraryDir, videoDir }), { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] });
  if (roll < 0.80) {
    const clip = recordClip({ libraryDir, videoDir, fileName: `c${step}.mp4`, title: `c${step}`, durationSeconds: 1, clipTimestamps: { start: 0, end: 1 } });
    if (random() < 0.3) deleteClip({ libraryDir, videoDir, clipId: clip.id });
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] };
  }
  if (roll < 0.86) {
    fs.writeFileSync(path.join(videoDir, 'video-thumbnail.jpg'), 'img');
    // Channel icon lands beside the videos -- the patch must pick it up too.
    if (!videoDir.includes(`${path.sep}NonYT${path.sep}`)) fs.writeFileSync(path.join(path.dirname(videoDir), 'channel-icon.png'), 'img');
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] };
  }
  if (roll < 0.90) {
    // Corrupt the only epoch -> the video drops out of the index.
    for (const e of epochs) fs.writeFileSync(path.join(videoDir, e, 'metadata.json'), '{ broken');
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir] };
  }
  if (videoDir.includes(`${path.sep}NonYT${path.sep}`)) return { [DEFAULT_LIBRARY_DIR_NAME]: [] };
  try {
    const moved = moveLibraryEntry({ libraryDir, videoDir, targetTag: music });
    return { [DEFAULT_LIBRARY_DIR_NAME]: [videoDir], [music]: [moved.videoDir] };
  } catch {
    return { [DEFAULT_LIBRARY_DIR_NAME]: [] };
  }
}

describe('patchLibraryIndex', () => {
  for (const seed of [1, 2, 3]) {
    it(`stays deep-equal to a full rescan across 150 random writes (seed ${seed})`, async () => {
      const random = createRandom(seed);
      const { folderName: music } = createLibraryTag(libraryDir, 'Music');
      const patched = { [DEFAULT_LIBRARY_DIR_NAME]: await scanLibrary(libraryDir), [music]: await scanLibrary(libraryDir, music) };
      for (let step = 0; step < 150; step++) {
        const touched = randomWrite(random, step, music);
        for (const [tag, dirs] of Object.entries(touched)) {
          const next = patchLibraryIndex(patched[tag], libraryDir, tag, dirs);
          expect(next).not.toBeNull();
          patched[tag] = next;
        }
        for (const tag of [DEFAULT_LIBRARY_DIR_NAME, music]) {
          expect(patched[tag], `step ${step}, ${tag}`).toEqual(await scanLibrary(libraryDir, tag));
        }
      }
      // Sanity: the run actually exercised a non-trivial library.
      expect(patched[DEFAULT_LIBRARY_DIR_NAME].channels.length).toBeGreaterThan(1);
    });
  }

  it('does not modify the index object it was given', async () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: { id: 'a', title: 'A', uploader: 'Chan', resolutions: [] } });
    const before = await scanLibrary(libraryDir);
    const snapshot = JSON.parse(JSON.stringify(before));
    fs.rmSync(videoDir, { recursive: true, force: true });
    const after = patchLibraryIndex(before, libraryDir, DEFAULT_LIBRARY_DIR_NAME, [videoDir]);
    expect(after.channels).toEqual([]);
    expect(before).toEqual(snapshot);
  });

  it('returns null for paths it cannot place, so the caller rescans', async () => {
    const index = await scanLibrary(libraryDir);
    expect(patchLibraryIndex(index, libraryDir, DEFAULT_LIBRARY_DIR_NAME, [os.tmpdir()])).toBeNull();
    expect(patchLibraryIndex(index, libraryDir, DEFAULT_LIBRARY_DIR_NAME, [path.join(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'OnlyAChannel')])).toBeNull();
    expect(patchLibraryIndex(index, libraryDir, DEFAULT_LIBRARY_DIR_NAME, [path.join(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'playlists', 'PL')])).toBeNull();
  });
});

describe('updateLibraryIndexForVideoDirs', () => {
  it('patches the cached index in place of a rescan, and does nothing for an uncached sublibrary', async () => {
    const a = writeLibraryEntry({ libraryDir, videoMetaData: { id: 'a', title: 'A', uploader: 'Chan', resolutions: [] } });
    await refreshLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME);
    expect(updateLibraryIndexForVideoDirs(libraryDir, 'Music', [a.videoDir])).toBeNull();

    const b = writeLibraryEntry({ libraryDir, videoMetaData: { id: 'b', title: 'B', uploader: 'Chan', resolutions: [] } });
    const updated = await updateLibraryIndexForVideoDirs(libraryDir, DEFAULT_LIBRARY_DIR_NAME, [b.videoDir]);
    expect(updated.channels[0].videos.map((v) => v.metadata.videoId).sort()).toEqual(['a', 'b']);
    // getLibraryIndex now serves the patched index without rescanning.
    expect(await getLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toBe(updated);
  });

  it('applies queued updates in call order', async () => {
    await refreshLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME);
    const a = writeLibraryEntry({ libraryDir, videoMetaData: { id: 'a', title: 'A', uploader: 'Chan', resolutions: [] } });
    const first = updateLibraryIndexForVideoDirs(libraryDir, DEFAULT_LIBRARY_DIR_NAME, [a.videoDir]);
    fs.rmSync(a.videoDir, { recursive: true, force: true });
    const second = updateLibraryIndexForVideoDirs(libraryDir, DEFAULT_LIBRARY_DIR_NAME, [a.videoDir]);
    await first;
    expect((await second).channels).toEqual([]);
    expect(await getLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual(await scanLibrary(libraryDir));
  });

  it('falls back to a full scan for a path it cannot place', async () => {
    writeLibraryEntry({ libraryDir, videoMetaData: { id: 'a', title: 'A', uploader: 'Chan', resolutions: [] } });
    await refreshLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME);
    writeLibraryEntry({ libraryDir, videoMetaData: { id: 'b', title: 'B', uploader: 'Other', resolutions: [] } });
    const updated = await updateLibraryIndexForVideoDirs(libraryDir, DEFAULT_LIBRARY_DIR_NAME, [os.tmpdir()]);
    expect(updated).toEqual(await scanLibrary(libraryDir));
  });
});
