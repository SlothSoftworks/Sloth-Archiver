// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChannelTranscriptFetch from './ChannelTranscriptFetch';
import type { LibraryChannel, LibraryVideo } from '../../types';
import type { TranscriptBatchStatus } from '../../types/electron-api';

function makeVideo(name: string, metadata: Record<string, unknown> = {}): LibraryVideo {
  return {
    videoFolderName: name,
    videoDir: `/lib/Channel A/${name}`,
    latestEpoch: '100',
    metadata: { title: name, platform: 'youtube', ...metadata },
    epochs: [],
    thumbnailPath: null,
    clipCount: 0,
  } as unknown as LibraryVideo;
}

const CHANNEL: LibraryChannel = {
  channelFolderName: 'Channel A',
  displayName: 'Channel A',
  channelIconPath: null,
  videos: [
    makeVideo('v1'),
    makeVideo('v2', { transcript: { language: 'en', languageName: 'English', source: 'auto', fetchedEpoch: 1, segmentCount: 3 } }),
    makeVideo('v3'),
  ],
};

function batch(overrides: Partial<TranscriptBatchStatus>): TranscriptBatchStatus {
  return { label: 'Channel A', total: 2, done: 0, failed: 0, current: null, stoppedReason: null, finished: false, ...overrides };
}

let progressCallback: ((status: TranscriptBatchStatus) => void) | null;

beforeEach(() => {
  progressCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    getTranscriptBatchStatus: vi.fn().mockResolvedValue(null),
    fetchTranscripts: vi.fn().mockResolvedValue({ success: true }),
    cancelTranscriptBatch: vi.fn().mockResolvedValue({ success: true }),
    onTranscriptBatchProgress: vi.fn((cb) => { progressCallback = cb; }),
    removeTranscriptBatchProgressListener: vi.fn(),
  };
});

function renderFetch(channel = CHANNEL) {
  const onFinished = vi.fn();
  render(<ChannelTranscriptFetch channel={channel} onFinished={onFinished} />);
  return { onFinished };
}

describe('ChannelTranscriptFetch', () => {
  it('confirms, then queues only the latest versions without a transcript, labelled with the channel', async () => {
    const user = userEvent.setup();
    renderFetch();

    await user.click(screen.getByRole('button', { name: 'Fetch missing transcripts' }));
    expect(screen.getByText('Fetch 2 missing transcripts?')).toBeInTheDocument();
    expect(screen.getByText(/about 1 minute\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fetch' }));

    expect(window.electronAPI.fetchTranscripts).toHaveBeenCalledWith({
      items: [{ videoDir: '/lib/Channel A/v1', epoch: '100' }, { videoDir: '/lib/Channel A/v3', epoch: '100' }],
      label: 'Channel A',
    });
  });

  it('is disabled when every video already has a transcript', () => {
    renderFetch({ ...CHANNEL, videos: [CHANNEL.videos[1]] });
    expect(screen.getByRole('button', { name: 'Fetch missing transcripts' })).toBeDisabled();
  });

  it('shows progress and cancels', async () => {
    const user = userEvent.setup();
    renderFetch();
    await act(async () => { progressCallback!(batch({ done: 1 })); });

    expect(screen.getByText('Transcripts 1 / 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop fetching transcripts' }));
    expect(window.electronAPI.cancelTranscriptBatch).toHaveBeenCalled();
  });

  it('picks a running batch back up on mount', async () => {
    window.electronAPI.getTranscriptBatchStatus = vi.fn().mockResolvedValue(batch({ total: 40, done: 12 }));
    renderFetch();
    expect(await screen.findByText('Transcripts 12 / 40')).toBeInTheDocument();
  });

  it("doesn't claim another channel's batch", async () => {
    window.electronAPI.getTranscriptBatchStatus = vi.fn().mockResolvedValue(batch({ label: 'Channel B' }));
    renderFetch();
    await act(async () => {});
    expect(screen.queryByTestId('transcript-batch-progress')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fetch missing transcripts' })).toBeDisabled();
  });

  it('summarizes a finished batch and refreshes the channel', async () => {
    const { onFinished } = renderFetch();
    await act(async () => { progressCallback!(batch({ total: 40, done: 40, failed: 2, finished: true })); });

    expect(screen.getByText('38 fetched, 2 unavailable')).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('says why a batch stopped early', async () => {
    renderFetch();
    await act(async () => { progressCallback!(batch({ total: 40, done: 13, failed: 1, stoppedReason: 'rateLimit', finished: true })); });
    expect(screen.getByText('Stopped: YouTube is rate-limiting. 12 fetched -- try the rest later.')).toBeInTheDocument();
  });

  it('ignores the end of another channel\'s batch', async () => {
    const { onFinished } = renderFetch();
    await act(async () => { progressCallback!(batch({ label: 'Channel B', done: 2, finished: true })); });
    expect(onFinished).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
