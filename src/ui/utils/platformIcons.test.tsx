// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import PublicIcon from '@mui/icons-material/Public';
import { getPlatformIcon, getPlatformColor } from './platformIcons';

describe('getPlatformIcon', () => {
  it('maps a known audio-oriented platform to its audio icon', () => {
    const Icon = getPlatformIcon('soundcloud');
    expect(Icon).toBe(AudiotrackIcon);
  });

  it('falls back to the generic icon for an unknown platform', () => {
    const Icon = getPlatformIcon('someObscureExtractor');
    expect(Icon).toBe(PublicIcon);
  });

  it('falls back to the generic icon when no platform is given', () => {
    expect(getPlatformIcon(null)).toBe(PublicIcon);
    expect(getPlatformIcon(undefined)).toBe(PublicIcon);
  });

  it('renders as a real SVG icon', () => {
    const Icon = getPlatformIcon('soundcloud');
    const { container } = render(<Icon />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('getPlatformColor', () => {
  it('maps a known platform to its real brand color', () => {
    expect(getPlatformColor('soundcloud')).toBe('#FF5500');
  });

  it('falls back to a neutral grey for an unknown platform', () => {
    expect(getPlatformColor('someObscureExtractor')).toBe('#78909C');
  });

  it('falls back to the same neutral grey when no platform is given', () => {
    expect(getPlatformColor(null)).toBe('#78909C');
    expect(getPlatformColor(undefined)).toBe('#78909C');
  });

  it('gives archive.org the same neutral grey as the fallback, having no strong brand color of its own', () => {
    expect(getPlatformColor('archiveorg')).toBe('#78909C');
  });
});
