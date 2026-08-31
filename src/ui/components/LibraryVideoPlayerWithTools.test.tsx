// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LibraryVideoPlayerWithTools from './LibraryVideoPlayerWithTools';
import type { ClipMarkersControl } from './LibraryVideoPlayer';
import type { LibraryVideoMetadata } from '../../types';

// Real Vidstack currentTime/seekable state never updates from synthetic
// jsdom events without reverse-engineering its reactive internals (it's a
// signals-driven store fed by real HTMLMediaElement events, not a plain
// passthrough) -- not worth doing just to drive a "seek, then click Set
// Start" gesture. This fake stands in for LibraryVideoPlayer, exposing the
// same ref shape (a mutable currentTime the test can set) and rendering the
// same clip buttons LibraryVideoPlayerControls.tsx would, so this suite can
// exercise LibraryVideoPlayerWithTools's own logic (the state it derives,
// which IPC calls it makes) in isolation from Vidstack entirely.
let fakeCurrentTime = 0;
vi.mock('./LibraryVideoPlayer', () => ({
  __esModule: true,
  default: forwardRef(function FakeLibraryVideoPlayer(
    { clipMarkers }: { clipMarkers?: ClipMarkersControl },
    ref: React.ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({
      getCurrentTime: () => fakeCurrentTime,
      getDuration: () => 100,
      seekTo: () => {},
      play: () => {},
      pause: () => {},
    }));
    if (!clipMarkers) return null;
    return (
      <div>
        <button onClick={clipMarkers.onSetStart}>Set clip start</button>
        <button onClick={clipMarkers.onSetEnd}>Set clip end</button>
        <button onClick={clipMarkers.onSave} disabled={clipMarkers.saveDisabled}>Save clip</button>
        <button onClick={clipMarkers.onClear} disabled={clipMarkers.clearDisabled}>Clear clip selection</button>
      </div>
    );
  }),
}));

function baseMetadata(overrides: Partial<LibraryVideoMetadata> = {}): LibraryVideoMetadata {
  return {
    videoId: 'abc123',
    channelId: null,
    channel: 'Some Channel',
    title: 'A Video',
    fullTitle: 'A Video',
    description: null,
    thumbnail: null,
    originalUrl: 'https://youtube.com/watch?v=abc123',
    duration: null,
    durationString: '2:00',
    uploadDate: '20260101',
    addedEpoch: 0,
    downloadedFilePath: '/lib/c/v1/1/video.mp4',
    downloadedResolution: '720',
    downloadedFormat: 'dflt',
    downloadedAudioFilePath: null,
    ...overrides,
  };
}

// Drives Set Start/Set End through the fake player above, then opens
// SaveClipDialog via the Save button.
async function openSaveClipDialog(user: ReturnType<typeof userEvent.setup>, startSeconds: number, endSeconds: number) {
  fakeCurrentTime = startSeconds;
  await user.click(screen.getByRole('button', { name: 'Set clip start' }));
  fakeCurrentTime = endSeconds;
  await user.click(screen.getByRole('button', { name: 'Set clip end' }));
  await user.click(screen.getByRole('button', { name: 'Save clip' }));
}

beforeEach(() => {
  fakeCurrentTime = 0;
  window.electronAPI = {
    ...window.electronAPI,
    createClip: vi.fn().mockResolvedValue({
      success: true,
      clip: { id: 'clip1', fileName: 'My Clip.mp4', title: 'My Clip', createdAt: 0, durationSeconds: 10 },
    }),
    saveExportedFile: vi.fn().mockResolvedValue({ canceled: false, filePath: '/picked/My Clip.mp4' }),
    extractClipFromFile: vi.fn().mockResolvedValue({ success: true, outputPath: '/picked/My Clip.mp4' }),
    openFileInDirectory: vi.fn(),
  };
});

describe('LibraryVideoPlayerWithTools', () => {
  it('library mode: saves into the library via createClip and fires onClipCreated', async () => {
    const user = userEvent.setup();
    const onClipCreated = vi.fn();
    render(
      <LibraryVideoPlayerWithTools
        metadata={baseMetadata()}
        videoDir="/lib/c/v1"
        existingClipTitles={[]}
        convertFormatOptions={['mp4']}
        onClipCreated={onClipCreated}
      />,
    );

    await openSaveClipDialog(user, 10, 20);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Save clip' })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Clip name'), 'My Clip');
    await user.click(within(dialog).getByRole('button', { name: 'Save clip' }));

    await waitFor(() => expect(window.electronAPI.createClip).toHaveBeenCalledWith({
      videoDir: '/lib/c/v1', inputPath: '/lib/c/v1/1/video.mp4', start: '00:00:10', end: '00:00:20', format: 'source', clipName: 'My Clip', forceReencode: false,
    }));
    expect(onClipCreated).toHaveBeenCalledWith({ id: 'clip1', fileName: 'My Clip.mp4', title: 'My Clip', createdAt: 0, durationSeconds: 10 });
    expect(window.electronAPI.saveExportedFile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('library mode: "Save as file" diverts the save to a file export instead of the library, and shows a success toast', async () => {
    const user = userEvent.setup();
    const onClipCreated = vi.fn();
    render(
      <LibraryVideoPlayerWithTools
        metadata={baseMetadata()}
        videoDir="/lib/c/v1"
        existingClipTitles={[]}
        convertFormatOptions={['mp4']}
        onClipCreated={onClipCreated}
      />,
    );

    await openSaveClipDialog(user, 10, 20);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Clip name'), 'My Clip');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Save as file' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save clip' }));

    await waitFor(() => expect(window.electronAPI.saveExportedFile).toHaveBeenCalledWith({
      defaultName: 'My Clip.mp4', extensions: ['mp4'], inputPath: '/lib/c/v1/1/video.mp4',
    }));
    expect(window.electronAPI.extractClipFromFile).toHaveBeenCalledWith({
      inputPath: '/lib/c/v1/1/video.mp4', outputPath: '/picked/My Clip.mp4', start: '00:00:10', end: '00:00:20', format: 'source', forceReencode: false,
    });
    expect(window.electronAPI.createClip).not.toHaveBeenCalled();
    expect(onClipCreated).not.toHaveBeenCalled();
    expect(await screen.findByText('Clip saved')).toBeInTheDocument();

    await user.click(screen.getByText('View'));
    expect(window.electronAPI.openFileInDirectory).toHaveBeenCalledWith('/picked/My Clip.mp4');
  });

  it('standaloneClipping: never touches the library, always exports to a picked file, and titles the dialog for it', async () => {
    const user = userEvent.setup();
    const onClipCreated = vi.fn();
    const onClipSavedToFile = vi.fn();
    render(
      <LibraryVideoPlayerWithTools
        metadata={baseMetadata()}
        convertFormatOptions={['mp4']}
        onClipCreated={onClipCreated}
        standaloneClipping
        onClipSavedToFile={onClipSavedToFile}
      />,
    );

    await openSaveClipDialog(user, 5, 15);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Save clip to file' })).toBeInTheDocument();
    // No library-mode-only checkbox in standalone mode -- exporting to a
    // file already is the only outcome.
    expect(within(dialog).queryByRole('checkbox', { name: 'Save as file' })).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Clip name'), 'Standalone Clip');
    await user.click(within(dialog).getByRole('button', { name: 'Save clip' }));

    await waitFor(() => expect(window.electronAPI.extractClipFromFile).toHaveBeenCalledWith({
      inputPath: '/lib/c/v1/1/video.mp4', outputPath: '/picked/My Clip.mp4', start: '00:00:05', end: '00:00:15', format: 'source', forceReencode: false,
    }));
    expect(window.electronAPI.createClip).not.toHaveBeenCalled();
    expect(onClipCreated).not.toHaveBeenCalled();
    expect(onClipSavedToFile).toHaveBeenCalledWith('/picked/My Clip.mp4');
  });

  it('cancelling the native save dialog leaves the clip range and dialog open, without exporting anything', async () => {
    window.electronAPI.saveExportedFile = vi.fn().mockResolvedValue({ canceled: true });
    const user = userEvent.setup();
    render(
      <LibraryVideoPlayerWithTools
        metadata={baseMetadata()}
        convertFormatOptions={['mp4']}
        standaloneClipping
      />,
    );

    await openSaveClipDialog(user, 5, 15);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Clip name'), 'Standalone Clip');
    await user.click(within(dialog).getByRole('button', { name: 'Save clip' }));

    await waitFor(() => expect(window.electronAPI.saveExportedFile).toHaveBeenCalled());
    expect(window.electronAPI.extractClipFromFile).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('disables the Save button in the player controls until both a start and end are set', async () => {
    const user = userEvent.setup();
    render(
      <LibraryVideoPlayerWithTools
        metadata={baseMetadata()}
        videoDir="/lib/c/v1"
        existingClipTitles={[]}
        convertFormatOptions={['mp4']}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save clip' })).toBeDisabled();
    fakeCurrentTime = 10;
    await user.click(screen.getByRole('button', { name: 'Set clip start' }));
    expect(screen.getByRole('button', { name: 'Save clip' })).toBeDisabled();
    fakeCurrentTime = 20;
    await user.click(screen.getByRole('button', { name: 'Set clip end' }));
    expect(screen.getByRole('button', { name: 'Save clip' })).toBeEnabled();
  });
});
