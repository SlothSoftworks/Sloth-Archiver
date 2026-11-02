// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TranscriptPanel from './TranscriptPanel';
import type { Transcript } from '../../types';

const TRANSCRIPT: Transcript = {
  version: 1,
  language: 'en',
  languageName: 'English',
  source: 'auto',
  fetchedEpoch: 1,
  segments: [
    { start: 18.8, end: 21.79, text: "We're no strangers to" },
    { start: 21.8, end: 25.95, text: 'love. You know the rules and so do' },
    { start: 65, end: 70, text: 'Never gonna give you up, never gonna let you down' },
  ],
};

let updatedCallback: ((data: { videoDir: string; epoch: string }) => void) | null;

beforeEach(() => {
  updatedCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    getTranscript: vi.fn().mockResolvedValue({ success: true, transcript: TRANSCRIPT }),
    fetchTranscript: vi.fn().mockResolvedValue({ success: true, transcript: TRANSCRIPT }),
    listTranscriptLanguages: vi.fn().mockResolvedValue({ success: true, languages: [
      { code: 'en', name: 'English', source: 'auto' },
      { code: 'ja', name: 'Japanese', source: 'manual' },
    ] }),
    onTranscriptUpdated: vi.fn((cb) => { updatedCallback = cb; }),
    removeTranscriptUpdatedListener: vi.fn(),
  };
});

function renderPanel(overrides: Partial<Parameters<typeof TranscriptPanel>[0]> = {}) {
  const props = { videoDir: '/lib/c/v1', epoch: '100', isLocal: false, onSeek: vi.fn(), onFetched: vi.fn(), ...overrides };
  return { ...render(<TranscriptPanel {...props} />), props };
}

describe('TranscriptPanel', () => {
  it('shows the stored transcript with timestamps and its source', async () => {
    renderPanel();
    expect(await screen.findByText("We're no strangers to")).toBeInTheDocument();
    expect(screen.getByText('0:18')).toBeInTheDocument();
    expect(screen.getByText('1:05')).toBeInTheDocument();
    expect(screen.getByText('English · auto-generated')).toBeInTheDocument();
    expect(window.electronAPI.getTranscript).toHaveBeenCalledWith({ videoDir: '/lib/c/v1', epoch: '100' });
  });

  it('seeks to a line when it is clicked', async () => {
    const user = userEvent.setup();
    const { props } = renderPanel();
    await user.click(await screen.findByText('love. You know the rules and so do'));
    expect(props.onSeek).toHaveBeenCalledWith(21.8);
  });

  it('filters lines by search, counts and highlights matches', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("We're no strangers to");

    await user.type(screen.getByPlaceholderText('Search transcript'), 'never');

    const lines = screen.getByTestId('transcript-lines');
    expect(within(lines).queryByText("We're no strangers to")).not.toBeInTheDocument();
    expect(screen.getByText('1 match')).toBeInTheDocument();
    expect(lines.querySelectorAll('mark')).toHaveLength(2);
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("We're no strangers to");
    await user.type(screen.getByPlaceholderText('Search transcript'), 'zebra');
    expect(screen.getByText('No lines match "zebra".')).toBeInTheDocument();
    expect(screen.getByText('0 matches')).toBeInTheDocument();
  });

  it('fetches when there is none yet, and reports it to the parent', async () => {
    window.electronAPI.getTranscript = vi.fn().mockResolvedValue({ success: true, transcript: null });
    const user = userEvent.setup();
    const { props } = renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Fetch transcript' }));

    expect(window.electronAPI.fetchTranscript).toHaveBeenCalledWith({ videoDir: '/lib/c/v1', epoch: '100', language: undefined });
    expect(await screen.findByText("We're no strangers to")).toBeInTheDocument();
    expect(props.onFetched).toHaveBeenCalledWith(TRANSCRIPT);
  });

  it('shows a failed fetch with Retry', async () => {
    window.electronAPI.getTranscript = vi.fn().mockResolvedValue({ success: true, transcript: null });
    window.electronAPI.fetchTranscript = vi.fn().mockResolvedValue({ success: false, kind: 'noTranscript', message: 'This video has no transcript.' });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Fetch transcript' }));
    expect(await screen.findByText('This video has no transcript.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(window.electronAPI.fetchTranscript).toHaveBeenCalledTimes(2);
  });

  it('re-fetches in another language from the menu', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("We're no strangers to");

    await user.click(screen.getByRole('button', { name: 'Other language' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Japanese' }));

    expect(window.electronAPI.fetchTranscript).toHaveBeenCalledWith({ videoDir: '/lib/c/v1', epoch: '100', language: 'ja' });
  });

  it('reloads when main reports a fetch for this version only', async () => {
    window.electronAPI.getTranscript = vi.fn().mockResolvedValue({ success: true, transcript: null });
    const { props } = renderPanel();
    await screen.findByRole('button', { name: 'Fetch transcript' });

    await act(async () => { updatedCallback!({ videoDir: '/lib/c/v1', epoch: '999' }); });
    expect(window.electronAPI.getTranscript).toHaveBeenCalledTimes(1);

    window.electronAPI.getTranscript = vi.fn().mockResolvedValue({ success: true, transcript: TRANSCRIPT });
    await act(async () => { updatedCallback!({ videoDir: '/lib/c/v1', epoch: '100' }); });
    expect(await screen.findByText("We're no strangers to")).toBeInTheDocument();
    await waitFor(() => expect(props.onFetched).toHaveBeenCalledWith(TRANSCRIPT));
  });

  it('explains that local files have no transcript', async () => {
    renderPanel({ isLocal: true });
    expect(await screen.findByText("Transcripts aren't available for local files.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fetch transcript' })).not.toBeInTheDocument();
  });
});
