// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BulkDeleteConfirmDialog from './BulkDeleteConfirmDialog';

describe('BulkDeleteConfirmDialog', () => {
  it('shows a count-aware, pluralized title', () => {
    render(<BulkDeleteConfirmDialog open count={3} deleting={false} error={null} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Delete 3 videos?')).toBeInTheDocument();
  });

  it('singularizes for a single video', () => {
    render(<BulkDeleteConfirmDialog open count={1} deleting={false} error={null} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Delete 1 video?')).toBeInTheDocument();
  });

  it('disables both buttons while deleting', () => {
    render(<BulkDeleteConfirmDialog open count={2} deleting error={null} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '' })).toBeDisabled(); // Delete button shows a spinner, no text, while deleting
  });

  it('shows the error text when set', () => {
    render(<BulkDeleteConfirmDialog open count={2} deleting={false} error="2 of 2 couldn't be deleted." onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText("2 of 2 couldn't be deleted.")).toBeInTheDocument();
  });

  it('fires onCancel/onConfirm', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<BulkDeleteConfirmDialog open count={1} deleting={false} error={null} onCancel={onCancel} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
