// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddLocalFileDialog from './AddLocalFileDialog';
import { LibraryTagsProvider } from '../hooks/useLibraryTags';

beforeEach(() => {
  window.electronAPI = {
    ...window.electronAPI,
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [] }),
    getActiveLibraryTag: vi.fn().mockResolvedValue({ activeLibraryTag: 'DefaultLibrary', activeLibraryTagDir: '' }),
    openLocalVideoFile: vi.fn().mockResolvedValue({ filePaths: ['/some/path/My Video File.mp4'], canceled: false }),
    probeLocalFile: vi.fn().mockResolvedValue({
      id: 'abc123',
      width: 1920,
      height: 1080,
      duration: 120,
      tags: { title: 'Probed Title', artist: 'Probed Artist', date: '2024', genre: 'Rock', comment: 'a comment' },
    }),
  };
});

function renderDialog(overrides: Partial<Parameters<typeof AddLocalFileDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <LibraryTagsProvider>
      <AddLocalFileDialog open onClose={onClose} submitting={false} error={null} onSubmit={onSubmit} {...overrides} />
    </LibraryTagsProvider>,
  );
  return { ...utils, onSubmit, onClose };
}

describe('AddLocalFileDialog', () => {
  it('shows the copy-not-move guarantee', () => {
    renderDialog();
    expect(screen.getByText(/never moved or deleted/)).toBeInTheDocument();
  });

  it('prefills Title/Metadata from the probe after picking a file', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Choose file...' }));

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Probed Title'));
    await user.click(screen.getByRole('button', { name: 'Metadata' }));
    expect(screen.getByLabelText('Description')).toHaveValue('a comment');
    expect(screen.getByLabelText('Uploader')).toHaveValue('Probed Artist');
    // The probed date tag was the bare year "2024" -- dayjs parses that
    // leniently as 2024-01-01, so the picker prefills to that normalized
    // date rather than showing the raw, non-YYYYMMDD tag value.
    expect(screen.getByDisplayValue('01/01/2024')).toBeInTheDocument();
  });

  it('leaves the upload date picker empty when the probed date tag is unparseable', async () => {
    window.electronAPI.probeLocalFile = vi.fn().mockResolvedValue({
      id: 'abc123', width: 1920, height: 1080, duration: 120,
      tags: { title: 'Probed Title', artist: 'Probed Artist', date: 'not-a-date', genre: 'Rock', comment: 'a comment' },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Choose file...' }));

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Probed Title'));
    await user.click(screen.getByRole('button', { name: 'Metadata' }));
    expect(screen.getByRole('spinbutton', { name: 'Month' })).toHaveTextContent('MM');
  });

  it('falls back to the filename (minus extension) as the title when the file has no title tag', async () => {
    window.electronAPI.probeLocalFile = vi.fn().mockResolvedValue({
      id: 'abc123', width: null, height: null, duration: null,
      tags: { title: null, artist: null, date: null, genre: null, comment: null },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Choose file...' }));

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('My Video File'));
  });

  it('disables submit until a file is picked and a title is present', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByRole('button', { name: 'Add to library' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Choose file...' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to library' })).toBeEnabled());
  });

  it('submits the picked file, title and metadata fields', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Choose file...' }));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Probed Title'));

    await user.click(screen.getByRole('button', { name: 'Add to library' }));

    expect(onSubmit).toHaveBeenCalledWith({
      sourceFilePath: '/some/path/My Video File.mp4',
      formFields: expect.objectContaining({
        title: 'Probed Title',
        description: 'a comment',
        uploader: 'Probed Artist',
        uploadDate: '20240101',
        categories: [],
        tags: ['Rock'],
        music: { track: '', artist: 'Probed Artist', album: '', genre: 'Rock' },
      }),
      targetTag: 'DefaultLibrary',
    });
  });

  it('submits an empty uploadDate when the probed date tag was unparseable', async () => {
    window.electronAPI.probeLocalFile = vi.fn().mockResolvedValue({
      id: 'abc123', width: 1920, height: 1080, duration: 120,
      tags: { title: 'Probed Title', artist: 'Probed Artist', date: 'not-a-date', genre: 'Rock', comment: 'a comment' },
    });
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Choose file...' }));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Probed Title'));

    await user.click(screen.getByRole('button', { name: 'Add to library' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      formFields: expect.objectContaining({ uploadDate: '' }),
    }));
  });

  it('submits a date entered via the picker as a strict YYYYMMDD string', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Choose file...' }));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Probed Title'));
    await user.click(screen.getByRole('button', { name: 'Metadata' }));

    await user.click(screen.getByRole('spinbutton', { name: 'Month' }));
    await user.keyboard('03042025');
    await user.click(screen.getByRole('button', { name: 'Add to library' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      formFields: expect.objectContaining({ uploadDate: '20250304' }),
    }));
  });

  it('never renders a sublibrary picker when only one sublibrary exists', async () => {
    renderDialog();
    await waitFor(() => expect(window.electronAPI.listLibraryTags).toHaveBeenCalled());
    expect(screen.queryByLabelText('Sublibrary')).not.toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a backend-reported error inline', () => {
    renderDialog({ error: 'Failed to add this file to the library.' });
    expect(screen.getByText('Failed to add this file to the library.')).toBeInTheDocument();
  });
});
