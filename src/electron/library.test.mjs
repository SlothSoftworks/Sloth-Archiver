import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { previewCachePathFor } from './previewCache.mjs';
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
  moveLibraryEntry,
  overrideLibraryEntry,
  scanLibrary,
  getLibraryIndex,
  refreshLibraryIndex,
  findVideoInIndex,
  writePlaylistSnapshot,
  enrichPlaylistEntry,
  PLAYLISTS_DIR_NAME,
  CLIPS_DIR_NAME,
  DEFAULT_LIBRARY_DIR_NAME,
  libraryTagDir,
  listLibraryTags,
  createLibraryTag,
  listVideoTags,
  setVideoTag,
  addTagToVideos,
  removeVideosFromTags,
  transferVideoTags,
  checkAndRepairEpochFiles,
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
    expect(channelDir).toBe(path.join(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Some Channel'));
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

  it('lazily creates DefaultLibrary/library.json on first write, with sublibraryName/createdEpoch', () => {
    const metadataPath = path.join(libraryTagDir(libraryDir), 'library.json');
    expect(fs.existsSync(metadataPath)).toBe(false);

    writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });

    const written = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    expect(written.sublibraryName).toBe(DEFAULT_LIBRARY_DIR_NAME);
    expect(typeof written.createdEpoch).toBe('number');
  });

  it('does not overwrite library.json on a later write', () => {
    writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const metadataPath = path.join(libraryTagDir(libraryDir), 'library.json');
    const first = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

    writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'def456', uploader: 'Other Channel' }) });
    const second = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

    expect(second).toEqual(first);
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

  it('returns the deleted video\'s videoId, read before the folder is removed', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'tagged-vid' }) });
    const result = deleteLibraryEntry({ libraryDir, videoDir });
    expect(result.videoId).toBe('tagged-vid');
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

    // A leftover preview-cache derivative (e.g. from a prior mkv preview)
    // must not survive its source file being deleted -- see
    // previewCachePathFor's own callers in deleteLocalFiles.
    const firstVideoPreview = previewCachePathFor(firstVideoFile);
    fs.mkdirSync(path.dirname(firstVideoPreview), { recursive: true });
    fs.writeFileSync(firstVideoPreview, 'fake preview bytes');

    const result = deleteLocalFiles({ libraryDir, videoDir: first.videoDir });

    expect(result.filesDeleted).toBe(3);
    expect(fs.existsSync(firstVideoFile)).toBe(false);
    expect(fs.existsSync(firstAudioFile)).toBe(false);
    expect(fs.existsSync(secondVideoFile)).toBe(false);
    expect(fs.existsSync(firstVideoPreview)).toBe(false);
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

  it('deleteClip removes the file, its preview-cache derivative, and the manifest entry', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipPath = buildClipFilePath(videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');
    const clip = recordClip({ libraryDir, videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 1 });
    // A second, still-remaining clip so the clipsDir itself survives below --
    // isolates this assertion to the single-file preview cleanup, distinct
    // from the "whole folder removed" case covered separately below.
    const otherClipPath = buildClipFilePath(videoDir, 'Other Clip', 'mp4');
    fs.writeFileSync(otherClipPath, 'fake clip bytes');
    recordClip({ libraryDir, videoDir, fileName: path.basename(otherClipPath), title: 'Other Clip', durationSeconds: 1 });
    const clipPreview = previewCachePathFor(clipPath);
    fs.mkdirSync(path.dirname(clipPreview), { recursive: true });
    fs.writeFileSync(clipPreview, 'fake preview bytes');

    const result = deleteClip({ libraryDir, videoDir, clipId: clip.id });

    expect(result.success).toBe(true);
    expect(fs.existsSync(clipPath)).toBe(false);
    expect(fs.existsSync(clipPreview)).toBe(false);
    expect(listClips({ libraryDir, videoDir }).map((c) => c.id)).not.toContain(clip.id);
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
    fs.mkdirSync(path.join(libraryTagDir(libraryDir), PLAYLISTS_DIR_NAME), { recursive: true });
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

describe('checkAndRepairEpochFiles', () => {
  // Simulates exactly what happened when the DefaultLibrary migration
  // landed on top of an already-populated library: metadata.json still
  // points at the file's old, pre-move location, but the real file is
  // sitting right there in the epoch's own current, correct folder.
  function writeStaleMetadataFile(epochDir, patch) {
    const metadataPath = path.join(epochDir, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    Object.assign(metadata, patch);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  it('refuses to check a videoDir outside the configured library folder', () => {
    expect(() => checkAndRepairEpochFiles({ libraryDir, videoDir: '/etc', epoch: '1' }))
      .toThrow(/outside the configured library folder/);
  });

  it('repairs a stale downloadedFilePath to the real file sitting in the current epoch folder', () => {
    const { epochDir, videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);
    const realPath = path.join(epochDir, 'video.mp4');
    fs.writeFileSync(realPath, 'fake video bytes');
    const staleOldPath = '/some/old/location/that/no/longer/exists/video.mp4';
    writeStaleMetadataFile(epochDir, { downloadedFilePath: staleOldPath, downloadedResolution: '1080', downloadedFormat: 'mp4' });

    const result = checkAndRepairEpochFiles({ libraryDir, videoDir, epoch });

    expect(result.videoRepaired).toBe(true);
    expect(result.videoMissing).toBe(false);
    expect(result.metadata.downloadedFilePath).toBe(realPath);
    // Repaired on disk too, not just in the returned result -- any other
    // consumer reading metadata.json directly must see the fix as well.
    expect(readMetadata(videoDir, epoch).downloadedFilePath).toBe(realPath);
  });

  it('repairs a stale downloadedAudioFilePath the same way', () => {
    const { epochDir, videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);
    const realPath = path.join(epochDir, 'audio.mp3');
    fs.writeFileSync(realPath, 'fake audio bytes');
    writeStaleMetadataFile(epochDir, { downloadedAudioFilePath: '/old/audio.mp3' });

    const result = checkAndRepairEpochFiles({ libraryDir, videoDir, epoch });

    expect(result.audioRepaired).toBe(true);
    expect(result.audioMissing).toBe(false);
    expect(result.metadata.downloadedAudioFilePath).toBe(realPath);
  });

  it('reports videoMissing (and leaves the stored path untouched) when no matching file exists', () => {
    const { epochDir, videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);
    const staleOldPath = '/genuinely/gone/video.mp4';
    writeStaleMetadataFile(epochDir, { downloadedFilePath: staleOldPath });

    const result = checkAndRepairEpochFiles({ libraryDir, videoDir, epoch });

    // Never invents a path and never nulls one out just because it
    // couldn't find it -- could just as easily be temporarily-unmounted
    // removable media, not a real deletion.
    expect(result.videoRepaired).toBe(false);
    expect(result.videoMissing).toBe(true);
    expect(result.metadata.downloadedFilePath).toBe(staleOldPath);
    expect(readMetadata(videoDir, epoch).downloadedFilePath).toBe(staleOldPath);
  });

  it('does not mistake swapLibraryDownload\'s transient video.new.<ext> temp file for the real one', () => {
    const { epochDir, videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);
    // Mid-swap temp file only -- no real video.<ext> exists yet.
    fs.writeFileSync(path.join(epochDir, 'video.new.mp4'), 'in-progress swap bytes');
    const staleOldPath = '/old/video.mp4';
    writeStaleMetadataFile(epochDir, { downloadedFilePath: staleOldPath });

    const result = checkAndRepairEpochFiles({ libraryDir, videoDir, epoch });

    expect(result.videoRepaired).toBe(false);
    expect(result.videoMissing).toBe(true);
  });

  it('leaves an already-valid downloadedFilePath alone (no unnecessary write, no false repair flag)', () => {
    const { epochDir, videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);
    const realPath = path.join(epochDir, 'video.mp4');
    fs.writeFileSync(realPath, 'fake video bytes');
    recordLibraryDownload({ videoDir, epoch, filePath: realPath, resolution: '1080', format: 'mp4' });

    const result = checkAndRepairEpochFiles({ libraryDir, videoDir, epoch });

    expect(result.videoRepaired).toBe(false);
    expect(result.videoMissing).toBe(false);
    expect(result.metadata.downloadedFilePath).toBe(realPath);
  });

  it('reports neither missing nor repaired when nothing was ever downloaded', () => {
    const { videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);

    const result = checkAndRepairEpochFiles({ libraryDir, videoDir, epoch });

    expect(result).toMatchObject({ videoRepaired: false, audioRepaired: false, videoMissing: false, audioMissing: false });
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

  it('starts a new scan when only the libraryTag changes, same libraryDir', async () => {
    createLibraryTag(libraryDir, 'Music');
    writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ uploader: 'Default Channel' }) });
    writeLibraryEntry({ libraryDir, libraryTag: 'Music', videoMetaData: baseVideoMetaData({ uploader: 'Music Channel' }) });

    const defaultIndex = await getLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME);
    const musicIndex = await getLibraryIndex(libraryDir, 'Music');

    expect(defaultIndex).not.toBe(musicIndex);
    expect(defaultIndex.channels.map((c) => c.displayName)).toEqual(['Default Channel']);
    expect(musicIndex.channels.map((c) => c.displayName)).toEqual(['Music Channel']);
    // Re-requesting the first tag still hits the cache rather than re-scanning.
    expect(getLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toBe(getLibraryIndex(libraryDir, DEFAULT_LIBRARY_DIR_NAME));
  });
});

describe('listLibraryTags / createLibraryTag', () => {
  it('returns [] for a libraryDir with nothing written yet', () => {
    expect(listLibraryTags(libraryDir)).toEqual([]);
  });

  it('lists DefaultLibrary once something has been written to it', () => {
    writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const tags = listLibraryTags(libraryDir);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tagName: DEFAULT_LIBRARY_DIR_NAME, folderName: DEFAULT_LIBRARY_DIR_NAME });
    expect(typeof tags[0].createdEpoch).toBe('number');
  });

  it('ignores a sibling folder with no library.json', () => {
    fs.mkdirSync(path.join(libraryDir, 'Not A Library'), { recursive: true });
    expect(listLibraryTags(libraryDir)).toEqual([]);
  });

  it('createLibraryTag creates the folder + library.json eagerly, sorted oldest-first', () => {
    const tag = createLibraryTag(libraryDir, 'Music');
    expect(tag.folderName).toBe('Music');
    expect(fs.existsSync(path.join(libraryDir, 'Music', 'library.json'))).toBe(true);

    createLibraryTag(libraryDir, 'Later Tag');
    const tags = listLibraryTags(libraryDir);
    expect(tags.map((t) => t.folderName)).toEqual(['Music', 'Later Tag']);
  });

  it('createLibraryTag sanitizes the requested name the same way channel names are', () => {
    const tag = createLibraryTag(libraryDir, 'My/Tag');
    expect(tag.folderName).toBe('My_Tag');
  });

  it('createLibraryTag refuses a name that already exists, valid tag or not', () => {
    createLibraryTag(libraryDir, 'Music');
    expect(() => createLibraryTag(libraryDir, 'Music')).toThrow(/already exists/);

    fs.mkdirSync(path.join(libraryDir, 'Random Folder'), { recursive: true });
    expect(() => createLibraryTag(libraryDir, 'Random Folder')).toThrow(/already exists/);
  });

  it('createLibraryTag throws when no libraryDir is configured', () => {
    expect(() => createLibraryTag('', 'Music')).toThrow(/No library folder is configured/);
  });

  it('reads a pre-rename manifest (old tagName field, no sublibraryName) the same as a new one', () => {
    const dir = libraryTagDir(libraryDir, 'Legacy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ tagName: 'Legacy', createdEpoch: 123 }), 'utf-8');

    const tags = listLibraryTags(libraryDir);
    expect(tags).toContainEqual({ tagName: 'Legacy', folderName: 'Legacy', createdEpoch: 123 });
  });
});

describe('video tags (listVideoTags / setVideoTag / addTagToVideos)', () => {
  it('listVideoTags returns {} for a sublibrary with no tags yet', () => {
    writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    expect(listVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual({});
  });

  it('setVideoTag applies a new tag, creating the key on first use', () => {
    const { tags } = setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    expect(tags).toEqual({ TVshows: ['vid1'] });
    expect(listVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual({ TVshows: ['vid1'] });
  });

  it('setVideoTag applying an already-applied tag does not duplicate the videoId', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    const { tags } = setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    expect(tags.TVshows).toEqual(['vid1']);
  });

  it('setVideoTag removes a videoId, keeping the tag key when other videos remain under it', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid2', applied: true });

    const { tags } = setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: false });
    expect(tags).toEqual({ TVshows: ['vid2'] });
  });

  it('setVideoTag removing the last videoId under a tag deletes the tag key entirely', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    const { tags } = setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: false });
    expect(tags).toEqual({});
  });

  it('addTagToVideos appends every given videoId into one tag, deduping against what is already there', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });
    const { tags } = addTagToVideos({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoIds: ['vid1', 'vid2', 'vid3'] });
    expect(tags.games).toEqual(['vid1', 'vid2', 'vid3']);
  });

  it('addTagToVideos creates the tag key if it does not exist yet', () => {
    const { tags } = addTagToVideos({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'brandNew', videoIds: ['vid1', 'vid2'] });
    expect(tags.brandNew).toEqual(['vid1', 'vid2']);
  });

  it('setVideoTag also lazily creates the sublibrary folder, same as writeLibraryEntry does', () => {
    expect(fs.existsSync(libraryTagDir(libraryDir))).toBe(false);
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });
    expect(fs.existsSync(libraryTagDir(libraryDir))).toBe(true);
  });

  it('the tags map is read via the sublibraryName-keyed manifest and does not disturb it', () => {
    createLibraryTag(libraryDir, 'Music');
    setVideoTag({ libraryDir, libraryTag: 'Music', tagName: 'games', videoId: 'vid1', applied: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(libraryTagDir(libraryDir, 'Music'), 'library.json'), 'utf-8'));
    expect(manifest.sublibraryName).toBe('Music');
    expect(manifest.tags).toEqual({ games: ['vid1'] });
  });
});

describe('removeVideosFromTags', () => {
  it('prunes the given videoIds out of every tag, in one write', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid2', applied: true });
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });

    removeVideosFromTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, ['vid1']);

    expect(listVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual({ TVshows: ['vid2'] });
  });

  it('deletes a tag entirely once removing the given ids empties it', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    removeVideosFromTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, ['vid1']);
    expect(listVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual({});
  });

  it('is a no-op (no write) when no tag references any of the given ids', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    const manifestPath = path.join(libraryTagDir(libraryDir), 'library.json');
    const before = fs.statSync(manifestPath).mtimeMs;

    removeVideosFromTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, ['unrelated-id']);

    expect(fs.statSync(manifestPath).mtimeMs).toBe(before);
    expect(listVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual({ TVshows: ['vid1'] });
  });

  it('is a no-op when given an empty id list or a sublibrary with no manifest yet', () => {
    expect(() => removeVideosFromTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, [])).not.toThrow();
    expect(() => removeVideosFromTags(libraryDir, 'NeverCreated', ['vid1'])).not.toThrow();
  });
});

describe('transferVideoTags', () => {
  it('moves matching tag entries from the source manifest to the target, keeping tag names', () => {
    createLibraryTag(libraryDir, 'Music');
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid1', applied: true });
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'TVshows', videoId: 'vid2', applied: true });

    transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', ['vid1']);

    expect(listVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual({ TVshows: ['vid2'] });
    expect(listVideoTags(libraryDir, 'Music')).toEqual({ TVshows: ['vid1'] });
  });

  it('creates the target tag key if it does not already have that tag', () => {
    createLibraryTag(libraryDir, 'Music');
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });

    transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', ['vid1']);

    expect(listVideoTags(libraryDir, 'Music')).toEqual({ games: ['vid1'] });
  });

  it('merges into an existing target tag rather than clobbering it', () => {
    createLibraryTag(libraryDir, 'Music');
    setVideoTag({ libraryDir, libraryTag: 'Music', tagName: 'games', videoId: 'already-there', applied: true });
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });

    transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', ['vid1']);

    expect(listVideoTags(libraryDir, 'Music').games.sort()).toEqual(['already-there', 'vid1']);
  });

  it('lazily creates the target sublibrary folder if it does not exist yet', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });
    expect(fs.existsSync(libraryTagDir(libraryDir, 'Music'))).toBe(false);

    transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', ['vid1']);

    expect(fs.existsSync(libraryTagDir(libraryDir, 'Music'))).toBe(true);
  });

  it('removes an emptied tag key from the source manifest entirely', () => {
    createLibraryTag(libraryDir, 'Music');
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });

    transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', ['vid1']);

    const sourceManifest = JSON.parse(fs.readFileSync(path.join(libraryTagDir(libraryDir), 'library.json'), 'utf-8'));
    expect(sourceManifest.tags).toEqual({});
  });

  it('does not disturb untagged videos left behind in the source', () => {
    createLibraryTag(libraryDir, 'Music');
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid2', applied: true });

    transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', ['vid1']);

    expect(listVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME)).toEqual({ games: ['vid2'] });
  });

  it('is a no-op when given an empty id list or a source sublibrary with no manifest yet', () => {
    expect(() => transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', [])).not.toThrow();
    expect(() => transferVideoTags(libraryDir, 'NeverCreated', 'Music', ['vid1'])).not.toThrow();
  });

  it('is a no-op when none of the given ids are actually tagged in the source', () => {
    setVideoTag({ libraryDir, libraryTag: DEFAULT_LIBRARY_DIR_NAME, tagName: 'games', videoId: 'vid1', applied: true });
    expect(fs.existsSync(libraryTagDir(libraryDir, 'Music'))).toBe(false);

    transferVideoTags(libraryDir, DEFAULT_LIBRARY_DIR_NAME, 'Music', ['unrelated-id']);

    // No target manifest should have been created for a transfer that moved nothing.
    expect(fs.existsSync(libraryTagDir(libraryDir, 'Music'))).toBe(false);
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

describe('moveLibraryEntry', () => {
  it('refuses to move a videoDir outside the configured library folder', () => {
    expect(() => moveLibraryEntry({ libraryDir, videoDir: '/etc', targetTag: 'Music' }))
      .toThrow(/outside the configured library folder/);
  });

  it('moves the whole video folder into the target tag, under the same channel folder name', () => {
    const { videoDir, channelDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ uploader: 'Some Channel' }) });
    createLibraryTag(libraryDir, 'Music');

    const result = moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });

    const expectedVideoDir = path.join(libraryTagDir(libraryDir, 'Music'), path.basename(channelDir), path.basename(videoDir));
    expect(result.videoDir).toBe(expectedVideoDir);
    expect(fs.existsSync(videoDir)).toBe(false);
    expect(fs.existsSync(result.videoDir)).toBe(true);
  });

  it('returns the moved video\'s videoId, read from the moved metadata.json', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'tagged-vid' }) });
    const result = moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });
    expect(result.videoId).toBe('tagged-vid');
  });

  it('lazily creates the target tag folder if it does not already exist', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    expect(listLibraryTags(libraryDir).map((t) => t.folderName)).not.toContain('Music');

    const result = moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });

    expect(fs.existsSync(result.videoDir)).toBe(true);
    expect(listLibraryTags(libraryDir).map((t) => t.folderName)).toContain('Music');
  });

  it('repairs downloadedFilePath/downloadedAudioFilePath in every moved epoch to the new location', () => {
    const { videoDir, epochDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);
    const videoFile = path.join(epochDir, 'video.mp4');
    const audioFile = path.join(epochDir, 'audio.mp3');
    fs.writeFileSync(videoFile, 'fake video bytes');
    fs.writeFileSync(audioFile, 'fake audio bytes');
    recordLibraryDownload({ videoDir, epoch, filePath: videoFile, resolution: '1080', format: 'mp4' });
    recordLibraryDownload({ videoDir, epoch, filePath: audioFile, kind: 'audio' });

    const result = moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });

    const moved = readMetadata(result.videoDir, epoch);
    expect(moved.downloadedFilePath).toBe(path.join(result.videoDir, epoch, 'video.mp4'));
    expect(moved.downloadedAudioFilePath).toBe(path.join(result.videoDir, epoch, 'audio.mp3'));
    // The bytes moved with the folder, at the now-repaired path.
    expect(fs.readFileSync(moved.downloadedFilePath, 'utf-8')).toBe('fake video bytes');
  });

  it('leaves an epoch with nothing downloaded (both fields null) untouched by the repair', () => {
    const { videoDir, epochDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const epoch = String(metadata.addedEpoch);

    const result = moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });

    const moved = readMetadata(result.videoDir, epoch);
    expect(moved.downloadedFilePath).toBeNull();
    expect(moved.downloadedAudioFilePath).toBeNull();
    expect(fs.existsSync(epochDir)).toBe(false);
  });

  it('preserves clips -- clips.json resolves against the new videoDir with no repair needed', () => {
    const { videoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData() });
    const clipPath = buildClipFilePath(videoDir, 'My Clip', 'mp4');
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, 'fake clip bytes');
    const clip = recordClip({ libraryDir, videoDir, fileName: path.basename(clipPath), title: 'My Clip', durationSeconds: 5 });

    const result = moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });

    expect(listClips({ libraryDir, videoDir: result.videoDir })).toEqual([clip]);
  });

  it('copies the channel icon into the target only when the target channel folder does not already exist', () => {
    const { videoDir, channelDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ uploader: 'Some Channel' }) });
    fs.writeFileSync(path.join(channelDir, 'channel-icon.jpg'), 'source icon bytes');

    const result = moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });

    const targetChannelDir = path.dirname(result.videoDir);
    expect(fs.readFileSync(path.join(targetChannelDir, 'channel-icon.jpg'), 'utf-8')).toBe('source icon bytes');
  });

  it('does not overwrite an existing icon already sitting in the target channel folder', () => {
    const { videoDir: firstVideoDir, channelDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'vid1', uploader: 'Some Channel' }) });
    fs.writeFileSync(path.join(channelDir, 'channel-icon.jpg'), 'source icon bytes');
    // First move creates the target channel folder + copies the icon.
    moveLibraryEntry({ libraryDir, videoDir: firstVideoDir, targetTag: 'Music' });
    const targetChannelDir = path.join(libraryTagDir(libraryDir, 'Music'), path.basename(channelDir));
    fs.writeFileSync(path.join(targetChannelDir, 'channel-icon.jpg'), 'a different, already-there icon');

    const { videoDir: secondVideoDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ id: 'vid2', uploader: 'Some Channel' }) });
    moveLibraryEntry({ libraryDir, videoDir: secondVideoDir, targetTag: 'Music' });

    expect(fs.readFileSync(path.join(targetChannelDir, 'channel-icon.jpg'), 'utf-8')).toBe('a different, already-there icon');
  });

  it('refuses when the target sublibrary already has this exact video', () => {
    const { videoDir, channelDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ uploader: 'Some Channel' }) });
    const targetChannelDir = path.join(libraryTagDir(libraryDir, 'Music'), path.basename(channelDir));
    fs.mkdirSync(path.join(targetChannelDir, path.basename(videoDir)), { recursive: true });

    expect(() => moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' }))
      .toThrow(/already exists in the target sublibrary/);
    // Refused before anything was touched -- the source is still intact.
    expect(fs.existsSync(videoDir)).toBe(true);
  });

  it('does not clean up the source channel folder even when this was its only video', () => {
    const { videoDir, channelDir } = writeLibraryEntry({ libraryDir, videoMetaData: baseVideoMetaData({ uploader: 'Some Channel' }) });
    fs.writeFileSync(path.join(channelDir, 'channel-icon.jpg'), 'source icon bytes');

    moveLibraryEntry({ libraryDir, videoDir, targetTag: 'Music' });

    // Deliberately left as-is (per decided scope: moving and cleanup are
    // separate responsibilities) -- the now-video-less source channel
    // folder, and its icon, both still exist.
    expect(fs.existsSync(channelDir)).toBe(true);
    expect(fs.existsSync(path.join(channelDir, 'channel-icon.jpg'))).toBe(true);
  });
});
