// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClipCollectionView from './ClipCollectionView';
import type { LibraryClip } from '../../types';

function makeClip(overrides: Partial<LibraryClip> = {}): LibraryClip {
  return { id: 'clip1', fileName: 'Clip One.mp4', title: 'Clip One', createdAt: Date.UTC(2026, 0, 1), durationSeconds: 5, ...overrides };
}

function renderView(overrides: Partial<Parameters<typeof ClipCollectionView>[0]> = {}) {
  const onClipsChanged = vi.fn();
  const onEmptied = vi.fn();
  const onOpenFileLocation = vi.fn();
  const onExtractMp3 = vi.fn();
  const utils = render(
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
      {...overrides}
    />,
  );
  return { ...utils, onClipsChanged, onEmptied, onOpenFileLocation, onExtractMp3 };
}

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    deleteClip: vi.fn().mockResolvedValue({ success: true }),
  };
});

describe('ClipCollectionView', () => {
  it('renders every clip with title and formatted duration, and plays the first by default', () => {
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two', durationSeconds: 65 })];
    const { container } = renderView({ clips });
    expect(screen.getByText('Clip One')).toBeInTheDocument();
    expect(screen.getByText('Clip Two')).toBeInTheDocument();
    expect(screen.getByText(/00:01:05/)).toBeInTheDocument();
    expect(container.querySelector('video')).toHaveAttribute('src', expect.stringContaining('Clip%20One.mp4'));
  });

  it('swaps the active clip on click', async () => {
    const user = userEvent.setup();
    const clips = [makeClip(), makeClip({ id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two' })];
    const { container } = renderView({ clips });
    await user.click(screen.getByText('Clip Two'));
    expect(container.querySelector('video')).toHaveAttribute('src', expect.stringContaining('Clip%20Two.mp4'));
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
});
