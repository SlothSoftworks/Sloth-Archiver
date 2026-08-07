// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LibraryVideoPlayer from './LibraryVideoPlayer';
import type { LibraryVideoMetadata } from '../screens/LibraryVideoDetail';

function baseMetadata(overrides: Partial<LibraryVideoMetadata> = {}): LibraryVideoMetadata {
  return {
    videoId: 'abc123',
    channel: 'Some Channel',
    title: 'A Video',
    fullTitle: 'A Video',
    description: null,
    thumbnail: 'https://example.com/thumb.jpg',
    originalUrl: 'https://youtube.com/watch?v=abc123',
    durationString: '2:00',
    uploadDate: '20260101',
    downloadedFilePath: null,
    downloadedResolution: null,
    downloadedFormat: null,
    downloadedAudioFilePath: null,
    ...overrides,
  };
}

describe('LibraryVideoPlayer', () => {
  it('embeds the YouTube player when no local file is downloaded', () => {
    const { container } = render(<LibraryVideoPlayer metadata={baseMetadata()} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abc123');
    expect(container.querySelector('video')).toBeNull();
  });

  it('renders a local <video> for a playable extension, pointed at the app-video:// URL', () => {
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
    );
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('src', 'app-video://local/%2Flib%2Fc%2Fv1%2F1%2Fvideo.mp4?v=0');
    expect(video).toHaveAttribute('controlslist', 'nodownload');
  });

  it('shows a play overlay that starts playback and then disappears', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
    );
    const playButton = screen.getByRole('button', { name: 'Play' });
    expect(playButton).toBeInTheDocument();

    await user.click(playButton);
    const video = container.querySelector('video') as HTMLVideoElement;
    fireEvent.play(video);

    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
  });

  it('falls back to a static thumbnail with an explanatory caption for a known-unplayable extension', () => {
    render(<LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mkv' })} />);
    expect(screen.getByText(/Downloaded as \.mkv, which this embedded player can't play/)).toBeInTheDocument();
  });

  it('falls back to the same explanatory caption when a playable-extension file errors at runtime', () => {
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    fireEvent.error(video);

    expect(screen.getByText(/This \.mp4 file couldn't be played here/)).toBeInTheDocument();
  });
});
