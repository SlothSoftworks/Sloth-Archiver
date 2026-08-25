// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BulkDeleteConfirmDialog from './BulkDeleteConfirmDialog';

describe('BulkDeleteConfirmDialog', () => {
  it('shows the given title and description', () => {
    render(
      <BulkDeleteConfirmDialog
        open
        title="Delete 3 videos?"
        description="This deletes the tracked entries and their files. This can't be undone."
        deleting={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Delete 3 videos?')).toBeInTheDocument();
    expect(screen.getByText("This deletes the tracked entries and their files. This can't be undone.")).toBeInTheDocument();
  });

  it('disables both buttons while deleting', () => {
    render(<BulkDeleteConfirmDialog open title="t" description="d" deleting error={null} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '' })).toBeDisabled(); // Delete button shows a spinner, no text, while deleting
  });

  it('shows the error text when set', () => {
    render(<BulkDeleteConfirmDialog open title="t" description="d" deleting={false} error="2 of 2 couldn't be deleted." onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText("2 of 2 couldn't be deleted.")).toBeInTheDocument();
  });

  it('fires onCancel/onConfirm', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<BulkDeleteConfirmDialog open title="t" description="d" deleting={false} error={null} onCancel={onCancel} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
