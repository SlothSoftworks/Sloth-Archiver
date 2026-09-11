// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlayerContextMenu from './PlayerContextMenu';

function renderMenu(overrides: Partial<React.ComponentProps<typeof PlayerContextMenu>> = {}) {
  const onClose = vi.fn();
  const onToggleLoop = vi.fn();
  const onToggleLoopSequence = vi.fn();
  const utils = render(
    <PlayerContextMenu
      open
      anchorPosition={{ top: 10, left: 20 }}
      onClose={onClose}
      loopEnabled={false}
      onToggleLoop={onToggleLoop}
      loopSequenceEnabled={false}
      onToggleLoopSequence={onToggleLoopSequence}
      loopSequenceDisabled={false}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onToggleLoop, onToggleLoopSequence };
}

describe('PlayerContextMenu', () => {
  it('renders both items with no check icon when neither is active', () => {
    renderMenu();
    expect(screen.getByRole('menuitem', { name: 'Loop' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Loop sequence' })).toBeInTheDocument();
    expect(screen.queryByTestId('CheckIcon')).not.toBeInTheDocument();
  });

  it('shows a check icon only on the active item', () => {
    renderMenu({ loopEnabled: true });
    const loopItem = screen.getByRole('menuitem', { name: 'Loop' });
    const loopSequenceItem = screen.getByRole('menuitem', { name: 'Loop sequence' });
    expect(within(loopItem).getByTestId('CheckIcon')).toBeInTheDocument();
    expect(within(loopSequenceItem).queryByTestId('CheckIcon')).not.toBeInTheDocument();
  });

  it('disables Loop sequence when loopSequenceDisabled is true', () => {
    renderMenu({ loopSequenceDisabled: true });
    expect(screen.getByRole('menuitem', { name: 'Loop sequence' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('clicking Loop fires its callback and closes the menu', async () => {
    const user = userEvent.setup();
    const { onToggleLoop, onClose } = renderMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Loop' }));

    expect(onToggleLoop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking Loop sequence fires its callback and closes the menu', async () => {
    const user = userEvent.setup();
    const { onToggleLoopSequence, onClose } = renderMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Loop sequence' }));

    expect(onToggleLoopSequence).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    renderMenu({ open: false });
    expect(screen.queryByRole('menuitem', { name: 'Loop' })).not.toBeInTheDocument();
  });
});
