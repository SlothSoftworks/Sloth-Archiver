import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanLibrary, findVideoInIndex, reconcilePlaylistSnapshot } from './library.mjs';
import { generateLibraryFixture, generatePlaylistFixture, buildPlaylistEntries, DISTRIBUTIONS } from '../../scripts/perf/libraryFixture.mjs';

// Guards the dev-only benchmark fixture generator (scripts/perf/) against
// drifting from what the real library reader expects: whatever it writes
// must scan back as the same number of channels/videos/epochs.
let dir;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('perf library fixture generator', () => {
  it('writes a library that scanLibrary reads back completely', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-fixture-'));
    const summary = generateLibraryFixture({ libraryDir: dir, videos: 120, videosPerChannel: DISTRIBUTIONS.scattered * 10, clipsFraction: 0.2 });
    const index = await scanLibrary(dir);
    const scannedVideos = index.channels.flatMap((c) => c.videos);
    expect(scannedVideos).toHaveLength(summary.videos);
    expect(scannedVideos.reduce((n, v) => n + v.epochs.length, 0)).toBe(summary.epochs);
    expect(scannedVideos.filter((v) => v.metadata.downloadedFilePath).length).toBe(summary.downloaded);
    expect(scannedVideos.reduce((n, v) => n + v.clipCount, 0)).toBe(summary.clips);
    expect(index.channels.filter((c) => !c.isPlatformGroup)).toHaveLength(summary.youtubeChannels);
    expect(index.channels.some((c) => c.isPlatformGroup)).toBe(true);
    expect(scannedVideos.every((v) => v.thumbnailPath)).toBe(true);
    expect(findVideoInIndex(index, summary.videoIds[0])).not.toBeNull();
  });

  it('is deterministic for a given seed', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-fixture-'));
    const a = generateLibraryFixture({ libraryDir: path.join(dir, 'a'), videos: 30 });
    const b = generateLibraryFixture({ libraryDir: path.join(dir, 'b'), videos: 30 });
    expect(a).toEqual(b);
  });

  it('writes a playlist snapshot that reconcilePlaylistSnapshot accepts', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-fixture-'));
    const summary = generateLibraryFixture({ libraryDir: dir, videos: 20 });
    const entries = buildPlaylistEntries({ count: 50, libraryVideoIds: summary.videoIds });
    generatePlaylistFixture({ libraryDir: dir, playlistId: 'PLfixture', entries });
    const index = await scanLibrary(dir);
    const result = reconcilePlaylistSnapshot({ libraryDir: dir, playlistId: 'PLfixture', freshEntries: entries, index });
    expect(result.entries).toHaveLength(50);
    expect(result.missingFromLibraryEntries.length).toBeLessThan(50);
  });
});
