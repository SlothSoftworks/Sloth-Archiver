// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChangeThumbnailDialog from './ChangeThumbnailDialog';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    openImageFile: vi.fn().mockResolvedValue({ filePaths: ['/some/path/picture.jpg'], canceled: false }),
    changeThumbnail: vi.fn().mockResolvedValue({ success: true, thumbnailPath: '/video/video-thumbnail.jpg' }),
  };
});

function renderDialog(overrides: Partial<Parameters<typeof ChangeThumbnailDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onThumbnailChanged = vi.fn();
  const utils = render(
    <ChangeThumbnailDialog
      open
      onClose={onClose}
      videoDir="/library/SomeVideo"
      downloadedFilePath="/library/SomeVideo/epoch1/video.mp4"
      initialTimestampSeconds={12.5}
      onThumbnailChanged={onThumbnailChanged}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onThumbnailChanged };
}

describe('ChangeThumbnailDialog', () => {
  it('defaults to From timestamp, prefilled with the captured playback position', () => {
    renderDialog();
    expect(screen.getByRole('radio', { name: 'From timestamp' })).toBeChecked();
    expect(screen.getByLabelText('Timestamp')).toHaveValue('00:00:12.500');
  });

  it('defaults to From file when there is no downloaded video file to grab a frame from', () => {
    renderDialog({ downloadedFilePath: null });
    expect(screen.getByRole('radio', { name: 'From file' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'From timestamp' })).toBeDisabled();
  });

  it('submits the timestamp mode payload', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Change thumbnail' }));

    expect(window.electronAPI.changeThumbnail).toHaveBeenCalledWith({
      videoDir: '/library/SomeVideo',
      mode: 'timestamp',
      downloadedFilePath: '/library/SomeVideo/epoch1/video.mp4',
      timestampSeconds: 12.5,
    });
  });

  it('submits the file mode payload after picking an image', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('radio', { name: 'From file' }));
    await user.click(screen.getByRole('button', { name: 'Choose image...' }));
    await waitFor(() => expect(screen.getByText('/some/path/picture.jpg')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Change thumbnail' }));

    expect(window.electronAPI.changeThumbnail).toHaveBeenCalledWith({
      videoDir: '/library/SomeVideo',
      mode: 'file',
      imageFilePath: '/some/path/picture.jpg',
    });
  });

  it('calls onThumbnailChanged and closes on success', async () => {
    const user = userEvent.setup();
    const { onClose, onThumbnailChanged } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Change thumbnail' }));

    await waitFor(() => expect(onThumbnailChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a backend-reported error inline and keeps the dialog open', async () => {
    window.electronAPI.changeThumbnail = vi.fn().mockResolvedValue({ success: false, message: 'ffmpeg failed to extract a frame at this timestamp.' });
    const user = userEvent.setup();
    const { onClose, onThumbnailChanged } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Change thumbnail' }));

    await waitFor(() => expect(screen.getByText('ffmpeg failed to extract a frame at this timestamp.')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(onThumbnailChanged).not.toHaveBeenCalled();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
