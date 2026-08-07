// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LibraryVideoDetail from './LibraryVideoDetail';
import type { DownloadProgressMessage } from '../../types';

let registeredCallback: ((msg: DownloadProgressMessage) => void) | null = null;

function baseMetadata(overrides: Record<string, unknown> = {}) {
  return {
    videoId: 'vid1',
    channel: 'Channel A',
    title: 'Alpha Video',
    fullTitle: 'Alpha Video',
    description: 'a description',
    thumbnail: null,
    originalUrl: 'https://youtube.com/watch?v=vid1',
    durationString: '2:00',
    uploadDate: '20260115',
    resolutions: [
      { resolution: '720', filesizeMb: '10' },
      { resolution: '480', filesizeMb: '5' },
      { resolution: 'MP3', filesizeMb: '3' },
    ],
    downloadedFilePath: null,
    downloadedResolution: null,
    downloadedFormat: null,
    downloadedAudioFilePath: null,
    ...overrides,
  };
}

function makeVideo(metadataOverrides: Record<string, unknown> = {}, videoOverrides: Record<string, unknown> = {}) {
  const metadata = baseMetadata(metadataOverrides);
  return {
    videoFolderName: 'vidA',
    videoDir: '/lib/Channel A/vidA',
    latestEpoch: '100',
    metadata,
    epochs: [{ epoch: '100', metadata }],
    thumbnailPath: null,
    ...videoOverrides,
  };
}

function emit(msg: DownloadProgressMessage) {
  registeredCallback?.(msg);
}

beforeEach(() => {
  registeredCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    getCustomConvertFormats: vi.fn().mockResolvedValue({ customConvertFormats: [] }),
    onFfmpegUtilityProgress: vi.fn(),
    removeFfmpegUtilityProgressListener: vi.fn(),
    deleteVideoInfoCacheEntry: vi.fn().mockResolvedValue({ success: true, existed: true }),
    getVideoInfoPython: vi.fn(),
    addLibraryVersion: vi.fn(),
    swapLibraryDownload: vi.fn(),
    recordLibraryDownload: vi.fn().mockResolvedValue(undefined),
    openFileInDirectory: vi.fn(),
    openFileExternally: vi.fn(),
    saveExportedFile: vi.fn().mockResolvedValue({ canceled: false, filePath: '/exported/out' }),
    extractMp3FromFile: vi.fn().mockResolvedValue({ success: true }),
    convertFileFormat: vi.fn().mockResolvedValue({ success: true }),
    extractClipFromFile: vi.fn().mockResolvedValue({ success: true }),
    embedFileMetadata: vi.fn().mockResolvedValue({ success: true }),
    deleteLibraryEntry: vi.fn(),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn((cb: (msg: DownloadProgressMessage) => void) => { registeredCallback = cb; }),
    removeProgressListener: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

function renderDetail(video: ReturnType<typeof makeVideo>) {
  const onBack = vi.fn();
  const onLibraryChanged = vi.fn().mockResolvedValue(undefined);
  const onDeleted = vi.fn();
  const onVersionsChanged = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <LibraryVideoDetail
      video={video}
      onBack={onBack}
      onLibraryChanged={onLibraryChanged}
      onDeleted={onDeleted}
      onVersionsChanged={onVersionsChanged}
    />,
  );
  return { ...utils, onBack, onLibraryChanged, onDeleted, onVersionsChanged };
}

describe('LibraryVideoDetail', () => {
  it('renders the title, upload date, and back navigation', async () => {
    const video = makeVideo();
    const { onBack } = renderDetail(video);
    const user = userEvent.setup();

    expect(screen.getByText('Alpha Video')).toBeInTheDocument();
    expect(screen.getByText('2026 / Jan / 15')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to videos' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('runs the initial download flow and records it once done', async () => {
    const video = makeVideo();
    const { onVersionsChanged } = renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /720p/ }));

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({
        videoUrl: 'https://youtube.com/watch?v=vid1',
        outputPath: '/lib/Channel A/vidA/100/video',
        format: 'dflt',
        resolution: '720',
      }),
    );
    expect(screen.getByText(/Downloading \(720p\)/)).toBeInTheDocument();

    emit({ type: 'done', payload: { filename: '/lib/Channel A/vidA/100/video.mp4' } as DownloadProgressMessage['payload'] });

    await waitFor(() => expect(window.electronAPI.recordLibraryDownload).toHaveBeenCalledWith({
      videoDir: '/lib/Channel A/vidA',
      epoch: '100',
      filePath: '/lib/Channel A/vidA/100/video.mp4',
      resolution: '720',
      format: 'dflt',
      kind: 'video',
    }));
    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalled());

    expect(await screen.findByRole('button', { name: 'Open file location' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open file location' }));
    expect(window.electronAPI.openFileInDirectory).toHaveBeenCalledWith('/lib/Channel A/vidA/100/video.mp4');
  });

  it('runs the quality-swap flow, excluding the currently-downloaded resolution', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '480', downloadedFormat: 'dflt' });
    (window.electronAPI.swapLibraryDownload as ReturnType<typeof vi.fn>).mockResolvedValue(
      baseMetadata({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' }),
    );
    renderDetail(video);
    const user = userEvent.setup();

    expect(screen.getByText('480p')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download a different quality' }));

    expect(screen.getByRole('button', { name: /480p \(current\)/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /720p/ }));

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: '/lib/Channel A/vidA/100/video.new', resolution: '720' }),
    );

    emit({ type: 'done', payload: { filename: '/v/video.new.mp4' } as DownloadProgressMessage['payload'] });

    await waitFor(() => expect(window.electronAPI.swapLibraryDownload).toHaveBeenCalledWith({
      videoDir: '/lib/Channel A/vidA',
      epoch: '100',
      tempFilePath: '/v/video.new.mp4',
      oldFilePath: '/v/video.mp4',
      resolution: '720',
      format: 'dflt',
      kind: 'video',
    }));

    expect(await screen.findByText('720p')).toBeInTheDocument();
  });

  it('downloads the MP3 for the first time and records it as an audio download', async () => {
    const video = makeVideo();
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Download MP3/ }));

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: '/lib/Channel A/vidA/100/audio', resolution: 'mp3', format: 'dflt' }),
    );

    emit({ type: 'done', payload: { filename: '/lib/Channel A/vidA/100/audio.mp3' } as DownloadProgressMessage['payload'] });

    await waitFor(() => expect(window.electronAPI.recordLibraryDownload).toHaveBeenCalledWith({
      videoDir: '/lib/Channel A/vidA',
      epoch: '100',
      filePath: '/lib/Channel A/vidA/100/audio.mp3',
      resolution: 'mp3',
      format: 'dflt',
      kind: 'audio',
    }));

    expect(await screen.findByRole('button', { name: 'Open audio file location' })).toBeInTheDocument();
  });

  it('re-downloads the MP3 through the swap path when one already exists', async () => {
    const video = makeVideo({ downloadedAudioFilePath: '/v/audio.mp3' });
    (window.electronAPI.swapLibraryDownload as ReturnType<typeof vi.fn>).mockResolvedValue(
      baseMetadata({ downloadedAudioFilePath: '/v/audio.mp3' }),
    );
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Re-download MP3' }));

    expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: '/lib/Channel A/vidA/100/audio.new', resolution: 'mp3' }),
    );

    emit({ type: 'done', payload: { filename: '/v/audio.new.mp3' } as DownloadProgressMessage['payload'] });

    await waitFor(() => expect(window.electronAPI.swapLibraryDownload).toHaveBeenCalledWith({
      videoDir: '/lib/Channel A/vidA',
      epoch: '100',
      tempFilePath: '/v/audio.new.mp3',
      oldFilePath: '/v/audio.mp3',
      resolution: 'mp3',
      format: 'dflt',
      kind: 'audio',
    }));
  });

  it('switching versions swaps the displayed metadata', async () => {
    const meta100 = baseMetadata({ downloadedFilePath: '/v/100.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    const meta50 = baseMetadata({ downloadedFilePath: '/v/50.mp4', downloadedResolution: '480', downloadedFormat: 'dflt' });
    const video = makeVideo({}, {
      latestEpoch: '100',
      metadata: meta100,
      epochs: [{ epoch: '100', metadata: meta100 }, { epoch: '50', metadata: meta50 }],
    });
    renderDetail(video);
    const user = userEvent.setup();

    expect(screen.getByText('720p')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Version'));
    const options = await screen.findAllByRole('option');
    await user.click(options[1]);

    expect(await screen.findByText('480p')).toBeInTheDocument();
  });

  it('downloads a new version by re-fetching live data', async () => {
    const video = makeVideo();
    const newMetadata = baseMetadata({ title: 'Alpha Video V2' });
    (window.electronAPI.getVideoInfoPython as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, data: { response: newMetadata, fromCache: false },
    });
    (window.electronAPI.addLibraryVersion as ReturnType<typeof vi.fn>).mockResolvedValue({ epoch: '200', metadata: newMetadata });
    const { onVersionsChanged } = renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Download new version' }));

    await waitFor(() => expect(window.electronAPI.deleteVideoInfoCacheEntry).toHaveBeenCalledWith('https://youtube.com/watch?v=vid1'));
    expect(window.electronAPI.getVideoInfoPython).toHaveBeenCalledWith('https://youtube.com/watch?v=vid1');
    expect(window.electronAPI.addLibraryVersion).toHaveBeenCalledWith(newMetadata, '/lib/Channel A/vidA');
    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalled());
    expect(await screen.findByText('Alpha Video V2')).toBeInTheDocument();
  });

  it('extracts an MP3 copy from the downloaded video via the FFMPEG panel', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Extract MP3' }));

    await waitFor(() => expect(window.electronAPI.saveExportedFile).toHaveBeenCalledWith({
      defaultName: 'Alpha Video.mp3', extensions: ['mp3'], inputPath: '/v/video.mp4',
    }));
    expect(window.electronAPI.extractMp3FromFile).toHaveBeenCalledWith({ inputPath: '/v/video.mp4', outputPath: '/exported/out' });
  });

  it('converts to the default selected format without opening the picker', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Convert to a different format' }));

    await waitFor(() => expect(window.electronAPI.convertFileFormat).toHaveBeenCalledWith({
      inputPath: '/v/video.mp4', outputPath: '/exported/out', format: 'mp4',
    }));
  });

  it('converts to a custom "Other" format typed by the user', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Other...' }));
    await user.type(screen.getByLabelText('Custom format name'), 'FLAC');

    await user.click(screen.getByRole('button', { name: 'Convert to a different format' }));

    await waitFor(() => expect(window.electronAPI.convertFileFormat).toHaveBeenCalledWith({
      inputPath: '/v/video.mp4', outputPath: '/exported/out', format: 'flac',
    }));
  });

  it('extracts a clip using the entered start/end times', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Clip start'), '0:10');
    await user.type(screen.getByLabelText('Clip end'), '0:20');
    await user.click(screen.getByRole('button', { name: 'Extract clip' }));

    await waitFor(() => expect(window.electronAPI.extractClipFromFile).toHaveBeenCalledWith({
      inputPath: '/v/video.mp4', outputPath: '/exported/out', start: '0:10', end: '0:20',
    }));
  });

  it('embeds metadata into every downloaded file (video and audio) and shows a success toast', async () => {
    const video = makeVideo({
      downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt',
      downloadedAudioFilePath: '/v/audio.mp3',
    });
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Embed metadata into local file' }));

    await waitFor(() => expect(window.electronAPI.embedFileMetadata).toHaveBeenCalledWith(expect.objectContaining({
      inputPath: '/v/video.mp4', kind: 'video',
    })));
    expect(window.electronAPI.embedFileMetadata).toHaveBeenCalledWith(expect.objectContaining({
      inputPath: '/v/audio.mp3', kind: 'audio',
    }));
    expect(await screen.findByText('Metadata embedded')).toBeInTheDocument();
  });

  it('deletes the last remaining version and bounces out via onDeleted', async () => {
    const video = makeVideo();
    (window.electronAPI.deleteLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ videoDeleted: true });
    const { onLibraryChanged, onDeleted, onVersionsChanged } = renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Delete video' }));
    expect(screen.getByText('Delete this video?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(window.electronAPI.deleteLibraryEntry).toHaveBeenCalledWith('/lib/Channel A/vidA', '100');
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
    expect(onDeleted).toHaveBeenCalled();
    expect(onVersionsChanged).not.toHaveBeenCalled();
  });

  it('deletes one version while others remain, refreshing via onVersionsChanged instead', async () => {
    const meta100 = baseMetadata();
    const meta50 = baseMetadata();
    const video = makeVideo({}, {
      epochs: [{ epoch: '100', metadata: meta100 }, { epoch: '50', metadata: meta50 }],
    });
    (window.electronAPI.deleteLibraryEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ videoDeleted: false });
    const { onDeleted, onVersionsChanged } = renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Delete video' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalled());
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
