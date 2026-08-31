// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SaveClipDialog from './SaveClipDialog';

function renderDialog(overrides: Partial<Parameters<typeof SaveClipDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <SaveClipDialog
      open
      onClose={onClose}
      defaultClipStart="00:00:10"
      defaultClipEnd="00:00:20"
      convertFormatOptions={['mp4', 'mov', 'mkv', 'webm', 'avi']}
      existingClipTitles={['Existing Clip']}
      submitting={false}
      progress={0}
      error={null}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { ...utils, onSubmit, onClose };
}

describe('SaveClipDialog', () => {
  it('pre-fills start/end from props and defaults format to "Same as source"', () => {
    renderDialog();
    expect(screen.getByLabelText('Start')).toHaveValue('00:00:10');
    expect(screen.getByLabelText('End')).toHaveValue('00:00:20');
    expect(screen.getByText('Same as source')).toBeInTheDocument();
  });

  it('disables submit when the name is empty', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Save clip' })).toBeDisabled();
  });

  it('disables submit and shows an error when the name collides with an existing clip', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Clip name'), 'Existing Clip');
    expect(screen.getByRole('button', { name: 'Save clip' })).toBeDisabled();
    expect(screen.getByText('A clip with this name already exists for this video.')).toBeInTheDocument();
  });

  it('disables submit when the range is invalid', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Clip name'), 'New Clip');
    await user.clear(screen.getByLabelText('End'));
    await user.type(screen.getByLabelText('End'), '000005'); // before start (10s)
    expect(screen.getByText('End must be at least 1 second after start.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save clip' })).toBeDisabled();
  });

  it('reveals a freeform field for "Other..." and requires it before submitting', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Clip name'), 'New Clip');
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Other...' }));
    expect(screen.getByRole('button', { name: 'Save clip' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Format name'), 'flac');
    expect(screen.getByRole('button', { name: 'Save clip' })).toBeEnabled();
  });

  it('submits with the chosen name/range/format', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.type(screen.getByLabelText('Clip name'), 'New Clip');
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'MP4' }));
    await user.click(screen.getByRole('button', { name: 'Save clip' }));

    expect(onSubmit).toHaveBeenCalledWith({
      clipName: 'New Clip', start: '00:00:10', end: '00:00:20', format: 'mp4', forceReencode: false, saveAsFile: false,
    });
  });

  it('hides the "Save as file" checkbox by default', () => {
    renderDialog();
    expect(screen.queryByText('Save as file')).not.toBeInTheDocument();
  });

  it('shows the "Save as file" checkbox when offerSaveAsFile is set, and includes it in the submit payload', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({ offerSaveAsFile: true });
    await user.type(screen.getByLabelText('Clip name'), 'New Clip');
    await user.click(screen.getByRole('checkbox', { name: 'Save as file' }));
    await user.click(screen.getByRole('button', { name: 'Save clip' }));

    expect(onSubmit).toHaveBeenCalledWith({
      clipName: 'New Clip', start: '00:00:10', end: '00:00:20', format: 'source', forceReencode: false, saveAsFile: true,
    });
  });

  it('shows a progress bar while submitting', () => {
    renderDialog({ submitting: true, progress: 42 });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('shows a backend-reported error inline', () => {
    renderDialog({ error: 'A clip with this name already exists for this video.' });
    expect(screen.getByText('A clip with this name already exists for this video.')).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
