import { describe, it, expect } from 'vitest';
import { allVideoFilter, getSupportedVideoFilters } from './constants.mjs';

describe('getSupportedVideoFilters', () => {
  it('lists the supported video formats, a separate mp3 audio filter, and an "all files" catch-all', () => {
    expect(getSupportedVideoFilters()).toEqual([
      { name: 'Video Files', extensions: ['mp4', 'mkv', '3gp'] },
      { name: 'Audio Files', extensions: ['mp3'] },
      { name: 'All Files', extensions: ['*'] },
    ]);
  });

  it('does not mutate SUPPORTED_FORMATS across calls', () => {
    const first = getSupportedVideoFilters();
    const second = getSupportedVideoFilters();
    expect(first[0].extensions).toEqual(second[0].extensions);
  });
});

describe('allVideoFilter', () => {
  it('is a single "All Files" filter matching everything', () => {
    expect(allVideoFilter).toEqual([{ name: 'All Files', extensions: ['*'] }]);
  });
});
