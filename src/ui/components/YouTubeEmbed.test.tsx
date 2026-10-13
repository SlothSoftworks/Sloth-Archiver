// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import YouTubeEmbed from './YouTubeEmbed';

describe('YouTubeEmbed', () => {
  it('renders an iframe pointed at the nocookie embed URL for the given video', () => {
    const { container } = render(<YouTubeEmbed videoId="abc123def45" />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abc123def45');
    expect(iframe).toHaveAttribute('title', 'YouTube video player');
    expect(iframe).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    expect(iframe).toHaveAttribute('allowfullscreen');
  });

  // SEC-009: the id is spliced into the frame URL, so a crafted one could
  // point the frame at another path/query on the embed origin.
  it('renders nothing for an id that is not a real YouTube video id', () => {
    for (const bad of ['../../evil', 'abc123def45?x=1', 'abc123def4#', 'abc123', '', 'abc123def456']) {
      const { container, unmount } = render(<YouTubeEmbed videoId={bad} />);
      expect(container.querySelector('iframe')).toBeNull();
      unmount();
    }
  });
});
