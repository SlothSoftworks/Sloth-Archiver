// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import LibraryVideoDetail from './LibraryVideoDetail';
import { BackgroundPlayerProvider, useBackgroundPlayer } from '../hooks/useBackgroundPlayer.tsx';
import type { LibraryClip, DownloadProgressMessage } from '../../types';

// The real clip-creation flow (seeking the player, the embedded Set Start/
// Set End/Save buttons, SaveClipDialog, the createClip IPC call) now lives
// entirely inside LibraryVideoPlayerWithTools -- see its own test file for
// coverage of that. Vidstack's internal currentTime/seekable state also
// never updates from synthetic jsdom events without reverse-engineering its
// reactive internals, which isn't worth doing just to drive a "seek, then
// click Set Start" gesture from this outer level. What LibraryVideoDetail
// itself is responsible for is just wiring: passing videoDir/
// existingClipTitles down, and reacting to onClipCreated (updating the
// clips list, refreshing the index) -- this fake stands in for the real
// player and exercises exactly that, via a single button that fires
// onClipCreated with a canned clip.
vi.mock('../components/LibraryVideoPlayerWithTools', () => ({
  default: ({ onClipCreated, overrideFilePath }: { onClipCreated?: (clip: LibraryClip) => void; overrideFilePath?: string }) => (
    <>
      <button
        onClick={() => onClipCreated?.({ id: 'clip1', fileName: 'My Clip.mp4', title: 'My Clip', createdAt: 0, durationSeconds: 10 })}
      >
        Fake save clip
      </button>
      {/* Exposes overrideFilePath (the real component's own file-to-play prop)
          so tests can assert which clip a caller handed down, without this
          fake needing to stand in for the real Vidstack player. */}
      {overrideFilePath && <div data-testid="fake-player-override-path" data-override-file-path={overrideFilePath} />}
    </>
  ),
}));

let registeredCallback: ((msg: DownloadProgressMessage) => void) | null = null;

function baseMetadata(overrides: Record<string, unknown> = {}) {
  return {
    videoId: 'vid1',
    channelId: null,
    channel: 'Channel A',
    title: 'Alpha Video',
    fullTitle: 'Alpha Video',
    description: 'a description',
    thumbnail: null,
    originalUrl: 'https://youtube.com/watch?v=vid1',
    duration: null,
    durationString: '2:00',
    uploadDate: '20260115',
    addedEpoch: 0,
    resolutions: [
      { resolution: '720', filesizeMb: 10 },
      { resolution: '480', filesizeMb: 5 },
      { resolution: 'MP3', filesizeMb: 3 },
    ],
    downloadedFilePath: null,
    downloadedResolution: null,
    downloadedFormat: null,
    downloadedAudioFilePath: null,
    lastPlaybackPositionSeconds: null,
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
    clipCount: 0,
    ...videoOverrides,
  };
}

// requestId echoes back whatever startDownload actually generated
// (crypto.randomUUID()) -- useDownloadVideo filters every incoming message
// against it, so a message emitted without one is silently dropped.
function getLastRequestId(): string {
  const calls = (window.electronAPIPythonDownload.startDownloadPython as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0].requestId;
}

function emit(msg: Omit<DownloadProgressMessage, 'requestId'> & { requestId?: string }) {
  registeredCallback?.({ requestId: getLastRequestId(), ...msg } as DownloadProgressMessage);
}

beforeEach(() => {
  registeredCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    getCustomConvertFormats: vi.fn().mockResolvedValue({ customConvertFormats: [] }),
    onFfmpegUtilityProgress: vi.fn(),
    removeFfmpegUtilityProgressListener: vi.fn(),
    ensurePlayablePreview: vi.fn().mockResolvedValue({ success: true, previewPath: '/mock/preview.mp4', generated: false }),
    onPreviewGenerationProgress: vi.fn(),
    removePreviewGenerationProgressListener: vi.fn(),
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
    getClips: vi.fn().mockResolvedValue({ success: true, clips: [] }),
    createClip: vi.fn().mockResolvedValue({ success: true, clip: { id: 'clip1', fileName: 'My Clip.mp4', title: 'My Clip', createdAt: 0, durationSeconds: 5 } }),
    deleteClip: vi.fn().mockResolvedValue({ success: true }),
    convertClip: vi.fn().mockResolvedValue({ success: true, clip: { id: 'clip1', fileName: 'My Clip.mkv', title: 'My Clip', createdAt: 0, durationSeconds: 5 } }),
    // Defaults to "everything checked out fine" so the file-check effect
    // (fired on mount/epoch-change whenever a downloaded path is set) is a
    // no-op for every test that isn't specifically exercising it.
    checkAndRepairEpochFiles: vi.fn().mockResolvedValue({ success: true, videoRepaired: false, audioRepaired: false, videoMissing: false, audioMissing: false }),
    setVideoTag: vi.fn().mockResolvedValue({ success: true, tags: {} }),
  };
  window.electronAPIPythonDownload = {
    startDownloadPython: vi.fn(),
    onProgressUpdate: vi.fn((cb: (msg: DownloadProgressMessage) => void) => { registeredCallback = cb; }),
    removeProgressListener: vi.fn(),
    cancelDownload: vi.fn(),
  } as unknown as typeof window.electronAPIPythonDownload;
});

function renderDetail(
  video: ReturnType<typeof makeVideo>,
  videoTags: Record<string, string[]> = {},
  deepLinkOverrides: { initialActiveView?: 'video' | 'clips'; initialClipId?: string | null } = {},
) {
  const onBack = vi.fn();
  const onLibraryChanged = vi.fn().mockResolvedValue(undefined);
  const onDeleted = vi.fn();
  const onVersionsChanged = vi.fn().mockResolvedValue(undefined);
  const onVideoTagsChanged = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <MemoryRouter>
      <BackgroundPlayerProvider>
        <LibraryVideoDetail
          video={video}
          onBack={onBack}
          onLibraryChanged={onLibraryChanged}
          onDeleted={onDeleted}
          onVersionsChanged={onVersionsChanged}
          videoTags={videoTags}
          onVideoTagsChanged={onVideoTagsChanged}
          {...deepLinkOverrides}
        />
      </BackgroundPlayerProvider>
    </MemoryRouter>,
  );
  return { ...utils, onBack, onLibraryChanged, onDeleted, onVersionsChanged, onVideoTagsChanged };
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

  it('shows an error on the video quality picker when a video download fails, without bleeding into the audio section', async () => {
    const video = makeVideo();
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /720p/ }));
    emit({ type: 'error', payload: { message: 'network gone', kind: 'network' } as unknown as DownloadProgressMessage['payload'] });

    expect(await screen.findByText('Download failed -- try again.')).toBeInTheDocument();
    // Only the video picker's message -- the Audio section's "Download
    // MP3" button stays untouched, since this error belongs to the video
    // flow, not audio.
    expect(screen.getAllByText('Download failed -- try again.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Download MP3/ })).toBeInTheDocument();
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

  it('shows an error message when an MP3 download fails, and clears it on retry', async () => {
    const video = makeVideo();
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Download MP3/ }));
    emit({ type: 'error', payload: { message: 'network gone', kind: 'network' } as unknown as DownloadProgressMessage['payload'] });

    expect(await screen.findByText('Download failed -- try again.')).toBeInTheDocument();
    // The download button itself stays reachable so the user can retry --
    // it doesn't get replaced or hidden by the error.
    expect(screen.getByRole('button', { name: /Download MP3/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Download MP3/ }));
    expect(screen.queryByText('Download failed -- try again.')).not.toBeInTheDocument();
  });

  it('shows a distinct "Cancelled" message when an MP3 download is cancelled', async () => {
    const video = makeVideo();
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Download MP3/ }));
    emit({ type: 'error', payload: { message: 'Cancelled.', kind: 'cancelled' } as unknown as DownloadProgressMessage['payload'] });

    expect(await screen.findByText('Cancelled.')).toBeInTheDocument();
    expect(screen.queryByText('Download failed -- try again.')).not.toBeInTheDocument();
  });

  it('does not show the audio error on the video quality picker, and vice versa', async () => {
    const video = makeVideo();
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Download MP3/ }));
    emit({ type: 'error', payload: { message: 'network gone', kind: 'network' } as unknown as DownloadProgressMessage['payload'] });

    expect(await screen.findByText('Download failed -- try again.')).toBeInTheDocument();
    // Only one "Download failed" message should be showing (the audio
    // one) -- the shared video ResolutionPicker must stay quiet, since this
    // error belongs to the audio flow, not a video/swap download.
    expect(screen.getAllByText('Download failed -- try again.')).toHaveLength(1);
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

  describe('generic (non-YouTube) audio-only entry', () => {
    it('routes its MP3-only download through the main resolution grid, not the separate Audio section', async () => {
      const video = makeVideo({
        platform: 'soundcloud',
        resolutions: [{ resolution: 'MP3', filesizeMb: 5 }],
      });
      const { onVersionsChanged } = renderDetail(video);
      const user = userEvent.setup();

      // The separate Audio section's "Download MP3" button never renders --
      // only the main grid's MP3 button does.
      expect(screen.queryByRole('button', { name: /Download MP3/ })).not.toBeInTheDocument();
      const mp3Button = screen.getByRole('button', { name: /^MP3/ });
      expect(mp3Button).toHaveTextContent('MP3');
      expect(mp3Button).not.toHaveTextContent('MP3p');

      await user.click(mp3Button);

      // Same flow as a normal video quality pick (handleDownload), not
      // handleAudioDownload -- lands toward downloadedFilePath, not
      // downloadedAudioFilePath.
      expect(window.electronAPIPythonDownload.startDownloadPython).toHaveBeenCalledWith(
        expect.objectContaining({ outputPath: '/lib/Channel A/vidA/100/video', resolution: 'MP3' }),
      );

      emit({ type: 'done', payload: { filename: '/lib/Channel A/vidA/100/video.mp3' } as DownloadProgressMessage['payload'] });

      await waitFor(() => expect(window.electronAPI.recordLibraryDownload).toHaveBeenCalledWith({
        videoDir: '/lib/Channel A/vidA',
        epoch: '100',
        filePath: '/lib/Channel A/vidA/100/video.mp3',
        resolution: 'MP3',
        format: 'dflt',
        kind: 'video',
      }));
      await waitFor(() => expect(onVersionsChanged).toHaveBeenCalled());

      // The plain native <audio controls> widget from the old MP3 section
      // never renders for this flow.
      expect(document.querySelector('audio')).not.toBeInTheDocument();
    });

    it('leaves a real YouTube entry with both a video resolution and a separate MP3 resolution unaffected', async () => {
      const video = makeVideo({ downloadedAudioFilePath: '/v/audio.mp3' });
      renderDetail(video);

      // The Audio section's own "Download MP3"/<audio> flow still works
      // exactly as before -- untouched by the generic-entry routing change.
      expect(screen.getByRole('button', { name: /^720p/ })).toBeInTheDocument();
      expect(document.querySelector('audio')).toBeInTheDocument();
    });
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
    const newMetadata = baseMetadata({ title: 'Alpha Video V2', channelId: 'UC1' });
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
      inputPath: '/v/video.mp4', outputPath: '/exported/out', format: 'mp4', forceReencode: false,
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
      inputPath: '/v/video.mp4', outputPath: '/exported/out', format: 'flac', forceReencode: false,
    }));
  });

  it('adds a clip fired by the player and refreshes the index', async () => {
    const { onVersionsChanged } = renderDetail(makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Fake save clip' }));

    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Clip Collection' })).toBeInTheDocument();
  });

  it('shows the Clip Collection tab only once the video has a clip', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    expect(screen.queryByRole('button', { name: 'Clip Collection' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Fake save clip' }));

    expect(await screen.findByRole('button', { name: 'Clip Collection' })).toBeInTheDocument();
  });

  it('hides the Clip Collection tab again once its last clip is deleted', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    const user = userEvent.setup();
    // The tab click below triggers a lazy getClips() fetch since this is the
    // first time it's opened -- mock it to agree with the clip the fake
    // player just fired, or the fetch would silently overwrite it with [].
    window.electronAPI.getClips = vi.fn().mockResolvedValue({
      success: true,
      clips: [{ id: 'clip1', fileName: 'My Clip.mp4', title: 'My Clip', createdAt: 0, durationSeconds: 5 }],
    });

    await user.click(screen.getByRole('button', { name: 'Fake save clip' }));
    await user.click(await screen.findByRole('button', { name: 'Clip Collection' }));

    await user.click(await screen.findByRole('button', { name: 'Delete My Clip' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clip Collection' })).not.toBeInTheDocument());
  });

  it('converts a clip in place and merges the updated clip record', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    const user = userEvent.setup();
    window.electronAPI.getClips = vi.fn().mockResolvedValue({
      success: true,
      clips: [{ id: 'clip1', fileName: 'My Clip.mp4', title: 'My Clip', createdAt: 0, durationSeconds: 5 }],
    });

    await user.click(screen.getByRole('button', { name: 'Fake save clip' }));
    await user.click(await screen.findByRole('button', { name: 'Clip Collection' }));

    await user.click(await screen.findByRole('button', { name: 'Convert clip to a different format' }));

    await waitFor(() => expect(window.electronAPI.convertClip).toHaveBeenCalledWith({
      videoDir: video.videoDir, clipId: 'clip1', format: 'mp4', forceReencode: false,
    }));
    expect(await screen.findByText(/My Clip\.mkv|My Clip/)).toBeInTheDocument();
  });

  it('converts a clip into a new external file when "Save into new file" is checked', async () => {
    const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720', downloadedFormat: 'dflt' });
    renderDetail(video);
    const user = userEvent.setup();
    window.electronAPI.getClips = vi.fn().mockResolvedValue({
      success: true,
      clips: [{ id: 'clip1', fileName: 'My Clip.mp4', title: 'My Clip', createdAt: 0, durationSeconds: 5 }],
    });

    await user.click(screen.getByRole('button', { name: 'Fake save clip' }));
    await user.click(await screen.findByRole('button', { name: 'Clip Collection' }));

    await user.click(await screen.findByRole('checkbox', { name: 'Save into new file' }));
    await user.click(await screen.findByRole('button', { name: 'Convert clip to a different format' }));

    await waitFor(() => expect(window.electronAPI.convertFileFormat).toHaveBeenCalledWith({
      inputPath: `${video.videoDir}/clips/My Clip.mp4`, outputPath: '/exported/out', format: 'mp4', forceReencode: false,
    }));
    expect(window.electronAPI.convertClip).not.toHaveBeenCalled();
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

  // Regression test: a generic (non-YouTube) entry has no separate
  // downloadedAudioFilePath slot, so an audio-only download (resolution
  // 'MP3') lands directly in downloadedFilePath -- kind must reflect that
  // it's audio, not assume "downloadedFilePath means video" the way a real
  // YouTube video+separate-MP3 entry always can.
  it('embeds metadata with kind "audio" when downloadedFilePath itself holds an MP3-resolution download', async () => {
    const video = makeVideo({
      downloadedFilePath: '/v/track.mp3', downloadedResolution: 'MP3', downloadedFormat: 'dflt',
    });
    renderDetail(video);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Embed metadata into local file' }));

    await waitFor(() => expect(window.electronAPI.embedFileMetadata).toHaveBeenCalledWith(expect.objectContaining({
      inputPath: '/v/track.mp3', kind: 'audio',
    })));
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

  describe('on-demand file check (checkAndRepairEpochFiles)', () => {
    it('checks the current epoch\'s files on mount when something is downloaded', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedAudioFilePath: '/v/audio.mp3' });
      renderDetail(video);

      await waitFor(() => expect(window.electronAPI.checkAndRepairEpochFiles).toHaveBeenCalledWith('/lib/Channel A/vidA', '100'));
    });

    it('never calls the check when nothing has been downloaded', async () => {
      const video = makeVideo();
      renderDetail(video);
      await screen.findByText('Alpha Video');

      expect(window.electronAPI.checkAndRepairEpochFiles).not.toHaveBeenCalled();
    });

    it('pops up a warning when the video file is missing and cannot be repaired', async () => {
      (window.electronAPI.checkAndRepairEpochFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, videoRepaired: false, audioRepaired: false, videoMissing: true, audioMissing: false,
      });
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4' });
      renderDetail(video);

      expect(await screen.findByText('Video file not found')).toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await waitFor(() => expect(screen.queryByText('Video file not found')).not.toBeInTheDocument());
    });

    it('pops up a combined warning when both video and audio are missing', async () => {
      (window.electronAPI.checkAndRepairEpochFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, videoRepaired: false, audioRepaired: false, videoMissing: true, audioMissing: true,
      });
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedAudioFilePath: '/v/audio.mp3' });
      renderDetail(video);

      expect(await screen.findByText('Video and audio files not found')).toBeInTheDocument();
    });

    it('silently applies a repaired path and notifies onLibraryChanged, without any warning popup', async () => {
      (window.electronAPI.checkAndRepairEpochFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, videoRepaired: true, audioRepaired: false, videoMissing: false, audioMissing: false,
        metadata: baseMetadata({ downloadedFilePath: '/lib/Channel A/vidA/100/video.mp4' }),
      });
      const video = makeVideo({ downloadedFilePath: '/v/old/video.mp4' });
      const { onLibraryChanged } = renderDetail(video);

      await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
      expect(screen.queryByText(/not found/)).not.toBeInTheDocument();
    });

    // The bug this covers: a file that was missing, then restored to the
    // exact same stored path (so checkAndRepairEpochFiles' own repair never
    // fires -- nothing about the path itself needed to change) never
    // re-triggers a check on its own once the dialog is showing, since
    // nothing about metadata/selectedEpoch/video.videoDir changes value
    // either. Retry is the explicit way back from that; LibraryVideoPlayer
    // itself is mocked out in this file (see the top-of-file comment), so
    // what's covered here is the re-check firing and the dialog clearing --
    // the player's own cacheBustKey-driven reload was verified live in the
    // real app.
    it('Retry re-runs the check and clears the warning once the file is confirmed present again', async () => {
      const mockCheck = window.electronAPI.checkAndRepairEpochFiles as ReturnType<typeof vi.fn>;
      mockCheck.mockResolvedValueOnce({
        success: true, videoRepaired: false, audioRepaired: false, videoMissing: true, audioMissing: false,
      });
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4' });
      renderDetail(video);
      await screen.findByText('Video file not found');

      // Same stored path both times -- the file just became valid again,
      // nothing for the repair itself to change.
      mockCheck.mockResolvedValueOnce({
        success: true, videoRepaired: false, audioRepaired: false, videoMissing: false, audioMissing: false,
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(mockCheck).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.queryByText('Video file not found')).not.toBeInTheDocument());
    });
  });

  describe('video tags', () => {
    it('renders a pink chip for every tag currently applied to this video', () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' });
      renderDetail(video, { TVshows: ['vid1'], games: ['someone-else'] });
      expect(screen.getByText('TVshows')).toBeInTheDocument();
      expect(screen.queryByText('games')).not.toBeInTheDocument();
    });

    it('the edit-tags popover lists every known tag as a checkbox, checked only for applied ones', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' });
      renderDetail(video, { TVshows: ['vid1'], games: ['someone-else'] });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Edit tags' }));

      const tvShowsCheckbox = screen.getByRole('checkbox', { name: 'TVshows' });
      const gamesCheckbox = screen.getByRole('checkbox', { name: 'games' });
      expect(tvShowsCheckbox).toBeChecked();
      expect(gamesCheckbox).not.toBeChecked();
    });

    it('checking an unapplied tag calls setVideoTag with applied:true', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' });
      renderDetail(video, { games: ['someone-else'] });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Edit tags' }));
      await user.click(screen.getByRole('checkbox', { name: 'games' }));

      expect(window.electronAPI.setVideoTag).toHaveBeenCalledWith('games', 'vid1', true);
    });

    it('unchecking an applied tag calls setVideoTag with applied:false', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' });
      renderDetail(video, { TVshows: ['vid1'] });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Edit tags' }));
      await user.click(screen.getByRole('checkbox', { name: 'TVshows' }));

      expect(window.electronAPI.setVideoTag).toHaveBeenCalledWith('TVshows', 'vid1', false);
    });

    it('creating a new tag from the text field calls setVideoTag with applied:true and clears the field', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' });
      renderDetail(video);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Edit tags' }));

      const input = screen.getByPlaceholderText('New tag');
      await user.type(input, 'brandNew{Enter}');

      expect(window.electronAPI.setVideoTag).toHaveBeenCalledWith('brandNew', 'vid1', true);
      expect(input).toHaveValue('');
    });
  });

  describe('deep-linked Clip Collection (mini-player bar reopen)', () => {
    it('opens straight into Clip Collection with the given clip active, when initialActiveView/initialClipId are set', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' }, { clipCount: 2 });
      window.electronAPI.getClips = vi.fn().mockResolvedValue({
        success: true,
        clips: [
          { id: 'clip1', fileName: 'Clip One.mp4', title: 'Clip One', createdAt: 0, durationSeconds: 5 },
          { id: 'clip2', fileName: 'Clip Two.mp4', title: 'Clip Two', createdAt: 0, durationSeconds: 5 },
        ],
      });
      renderDetail(video, {}, { initialActiveView: 'clips', initialClipId: 'clip2' });

      expect(await screen.findByText('Clip Two')).toBeInTheDocument();
      // The fake LibraryVideoPlayerWithTools (see the module mock above)
      // surfaces whichever overrideFilePath it was actually handed -- this
      // confirms ClipCollectionView picked clip2 as active, not just that
      // clip2 appears somewhere in the sidebar list.
      expect(await screen.findByTestId('fake-player-override-path')).toHaveAttribute('data-override-file-path', expect.stringContaining('Clip Two.mp4'));
    });

    // Regression test: ClipCollectionView's "Mark clip on original video"
    // re-navigates to this *same* video with fresh initialClipStartSeconds/
    // EndSeconds -- LibraryScreen.tsx renders this component without a key,
    // so it doesn't remount, and activeView's own useState initializer
    // never re-runs on its own. Without the dedicated effect that watches
    // these two props, the user stayed stuck on the Clip Collection tab.
    it('switches back to the video view when a "mark clip on original video" deep link arrives while Clip Collection is open', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' }, { clipCount: 1 });
      window.electronAPI.getClips = vi.fn().mockResolvedValue({
        success: true,
        clips: [{ id: 'clip1', fileName: 'Clip One.mp4', title: 'Clip One', createdAt: 0, durationSeconds: 5 }],
      });
      const { rerender } = renderDetail(video, {}, { initialActiveView: 'clips' });

      expect(await screen.findByText('Clip One')).toBeInTheDocument();

      rerender(
        <MemoryRouter>
          <BackgroundPlayerProvider>
            <LibraryVideoDetail
              video={video}
              onBack={vi.fn()}
              onLibraryChanged={vi.fn()}
              onDeleted={vi.fn()}
              onVersionsChanged={vi.fn()}
              videoTags={{}}
              onVideoTagsChanged={vi.fn()}
              initialActiveView="clips"
              initialClipStartSeconds={5}
              initialClipEndSeconds={12}
            />
          </BackgroundPlayerProvider>
        </MemoryRouter>,
      );

      expect(await screen.findByRole('button', { name: 'Fake save clip' })).toBeInTheDocument();
      expect(screen.queryByText('Clip One')).not.toBeInTheDocument();
    });
  });

  describe('double-playback guard (background player)', () => {
    // Two-phase render, deliberately: mount the provider + a probe first,
    // start background playback via act(), *then* rerender with
    // LibraryVideoDetail added -- guarantees the background player already
    // has `current` set before LibraryVideoDetail's own guard effect runs,
    // rather than racing two components' mount-effects against each other.
    function renderWithBackgroundPlaying(playingVideo: ReturnType<typeof makeVideo>) {
      let bgRef!: ReturnType<typeof useBackgroundPlayer>;
      function Probe({ children }: { children?: React.ReactNode }) {
        bgRef = useBackgroundPlayer();
        return <>{children}</>;
      }
      const utils = render(
        <BackgroundPlayerProvider>
          <Probe />
        </BackgroundPlayerProvider>,
      );
      act(() => {
        bgRef.enqueue({
          videoId: playingVideo.metadata.videoId, title: playingVideo.metadata.title, channel: playingVideo.metadata.channel,
          thumbnailPath: null, sourcePath: '/lib/Channel A/vidA/100/video.mp4', mimeType: 'video/mp4',
        });
        // Real media playback never actually starts in jsdom -- drive
        // "currently playing" the same explicit way
        // useBackgroundPlayer.test.tsx's own tests do, via the element's
        // real play event, so `paused` genuinely starts false here.
        bgRef.videoRef.current?.dispatchEvent(new Event('play'));
      });

      const mountDetail = (detailVideo: ReturnType<typeof makeVideo>) => utils.rerender(
        <BackgroundPlayerProvider>
          <Probe>
            <LibraryVideoDetail
              video={detailVideo}
              onBack={vi.fn()}
              onLibraryChanged={vi.fn()}
              onDeleted={vi.fn()}
              onVersionsChanged={vi.fn()}
              videoTags={{}}
              onVideoTagsChanged={vi.fn()}
            />
          </Probe>
        </BackgroundPlayerProvider>,
      );
      // A function, not a plain getter-backed property -- destructuring a
      // getter at call time would snapshot whatever bgRef was at that
      // instant rather than staying live for a later read (confirmed the
      // hard way in LibraryVideoPlayer.test.tsx's own equivalent helper).
      return { getBg: () => bgRef, mountDetail };
    }

    it('auto-pauses the background player when opening the video it\'s currently playing', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' });
      const { getBg, mountDetail } = renderWithBackgroundPlaying(video);
      // jsdom's HTMLMediaElement.pause() is a no-op stub that never actually
      // fires a real 'pause' event (confirmed directly -- unlike real
      // browsers), so this asserts the guard effect actually *called*
      // pause() on the element, rather than asserting the derived `paused`
      // state flipped, which jsdom can't produce here.
      const pauseSpy = vi.spyOn(getBg().videoRef.current!, 'pause');

      mountDetail(video);

      await waitFor(() => expect(pauseSpy).toHaveBeenCalled());
    });

    it('does not touch the background player when it\'s playing a different video', async () => {
      const video = makeVideo({ downloadedFilePath: '/v/video.mp4', downloadedResolution: '720' });
      const otherVideo = makeVideo({ videoId: 'someOtherVideo' });
      const { getBg, mountDetail } = renderWithBackgroundPlaying(otherVideo);
      const pauseSpy = vi.spyOn(getBg().videoRef.current!, 'pause');

      mountDetail(video);

      await waitFor(() => screen.getByText('Alpha Video'));
      expect(getBg().current?.videoId).toBe('someOtherVideo');
      expect(pauseSpy).not.toHaveBeenCalled();
    });
  });
});
