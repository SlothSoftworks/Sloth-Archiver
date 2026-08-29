import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  sanitizeForFilesystem,
  channelFolderName,
  videoFolderName,
  writeLibraryEntry,
  addLibraryVersion,
  recordLibraryDownload,
  swapLibraryDownload,
  deleteLibraryEntry,
  deleteLocalFiles,
  overrideLibraryEntry,
  scanLibrary,
  getLibraryIndex,
  refreshLibraryIndex,
  findVideoInIndex,
  writePlaylistSnapshot,
  enrichPlaylistEntry,
  PLAYLISTS_DIR_NAME,
  CLIPS_DIR_NAME,
  buildClipFilePath,
  recordClip,
  listClips,
  deleteClip,
  updateClipFile,
} from './library.mjs';

let libraryDir;

// library.mjs keys epoch folders on Date.now(), and several tests below
// deliberately create two epochs back-to-back in the same test -- real
// wall-clock time isn't fine-grained enough to guarantee those land in
// different milliseconds, which would silently collapse two epochs into one
// folder. A strictly-incrementing fake clock makes epoch uniqueness
// deterministic instead of a timing race.
let mockNow;

beforeEach(() => {
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-'));
  mockNow = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readMetadata(...segments) {
  return JSON.parse(fs.readFileSync(path.join(...segments, 'metadata.json'), 'utf-8'));
}

function baseVideoMetaData(overrides = {}) {
  return {
    id: 'abc123',
    title: 'My Video',
    fullTitle: 'My Video (Full)',
    description: 'desc',
    thumbnail: 'https://example.com/thumb.jpg',
    originalUrl: 'https://youtube.com/watch?v=abc123',
    duration: 120,
    durationString: '2:00',
    uploadDate: '20260101',
    channelId: 'UC123',
    uploader: 'Some Channel',
    resolutions: [{ resolution: '720', filesizeMb: '10' }],
    ...overrides,
  };
}

describe('sanitizeForFilesystem', () => {
  it('returns "untitled" for empty/null/undefined input', () => {
    expect(sanitizeForFilesystem('')).toBe('untitled');
    expect(sanitizeForFilesystem(null)).toBe('untitled');
    expect(sanitizeForFilesystem(undefined)).toBe('untitled');
  });

  it('strips illegal filesystem characters and control chars', () => {
    expect(sanitizeForFilesystem('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('trims trailing dots and whitespace', () => {
    expect(sanitizeForFilesystem('Video Title...   ')).toBe('Video Title');
  });

  it('truncates to maxLength', () => {
    expect(sanitizeForFilesystem('a'.repeat(200), 10)).toBe('a'.repeat(10));
  });

  it('leaves a normal safe title unchanged', () => {
    expect(sanitizeForFilesystem('A Perfectly Normal Title')).toBe('A Perfectly Normal Title');
  });

  it('appends an underscore to Windows-reserved device names, case-insensitively', () => {
    expect(sanitizeForFilesystem('CON')).toBe('CON_');
    expect(sanitizeForFilesystem('con')).toBe('con_');
    expect(sanitizeForFilesystem('LPT1')).toBe('LPT1_');
  });
});

describe('channelFolderName / videoFolderName', () => {
  it('falls back to "Unknown Channel" for a falsy channel name', () => {
    expect(channelFolderName(null)).toBe('Unknown Channel');
    expect(channelFolderName('')).toBe('Unknown Channel');
  });

  it('sanitizes a real channel name', () => {
    expect(channelFolderName('My/Channel')).toBe('My_Channel');
  });

  it('sanitizes a videoId as-is', () => {
    expect(videoFolderName('abc123')).toBe('abc123');
  });
});

describe('writeLibraryEntry', () => {
  it('throws when videoMetaData.id is missing', () => {
    expect(() => writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: undefined }) }))
      .toThrow(/id is required/);
  });

  it('throws when libraryDir is missing', () => {
    expect(() => writeLibraryEntry({ libraryDir: '', videoMetaData: baseVideoMetaData() }))
      .toThrow(/No library folder is configured/);
  });

  it('creates the channel/video/epoch folder tree and writes metadata.json', () => {
    const { channelDir, videoDir, epochDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });

    expect(fs.existsSync(epochDir)).toBe(true);
    expect(channelDir).toBe(path.join(libraryDir, 'Some Channel'));
    expect(videoDir).toBe(path.join(channelDir, 'abc123'));

    expect(metadata.schemaVersion).toBe(3);
    expect(metadata.videoId).toBe('abc123');
    expect(metadata.channel).toBe('Some Channel');
    expect(metadata.resolutions).toEqual([{ resolution: '720', filesizeMb: '10' }]);
    expect(metadata.downloadedFilePath).toBeNull();
    expect(metadata.downloadedAudioFilePath).toBeNull();

    expect(readMetadata(epochDir)).toEqual(metadata);
  });

  it('defaults resolutions to an empty array when not provided', () => {
    const { metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ resolutions: undefined }) });
    expect(metadata.resolutions).toEqual([]);
  });
});

describe('addLibraryVersion', () => {
  it('refuses to add a version outside the configured library folder', () => {
    expect(() => addLibraryVersion({ libraryDir, videoDir: path.join(libraryDir, '..', 'outside'), videoMetaData: baseVideoMetaData() }))
      .toThrow(/outside the configured library folder/);
  });

  it('adds a new epoch under an existing videoDir', () => {
    const first = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const second = addLibraryVersion({ libraryDir, videoDir: first.videoDir, videoMetaData: baseVideoMetaData({ title: 'New Title' }) });

    expect(second.videoDir).toBe(first.videoDir);
    expect(second.epochDir).not.toBe(first.epochDir);
    expect(fs.readdirSync(first.videoDir)).toHaveLength(2);
    expect(second.metadata.title).toBe('New Title');
  });
});

describe('recordLibraryDownload', () => {
  it('sets video fields for kind "video" without touching audio fields', () => {
    const { videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);

    const updated = recordLibraryDownload({ videoDir, epoch, filePath: '/x/video.mp4', resolution: '720', format: 'mp4' });

    expect(updated.downloadedFilePath).toBe('/x/video.mp4');
    expect(updated.downloadedResolution).toBe('720');
    expect(updated.downloadedFormat).toBe('mp4');
    expect(updated.downloadedAudioFilePath).toBeNull();
  });

  it('sets only downloadedAudioFilePath for kind "audio"', () => {
    const { videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);

    const updated = recordLibraryDownload({ videoDir, epoch, filePath: '/x/audio.mp3', kind: 'audio' });

    expect(updated.downloadedAudioFilePath).toBe('/x/audio.mp3');
    expect(updated.downloadedFilePath).toBeNull();
  });
});

describe('swapLibraryDownload', () => {
  it('refuses to swap in a file outside the configured library folder', () => {
    const { videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    expect(() => swapLibraryDownload({
      libraryDir, videoDir, epoch: String(metadata.addedEpoch),
      tempFilePath: '/tmp/somewhere-else/video.mp4', oldFilePath: null,
    })).toThrow(/outside the configured library folder/);
  });

  it('renames the temp file into the deterministic video.<ext> slot and updates metadata', () => {
    const { videoDir, epochDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);
    const tempFilePath = path.join(epochDir, 'video.new.mp4');
    fs.writeFileSync(tempFilePath, 'fake video bytes');

    const updated = swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath: null, resolution: '1080', format: 'mp4' });

    const targetPath = path.join(epochDir, 'video.mp4');
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.existsSync(tempFilePath)).toBe(false);
    expect(updated.downloadedFilePath).toBe(targetPath);
    expect(updated.downloadedResolution).toBe('1080');
  });

  it('deletes the old file and any pre-existing target before renaming in', () => {
    const { videoDir, epochDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);

    const oldFilePath = path.join(epochDir, 'video.webm');
    fs.writeFileSync(oldFilePath, 'old bytes');
    const targetPath = path.join(epochDir, 'video.mp4');
    fs.writeFileSync(targetPath, 'stale bytes at the target path already');
    const tempFilePath = path.join(epochDir, 'video.new.mp4');
    fs.writeFileSync(tempFilePath, 'fresh bytes');

    swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath, resolution: '1080', format: 'mp4' });

    expect(fs.existsSync(oldFilePath)).toBe(false);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('fresh bytes');
  });
});

describe('deleteLibraryEntry', () => {
  it('refuses to delete a path outside the configured library folder', () => {
    expect(() => deleteLibraryEntry({ libraryDir, videoDir: '/etc' })).toThrow(/outside the configured library folder/);
  });

  it('deletes the whole video when no epoch is given', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const result = deleteLibraryEntry({ libraryDir, videoDir });
    expect(result.videoDeleted).toBe(true);
    expect(fs.existsSync(videoDir)).toBe(false);
  });

  it('deletes just one epoch and keeps the video when other epochs remain', () => {
    const first = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const second = addLibraryVersion({ libraryDir, videoDir: first.videoDir, videoMetaData: baseVideoMetaData() });

    const result = deleteLibraryEntry({ libraryDir, videoDir: first.videoDir, epoch: String(first.metadata.addedEpoch) });

    expect(result.videoDeleted).toBe(false);
    expect(fs.existsSync(first.epochDir)).toBe(false);
    expect(fs.existsSync(second.epochDir)).toBe(true);
  });

  it('deletes the whole video once its last remaining epoch is deleted', () => {
    const { videoDir, epochDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const result = deleteLibraryEntry({ libraryDir, videoDir, epoch: String(metadata.addedEpoch) });
    expect(result.videoDeleted).toBe(true);
    expect(fs.existsSync(epochDir)).toBe(false);
    expect(fs.existsSync(videoDir)).toBe(false);
  });
});

describe('deleteLocalFiles', () => {
  it('refuses to delete files outside the configured library folder', () => {
    expect(() => deleteLocalFiles({ libraryDir, videoDir: '/etc' })).toThrow(/outside the configured library folder/);
  });

  it('deletes the downloaded video and audio files across every epoch, keeping the entries', () => {
    const first = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const firstEpoch = String(first.metadata.addedEpoch);
    const second = addLibraryVersion({ libraryDir, videoDir: first.videoDir, videoMetaData: baseVideoMetaData() });
    const secondEpoch = second.epoch;

    const firstVideoFile = path.join(first.epochDir, 'video.mp4');
    const firstAudioFile = path.join(first.epochDir, 'audio.mp3');
    const secondVideoFile = path.join(second.epochDir, 'video.mp4');
    fs.writeFileSync(firstVideoFile, 'fake video bytes');
    fs.writeFileSync(firstAudioFile, 'fake audio bytes');
    fs.writeFileSync(secondVideoFile, 'fake video bytes');
    recordLibraryDownload({ videoDir: first.videoDir, epoch: firstEpoch, filePath: firstVideoFile, resolution: '1080', format: 'mp4' });
    recordLibraryDownload({ videoDir: first.videoDir, epoch: firstEpoch, filePath: firstAudioFile, kind: 'audio' });
    recordLibraryDownload({ videoDir: first.videoDir, epoch: secondEpoch, filePath: secondVideoFile, resolution: '720', format: 'mp4' });

    const result = deleteLocalFiles({ libraryDir, videoDir: first.videoDir });

    expect(result.filesDeleted).toBe(3);
    expect(fs.existsSync(firstVideoFile)).toBe(false);
    expect(fs.existsSync(firstAudioFile)).toBe(false);
    expect(fs.existsSync(secondVideoFile)).toBe(false);
    // Entries themselves (metadata.json, epoch folders) stay -- only the
    // media files and their metadata pointers are gone.
    expect(fs.existsSync(first.epochDir)).toBe(true);
    expect(fs.existsSync(second.epochDir)).toBe(true);
    const firstMeta = readMetadata(first.videoDir, firstEpoch);
    expect(firstMeta.downloadedFilePath).toBeNull();
    expect(firstMeta.downloadedResolution).toBeNull();
    expect(firstMeta.downloadedFormat).toBeNull();
    expect(firstMeta.downloadedAudioFilePath).toBeNull();
    const secondMeta = readMetadata(first.videoDir, secondEpoch);
    expect(secondMeta.downloadedFilePath).toBeNull();
  });

  it('is a no-op for a video with nothing downloaded', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const result = deleteLocalFiles({ libraryDir, videoDir });
    expect(result.filesDeleted).toBe(0);
  });
});

describe('clips (recordClip / listClips / deleteClip)', () => {
  it('refuses to record/list/delete outside the configured library folder', () => {
    expect(() => recordClip({ libraryDir, videoDir: '/etc', fileName: 'a.mp4', title: 'a', durationSeconds: 1 })).toThrow(/outside the configured library folder/);
    expect(() => listClips({ libraryDir, videoDir: '/etc' })).toThrow(/outside the configured library folder/);
    expect(() => deleteClip({ libraryDir, videoDir: '/etc', clipId: 'x' })).toThrow(/outside the configured library folder/);
  });

  it('records a clip into clips.json and returns it with an id/createdAt', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipPath = buildClipFilePath(videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');

    const clip = recordClip({ libraryDir, videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 12 });

    expect(clip.id).toBeTruthy();
    expect(clip.createdAt).toBeTypeOf('number');
    expect(clip.fileName).toBe('My Clip.mp4');
    expect(clip.durationSeconds).toBe(12);
    expect(listClips({ libraryDir, videoDir })).toEqual([clip]);
  });

  it('throws on a duplicate fileName rather than overwriting', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    recordClip({ libraryDir, videoDir, fileName: 'a.mp4', title: 'a', durationSeconds: 1 });
    expect(() => recordClip({ libraryDir, videoDir, fileName: 'a.mp4', title: 'a again', durationSeconds: 2 }))
      .toThrow(/already exists/);
  });

  it('listClips returns [] for a video with no clips folder', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    expect(listClips({ libraryDir, videoDir })).toEqual([]);
  });

  it('listClips drops a manifest entry whose file no longer exists on disk', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    recordClip({ libraryDir, videoDir, fileName: 'ghost.mp4', title: 'Ghost', durationSeconds: 1 }); // never actually written to disk
    expect(listClips({ libraryDir, videoDir })).toEqual([]);
  });

  it('deleteClip removes the file and the manifest entry', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipPath = buildClipFilePath(videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');
    const clip = recordClip({ libraryDir, videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 1 });

    const result = deleteClip({ libraryDir, videoDir, clipId: clip.id });

    expect(result.success).toBe(true);
    expect(fs.existsSync(clipPath)).toBe(false);
    expect(listClips({ libraryDir, videoDir })).toEqual([]);
  });

  it('deleteClip removes the whole clips/ folder (and manifest) when it was the last clip', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipPath = buildClipFilePath(videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');
    const clip = recordClip({ libraryDir, videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 1 });

    deleteClip({ libraryDir, videoDir, clipId: clip.id });

    expect(fs.existsSync(path.join(videoDir, CLIPS_DIR_NAME))).toBe(false);
  });

  it('deleteClip keeps the clips/ folder and manifest when other clips remain', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipPathA = buildClipFilePath(videoDir, 'Clip A', 'mp4');
    const clipPathB = buildClipFilePath(videoDir, 'Clip B', 'mp4');
    fs.mkdirSync(path.dirname(clipPathA), { recursive: true });
    fs.writeFileSync(clipPathA, 'fake clip bytes');
    fs.writeFileSync(clipPathB, 'fake clip bytes');
    const clipA = recordClip({ libraryDir, videoDir, fileName: path.basename(clipPathA), title: 'Clip A', durationSeconds: 1 });
    recordClip({ libraryDir, videoDir, fileName: path.basename(clipPathB), title: 'Clip B', durationSeconds: 1 });

    deleteClip({ libraryDir, videoDir, clipId: clipA.id });

    expect(fs.existsSync(path.join(videoDir, CLIPS_DIR_NAME))).toBe(true);
    expect(listClips({ libraryDir, videoDir }).map((c) => c.title)).toEqual(['Clip B']);
  });

  it('deleteClip returns { success: false } for an unknown clipId', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    expect(deleteClip({ libraryDir, videoDir, clipId: 'nope' })).toEqual({ success: false });
  });

  it('updateClipFile updates fileName/durationSeconds and keeps id/title/createdAt', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clip = recordClip({ libraryDir, videoDir, fileName: 'My Clip.mp4', title: 'My Clip', durationSeconds: 5 });

    const updated = updateClipFile({ libraryDir, videoDir, clipId: clip.id, fileName: 'My Clip.mkv', durationSeconds: 6 });

    expect(updated).toEqual({ ...clip, fileName: 'My Clip.mkv', durationSeconds: 6 });
    expect(listClips({ libraryDir, videoDir })).toEqual([]); // file on disk is still the old one in this unit test
  });

  it('updateClipFile throws when the new fileName collides with a different clip', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipA = recordClip({ libraryDir, videoDir, fileName: 'Clip A.mp4', title: 'Clip A', durationSeconds: 1 });
    recordClip({ libraryDir, videoDir, fileName: 'Clip B.mkv', title: 'Clip B', durationSeconds: 1 });

    expect(() => updateClipFile({ libraryDir, videoDir, clipId: clipA.id, fileName: 'Clip B.mkv', durationSeconds: 1 }))
      .toThrow(/already exists/);
  });

  it('updateClipFile throws for an unknown clipId', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    expect(() => updateClipFile({ libraryDir, videoDir, clipId: 'nope', fileName: 'x.mp4', durationSeconds: 1 }))
      .toThrow(/not found/);
  });

  it('updateClipFile refuses a videoDir outside the configured library folder', () => {
    expect(() => updateClipFile({ libraryDir, videoDir: '/etc', clipId: 'x', fileName: 'x.mp4', durationSeconds: 1 }))
      .toThrow(/outside the configured library folder/);
  });
});

describe('clip lifecycle vs. video lifecycle', () => {
  it('whole-video delete also removes its clips folder', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipPath = buildClipFilePath(videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');
    recordClip({ libraryDir, videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 1 });

    deleteLibraryEntry({ libraryDir, videoDir });

    expect(fs.existsSync(videoDir)).toBe(false);
  });

  it('single-epoch delete (other epochs remain) leaves clips untouched', () => {
    const first = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    addLibraryVersion({ libraryDir, videoDir: first.videoDir, videoMetaData: baseVideoMetaData() });
    const clipPath = buildClipFilePath(first.videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');
    recordClip({ libraryDir, videoDir: first.videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 1 });

    deleteLibraryEntry({ libraryDir, videoDir: first.videoDir, epoch: String(first.metadata.addedEpoch) });

    expect(fs.existsSync(clipPath)).toBe(true);
    expect(listClips({ libraryDir, videoDir: first.videoDir })).toHaveLength(1);
  });

  it('bulk "delete local files" leaves clips untouched', () => {
    const { videoDir, epochDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const videoFile = path.join(epochDir, 'video.mp4');
    fs.writeFileSync(videoFile, 'fake video bytes');
    recordLibraryDownload({ videoDir, epoch: String(metadata.addedEpoch), filePath: videoFile, resolution: '1080', format: 'mp4' });
    const clipPath = buildClipFilePath(videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');
    recordClip({ libraryDir, videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 1 });

    deleteLocalFiles({ libraryDir, videoDir });

    expect(fs.existsSync(clipPath)).toBe(true);
    expect(listClips({ libraryDir, videoDir })).toHaveLength(1);
  });
});

describe('overrideLibraryEntry', () => {
  it('removes the existing video dir before writing the new entry', () => {
    const original = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const result = overrideLibraryEntry({
      libraryDir,
      videoMetaData: baseVideoMetaData({ title: 'Replaced' }),
      existingVideoDir: original.videoDir,
    });

    expect(fs.existsSync(original.videoDir)).toBe(true); // re-created by writeLibraryEntry with the same id/channel
    expect(result.metadata.title).toBe('Replaced');
    // Only the new epoch should exist -- the old one was wiped first.
    expect(fs.readdirSync(result.videoDir)).toHaveLength(1);
  });
});

describe('scanLibrary', () => {
  it('returns an empty index for a missing/nonexistent directory', async () => {
    const index = await scanLibrary(path.join(libraryDir, 'does-not-exist'));
    expect(index).toEqual({ channels: [] });
  });

  it('skips the reserved playlists directory', async () => {
    fs.mkdirSync(path.join(libraryDir, PLAYLISTS_DIR_NAME), { recursive: true });
    const index = await scanLibrary(libraryDir);
    expect(index.channels).toEqual([]);
  });

  it('builds the full channel -> video -> epoch tree, sorted correctly', async () => {
    writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'vid1', uploader: 'Zeta Channel' }) });
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'vid2', uploader: 'Alpha Channel' }) });
    addLibraryVersion({ libraryDir, videoDir, videoMetaData: baseVideoMetaData({ id: 'vid2', uploader: 'Alpha Channel', title: 'v2' }) });

    const index = await scanLibrary(libraryDir);

    expect(index.channels.map((c) => c.displayName)).toEqual(['Alpha Channel', 'Zeta Channel']);
    const alpha = index.channels.find((c) => c.displayName === 'Alpha Channel');
    expect(alpha.videos).toHaveLength(1);
    expect(alpha.videos[0].epochs).toHaveLength(2);
    expect(alpha.videos[0].metadata.title).toBe('v2'); // latest epoch first
  });

  it('is tolerant of a corrupt metadata.json (skips that epoch instead of throwing)', async () => {
    const { epochDir, videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    fs.writeFileSync(path.join(epochDir, 'metadata.json'), '{ not valid json');

    const index = await scanLibrary(libraryDir);
    expect(index.channels).toEqual([]);
    expect(fs.existsSync(videoDir)).toBe(true); // folder itself is untouched, just excluded from the index
  });

  it('picks up a video-thumbnail sibling file when present', async () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const thumbPath = path.join(videoDir, 'video-thumbnail.jpg');
    fs.writeFileSync(thumbPath, 'fake image bytes');

    const index = await scanLibrary(libraryDir);
    expect(index.channels[0].videos[0].thumbnailPath).toBe(thumbPath);
  });

  it('never mistakes the reserved clips folder for an epoch, with or without a stray metadata.json inside it', async () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipsDir = path.join(videoDir, CLIPS_DIR_NAME);
    fs.mkdirSync(clipsDir, { recursive: true });
    // A stray metadata.json inside clips/ (as if some other process wrote
    // one) must still not be picked up as a real epoch.
    fs.writeFileSync(path.join(clipsDir, 'metadata.json'), JSON.stringify({ videoId: 'not-a-real-epoch' }));

    const index = await scanLibrary(libraryDir);

    expect(index.channels[0].videos[0].epochs).toHaveLength(1);
    expect(index.channels[0].videos[0].metadata.videoId).not.toBe('not-a-real-epoch');
  });

  it('reports clipCount from clips.json', async () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    recordClip({ libraryDir, videoDir, fileName: 'a.mp4', title: 'a', durationSeconds: 1 });
    recordClip({ libraryDir, videoDir, fileName: 'b.mp4', title: 'b', durationSeconds: 1 });

    const index = await scanLibrary(libraryDir);

    expect(index.channels[0].videos[0].clipCount).toBe(2);
  });
});

describe('getLibraryIndex / refreshLibraryIndex caching', () => {
  it('reuses the in-flight/resolved promise for the same libraryDir', () => {
    const first = getLibraryIndex(libraryDir);
    const second = getLibraryIndex(libraryDir);
    expect(first).toBe(second);
  });

  it('starts a new scan for a different libraryDir', () => {
    const first = getLibraryIndex(libraryDir);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-other-'));
    try {
      const second = getLibraryIndex(otherDir);
      expect(first).not.toBe(second);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('refreshLibraryIndex always starts a fresh scan', () => {
    const first = getLibraryIndex(libraryDir);
    const refreshed = refreshLibraryIndex(libraryDir);
    expect(refreshed).not.toBe(first);
    // A subsequent getLibraryIndex call for the same dir now reuses the refreshed one.
    expect(getLibraryIndex(libraryDir)).toBe(refreshed);
  });
});

describe('findVideoInIndex', () => {
  it('finds a video by videoId across multiple channels', () => {
    const index = {
      channels: [
        { displayName: 'A', videos: [{ metadata: { videoId: 'one' } }] },
        { displayName: 'B', videos: [{ metadata: { videoId: 'two' } }] },
      ],
    };
    const result = findVideoInIndex(index, 'two');
    expect(result.channel.displayName).toBe('B');
    expect(result.video.metadata.videoId).toBe('two');
  });

  it('returns null when the video is not found', () => {
    const index = { channels: [{ displayName: 'A', videos: [] }] };
    expect(findVideoInIndex(index, 'missing')).toBeNull();
  });
});

describe('writePlaylistSnapshot / enrichPlaylistEntry', () => {
  const entries = () => [
    { videoId: 'v1', title: 'Video One', url: 'https://youtube.com/watch?v=v1', thumbnailUrl: 't1', uploadDate: '20260101' },
    { videoId: 'v2', title: 'v2', url: 'https://youtube.com/watch?v=v2' }, // dead title (== videoId)
  ];

  it('writes a snapshot with entries and a localFiles map resolved against the given index', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'v1' }) });
    const index = { channels: [{ videos: [{ metadata: { videoId: 'v1' }, videoDir }] }] };

    const result = writePlaylistSnapshot({
      libraryDir, playlistId: 'PL123', title: 'My Playlist', uploader: 'Someone',
      originalUrl: 'https://youtube.com/playlist?list=PL123', entries: entries(), index,
    });

    expect(result.skipped).toBeUndefined();
    expect(result.metadata.entries).toHaveLength(2);
    expect(result.metadata.entries[0].title).toBe('Video One');
    expect(result.metadata.entries[1].title).toBeNull(); // dead title collapsed to null
    expect(result.metadata.localFiles.v1).toBe(videoDir);
    expect(result.metadata.localFiles.v2).toBeNull();
  });

  it('no-ops on a second snapshot for the same playlist', () => {
    const index = { channels: [] };
    const first = writePlaylistSnapshot({ libraryDir, playlistId: 'PL123', entries: entries(), index });
    const second = writePlaylistSnapshot({ libraryDir, playlistId: 'PL123', entries: entries(), index });

    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe(true);
    expect(fs.readdirSync(first.playlistDir)).toHaveLength(1);
  });

  it('enrichPlaylistEntry returns null for an unknown playlist or entry', () => {
    expect(enrichPlaylistEntry({ libraryDir, playlistId: 'nope', videoId: 'v1' })).toBeNull();

    writePlaylistSnapshot({ libraryDir, playlistId: 'PL123', entries: entries(), index: { channels: [] } });
    expect(enrichPlaylistEntry({ libraryDir, playlistId: 'PL123', videoId: 'not-in-playlist' })).toBeNull();
  });

  it('enrichPlaylistEntry patches title/uploadDate/thumbnailUrl without clobbering with dead/empty values', () => {
    writePlaylistSnapshot({ libraryDir, playlistId: 'PL123', entries: entries(), index: { channels: [] } });

    // v2 has a dead title today -- enrich it with a real one.
    const updated = enrichPlaylistEntry({ libraryDir, playlistId: 'PL123', videoId: 'v2', title: 'Real Title', uploadDate: '20260202', thumbnailUrl: 't2' });
    const v2 = updated.entries.find((e) => e.videoId === 'v2');
    expect(v2.title).toBe('Real Title');
    expect(v2.uploadDate).toBe('20260202');
    expect(v2.thumbnailUrl).toBe('t2');

    // A later "enrich" with another dead title (title === videoId) must not clobber the real one just set.
    const reEnriched = enrichPlaylistEntry({ libraryDir, playlistId: 'PL123', videoId: 'v2', title: 'v2' });
    expect(reEnriched.entries.find((e) => e.videoId === 'v2').title).toBe('Real Title');
  });
});
