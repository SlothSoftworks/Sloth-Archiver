import { describe, it, expect } from 'vitest';
import { secondsFromPointerX, clipMarkerPercent } from './LibraryVideoPlayerControls';

// Pure, geometry-free unit tests -- deliberately not exercised through a
// rendered tree with simulated pointer events, since jsdom's real
// getBoundingClientRect() always returns a zero-size rect (no layout engine),
// which would make any such test meaningless regardless of what it appeared
// to assert.
describe('secondsFromPointerX', () => {
  it('maps a pointer position to a proportional time within the track', () => {
    const rect = { left: 100, width: 200 };
    expect(secondsFromPointerX(100, rect, 120)).toBe(0);
    expect(secondsFromPointerX(200, rect, 120)).toBe(60);
    expect(secondsFromPointerX(300, rect, 120)).toBe(120);
  });

  it('clamps to the track bounds for a pointer position outside it', () => {
    const rect = { left: 100, width: 200 };
    expect(secondsFromPointerX(0, rect, 120)).toBe(0);
    expect(secondsFromPointerX(1000, rect, 120)).toBe(120);
  });

  it('returns 0 for a zero-width track or a zero/negative duration, rather than NaN or Infinity', () => {
    expect(secondsFromPointerX(150, { left: 100, width: 0 }, 120)).toBe(0);
    expect(secondsFromPointerX(150, { left: 100, width: 200 }, 0)).toBe(0);
    expect(secondsFromPointerX(150, { left: 100, width: 200 }, -5)).toBe(0);
  });
});

describe('clipMarkerPercent', () => {
  it('converts seconds into a 0-100 percentage of duration', () => {
    expect(clipMarkerPercent(0, 120)).toBe(0);
    expect(clipMarkerPercent(60, 120)).toBe(50);
    expect(clipMarkerPercent(120, 120)).toBe(100);
  });

  it('clamps out-of-range seconds into the 0-100 range', () => {
    expect(clipMarkerPercent(-10, 120)).toBe(0);
    expect(clipMarkerPercent(500, 120)).toBe(100);
  });

  it('returns null when there is nothing to position (no seconds, or no known duration yet)', () => {
    expect(clipMarkerPercent(null, 120)).toBeNull();
    expect(clipMarkerPercent(60, 0)).toBeNull();
    expect(clipMarkerPercent(60, NaN)).toBeNull();
  });
});
