// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BulkDownloadQualityDialog from './BulkDownloadQualityDialog';

function makeVideo(overrides: Record<string, unknown> = {}) {
  return {
    videoDir: '/lib/Channel A/vidA',
    metadata: { videoId: 'vidA', title: 'Alpha Video', originalUrl: 'https://youtube.com/watch?v=vidA' },
    ...overrides,
  } as { videoDir: string; metadata: { videoId: string; title: string | null; originalUrl: string | null } };
}

describe('BulkDownloadQualityDialog', () => {
  it('shows a count-aware title and defaults to 720p', async () => {
    render(
      <BulkDownloadQualityDialog open onClose={vi.fn()} videos={[makeVideo(), makeVideo({ videoDir: '/lib/Channel A/vidB' })]} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText('Download 2 selected videos')).toBeInTheDocument();
    expect(screen.getByText('720p')).toBeInTheDocument();
  });

  it('confirms with the chosen resolution', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<BulkDownloadQualityDialog open onClose={vi.fn()} videos={[makeVideo()]} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: '1080p' }));
    await user.click(screen.getByRole('button', { name: 'Queue Download' }));

    expect(onConfirm).toHaveBeenCalledWith('1080');
  });

  it('warns when some selected videos have no saved source link', () => {
    render(
      <BulkDownloadQualityDialog
        open
        onClose={vi.fn()}
        videos={[makeVideo(), makeVideo({ videoDir: '/lib/Channel A/vidB', metadata: { videoId: 'vidB', title: 'Beta', originalUrl: null } })]}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 of 2 selected video has no/)).toBeInTheDocument();
  });

  it('disables confirming when every selected video lacks a source link', () => {
    render(
      <BulkDownloadQualityDialog
        open
        onClose={vi.fn()}
        videos={[makeVideo({ metadata: { videoId: 'vidA', title: 'Alpha', originalUrl: null } })]}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Queue Download' })).toBeDisabled();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<BulkDownloadQualityDialog open onClose={onClose} videos={[makeVideo()]} onConfirm={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
