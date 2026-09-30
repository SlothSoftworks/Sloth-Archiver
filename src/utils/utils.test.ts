import { describe, it, expect } from 'vitest';
import { isValidUrl, convertYYYYMMDDStringToDate, buildAppVideoUrl, safeRemoteImageUrl, isValidYouTubeVideoId } from './utils';

describe('isValidUrl', () => {
  it('accepts well-formed URLs of any scheme', () => {
    expect(isValidUrl('https://youtube.com/watch?v=x')).toBe(true);
    expect(isValidUrl('ftp://example.com')).toBe(true);
  });

  it('rejects unparseable strings', () => {
    expect(isValidUrl('not a url')).toBe(false);
    expect(isValidUrl('')).toBe(false);
  });
});

describe('convertYYYYMMDDStringToDate', () => {
  it('formats a valid YYYYMMDD string with the default format', () => {
    expect(convertYYYYMMDDStringToDate('20260115')).toBe('2026 / Jan / 15');
  });

  it('respects a custom format string', () => {
    expect(convertYYYYMMDDStringToDate('20260115', 'YYYY-MM-DD')).toBe('2026-01-15');
  });

  it('returns null for input that is not exactly 8 characters', () => {
    expect(convertYYYYMMDDStringToDate('2026011')).toBeNull();
    expect(convertYYYYMMDDStringToDate('202601155')).toBeNull();
    expect(convertYYYYMMDDStringToDate('')).toBeNull();
  });

  it('returns null for undefined/null-ish input', () => {
    expect(convertYYYYMMDDStringToDate(undefined as unknown as string)).toBeNull();
  });
});

describe('buildAppVideoUrl', () => {
  it('builds an app-video:// URL with the path URI-encoded', () => {
    expect(buildAppVideoUrl('/a/b/My Video.mp4')).toBe('app-video://local/%2Fa%2Fb%2FMy%20Video.mp4?v=0');
  });

  it('includes a cache-busting query param when given', () => {
    expect(buildAppVideoUrl('/a/b.mp4', 42)).toBe('app-video://local/%2Fa%2Fb.mp4?v=42');
  });
});

describe('safeRemoteImageUrl (SEC-009)', () => {
  it('passes a normal https thumbnail URL through', () => {
    expect(safeRemoteImageUrl('https://i.ytimg.com/vi/abc/maxresdefault.jpg')).toBe('https://i.ytimg.com/vi/abc/maxresdefault.jpg');
  });

  it('returns undefined for empty, unparseable and non-https values', () => {
    for (const bad of [null, undefined, '', 'not a url', 'http://i.ytimg.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd']) {
      expect(safeRemoteImageUrl(bad)).toBeUndefined();
    }
  });

  it('never returns a value that can close a CSS url("...") string', () => {
    const crafted = 'https://cdn.example.com/a.jpg"); background: url("https://evil.example/x';
    const result = safeRemoteImageUrl(crafted);
    expect(result === undefined || !result.includes('"')).toBe(true);
    expect(safeRemoteImageUrl('https://cdn.example.com/a.jpg?x=\\"')).toBeUndefined();
  });
});

describe('isValidYouTubeVideoId (SEC-009)', () => {
  it('accepts real 11-character ids', () => {
    expect(isValidYouTubeVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isValidYouTubeVideoId('a-b_c123XYZ')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['', null, undefined, 'short', 'dQw4w9WgXcQQ', '../../abcde', 'dQw4w9WgXc?', 'dQw4w9WgXc#']) {
      expect(isValidYouTubeVideoId(bad)).toBe(false);
    }
  });
});
