// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import QueueDrawer from './QueueDrawer';
import MiniPlayerBar from './MiniPlayerBar';
import { BackgroundPlayerProvider, useBackgroundPlayer, type BackgroundPlayerVideo } from '../hooks/useBackgroundPlayer.tsx';

function makeVideo(overrides: Partial<BackgroundPlayerVideo> = {}): BackgroundPlayerVideo {
  return {
    videoId: 'v1', title: 'Video One', channel: 'Some Channel',
    thumbnailPath: null, sourcePath: '/lib/c/v1/1/video.mp4', mimeType: 'video/mp4',
    ...overrides,
  };
}

// Drives the shared background-player context from outside QueueDrawer
// itself, same pattern MiniPlayerBar.test.tsx already uses. Starts the
// drawer closed and opens it via its own button -- MUI's Modal (which
// Drawer is built on) marks sibling content aria-hidden while open, which
// would otherwise make these enqueue buttons unreachable by role once the
// drawer is already open, same as real usage (MiniPlayerBar only opens the
// drawer after items already exist).
function Harness({ videos, onClose }: { videos: BackgroundPlayerVideo[]; onClose: () => void }) {
  const { enqueue } = useBackgroundPlayer();
  const [open, setOpen] = useState(false);
  return (
    <>
      {videos.map((v) => (
        <button key={v.videoId} onClick={() => enqueue(v)}>enqueue {v.videoId} (test)</button>
      ))}
      <button onClick={() => setOpen(true)}>open drawer (test)</button>
      <QueueDrawer open={open} onClose={() => { setOpen(false); onClose(); }} />
    </>
  );
}

function renderDrawer(videos: BackgroundPlayerVideo[], onClose = vi.fn()) {
  const utils = render(
    <MemoryRouter>
      <BackgroundPlayerProvider>
        <Harness videos={videos} onClose={onClose} />
      </BackgroundPlayerProvider>
    </MemoryRouter>,
  );
  return { ...utils, onClose };
}

// Enqueues both videos then opens the drawer -- shared setup for every
// test below, since MUI's Modal hides sibling content (including the
// Harness's own enqueue buttons) via aria-hidden once the drawer is open.
async function enqueueBothAndOpen(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
  await user.click(screen.getByRole('button', { name: 'enqueue v2 (test)' }));
  await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));
}

// A title matching a queue item's own title can also appear in the header
// (which shows the currently-playing item's title) -- this scopes to the
// specific row in the list, not the header.
function rowText(text: string): HTMLElement {
  const match = screen.getAllByText(text).find((el) => el.closest('li'));
  if (!match) throw new Error(`No row found with text: ${text}`);
  return match;
}

describe('QueueDrawer', () => {
  it('renders every queued item and highlights the currently-playing one', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1', title: 'Video One' }), makeVideo({ videoId: 'v2', title: 'Video Two' })];
    renderDrawer(videos);
    await enqueueBothAndOpen(user);

    await screen.findByText('Video Two');
    expect(screen.getAllByText('Video One').length).toBeGreaterThan(0);
    expect(rowText('Video One').closest('li')).toHaveAttribute('data-active', 'true');
    expect(rowText('Video Two').closest('li')).not.toHaveAttribute('data-active');
  });

  it('disables previous at the start of the queue and next at the end', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1' }), makeVideo({ videoId: 'v2', title: 'Video Two' })];
    renderDrawer(videos);
    await enqueueBothAndOpen(user);
    await screen.findByText('Video Two');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('play-pause and previous/next call through to the background player', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1', title: 'Video One' }), makeVideo({ videoId: 'v2', title: 'Video Two' })];
    renderDrawer(videos);
    await enqueueBothAndOpen(user);
    await screen.findByText('Video Two');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(rowText('Video One').closest('li')).not.toHaveAttribute('data-active');
    expect(rowText('Video Two').closest('li')).toHaveAttribute('data-active', 'true');
  });

  it('clicking a row (not its thumbnail) plays that item instead of navigating', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1', title: 'Video One' }), makeVideo({ videoId: 'v2', title: 'Video Two' })];
    renderDrawer(videos);
    await enqueueBothAndOpen(user);
    await screen.findByText('Video Two');
    expect(rowText('Video One').closest('li')).toHaveAttribute('data-active', 'true');

    await user.click(rowText('Video Two'));

    expect(rowText('Video One').closest('li')).not.toHaveAttribute('data-active');
    expect(rowText('Video Two').closest('li')).toHaveAttribute('data-active', 'true');
    // Still on the same page -- no navigation happened.
    expect(rowText('Video Two')).toBeInTheDocument();
  });

  it('removes an item from the queue via its own hover-revealed remove button', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1', title: 'Video One' }), makeVideo({ videoId: 'v2', title: 'Video Two' })];
    renderDrawer(videos);
    await enqueueBothAndOpen(user);
    await screen.findByText('Video Two');

    await user.click(screen.getByRole('button', { name: 'Remove Video Two from queue' }));

    expect(screen.queryByText('Video Two')).not.toBeInTheDocument();
    expect(rowText('Video One')).toBeInTheDocument();
  });

  it('clicking a queued item\'s thumbnail links to its (clip-aware) detail route and closes the drawer', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1' }), makeVideo({ videoId: 'v2', title: 'Video Two', clipId: 'clip1' })];
    const { onClose } = renderDrawer(videos);
    await enqueueBothAndOpen(user);
    await screen.findByText('Video Two');

    // The title text itself isn't inside the link (only the thumbnail is,
    // per the row-click-plays-instead behavior tested elsewhere) -- find it
    // via the row, not by matching link text.
    const secondLink = rowText('Video Two').closest('li')!.querySelector('a')!;
    expect(secondLink).toHaveAttribute('href', '/library/video/v2?view=clips&clip=clip1');

    await user.click(secondLink);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the currently-playing item\'s title at the top, updating as playback moves through the queue', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1', title: 'Video One' }), makeVideo({ videoId: 'v2', title: 'Video Two' })];
    renderDrawer(videos);
    await enqueueBothAndOpen(user);
    await screen.findByText('Video Two');

    expect(screen.getByRole('heading', { level: 6 })).toHaveTextContent('Video One');

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('heading', { level: 6 })).toHaveTextContent('Video Two');
  });

  it('the volume popover opens on click, closes on a second click, and its mute button toggles muted', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1' })];
    renderDrawer(videos);
    await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
    await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));
    await screen.findByRole('button', { name: 'Show volume' });

    expect(screen.queryByRole('button', { name: 'Mute' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show volume' }));
    await screen.findByRole('button', { name: 'Mute' });

    await user.click(screen.getByRole('button', { name: 'Mute' }));

    expect(document.querySelector('video')).toHaveProperty('muted', true);
    expect(await screen.findByRole('button', { name: 'Unmute' })).toBeInTheDocument();

    // hidden: true -- MUI's Popover marks everything outside itself
    // aria-hidden while open, including this same anchor button, which is
    // otherwise perfectly real and clickable.
    await user.click(screen.getByRole('button', { name: 'Hide volume', hidden: true }));
    expect(screen.queryByRole('button', { name: 'Unmute' })).not.toBeInTheDocument();
  });

  it('the volume popover\'s slider drives the underlying element\'s volume', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1' })];
    renderDrawer(videos);
    await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
    await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));

    await user.click(screen.getByRole('button', { name: 'Show volume' }));
    const slider = await screen.findByRole('slider', { name: 'Volume' });
    slider.focus();
    await user.keyboard('{ArrowDown}');

    expect((document.querySelector('video') as HTMLVideoElement).volume).toBeLessThan(1);
  });

  it('muting from the drawer is reflected in MiniPlayerBar\'s own control once minimized -- both surfaces share one volume state', async () => {
    const user = userEvent.setup();
    const videos = [makeVideo({ videoId: 'v1' })];
    // MiniPlayerBar mounted alongside the drawer, both under the same
    // provider -- same setup MainPage.tsx itself uses, and the only way to
    // confirm the two surfaces' controls actually share state rather than
    // each tracking their own copy. MiniPlayerBar hides itself while the
    // drawer is open (see its own queueOpen state), so its own volume
    // popover only becomes reachable again after closing the drawer below.
    render(
      <MemoryRouter>
        <BackgroundPlayerProvider>
          <Harness videos={videos} onClose={vi.fn()} />
          <MiniPlayerBar />
        </BackgroundPlayerProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
    await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));
    await user.click(screen.getByRole('button', { name: 'Show volume' }));
    await user.click(await screen.findByRole('button', { name: 'Mute' }));

    // MUI's Modal (which Drawer is built on) closes on Escape by default --
    // same convention MiniPlayerBar.test.tsx's own tests already use.
    await user.keyboard('{Escape}');

    await user.click(await screen.findByRole('button', { name: 'Show volume' }));
    expect(await screen.findByRole('button', { name: 'Unmute' })).toBeInTheDocument();
  });

  describe('audio/video mode toggle', () => {
    it('defaults to audio only -- no live video frame, no native controls', async () => {
      const user = userEvent.setup();
      const videos = [makeVideo({ videoId: 'v1' })];
      renderDrawer(videos);
      await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
      await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));
      await screen.findByRole('button', { name: 'Audio only' });

      expect(screen.getByRole('button', { name: 'Audio only' })).toHaveAttribute('aria-pressed', 'true');
      // The video can live inside MUI's Modal portal (document.body), not
      // necessarily under this render's own container.
      expect(document.querySelector('video')).not.toHaveAttribute('controls');
    });

    it('switching to Video reveals the live element with native controls; switching back hides it again', async () => {
      const user = userEvent.setup();
      const videos = [makeVideo({ videoId: 'v1' })];
      renderDrawer(videos);
      await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
      await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));
      await screen.findByRole('button', { name: 'Video' });

      await user.click(screen.getByRole('button', { name: 'Video' }));
      expect(document.querySelector('video')).toHaveAttribute('controls');

      await user.click(screen.getByRole('button', { name: 'Audio only' }));
      expect(document.querySelector('video')).not.toHaveAttribute('controls');
    });

    it('shows a play/pause + seek bar (same as MiniPlayerBar\'s own) while in audio mode, since native video controls aren\'t visible there', async () => {
      const user = userEvent.setup();
      const videos = [makeVideo({ videoId: 'v1' })];
      renderDrawer(videos);
      await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
      await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));
      await screen.findByRole('button', { name: 'Audio only' });

      expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Video' }));
      expect(screen.queryByRole('slider', { name: 'Seek' })).not.toBeInTheDocument();
    });
  });

  it('drags the resize handle to change the drawer\'s width', async () => {
    const videos = [makeVideo({ videoId: 'v1' })];
    renderDrawer(videos);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'enqueue v1 (test)' }));
    await user.click(screen.getByRole('button', { name: 'open drawer (test)' }));
    const handle = await screen.findByTestId('queue-drawer-resize-handle');
    const panel = handle.parentElement as HTMLElement;
    const widthBefore = panel.style.width;

    fireEvent.pointerDown(handle, { clientX: 360 });
    fireEvent.pointerMove(window, { clientX: 460 });
    fireEvent.pointerUp(window);

    expect(panel.style.width).not.toBe(widthBefore);
    expect(panel.style.width).toBe('460px');
  });
});
