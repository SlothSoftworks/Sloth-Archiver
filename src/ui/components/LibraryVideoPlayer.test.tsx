// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import LibraryVideoPlayer, { type ClipMarkersControl } from './LibraryVideoPlayer';
import { BackgroundPlayerProvider, useBackgroundPlayer } from '../hooks/useBackgroundPlayer.tsx';
import type { LibraryVideoMetadata } from '../../types';

// LibraryVideoPlayer always calls useBackgroundPlayer() (for its context
// menu's "Add to queue" item), so every render in this file needs a
// provider ancestor -- shadowing the plain RTL render here means none of
// the many call sites below need their own wrapper.
function render(ui: ReactElement) {
  return rtlRender(<BackgroundPlayerProvider>{ui}</BackgroundPlayerProvider>);
}

// For tests that need to inspect background-player state after an action --
// a sibling under the same provider, same pattern already used in
// LibraryVideoDetail.test.tsx/MiniPlayerBar.test.tsx. Returns a *function*
// (not a plain property) deliberately -- destructuring a getter-backed
// property at call time would snapshot whatever bgRef was at that instant,
// not the live value after a later state update.
function renderWithBgProbe(ui: ReactElement) {
  let bgRef!: ReturnType<typeof useBackgroundPlayer>;
  function Probe() {
    bgRef = useBackgroundPlayer();
    return null;
  }
  const utils = rtlRender(
    <BackgroundPlayerProvider>
      <Probe />
      {ui}
    </BackgroundPlayerProvider>,
  );
  return { ...utils, getBg: () => bgRef };
}

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
    lastPlaybackPositionSeconds: null,
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

// The click-anywhere-to-toggle-play overlay (and now the right-click
// context-menu surface too) is an unlabeled, childless sibling of
// [data-media-provider] inside Vidstack's own root element -- :empty
// reliably picks it out from the provider (has a <video> child) and the
// controls bar (has many children).
function findClickOverlay(container: HTMLElement): HTMLElement {
  const overlay = container.querySelector('[data-media-player] > div:empty');
  if (!overlay) throw new Error('click overlay not found');
  return overlay as HTMLElement;
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
    // Excludes the always-present, unrelated hidden <video> the
    // BackgroundPlayerProvider wrapper (see this file's own render() above)
    // renders for background playback -- this assertion is about whether
    // *this* player rendered a local video, not that one.
    expect(container.querySelector('video:not([data-testid="background-player-video"])')).toBeNull();
  });

  // Regression test: videoId on a generic entry is whatever platform-native
  // id that source actually uses (e.g. a Dailymotion/SoundCloud id), not a
  // real YouTube id -- embedding it as a YouTube video used to silently try
  // (and fail) to load an unrelated or nonexistent video.
  it('shows a "Video isn\'t downloaded" message instead of a broken YouTube embed for a generic (non-YouTube) entry with nothing downloaded', () => {
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ platform: 'soundcloud' })} />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText("Video isn't downloaded.")).toBeInTheDocument();
  });

  it('still embeds the YouTube player for a plain YouTube entry (platform unset)', () => {
    const { container } = render(<LibraryVideoPlayer metadata={baseMetadata({ platform: null })} />);
    expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abc123');
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

  it('hides the poster once playback starts for a real video, but keeps it up for the whole time on an audio-only source', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4', thumbnail: 'https://example.com/thumb.jpg' })} />,
    );
    await findSourceEl(container);
    const overlayButton = container.querySelector('[data-testid="PlayCircleOutlineIcon"]')?.closest('button');
    await user.click(overlayButton!);

    const video = container.querySelector('video') as HTMLVideoElement;
    // Real browsers report the decoded frame size here once loadedmetadata
    // fires; jsdom never decodes anything, so this has to be stubbed the
    // same way fireDecodeError above stubs video.error -- Vidstack's own
    // viewType derives from these, 'audio' whenever they're 0.
    Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
    fireReadinessCascade(video);
    fireEvent.play(video);

    await waitFor(() => expect(container.querySelector('img[alt=""]')).not.toBeInTheDocument());
  });

  it('keeps the poster visible through playback for an audio-only source', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/track.mp4', thumbnail: 'https://example.com/thumb.jpg' })} />,
    );
    await findSourceEl(container);
    const overlayButton = container.querySelector('[data-testid="PlayCircleOutlineIcon"]')?.closest('button');
    await user.click(overlayButton!);

    const video = container.querySelector('video') as HTMLVideoElement;
    // jsdom's videoWidth/videoHeight already default to 0 (no real decode
    // pipeline), matching a genuine audio-only source's own dimensions in a
    // real browser -- left unstubbed here on purpose, unlike the "real
    // video" test above.
    fireReadinessCascade(video);
    fireEvent.play(video);

    await waitFor(() => expect(container.querySelector('[data-testid="PlayCircleOutlineIcon"]')).not.toBeInTheDocument());
    expect(container.querySelector('img[alt=""]')).toBeInTheDocument();
  });

  // Regression test: the poster used to be a sibling of <MediaPlayer>
  // itself, rendered after it -- since neither has an explicit z-index,
  // plain (later-wins) DOM-order stacking meant it covered the *entire*
  // player, controls included, for as long as it stayed up. That was
  // invisible before an audio-only source could keep the poster up during
  // real playback (see the previous test) -- now it has to sit inside
  // <MediaPlayer>, above the video/background but below the click-overlay,
  // queue button, and controls bar that follow it in DOM order.
  it('keeps the poster behind the player controls in DOM order, not covering them', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/track.mp4', thumbnail: 'https://example.com/thumb.jpg' })} />,
    );
    await findSourceEl(container);
    const overlayButton = container.querySelector('[data-testid="PlayCircleOutlineIcon"]')?.closest('button');
    await user.click(overlayButton!);
    const video = container.querySelector('video') as HTMLVideoElement;
    fireReadinessCascade(video);
    fireEvent.play(video);
    await waitFor(() => expect(container.querySelector('img[alt=""]')).toBeInTheDocument());

    const poster = container.querySelector('img[alt=""]') as HTMLElement;
    // A real element from inside the controls bar (LibraryVideoPlayerControls)
    // -- stands in for "the controls," which have no single wrapping
    // data-attribute of their own to query directly.
    const controls = container.querySelector('[data-testid="time-current"]') as HTMLElement;
    expect(poster).toBeInTheDocument();
    expect(controls).toBeInTheDocument();
    // DOCUMENT_POSITION_FOLLOWING (4) means `controls` comes after `poster`
    // in the tree -- the poster has to be earlier, not later, to stay behind
    // it once both are visible at the same time.
    expect(poster.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(container.querySelector('video:not([data-testid="background-player-video"])')).toBeNull();
  });

  describe('clipMarkers', () => {
    function noopClipMarkers(overrides: Partial<ClipMarkersControl> = {}): ClipMarkersControl {
      return {
        startSeconds: null,
        endSeconds: null,
        onSetStart: vi.fn(),
        onSetEnd: vi.fn(),
        onStartSecondsChange: vi.fn(),
        onEndSecondsChange: vi.fn(),
        onSave: vi.fn(),
        saveDisabled: true,
        onClear: vi.fn(),
        clearDisabled: true,
        ...overrides,
      };
    }

    it('does not render the embedded clip controls when clipMarkers is not passed (e.g. Clip Collection)', async () => {
      const { container } = render(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
      );
      await findSourceEl(container);
      expect(screen.queryByRole('button', { name: 'Set clip start' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Set clip end' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save clip' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear clip selection' })).not.toBeInTheDocument();
    });

    it('wires Set Start/Set End clicks straight through to the given callbacks', async () => {
      const user = userEvent.setup();
      const clipMarkers = noopClipMarkers();
      const { container } = render(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} clipMarkers={clipMarkers} />,
      );
      await findSourceEl(container);

      await user.click(screen.getByRole('button', { name: 'Set clip start' }));
      expect(clipMarkers.onSetStart).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: 'Set clip end' }));
      expect(clipMarkers.onSetEnd).toHaveBeenCalledTimes(1);
    });

    it('disables Save/Clear per their own props, and wires clicks through once enabled', async () => {
      const user = userEvent.setup();
      const clipMarkers = noopClipMarkers({ startSeconds: 5, endSeconds: 10, saveDisabled: false, clearDisabled: false });
      const { container } = render(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} clipMarkers={clipMarkers} />,
      );
      await findSourceEl(container);

      const saveButton = screen.getByRole('button', { name: 'Save clip' });
      expect(saveButton).toBeEnabled();
      await user.click(saveButton);
      expect(clipMarkers.onSave).toHaveBeenCalledTimes(1);

      const clearButton = screen.getByRole('button', { name: 'Clear clip selection' });
      expect(clearButton).toBeEnabled();
      await user.click(clearButton);
      expect(clipMarkers.onClear).toHaveBeenCalledTimes(1);
    });

    it('disables Save and Clear when their respective props say so', async () => {
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          clipMarkers={noopClipMarkers({ saveDisabled: true, clearDisabled: true })}
        />,
      );
      await findSourceEl(container);
      expect(screen.getByRole('button', { name: 'Save clip' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Clear clip selection' })).toBeDisabled();
    });
  });

  describe('context menu (Loop / Loop sequence)', () => {
    function noopClipMarkers(overrides: Partial<ClipMarkersControl> = {}): ClipMarkersControl {
      return {
        startSeconds: null,
        endSeconds: null,
        onSetStart: vi.fn(),
        onSetEnd: vi.fn(),
        onStartSecondsChange: vi.fn(),
        onEndSecondsChange: vi.fn(),
        onSave: vi.fn(),
        saveDisabled: true,
        onClear: vi.fn(),
        clearDisabled: true,
        ...overrides,
      };
    }

    it('right-clicking the video area suppresses the native menu and opens this app\'s own at the cursor', async () => {
      const { container } = render(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
      );
      await findSourceEl(container);

      const event = fireEvent.contextMenu(findClickOverlay(container), { clientX: 42, clientY: 24 });

      expect(event).toBe(false); // fireEvent returns false when preventDefault() was called
      expect(await screen.findByRole('menuitem', { name: 'Loop' })).toBeInTheDocument();
    });

    it('selecting Loop sets Vidstack\'s own loop state on the player', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
      );
      await findSourceEl(container);
      // Vidstack reflects its own `loop` media state as a `data-loop`
      // attribute on the player root, per its own documented convention --
      // not necessarily the native <video>.loop DOM property, which it
      // doesn't sync back to directly.
      const playerRoot = container.querySelector('[data-media-player]') as HTMLElement;
      expect(playerRoot).not.toHaveAttribute('data-loop');

      fireEvent.contextMenu(findClickOverlay(container));
      await user.click(await screen.findByRole('menuitem', { name: 'Loop' }));

      await waitFor(() => expect(playerRoot).toHaveAttribute('data-loop'));
    });

    it('Loop sequence is disabled without both clip markers set, and enabled once they are', async () => {
      const { container, rerender } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          clipMarkers={noopClipMarkers()}
        />,
      );
      await findSourceEl(container);

      fireEvent.contextMenu(findClickOverlay(container));
      expect(await screen.findByRole('menuitem', { name: 'Loop sequence' })).toHaveAttribute('aria-disabled', 'true');
      await userEvent.setup().keyboard('{Escape}');

      rerender(
        <BackgroundPlayerProvider>
          <LibraryVideoPlayer
            metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
            clipMarkers={noopClipMarkers({ startSeconds: 5, endSeconds: 10 })}
          />
        </BackgroundPlayerProvider>,
      );
      fireEvent.contextMenu(findClickOverlay(container));
      expect(await screen.findByRole('menuitem', { name: 'Loop sequence' })).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('Loop sequence stays disabled when the end marker is not after the start marker', async () => {
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          clipMarkers={noopClipMarkers({ startSeconds: 10, endSeconds: 5 })}
        />,
      );
      await findSourceEl(container);

      fireEvent.contextMenu(findClickOverlay(container));
      expect(await screen.findByRole('menuitem', { name: 'Loop sequence' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('enabling Loop sequence seeks to the start marker immediately, without touching anything else about playback', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          clipMarkers={noopClipMarkers({ startSeconds: 5, endSeconds: 10 })}
        />,
      );
      await findSourceEl(container);
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);
      video.currentTime = 0;

      fireEvent.contextMenu(findClickOverlay(container));
      await user.click(await screen.findByRole('menuitem', { name: 'Loop sequence' }));

      await waitFor(() => expect(video.currentTime).toBe(5));
      // Regression guard for the actual bug: Vidstack's own clipStartTime/
      // clipEndTime props shrink the *displayed* duration/seek range to the
      // marked span, breaking the rest of the player -- this feature must
      // never use them, only ever move currentTime.
      const playerRoot = container.querySelector('[data-media-player]') as HTMLElement;
      expect(playerRoot).not.toHaveAttribute('data-clip-start-time');
      expect(playerRoot).not.toHaveAttribute('data-clip-end-time');
    });

    it('seeks back to the start marker once playback reaches the end marker', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          clipMarkers={noopClipMarkers({ startSeconds: 5, endSeconds: 10 })}
        />,
      );
      await findSourceEl(container);
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);

      fireEvent.contextMenu(findClickOverlay(container));
      await user.click(await screen.findByRole('menuitem', { name: 'Loop sequence' }));
      await waitFor(() => expect(video.currentTime).toBe(5));

      video.currentTime = 10;
      fireEvent.timeUpdate(video);

      await waitFor(() => expect(video.currentTime).toBe(5));
    });

    it('does not seek back once Loop sequence is turned off, even past the old end marker', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          clipMarkers={noopClipMarkers({ startSeconds: 5, endSeconds: 10 })}
        />,
      );
      await findSourceEl(container);
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);

      fireEvent.contextMenu(findClickOverlay(container));
      await user.click(await screen.findByRole('menuitem', { name: 'Loop sequence' }));
      await waitFor(() => expect(video.currentTime).toBe(5));
      fireEvent.contextMenu(findClickOverlay(container));
      await user.click(screen.getByRole('menuitem', { name: 'Loop sequence' })); // toggle back off

      video.currentTime = 15;
      fireEvent.timeUpdate(video);

      expect(video.currentTime).toBe(15);
    });

    it('selecting Loop sequence turns off an already-active Loop, and vice versa', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          clipMarkers={noopClipMarkers({ startSeconds: 5, endSeconds: 10 })}
        />,
      );
      await findSourceEl(container);

      fireEvent.contextMenu(findClickOverlay(container));
      await user.click(await screen.findByRole('menuitem', { name: 'Loop' }));

      fireEvent.contextMenu(findClickOverlay(container));
      expect(await screen.findByTestId('CheckIcon')).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: 'Loop sequence' }));

      fireEvent.contextMenu(findClickOverlay(container));
      const loopItem = await screen.findByRole('menuitem', { name: 'Loop' });
      const loopSequenceItem = screen.getByRole('menuitem', { name: 'Loop sequence' });
      expect(within(loopItem).queryByTestId('CheckIcon')).not.toBeInTheDocument();
      expect(within(loopSequenceItem).getByTestId('CheckIcon')).toBeInTheDocument();
    });
  });

  describe('time display (double-click for millisecond precision)', () => {
    it('double-clicking a time display switches both it and its counterpart to millisecond precision, and double-click again reverts both', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
      );
      await findSourceEl(container);
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);
      video.currentTime = 5.25;
      fireEvent.timeUpdate(video);

      // A fractional currentTime with no ms shown yet -- confirms the plain
      // Vidstack <Time> display (which sets its own data-type attribute) is
      // the default, not the detailed one.
      expect(screen.getByTestId('time-current').textContent).not.toContain('.');
      expect(screen.getByTestId('time-duration')).toHaveAttribute('data-type', 'duration');

      await user.dblClick(screen.getByTestId('time-current'));
      await waitFor(() => expect(screen.getByTestId('time-current').textContent).toContain('.'));
      // Both displays share one toggle -- duration switches to the custom
      // (non-Vidstack-<Time>, so no data-type attribute) display too.
      expect(screen.getByTestId('time-duration')).not.toHaveAttribute('data-type');

      await user.dblClick(screen.getByTestId('time-current'));
      await waitFor(() => expect(screen.getByTestId('time-current').textContent).not.toContain('.'));
      expect(screen.getByTestId('time-duration')).toHaveAttribute('data-type', 'duration');
    });
  });

  describe('Add to queue', () => {
    it('the hover button hands the video off to the background player and pauses this one', async () => {
      const user = userEvent.setup();
      const { container, getBg } = renderWithBgProbe(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} thumbnailPath="/lib/c/v1/thumb.jpg" />,
      );
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);
      await user.click(video); // start this player's own playback first
      fireEvent.play(video);

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));

      expect(getBg().current).toEqual({
        videoId: 'abc123', title: 'A Video', channel: 'Some Channel',
        thumbnailPath: '/lib/c/v1/thumb.jpg', sourcePath: '/lib/c/v1/1/video.mp4', mimeType: 'video/mp4',
      });
      // This player's own playback stopped -- only one audio stream at a time.
      expect(video.paused).toBe(true);
    });

    it('the context menu item does the same thing', async () => {
      const user = userEvent.setup();
      const { container, getBg } = renderWithBgProbe(
        <LibraryVideoPlayer metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })} />,
      );
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);

      fireEvent.contextMenu(findClickOverlay(container));
      await user.click(await screen.findByRole('menuitem', { name: 'Add to queue' }));

      expect(getBg().current?.videoId).toBe('abc123');
    });

    it('is offered even for Clip Collection\'s own player (overrideFilePath set)', async () => {
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          overrideFilePath="/lib/c/v1/clips/My Clip.mp4"
        />,
      );
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);

      expect(screen.getByRole('button', { name: 'Add to queue' })).toBeInTheDocument();
      fireEvent.contextMenu(findClickOverlay(container));
      expect(await screen.findByRole('menuitem', { name: 'Add to queue' })).toBeInTheDocument();
    });

    it('backgroundPlayOverride supplies the payload for Clip Collection\'s own player', async () => {
      const user = userEvent.setup();
      const { container, getBg } = renderWithBgProbe(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: null, channel: 'Some Channel' })}
          overrideFilePath="/lib/c/v1/clips/My Clip.mp4"
          backgroundPlayOverride={{
            videoId: 'abc123', title: 'A Video - My Clip', thumbnailPath: '/lib/c/v1/thumb.jpg', clipId: 'clip1',
          }}
        />,
      );
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));

      expect(getBg().current).toEqual({
        videoId: 'abc123', title: 'A Video - My Clip', channel: 'Some Channel',
        thumbnailPath: '/lib/c/v1/thumb.jpg', sourcePath: '/lib/c/v1/clips/My Clip.mp4', mimeType: 'video/mp4',
        clipId: 'clip1',
      });
    });

    it('initialSeekSeconds seeks and starts playback automatically once the player can play', async () => {
      const { container } = render(
        <LibraryVideoPlayer
          metadata={baseMetadata({ downloadedFilePath: '/lib/c/v1/1/video.mp4' })}
          initialSeekSeconds={42}
        />,
      );
      await findSourceEl(container);
      const video = container.querySelector('video') as HTMLVideoElement;

      fireReadinessCascade(video); // includes 'canplay', which triggers the seek+play

      await waitFor(() => expect(video.currentTime).toBe(42));
    });
  });
});
