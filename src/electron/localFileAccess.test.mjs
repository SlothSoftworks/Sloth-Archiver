import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLocalFileAccess, validateOpenablePath, isSameFile } from './localFileAccess.mjs';

let workDir;
let libraryDir;
let outsideDir;
let previewDir;

beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-localfile-test-')));
  libraryDir = path.join(workDir, 'library');
  outsideDir = path.join(workDir, 'elsewhere');
  previewDir = path.join(workDir, 'previews');
  fs.mkdirSync(libraryDir);
  fs.mkdirSync(outsideDir);
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeFile(filePath, contents = 'bytes') {
  fs.writeFileSync(filePath, contents);
  return filePath;
}

describe('validateOpenablePath', () => {
  it('accepts an existing video file and reports its size', () => {
    const filePath = writeFile(path.join(outsideDir, 'clip.mkv'), '12345');
    expect(validateOpenablePath(filePath)).toEqual({ success: true, filePath, sizeBytes: 5 });
  });

  it('accepts an upper-case extension', () => {
    const filePath = writeFile(path.join(outsideDir, 'CLIP.MP4'));
    expect(validateOpenablePath(filePath).success).toBe(true);
  });

  it.each([
    ['a relative path', 'clip.mp4'],
    ['a non-string', 42],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(validateOpenablePath(value)).toEqual({ success: false, message: 'Not a valid file path.' });
  });

  it('rejects a missing file', () => {
    expect(validateOpenablePath(path.join(outsideDir, 'gone.mp4'))).toEqual({ success: false, message: 'File not found.' });
  });

  it('rejects a directory even with a video extension', () => {
    const dirPath = path.join(outsideDir, 'folder.mp4');
    fs.mkdirSync(dirPath);
    expect(validateOpenablePath(dirPath)).toEqual({ success: false, message: 'Not a file.' });
  });

  it('rejects a non-video extension', () => {
    const filePath = writeFile(path.join(outsideDir, 'notes.txt'));
    expect(validateOpenablePath(filePath)).toEqual({ success: false, message: 'Not a supported video file.' });
  });
});

describe('isSameFile', () => {
  it('is true for the same path', () => {
    const filePath = writeFile(path.join(outsideDir, 'a.mp4'));
    expect(isSameFile(filePath, filePath)).toBe(true);
  });

  it('is true through a symlink', () => {
    const filePath = writeFile(path.join(outsideDir, 'a.mp4'));
    const linkPath = path.join(outsideDir, 'link.mp4');
    fs.symlinkSync(filePath, linkPath);
    expect(isSameFile(filePath, linkPath)).toBe(true);
  });

  it('is true through a hard link', () => {
    const filePath = writeFile(path.join(outsideDir, 'a.mp4'));
    const linkPath = path.join(outsideDir, 'hard.mp4');
    fs.linkSync(filePath, linkPath);
    expect(isSameFile(filePath, linkPath)).toBe(true);
  });

  it('is true for a different letter case on a case-insensitive disk', () => {
    const filePath = writeFile(path.join(outsideDir, 'a.mp4'));
    const upper = path.join(outsideDir, 'A.MP4');
    // Only meaningful where the disk ignores case (macOS/Windows defaults).
    if (!fs.existsSync(upper)) return;
    expect(isSameFile(filePath, upper)).toBe(true);
  });

  it('is false for two different files, or an output that does not exist yet', () => {
    const a = writeFile(path.join(outsideDir, 'a.mp4'));
    const b = writeFile(path.join(outsideDir, 'b.mp4'));
    expect(isSameFile(a, b)).toBe(false);
    expect(isSameFile(a, path.join(outsideDir, 'new.mp3'))).toBe(false);
  });
});

describe('createLocalFileAccess', () => {
  it('reads library files, and opened files only after they are remembered', () => {
    const access = createLocalFileAccess({ previewDir });
    const libraryFile = writeFile(path.join(libraryDir, 'v.mp4'));
    const outsideFile = writeFile(path.join(outsideDir, 'v.mkv'));

    expect(access.resolveReadableInput(libraryDir, libraryFile)).toBe(libraryFile);
    expect(access.resolveReadableInput(libraryDir, outsideFile)).toBeNull();

    access.rememberReadable(outsideFile);
    expect(access.isOpened(outsideFile)).toBe(true);
    expect(access.resolveReadableInput(libraryDir, outsideFile)).toBe(outsideFile);
    expect(access.resolveReadableInput(libraryDir, path.join(outsideDir, 'other.mkv'))).toBeNull();
    expect(access.isOpened('')).toBe(false);
  });

  it('keeps separate registries per instance', () => {
    const a = createLocalFileAccess({ previewDir });
    const b = createLocalFileAccess({ previewDir });
    const outsideFile = writeFile(path.join(outsideDir, 'v.mkv'));
    a.rememberReadable(outsideFile);
    expect(b.isOpened(outsideFile)).toBe(false);
  });

  it('puts previews in its own folder with a stable per-file name', () => {
    const access = createLocalFileAccess({ previewDir });
    const first = access.previewPathFor(path.join(outsideDir, 'v.mkv'));
    expect(path.dirname(first)).toBe(previewDir);
    expect(first).toMatch(/\.mp4$/);
    expect(access.previewPathFor(path.join(outsideDir, 'v.mkv'))).toBe(first);
    expect(access.previewPathFor(path.join(outsideDir, 'w.mkv'))).not.toBe(first);
  });

  it('clearPreviews empties the folder except the kept file, and tolerates a missing folder', () => {
    const access = createLocalFileAccess({ previewDir });
    access.clearPreviews();
    fs.mkdirSync(previewDir);
    const keep = writeFile(path.join(previewDir, 'keep.mp4'));
    writeFile(path.join(previewDir, 'old.mp4'));

    access.clearPreviews({ keep });
    expect(fs.readdirSync(previewDir)).toEqual(['keep.mp4']);

    access.clearPreviews();
    expect(fs.readdirSync(previewDir)).toEqual([]);
  });
});
