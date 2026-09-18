// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import MiniPlayerBar from './MiniPlayerBar';
import { BackgroundPlayerProvider, useBackgroundPlayer, type BackgroundPlayerVideo } from '../hooks/useBackgroundPlayer.tsx';

function makeVideo(overrides: Partial<BackgroundPlayerVideo> = {}): BackgroundPlayerVideo {
  return {
    videoId: 'v1', title: 'Video One', channel: 'Some Channel',
    thumbnailPath: '/lib/c/v1/thumb.jpg', sourcePath: '/lib/c/v1/1/video.mp4', mimeType: 'video/mp4',
    ...overrides,
  };
}

// Drives the shared background-player context from outside MiniPlayerBar
// itself (via a sibling under the same provider), mirroring how the real
// app starts background playback from the player's own context menu.
function PlayButton({ video = makeVideo() }: { video?: BackgroundPlayerVideo }) {
  const { play } = useBackgroundPlayer();
  return <button onClick={() => play(video)}>start playing (test)</button>;
}

function renderBar(video?: BackgroundPlayerVideo) {
  return render(
    <MemoryRouter>
      <BackgroundPlayerProvider>
        <PlayButton video={video} />
        <MiniPlayerBar />
      </BackgroundPlayerProvider>
    </MemoryRouter>,
  );
}

describe('MiniPlayerBar', () => {
  it('renders nothing when no background video is playing', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('shows the title/channel once something is playing, and a link back to its detail view', async () => {
    const user = userEvent.setup();
    renderBar(makeVideo({ videoId: 'abc123', title: 'My Video', channel: 'My Channel' }));

    await user.click(screen.getByRole('button', { name: 'start playing (test)' }));

    expect(await screen.findByText('My Video')).toBeInTheDocument();
    expect(screen.getByText('My Channel')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/library/video/abc123');
  });

  it('links into Clip Collection with the clip pre-selected when playing a clip', async () => {
    const user = userEvent.setup();
    renderBar(makeVideo({ videoId: 'abc123', clipId: 'clip1' }));

    await user.click(screen.getByRole('button', { name: 'start playing (test)' }));

    expect(await screen.findByRole('link')).toHaveAttribute('href', '/library/video/abc123?view=clips&clip=clip1');
  });

  it('the play/pause button reflects and toggles playback state', async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    await user.click(screen.getByRole('button', { name: 'start playing (test)' }));
    await screen.findByText('Video One');

    // jsdom has no real media pipeline -- paused state is driven by the
    // underlying element's own play/pause events, same as
    // useBackgroundPlayer.test.tsx's own tests.
    const video = container.querySelector('video')!;
    act(() => video.dispatchEvent(new Event('play')));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();

    act(() => video.dispatchEvent(new Event('pause')));
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('the close button stops playback, hiding the bar', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'start playing (test)' }));
    await screen.findByText('Video One');

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(screen.queryByText('Video One')).not.toBeInTheDocument();
  });
});
