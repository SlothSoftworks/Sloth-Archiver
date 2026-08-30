// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LibraryVideoPlayer from './LibraryVideoPlayer';
import type { LibraryVideoMetadata } from '../../types';

function baseMetadata(overrides: Partial<LibraryVideoMetadata> = {}): LibraryVideoMetadata {
  return {
    videoId: 'abc123',
    channelId: null,
    channel: 'Some Channel',
    title: 'A Video',
    fullTitle: 'A Video',
    description: null,
    thumbnail: 'https://example.com/thumb.jpg',
    originalUrl: 'https://youtube.com/watch?v=abc123',
    duration: null,
    durationString: '2:00',
    uploadDate: '20260101',
    addedEpoch: 0,
    downloadedFilePath: null,
    downloadedResolution: null,
    downloadedFormat: null,
    downloadedAudioFilePath: null,
    ...overrides,
  };
}

// Vidstack assigns the actual playable source asynchronously (its provider
// setup runs via an IntersectionObserver-gated load strategy -- see
// vitest.setup.ts's stub for why that's even reachable in jsdom at all), as
// a <source> child of the <video> element rather than a `src` attribute on
// the element itself -- unlike the plain native <video src=...> this
// component rendered before the Vidstack swap.
async function findSourceEl(container: HTMLElement) {
  return waitFor(() => {
    const source = container.querySelector('video source');
    if (!source) throw new Error('source element not yet rendered');
    return source;
  }, { timeout: 2000 });
}

// jsdom never runs a real network/decode pipeline, so none of the native
// readiness events a real browser fires as a matter of course (loadstart,
// durationchange, etc.) ever happen on their own -- Vidstack's own 'play'
// event only fires once its internal state considers the media actually
// loaded, so a bare fireEvent.play(video) with no such history is silently
// ignored as noise. Firing the same minimal cascade a real load produces
// gets it there.
function fireReadinessCascade(video: HTMLVideoElement) {
  for (const type of ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay']) {
    fireEvent(video, new Event(type));
  }
}

// Real browsers populate video.error automatically alongside a genuine
// decode/network 'error' event; jsdom does neither on its own for a
// manually-dispatched Event, and Vidstack's own error handling reads
// video.error before treating the event as real -- without this, a bare
// fireEvent.error(video) is indistinguishable from noise, same as 'play'
// above.
function fireDecodeError(video: HTMLVideoElement) {
  Object.defineProperty(video, 'error', { value: { code: 4, message: 'fake decode error' }, configurable: true });
  fireEvent.error(video);
}

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    ensurePlayablePreview: vi.fn().mockResolvedValue({ success: true, previewPath: '/mock/preview.mp4', generated: false }),
    onPreviewGenerationProgress: vi.fn(),
    removePreviewGenerationProgressListener: vi.fn(),
  };
});

describe('LibraryVideoPlayer', () => {
  it('embeds the YouTube player when no local file is downloaded', () => {
    const { container } = render(<LibraryVideoPlayer metadata={baseMetadata()} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abc123');
    expect(container.querySelector('video')).toBeNull();
  });

  it('renders a local <video> for a playable extension, pointed at the app-video:// URL', async () => {
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
    );
    const source = await findSourceEl(container);
    expect(source).toHaveAttribute('src', 'app-video://local/%2Flib%2Fc%2Fv1%2F1%2Fvideo.mp4?v=0');
    expect(source).toHaveAttribute('type', 'video/mp4');
    // No backend call for an already-native-playable extension.
    expect(window.electronAPI.ensurePlayablePreview).not.toHaveBeenCalled();
  });

  it('shows a play overlay that starts playback and then disappears', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
    );
    await findSourceEl(container);
    // Scoped to the icon, not aria-label -- both this one-shot centered
    // overlay and the control bar's own PlayButton share the "Play" label
    // while paused (the control bar's own PlayArrowIcon differs).
    const overlayButton = container.querySelector('[data-testid="PlayCircleOutlineIcon"]')?.closest('button');
    expect(overlayButton).toBeInTheDocument();

    await user.click(overlayButton!);
    const video = container.querySelector('video') as HTMLVideoElement;
    fireReadinessCascade(video);
    fireEvent.play(video);

    await waitFor(() => expect(container.querySelector('[data-testid="PlayCircleOutlineIcon"]')).not.toBeInTheDocument());
  });

  it('asks the backend for a playable preview for a non-native extension, and plays the generated preview once ready', async () => {
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mkv' })} />,
    );
    expect(screen.getByText('Preparing preview...')).toBeInTheDocument();
    expect(window.electronAPI.ensurePlayablePreview).toHaveBeenCalledWith({ filePath: '/lib/c/v1/1/video.mkv' });

    const source = await findSourceEl(container);
    expect(source).toHaveAttribute('src', 'app-video://local/%2Fmock%2Fpreview.mp4?v=0');
    expect(source).toHaveAttribute('type', 'video/mp4');
    expect(screen.queryByText('Preparing preview...')).not.toBeInTheDocument();
  });

  it('shows an explanatory caption when preview generation itself fails', async () => {
    window.electronAPI.ensurePlayablePreview = vi.fn().mockResolvedValue({ success: false, message: 'ffmpeg exploded' });
    render(<LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mkv' })} />);

    expect(await screen.findByText(/Couldn't prepare a playable preview for this \.mkv file/)).toBeInTheDocument();
  });

  it('falls back to an explanatory caption when a playable-extension file errors at runtime', async () => {
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    await findSourceEl(container);
    fireDecodeError(video);

    expect(await screen.findByText(/This \.mp4 file couldn't be played here/)).toBeInTheDocument();
  });

  it('prioritizes overrideFilePath over metadata.downloadedFilePath', async () => {
    const { container } = render(
      <LibraryVideoPlayer
        metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
        overrideFilePath="/lib/c/v1/clips/My Clip.mp4"
      />,
    );
    const source = await findSourceEl(container);
    expect(source).toHaveAttribute('src', 'app-video://local/%2Flib%2Fc%2Fv1%2Fclips%2FMy%20Clip.mp4?v=0');
  });

  it('never falls back to a YouTube embed when overrideFilePath is set but empty', () => {
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: null })} overrideFilePath="" />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });
});
