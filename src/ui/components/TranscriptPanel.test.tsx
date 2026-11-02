// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
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
      { code: 'en', name: 'English', source: 'auto', saved: true, isDefault: true },
      { code: 'ja', name: 'Japanese', source: 'manual', saved: true, isDefault: false },
    ] }),
    onTranscriptUpdated: vi.fn((cb) => { updatedCallback = cb; }),
    removeTranscriptUpdatedListener: vi.fn(),
    copyTranscriptText: vi.fn().mockResolvedValue({ success: true }),
    saveTranscriptText: vi.fn().mockResolvedValue({ success: true, filePath: '/out/t.txt' }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('shows a saved language picked in the languages dialog without fetching', async () => {
    const japanese: Transcript = { ...TRANSCRIPT, language: 'ja', languageName: 'Japanese', source: 'manual', segments: [{ start: 1, end: 2, text: '知らない仲じゃない' }] };
    window.electronAPI.getTranscript = vi.fn(async ({ language }) => ({ success: true, transcript: language === 'ja' ? japanese : TRANSCRIPT }));
    const user = userEvent.setup();
    const { props } = renderPanel();
    await screen.findByText("We're no strangers to");

    await user.click(screen.getByRole('button', { name: 'Transcript languages' }));
    await user.click(await screen.findByText('Japanese'));

    expect(await screen.findByText('知らない仲じゃない')).toBeInTheDocument();
    expect(screen.getByText('Japanese · uploader subtitles')).toBeInTheDocument();
    expect(window.electronAPI.getTranscript).toHaveBeenLastCalledWith({ videoDir: '/lib/c/v1', epoch: '100', language: 'ja' });
    expect(window.electronAPI.fetchTranscript).not.toHaveBeenCalled();
    expect(props.onFetched).not.toHaveBeenCalled();
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

  describe('follow along', () => {
    // jsdom has no layout: give each line a 30px slot so the auto-scroll
    // target is observable.
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
        return Number(this.dataset.index ?? 0) * 30;
      });
    });

    it('highlights the line being played and keeps it in view', async () => {
      let now: number | null = 22;
      renderPanel({ getCurrentTime: () => now });

      const current = await screen.findByText('love. You know the rules and so do');
      await waitFor(() => expect(current.closest('[data-index]')).toHaveAttribute('aria-current', 'true'));
      const lines = screen.getByTestId('transcript-lines');
      expect(lines.scrollTop).toBe(30);

      now = 66;
      await waitFor(() => expect(screen.getByText('Never gonna give you up, never gonna let you down').closest('[data-index]')).toHaveAttribute('aria-current', 'true'));
      expect(lines.scrollTop).toBe(60);
      expect(current.closest('[data-index]')).not.toHaveAttribute('aria-current');
    });

    it('stops scrolling when the user scrolls the list, until "Back to current"', async () => {
      const user = userEvent.setup();
      let now: number | null = 19;
      renderPanel({ getCurrentTime: () => now });
      await screen.findByText("We're no strangers to");
      const lines = screen.getByTestId('transcript-lines');

      fireEvent.wheel(lines);
      lines.scrollTop = 5;
      now = 66;
      await waitFor(() => expect(screen.getByText('Never gonna give you up, never gonna let you down').closest('[data-index]')).toHaveAttribute('aria-current', 'true'));
      expect(lines.scrollTop).toBe(5);

      await user.click(screen.getByRole('button', { name: 'Back to current' }));
      expect(lines.scrollTop).toBe(60);
      expect(screen.queryByRole('button', { name: 'Back to current' })).not.toBeInTheDocument();
    });

    it('highlights nothing while nothing local is playing', async () => {
      renderPanel({ getCurrentTime: () => null });
      await screen.findByText("We're no strangers to");
      expect(screen.getByTestId('transcript-lines').querySelector('[aria-current]')).toBeNull();
    });
  });

  describe('copy and save', () => {
    it('copies the text without timestamps', async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByText("We're no strangers to");

      await user.click(screen.getByRole('button', { name: 'Copy transcript' }));
      await user.click(screen.getByRole('menuitem', { name: 'Text only' }));

      expect(window.electronAPI.copyTranscriptText).toHaveBeenCalledWith({ videoDir: '/lib/c/v1', epoch: '100', language: 'en', withTimestamps: false });
      expect(await screen.findByText('Transcript copied')).toBeInTheDocument();
    });

    it('saves with timestamps', async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByText("We're no strangers to");

      await user.click(screen.getByRole('button', { name: 'Save transcript as text' }));
      await user.click(screen.getByRole('menuitem', { name: 'With timestamps' }));
      expect(window.electronAPI.saveTranscriptText).toHaveBeenCalledWith({ videoDir: '/lib/c/v1', epoch: '100', language: 'en', withTimestamps: true });
      expect(await screen.findByText('Transcript saved')).toBeInTheDocument();
    });

    it('stays quiet when the save dialog is cancelled', async () => {
      window.electronAPI.saveTranscriptText = vi.fn().mockResolvedValue({ success: false, canceled: true });
      const user = userEvent.setup();
      renderPanel();
      await screen.findByText("We're no strangers to");

      await user.click(screen.getByRole('button', { name: 'Save transcript as text' }));
      await user.click(screen.getByRole('menuitem', { name: 'Text only' }));
      await waitFor(() => expect(window.electronAPI.saveTranscriptText).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
