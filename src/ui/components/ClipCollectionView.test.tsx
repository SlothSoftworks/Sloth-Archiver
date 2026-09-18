// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClipCollectionView from './ClipCollectionView';
import { BackgroundPlayerProvider, useBackgroundPlayer } from '../hooks/useBackgroundPlayer.tsx';
import type { LibraryClip } from '../../types';

// Same one-shot readiness sequence LibraryVideoPlayer.test.tsx fires --
// Vidstack won't treat the <video> as playable (and offer "Add to queue")
// until these land.
function fireReadinessCascade(video: HTMLVideoElement) {
  for (const type of ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay']) {
    fireEvent(video, new Event(type));
  }
}

// A sibling under the same BackgroundPlayerProvider used to inspect the
// background player's state after an action -- returns a function, not a
// plain property, so it stays live instead of snapshotting at destructure
// time (same reasoning as LibraryVideoPlayer.test.tsx's renderWithBgProbe).
function renderWithBgProbe(overrides: Partial<Parameters<typeof ClipCollectionView>[0]> = {}) {
  let bgRef!: ReturnType<typeof useBackgroundPlayer>;
  function Probe() {
    bgRef = useBackgroundPlayer();
    return null;
  }
  const onClipsChanged = vi.fn();
  const onEmptied = vi.fn();
  const utils = render(
    <BackgroundPlayerProvider>
      <ClipCollectionView
        videoDir="/lib/c/v1"
        clips={[makeClip()]}
        onClipsChanged={onClipsChanged}
        onEmptied={onEmptied}
        onOpenFileLocation={vi.fn()}
        onExtractMp3={vi.fn()}
        extractingMp3={false}
        extractMp3Disabled={false}
        extractMp3Progress={0}
        extractMp3Error={null}
        convertFormatOptions={['mp4', 'mov', 'mkv', 'webm', 'avi']}
        onConvertClip={vi.fn()}
        convertingClip={false}
        convertClipDisabled={false}
        convertClipProgress={0}
        convertClipError={null}
        parentVideoId="video1"
        parentVideoTitle="Parent Video"
        parentThumbnailPath="/lib/c/v1/thumb.jpg"
        {...overrides}
      />
      <Probe />
    </BackgroundPlayerProvider>,
  );
  return { ...utils, getBg: () => bgRef };
}

function makeClip(overrides: Partial<LibraryClip> = {}): LibraryClip {
  return { id: 'clip1', fileName: 'Clip One.mp4', title: 'Clip One', createdAt: Date.UTC(2026, 0, 1), durationSeconds: 5, ...overrides };
}

function renderView(overrides: Partial<Parameters<typeof ClipCollectionView>[0]> = {}) {
  const onClipsChanged = vi.fn();
  const onEmptied = vi.fn();
  const onOpenFileLocation = vi.fn();
  const onExtractMp3 = vi.fn();
  const onConvertClip = vi.fn();
  const utils = render(
    <BackgroundPlayerProvider>
      <ClipCollectionView
        videoDir="/lib/c/v1"
        clips={[makeClip()]}
        onClipsChanged={onClipsChanged}
        onEmptied={onEmptied}
        onOpenFileLocation={onOpenFileLocation}
        onExtractMp3={onExtractMp3}
        extractingMp3={false}
        extractMp3Disabled={false}
        extractMp3Progress={0}
        extractMp3Error={null}
        convertFormatOptions={['mp4', 'mov', 'mkv', 'webm', 'avi']}
        onConvertClip={onConvertClip}
        convertingClip={false}
        convertClipDisabled={false}
        convertClipProgress={0}
        convertClipError={null}
        parentVideoId="video1"
        parentVideoTitle="Parent Video"
        parentThumbnailPath={null}
        {...overrides}
      />
    </BackgroundPlayerProvider>,
  );
  return { ...utils, onClipsChanged, onEmptied, onOpenFileLocation, onExtractMp3, onConvertClip };
}

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    deleteClip: vi.fn().mockResolvedValue({ success: true }),
    ensurePlayablePreview: vi.fn().mockResolvedValue({ success: true, previewPath: '/mock/preview.mp4', generated: false }),
    onPreviewGenerationProgress: vi.fn(),
    removePreviewGenerationProgressListener: vi.fn(),
  };
});

describe('ClipCollectionView', () => {
  it('shows a format tag next to each clip title, derived from its file extension', () => {
    const clips = [makeClip({ fileName: 'Clip One.mkv' }), makeClip({ id: 'clip2', fileName: 'Clip Two.webm', title: 'Clip Two' })];
    renderView({ clips });
    expect(screen.getByText('MKV')).toBeInTheDocument();
    expect(screen.getByText('WEBM')).toBeInTheDocument();
  });

  it('renders every clip with title and formatted duration, and plays the first by default', async () => {
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two', durationSeconds: 65 })];
    const { container } = renderView({ clips });
    expect(screen.getByText('Clip One')).toBeInTheDocument();
    expect(screen.getByText('Clip Two')).toBeInTheDocument();
    expect(screen.getByText(/00:01:05/)).toBeInTheDocument();
    // Vidstack assigns the playable source asynchronously, as a <source>
    // child rather than a `src` attribute directly on <video>.
    await waitFor(() => {
      expect(container.querySelector('video source')).toHaveAttribute('src', expect.stringContaining('Clip%20One.mp4'));
    });
  });

  it('swaps the active clip on click', async () => {
    const user = userEvent.setup();
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { container } = renderView({ clips });
    await user.click(screen.getByText('Clip Two'));
    await waitFor(() => {
      expect(container.querySelector('video source')).toHaveAttribute('src', expect.stringContaining('Clip%20Two.mp4'));
    });
  });

  it('deletes a clip via the confirm dialog and updates the list', async () => {
    const user = userEvent.setup();
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { onClipsChanged } = renderView({ clips });

    await user.click(screen.getByRole('button', { name: 'Delete Clip One' }));
    expect(await screen.findByText('Delete this clip?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(window.electronAPI.deleteClip).toHaveBeenCalledWith({ videoDir: '/lib/c/v1', clipId: 'clip1' }));
    expect(onClipsChanged).toHaveBeenCalledWith([clips[1]]);
  });

  it('calls onEmptied when the last clip is deleted', async () => {
    const user = userEvent.setup();
    const { onEmptied } = renderView({ clips: [makeClip()] });

    await user.click(screen.getByRole('button', { name: 'Delete Clip One' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onEmptied).toHaveBeenCalled());
  });

  it('calls onOpenFileLocation when "Open file location" is clicked', async () => {
    const user = userEvent.setup();
    const { onOpenFileLocation } = renderView();
    await user.click(screen.getByRole('button', { name: 'Open clip file location' }));
    expect(onOpenFileLocation).toHaveBeenCalled();
  });

  it('calls onExtractMp3 with the active clip when "Extract audio as MP3" is clicked', async () => {
    const user = userEvent.setup();
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { onExtractMp3 } = renderView({ clips });

    await user.click(screen.getByText('Clip Two'));
    await user.click(screen.getByRole('button', { name: 'Extract clip audio as MP3' }));

    expect(onExtractMp3).toHaveBeenCalledWith(clips[1]);
  });

  it('disables Extract MP3 and shows progress/error while extracting', () => {
    renderView({ extractingMp3: true, extractMp3Disabled: true, extractMp3Progress: 42, extractMp3Error: 'Failed to extract MP3.' });
    expect(screen.getByRole('button', { name: 'Extract clip audio as MP3' })).toBeDisabled();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('Failed to extract MP3.')).toBeInTheDocument();
  });

  it('converts the active clip in place by default (checkbox unchecked)', async () => {
    const user = userEvent.setup();
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { onConvertClip } = renderView({ clips });

    await user.click(screen.getByText('Clip Two'));
    await user.click(screen.getByRole('button', { name: 'Convert clip to a different format' }));

    expect(onConvertClip).toHaveBeenCalledWith(clips[1], 'mp4', false, false);
  });

  it('passes saveAsNewFile=true when "Save into new file" is checked', async () => {
    const user = userEvent.setup();
    const { onConvertClip } = renderView();

    await user.click(screen.getByRole('checkbox', { name: 'Save into new file' }));
    await user.click(screen.getByRole('button', { name: 'Convert clip to a different format' }));

    expect(onConvertClip).toHaveBeenCalledWith(expect.objectContaining({ id: 'clip1' }), 'mp4', true, false);
  });

  it('passes forceReencode=true when "Transcode on convert" is checked', async () => {
    const user = userEvent.setup();
    const { onConvertClip } = renderView();

    await user.click(screen.getByRole('checkbox', { name: 'Transcode on convert' }));
    await user.click(screen.getByRole('button', { name: 'Convert clip to a different format' }));

    expect(onConvertClip).toHaveBeenCalledWith(expect.objectContaining({ id: 'clip1' }), 'mp4', false, true);
  });

  it('reveals a freeform field for "Other..." and requires it before converting', async () => {
    const user = userEvent.setup();
    const { onConvertClip } = renderView();

    const selects = screen.getAllByRole('combobox');
    await user.click(selects[selects.length - 1]);
    await user.click(screen.getByRole('option', { name: 'Other...' }));
    expect(screen.getByRole('button', { name: 'Convert clip to a different format' })).toBeDisabled();

    await user.type(screen.getByLabelText('Custom convert format name'), 'flac');
    await user.click(screen.getByRole('button', { name: 'Convert clip to a different format' }));

    expect(onConvertClip).toHaveBeenCalledWith(expect.objectContaining({ id: 'clip1' }), 'flac', false, false);
  });

  it('disables Convert and shows progress/error while converting', () => {
    renderView({ convertingClip: true, convertClipDisabled: true, convertClipProgress: 17, convertClipError: 'Failed to convert.' });
    expect(screen.getByRole('button', { name: 'Convert clip to a different format' })).toBeDisabled();
    expect(screen.getByText('17%')).toBeInTheDocument();
    expect(screen.getByText('Failed to convert.')).toBeInTheDocument();
  });

  describe('Add to queue', () => {
    it('gives it the parent video\'s thumbnail and a "<video> - <clip>" title, not a blank/clip-only one', async () => {
      const user = userEvent.setup();
      const { container, getBg } = renderWithBgProbe();
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));

      expect(getBg().current).toEqual(expect.objectContaining({
        videoId: 'video1',
        title: 'Parent Video - Clip One',
        thumbnailPath: '/lib/c/v1/thumb.jpg',
        clipId: 'clip1',
      }));
    });

    it('identifies the specific active clip, not just the parent video, when the active clip changes', async () => {
      const user = userEvent.setup();
      const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
      const { container, getBg } = renderWithBgProbe({ clips });
      await user.click(screen.getByText('Clip Two'));
      const video = container.querySelector('video') as HTMLVideoElement;
      fireReadinessCascade(video);

      await user.click(screen.getByRole('button', { name: 'Add to queue' }));

      expect(getBg().current).toEqual(expect.objectContaining({ title: 'Parent Video - Clip Two', clipId: 'clip2' }));
    });
  });

  it('initialClipId opens directly into that clip instead of the first one, when it exists among the clips', async () => {
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { container } = renderView({ clips, initialClipId: 'clip2' });
    await waitFor(() => {
      expect(container.querySelector('video source')).toHaveAttribute('src', expect.stringContaining('Clip%20Two.mp4'));
    });
  });

  it('still picks initialClipId when clips arrive after mount, not just when passed synchronously up front', async () => {
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { container, rerender } = renderView({ clips: [], initialClipId: 'clip2' });
    rerender(
      <BackgroundPlayerProvider>
        <ClipCollectionView
          videoDir="/lib/c/v1"
          clips={clips}
          onClipsChanged={vi.fn()}
          onEmptied={vi.fn()}
          onOpenFileLocation={vi.fn()}
          onExtractMp3={vi.fn()}
          extractingMp3={false}
          extractMp3Disabled={false}
          extractMp3Progress={0}
          extractMp3Error={null}
          convertFormatOptions={['mp4']}
          onConvertClip={vi.fn()}
          convertingClip={false}
          convertClipDisabled={false}
          convertClipProgress={0}
          convertClipError={null}
          parentVideoId="video1"
          parentVideoTitle="Parent Video"
          parentThumbnailPath={null}
          initialClipId="clip2"
        />
      </BackgroundPlayerProvider>,
    );
    await waitFor(() => {
      expect(container.querySelector('video source')).toHaveAttribute('src', expect.stringContaining('Clip%20Two.mp4'));
    });
  });

  it('falls back to the first clip when initialClipId no longer matches any clip', async () => {
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { container } = renderView({ clips, initialClipId: 'deleted-clip' });
    await waitFor(() => {
      expect(container.querySelector('video source')).toHaveAttribute('src', expect.stringContaining('Clip%20One.mp4'));
    });
  });
});
