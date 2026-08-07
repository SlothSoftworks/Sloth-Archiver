// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import YouTubeEmbed from './YouTubeEmbed';

describe('YouTubeEmbed', () => {
  it('renders an iframe pointed at the nocookie embed URL for the given video', () => {
    const { container } = render(<YouTubeEmbed videoId="abc123" />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abc123');
    expect(iframe).toHaveAttribute('title', 'YouTube video player');
    expect(iframe).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    expect(iframe).toHaveAttribute('allowfullscreen');
  });
});
