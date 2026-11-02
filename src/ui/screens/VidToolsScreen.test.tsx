// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { useState } from 'react';
import VidToolsScreen from './VidToolsScreen';
import type { VidToolsFile } from '../../types/electron-api';

// The real player (Vidstack, preview consent) has its own tests; this fake
// only exposes the props VidTools hands down.
vi.mock('../components/LibraryVideoPlayerWithTools', () => ({
  default: (props: { overrideFilePath?: string; standaloneClipping?: boolean; hideAddToQueue?: boolean; confirmPreview?: { kind: string } }) => (
    <div
      data-testid="fake-player"
      data-path={props.overrideFilePath}
      data-standalone={String(!!props.standaloneClipping)}
      data-hide-queue={String(!!props.hideAddToQueue)}
      data-confirm={props.confirmPreview?.kind ?? 'none'}
    />
  ),
}));

const MKV: VidToolsFile = {
  filePath: '/elsewhere/movie.mkv',
  name: 'movie.mkv',
  dir: '/elsewhere',
  sizeBytes: 50 * 1024 * 1024,
  duration: 125,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  needsPreview: true,
  previewKind: 'remux',
};

function LibraryProbe() {
  const location = useLocation();
  return <div>Library route: {JSON.stringify(location.state)}</div>;
}

function Harness({ initialFile = null }: { initialFile?: VidToolsFile | null }) {
  const [file, setFile] = useState<VidToolsFile | null>(initialFile);
  return <VidToolsScreen file={file} onFileChange={setFile} />;
}

function renderScreen(initialFile: VidToolsFile | null = null) {
  return render(
    <MemoryRouter initialEntries={['/vidtools']}>
      <Routes>
        <Route path="/vidtools" element={<Harness initialFile={initialFile} />} />
        <Route path="/library" element={<LibraryProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    getCustomConvertFormats: vi.fn().mockResolvedValue({ customConvertFormats: [] }),
    onFfmpegUtilityProgress: vi.fn(),
    removeFfmpegUtilityProgressListener: vi.fn(),
    openLocalVideoFile: vi.fn().mockResolvedValue({ canceled: false, filePaths: [MKV.filePath] }),
    openVidToolsFile: vi.fn().mockResolvedValue({ success: true, ...MKV }),
    getPathForFile: vi.fn().mockReturnValue(MKV.filePath),
    saveExportedFile: vi.fn().mockResolvedValue({ canceled: false, filePath: '/out/movie.mp3' }),
    extractMp3FromFile: vi.fn().mockResolvedValue({ success: true, outputPath: '/out/movie.mp3' }),
    convertFileFormat: vi.fn().mockResolvedValue({ success: true, outputPath: '/out/movie.mp4' }),
    openFileInDirectory: vi.fn(),
  };
});

describe('VidToolsScreen', () => {
  it('opens a picked file and shows the player in standalone mode with its info', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole('button', { name: 'Choose video' }));

    expect(window.electronAPI.openVidToolsFile).toHaveBeenCalledWith(MKV.filePath);
    const player = await screen.findByTestId('fake-player');
    expect(player).toHaveAttribute('data-path', MKV.filePath);
    expect(player).toHaveAttribute('data-standalone', 'true');
    expect(player).toHaveAttribute('data-hide-queue', 'true');
    expect(player).toHaveAttribute('data-confirm', 'remux');
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    expect(screen.getByText('50 MB')).toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
    expect(screen.getByText('1920×1080')).toBeInTheDocument();
    expect(screen.getByText('h264 / aac')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Embed metadata into local file' })).not.toBeInTheDocument();
  });

  it('skips the consent prompt for a natively playable file', async () => {
    window.electronAPI.openVidToolsFile = vi.fn().mockResolvedValue({ success: true, ...MKV, filePath: '/elsewhere/a.mp4', name: 'a.mp4', needsPreview: false });
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('button', { name: 'Choose video' }));
    expect(await screen.findByTestId('fake-player')).toHaveAttribute('data-confirm', 'none');
  });

  it('opens a dropped file through getPathForFile', async () => {
    renderScreen();
    const dropped = new File(['x'], 'movie.mkv');

    fireEvent.drop(screen.getByTestId('vidtools-drop-zone'), { dataTransfer: { files: [dropped] } });

    expect(window.electronAPI.getPathForFile).toHaveBeenCalledWith(dropped);
    await waitFor(() => expect(window.electronAPI.openVidToolsFile).toHaveBeenCalledWith(MKV.filePath));
    expect(await screen.findByTestId('fake-player')).toBeInTheDocument();
  });

  it('shows main\'s refusal and stays on the drop zone', async () => {
    window.electronAPI.openVidToolsFile = vi.fn().mockResolvedValue({ success: false, message: 'Not a supported video file.' });
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole('button', { name: 'Choose video' }));

    expect(await screen.findByText('Not a supported video file.')).toBeInTheDocument();
    expect(screen.queryByTestId('fake-player')).not.toBeInTheDocument();
  });

  it('re-opens a kept file on mount, and drops it if it has gone missing', async () => {
    window.electronAPI.openVidToolsFile = vi.fn().mockResolvedValue({ success: false, message: 'File not found.' });
    renderScreen(MKV);

    expect(window.electronAPI.openVidToolsFile).toHaveBeenCalledWith(MKV.filePath);
    expect(await screen.findByText('File not found.')).toBeInTheDocument();
    expect(screen.getByTestId('vidtools-drop-zone')).toBeInTheDocument();
  });

  it('extracts MP3 from the opened file to a picked path', async () => {
    const user = userEvent.setup();
    renderScreen(MKV);
    await screen.findByTestId('fake-player');

    await user.click(screen.getByRole('button', { name: 'Extract MP3' }));

    expect(window.electronAPI.saveExportedFile).toHaveBeenCalledWith({ defaultName: 'movie.mp3', extensions: ['mp3'], inputPath: MKV.filePath });
    expect(window.electronAPI.extractMp3FromFile).toHaveBeenCalledWith({ inputPath: MKV.filePath, outputPath: '/out/movie.mp3' });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('converts the opened file, and shows main\'s error when it refuses', async () => {
    window.electronAPI.saveExportedFile = vi.fn().mockResolvedValue({ canceled: false, filePath: MKV.filePath });
    window.electronAPI.convertFileFormat = vi.fn().mockResolvedValue({ success: false, message: 'The output file is the source file.' });
    const user = userEvent.setup();
    renderScreen(MKV);
    await screen.findByTestId('fake-player');

    await user.click(screen.getByRole('button', { name: 'Convert to a different format' }));

    expect(window.electronAPI.convertFileFormat).toHaveBeenCalledWith({ inputPath: MKV.filePath, outputPath: MKV.filePath, format: 'mp4', forceReencode: false });
    expect(await screen.findByText('The output file is the source file.')).toBeInTheDocument();
  });

  it('does nothing when the save dialog is cancelled', async () => {
    window.electronAPI.saveExportedFile = vi.fn().mockResolvedValue({ canceled: true });
    const user = userEvent.setup();
    renderScreen(MKV);
    await screen.findByTestId('fake-player');

    await user.click(screen.getByRole('button', { name: 'Extract MP3' }));

    expect(window.electronAPI.extractMp3FromFile).not.toHaveBeenCalled();
  });

  it('Show in folder, Close file and Add to library', async () => {
    const user = userEvent.setup();
    renderScreen(MKV);
    await screen.findByTestId('fake-player');

    await user.click(screen.getByRole('button', { name: 'Show in folder' }));
    expect(window.electronAPI.openFileInDirectory).toHaveBeenCalledWith(MKV.filePath);

    await user.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByText(`Library route: ${JSON.stringify({ addLocalFilePath: MKV.filePath })}`)).toBeInTheDocument();
  });

  it('Close file goes back to the drop zone', async () => {
    const user = userEvent.setup();
    renderScreen(MKV);
    await screen.findByTestId('fake-player');

    await user.click(screen.getByRole('button', { name: 'Close file' }));

    expect(screen.getByTestId('vidtools-drop-zone')).toBeInTheDocument();
  });
});
