import { describe, it, expect } from 'vitest';
import { formatSecondsAsClipTimestamp, parseClipTimestampSeconds } from './FfmpegUtilitiesPanel';

describe('formatSecondsAsClipTimestamp / parseClipTimestampSeconds', () => {
  it('round-trips a fractional (drag-derived) boundary through both directions', () => {
    const formatted = formatSecondsAsClipTimestamp(83.456);
    expect(formatted).toBe('00:01:23.456');
    expect(parseClipTimestampSeconds(formatted)).toBeCloseTo(83.456, 3);
  });

  it('formats a whole-second value with no fractional suffix, unchanged from before', () => {
    expect(formatSecondsAsClipTimestamp(83)).toBe('00:01:23');
    expect(formatSecondsAsClipTimestamp(3661)).toBe('01:01:01');
  });

  it('carries a rounding-up fractional remainder into the seconds place instead of emitting :60', () => {
    // 59.9996s rounds to 60.000ms of fraction, which must carry into a whole
    // extra second rather than rendering as ":60.000".
    expect(formatSecondsAsClipTimestamp(59.9996)).toBe('00:01:00');
  });

  it('parseClipTimestampSeconds parses fractional seconds correctly (not truncated)', () => {
    expect(parseClipTimestampSeconds('00:01:23.456')).toBeCloseTo(83.456, 3);
    expect(parseClipTimestampSeconds('12.5')).toBeCloseTo(12.5, 3);
  });
});
