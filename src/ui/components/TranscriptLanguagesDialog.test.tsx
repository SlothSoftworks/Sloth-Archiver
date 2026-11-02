// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TranscriptLanguagesDialog from './TranscriptLanguagesDialog';

const TRANSCRIPT = { version: 1, language: 'fr', languageName: 'French', source: 'auto', fetchedEpoch: 1, segments: [] };

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    listTranscriptLanguages: vi.fn().mockResolvedValue({ success: true, languages: [
      { code: 'en', name: 'English', source: 'manual', saved: true, isDefault: true },
      { code: 'ja', name: 'Japanese', source: 'manual', saved: true, isDefault: false },
      { code: 'fr', name: 'French', source: 'auto', saved: false, isDefault: false },
    ] }),
    fetchTranscript: vi.fn().mockResolvedValue({ success: true, transcript: TRANSCRIPT, isDefault: false }),
  };
});

function renderDialog() {
  const props = { open: true, onClose: vi.fn(), videoDir: '/lib/c/v1', epoch: '100', currentLanguage: 'en', onShow: vi.fn() };
  render(<TranscriptLanguagesDialog {...props} />);
  return props;
}

describe('TranscriptLanguagesDialog', () => {
  it('lists every language with its source, the default, and what is saved', async () => {
    renderDialog();
    expect(await screen.findByText('English')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByLabelText('English is saved')).toBeInTheDocument();
    expect(screen.getByLabelText('Japanese is saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download French' })).toBeInTheDocument();
    expect(screen.getByText('Auto-generated')).toBeInTheDocument();
  });

  it('shows a saved language straight away', async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(await screen.findByText('Japanese'));

    expect(window.electronAPI.fetchTranscript).not.toHaveBeenCalled();
    expect(props.onShow).toHaveBeenCalledWith('ja');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('downloads an unsaved language before showing it', async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(await screen.findByText('French'));

    expect(window.electronAPI.fetchTranscript).toHaveBeenCalledWith({ videoDir: '/lib/c/v1', epoch: '100', language: 'fr' });
    expect(props.onShow).toHaveBeenCalledWith('fr');
  });

  it('the download icon saves a language without switching to it', async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Download French' }));

    expect(await screen.findByLabelText('French is saved')).toBeInTheDocument();
    expect(props.onShow).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the error when a download fails', async () => {
    window.electronAPI.fetchTranscript = vi.fn().mockResolvedValue({ success: false, kind: 'rateLimit', message: 'YouTube is rate-limiting.' });
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(await screen.findByText('French'));

    expect(await screen.findByText('YouTube is rate-limiting.')).toBeInTheDocument();
    expect(props.onShow).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download French' })).toBeInTheDocument();
  });
});
