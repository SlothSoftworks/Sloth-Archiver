import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateDirectorySetting,
  normalizeCustomConvertFormats,
  CUSTOM_CONVERT_FORMATS_MAX,
  pickFolderDialogOptions,
} from './settings.mjs';

describe('validateDirectorySetting (SEC-014)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-settings-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts an existing absolute directory, normalized', () => {
    expect(validateDirectorySetting(path.join(dir, 'x', '..'))).toEqual({ dir, error: null });
  });

  it('rejects a filesystem root', () => {
    const root = path.parse(dir).root;
    const result = validateDirectorySetting(root);
    expect(result.dir).toBeNull();
    expect(result.error).toMatch(/root/);
  });

  it('rejects relative, missing, non-directory and non-string values', () => {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    for (const bad of ['relative/path', path.join(dir, 'missing'), file, '', '   ', undefined, null, 42, { path: dir }]) {
      const result = validateDirectorySetting(bad);
      expect(result.dir).toBeNull();
      expect(result.error).toEqual(expect.any(String));
    }
  });
});

describe('normalizeCustomConvertFormats', () => {
  it('trims, lowercases and de-duplicates plain extensions', () => {
    expect(normalizeCustomConvertFormats([' FLV ', 'flv', 'mp3', 'Ogg'])).toEqual(['flv', 'mp3', 'ogg']);
  });

  it('drops anything that is not a short alphanumeric extension', () => {
    expect(normalizeCustomConvertFormats(['../x', 'a b', '-f', 'm4a;rm', '', 42, null, 'x'.repeat(17), 'ok'])).toEqual(['ok']);
  });

  it('returns an empty list for a non-array and caps the list length', () => {
    expect(normalizeCustomConvertFormats('mp4')).toEqual([]);
    const many = Array.from({ length: CUSTOM_CONVERT_FORMATS_MAX + 10 }, (_, i) => `f${i}`);
    expect(normalizeCustomConvertFormats(many)).toHaveLength(CUSTOM_CONVERT_FORMATS_MAX);
  });
});

describe('pickFolderDialogOptions (SEC-014)', () => {
  it('passes through only the cosmetic string fields', () => {
    expect(pickFolderDialogOptions({
      title: 'Select',
      buttonLabel: 'OK',
      defaultPath: '/home/me',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All', extensions: ['*'] }],
      securityScopedBookmarks: true,
    })).toEqual({ title: 'Select', buttonLabel: 'OK', defaultPath: '/home/me' });
  });

  it('drops non-string and empty values, and tolerates a missing options object', () => {
    expect(pickFolderDialogOptions({ title: 5, defaultPath: '' })).toEqual({});
    expect(pickFolderDialogOptions(undefined)).toEqual({});
    expect(pickFolderDialogOptions(null)).toEqual({});
  });
});
