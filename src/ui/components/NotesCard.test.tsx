// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotesCard, { NOTES_MAX_LENGTH } from './NotesCard';

describe('NotesCard', () => {
  it('shows the saved notes, or a placeholder when there are none', () => {
    const { rerender } = render(<NotesCard notes={'Line one\nLine two'} onSave={vi.fn()} />);
    expect(screen.getByText(/Line one/)).toBeInTheDocument();
    rerender(<NotesCard notes="" onSave={vi.fn()} />);
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
  });

  it('edits with a character counter and saves only on Save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ success: true, notes: 'hello' });
    render(<NotesCard notes="" onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Edit notes' }));
    const field = screen.getByRole('textbox', { name: 'Notes' });
    expect(field).toHaveAttribute('maxLength', String(NOTES_MAX_LENGTH));
    await user.type(field, 'hello');
    expect(screen.getByText(`5/${NOTES_MAX_LENGTH}`)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith('hello');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('Cancel discards the draft', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NotesCard notes="original" onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Edit notes' }));
    await user.clear(screen.getByRole('textbox', { name: 'Notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'changed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('original')).toBeInTheDocument();
  });

  it('stays in edit mode with the error shown when saving fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ success: false, message: 'Disk full' });
    render(<NotesCard notes="" onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Edit notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'draft');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Disk full')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('draft');
  });

  it('follows a new notes prop from the caller', () => {
    const { rerender } = render(<NotesCard notes="old" onSave={vi.fn()} />);
    rerender(<NotesCard notes="refreshed" onSave={vi.fn()} />);
    expect(screen.getByText('refreshed')).toBeInTheDocument();
  });
});
