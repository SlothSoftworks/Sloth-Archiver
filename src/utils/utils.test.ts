import { describe, it, expect } from 'vitest';
import { isValidUrl, convertYYYYMMDDStringToDate, buildAppVideoUrl, safeRemoteImageUrl, isValidYouTubeVideoId, formatDurationSeconds, formatApproxDate, estimateDownloadBytes, formatBytesApprox } from './utils';

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

describe('formatDurationSeconds', () => {
  it('uses M:SS under an hour and H:MM:SS from an hour up', () => {
    expect(formatDurationSeconds(0)).toBe('0:00');
    expect(formatDurationSeconds(7)).toBe('0:07');
    expect(formatDurationSeconds(308)).toBe('5:08');
    expect(formatDurationSeconds(3599)).toBe('59:59');
    expect(formatDurationSeconds(3600)).toBe('1:00:00');
    expect(formatDurationSeconds(2862 + 3600)).toBe('1:47:42');
    expect(formatDurationSeconds(36000 + 61)).toBe('10:01:01');
  });

  it('drops fractions of a second', () => {
    expect(formatDurationSeconds(59.9)).toBe('0:59');
  });

  it('is empty for a missing or nonsensical duration', () => {
    expect(formatDurationSeconds(null)).toBe('');
    expect(formatDurationSeconds(undefined)).toBe('');
    expect(formatDurationSeconds(NaN)).toBe('');
    expect(formatDurationSeconds(-5)).toBe('');
  });
});

describe('formatApproxDate', () => {
  // Local-time noon, so the expected calendar day holds in any time zone.
  const now = new Date(2026, 9, 11, 12, 0, 0).getTime();
  const secondsAt = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12, 0, 0).getTime() / 1000;

  it('shows the day for recent dates, in the app\'s usual date style', () => {
    expect(formatApproxDate(secondsAt(2026, 10, 4), now)).toBe('~2026 / Oct / 04');
    expect(formatApproxDate(secondsAt(2026, 8, 28), now)).toBe('~2026 / Aug / 28');
  });

  it('shows month and year once the date is more than about 45 days old', () => {
    expect(formatApproxDate(secondsAt(2026, 8, 20), now)).toBe('~Aug 2026');
    expect(formatApproxDate(secondsAt(2025, 6, 1), now)).toBe('~Jun 2025');
  });

  it('shows only the year once the date is more than about 18 months old', () => {
    expect(formatApproxDate(secondsAt(2025, 3, 1), now)).toBe('~2025');
    expect(formatApproxDate(secondsAt(2012, 7, 15), now)).toBe('~2012');
  });

  it('is empty for a missing date', () => {
    expect(formatApproxDate(null, now)).toBe('');
    expect(formatApproxDate(undefined, now)).toBe('');
    expect(formatApproxDate(NaN, now)).toBe('');
  });

  it('defaults to the current time', () => {
    expect(formatApproxDate(Date.now() / 1000)).toMatch(/^~\d{4} \/ [A-Z][a-z]{2} \/ \d{2}$/);
  });
});

describe('estimateDownloadBytes', () => {
  const HOUR = 3600;

  it('multiplies total length by a typical bitrate for the quality', () => {
    // 4000 kbps = 500,000 bytes per second.
    expect(estimateDownloadBytes([HOUR], '1080')).toEqual({ bytes: 1_800_000_000, unknownCount: 0 });
    expect(estimateDownloadBytes([600, 1200, 1800], '1080')).toEqual({ bytes: 1_800_000_000, unknownCount: 0 });
  });

  it('uses the 192 kbps this app encodes MP3 at', () => {
    expect(estimateDownloadBytes([HOUR], 'MP3')).toEqual({ bytes: 86_400_000, unknownCount: 0 });
  });

  it('gets smaller with every step down in quality', () => {
    const tiers = ['2160', '1440', '1080', '720', '480', '360', '240', '144'] as const;
    const sizes = tiers.map((tier) => estimateDownloadBytes([HOUR], tier).bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(tiers.length);
    expect(sizes[0]).toBe(7_200_000_000);
    expect(sizes[sizes.length - 1]).toBe(90_000_000);
  });

  it('leaves out videos with no usable length and counts them', () => {
    expect(estimateDownloadBytes([HOUR, null, undefined, 0, -5, NaN], '720')).toEqual({ bytes: 900_000_000, unknownCount: 5 });
    expect(estimateDownloadBytes([], '720')).toEqual({ bytes: 0, unknownCount: 0 });
  });
});

describe('formatBytesApprox', () => {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  it('keeps at most two significant figures', () => {
    expect(formatBytesApprox(1.26 * MB)).toBe('1.3 MB');
    expect(formatBytesApprox(86.4 * MB)).toBe('86 MB');
    expect(formatBytesApprox(456 * MB)).toBe('460 MB');
    expect(formatBytesApprox(1.68 * GB)).toBe('1.7 GB');
    expect(formatBytesApprox(12.4 * GB)).toBe('12 GB');
    expect(formatBytesApprox(237 * GB)).toBe('240 GB');
    expect(formatBytesApprox(3.2 * 1024 * GB)).toBe('3.2 TB');
  });

  it('moves up a unit before showing four digits', () => {
    expect(formatBytesApprox(994 * MB)).toBe('990 MB');
    expect(formatBytesApprox(999 * MB)).toBe('1 GB');
    expect(formatBytesApprox(1000 * MB)).toBe('1 GB');
    expect(formatBytesApprox(5000 * 1024 * GB)).toBe('5000 TB');
  });

  it('does not pretend to precision below a megabyte', () => {
    expect(formatBytesApprox(0)).toBe('less than 1 MB');
    expect(formatBytesApprox(500_000)).toBe('less than 1 MB');
    expect(formatBytesApprox(NaN)).toBe('less than 1 MB');
  });
});
