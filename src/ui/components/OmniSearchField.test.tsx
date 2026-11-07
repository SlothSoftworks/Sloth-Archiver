// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import OmniSearchField from './OmniSearchField';
import type { SearchProgress, SearchResults } from '../../types/electron-api';

const base = { tag: 'Music', tagName: 'Music', videoDir: '/lib/Music/c/v1', videoId: 'v1', platform: 'youtube', title: 'Rust talk', channel: 'Chan', thumbnailPath: null };

const RESULTS: SearchResults = {
  videos: { items: [{ ...base, kind: 'video', matches: [{ field: 'title', text: 'Rust talk', ranges: [[0, 4]] }] }], total: 1 },
  clips: { items: [{ ...base, kind: 'clip', clipId: 'c1', clipTitle: 'Best rust bit', matches: [{ field: 'clipTitle', text: 'Best rust bit', ranges: [[5, 9]] }] }], total: 1 },
  playlists: { items: [{ kind: 'playlist', tag: 'Music', tagName: 'Music', playlistId: 'PL1', title: 'Rust mix', uploader: '', matches: [{ field: 'playlistTitle', text: 'Rust mix', ranges: [[0, 4]] }] }], total: 1 },
};
const EMPTY: SearchResults = { videos: { items: [], total: 0 }, clips: { items: [], total: 0 }, playlists: { items: [], total: 0 } };

let progressCallback: ((progress: SearchProgress) => void) | null;

beforeEach(() => {
  progressCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    searchLibrary: vi.fn().mockResolvedValue({ success: true, results: RESULTS, transcriptsPending: false }),
    cancelSearch: vi.fn().mockResolvedValue({ success: true }),
    getSearchStatus: vi.fn().mockResolvedValue({ building: false }),
    onSearchProgress: vi.fn((cb) => { progressCallback = cb; return cb; }),
    removeSearchProgressListener: vi.fn(),
  };
});

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderField(props: { onOpenAdvanced?: () => void } = {}) {
  return render(
    <MemoryRouter>
      <OmniSearchField {...props} />
      <Location />
    </MemoryRouter>,
  );
}

async function openAndType(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole('button', { name: 'Search all libraries' }));
  await user.type(screen.getByRole('textbox', { name: 'Search all libraries' }), text);
}

describe('OmniSearchField', () => {
  it('searches as you type and lists videos, clips and playlists with their sublibrary', async () => {
    const user = userEvent.setup();
    renderField();
    await openAndType(user, 'rust');

    await waitFor(() => expect(window.electronAPI.searchLibrary).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: { mode: 'text', text: 'rust' }, scope: {} }),
    ));
    expect(await screen.findByText('Videos (1)')).toBeInTheDocument();
    expect(screen.getByText('Clips (1)')).toBeInTheDocument();
    expect(screen.getByText('Playlists (1)')).toBeInTheDocument();
    expect(screen.getAllByText('Music').length).toBeGreaterThan(0);
  });

  it('waits for two characters before searching', async () => {
    const user = userEvent.setup();
    renderField();
    await openAndType(user, 'r');
    await new Promise((r) => setTimeout(r, 300));
    expect(window.electronAPI.searchLibrary).not.toHaveBeenCalled();
  });

  it.each([
    ['video', /^Rust talk/, '/library/video/v1?tag=Music'],
    ['clip', /^Best rust bit/, '/library/video/v1?tag=Music&view=clips&clip=c1'],
    ['playlist', /^Rust mix/, '/library?tag=Music&section=playlists&playlist=PL1'],
  ])('opens a %s result at its deep link', async (_kind, name, path) => {
    const user = userEvent.setup();
    renderField();
    await openAndType(user, 'rust');
    await screen.findByText('Videos (1)');
    await user.click(screen.getByRole('button', { name }));
    expect(screen.getByTestId('location')).toHaveTextContent(path);
  });

  it('shows only a spinner while searching, with a note while the library is being indexed', async () => {
    window.electronAPI.searchLibrary = vi.fn(() => new Promise<never>(() => {}));
    window.electronAPI.getSearchStatus = vi.fn().mockResolvedValue({ building: true });
    const user = userEvent.setup();
    renderField();
    await openAndType(user, 'rust');

    expect(await screen.findByTestId('omni-search-spinner')).toBeInTheDocument();
    expect(await screen.findByText('Indexing your library…')).toBeInTheDocument();
    expect(screen.queryByText('Videos (1)')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    window.electronAPI.searchLibrary = vi.fn().mockResolvedValue({ success: true, results: EMPTY, transcriptsPending: false });
    const user = userEvent.setup();
    renderField();
    await openAndType(user, 'zebra');
    expect(await screen.findByText('No matches for "zebra".')).toBeInTheDocument();
  });

  it('with transcripts on, searches only on Enter and streams transcript lines in', async () => {
    window.electronAPI.searchLibrary = vi.fn().mockResolvedValue({ success: true, results: EMPTY, transcriptsPending: true });
    const user = userEvent.setup();
    renderField();
    await openAndType(user, 'ru');
    await waitFor(() => expect(window.electronAPI.searchLibrary).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('checkbox', { name: 'Also search transcripts' }));
    expect(screen.getByText('Can take a while on big libraries. Press Enter to search.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search all libraries' }), 'st');
    await new Promise((r) => setTimeout(r, 300));
    expect(window.electronAPI.searchLibrary).toHaveBeenCalledTimes(1);

    await user.keyboard('{Enter}');
    expect(window.electronAPI.searchLibrary).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: { mode: 'text', text: 'rust' }, scope: { transcripts: true } }),
    );
    const { searchId } = (window.electronAPI.searchLibrary as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(await screen.findByTestId('transcript-search-progress')).toBeInTheDocument();

    await act(async () => {
      progressCallback!({ searchId: 'stale', items: [], matched: 9, scanned: 9, total: 9, done: true });
      progressCallback!({
        searchId,
        items: [{
          ...base, kind: 'transcript', epoch: '100', isLatest: false, language: 'ja', languageName: 'Japanese', lineCount: 1,
          lines: [{ start: 65.4, text: 'rust again', ranges: [[0, 4]] }],
        }],
        matched: 1, scanned: 3, total: 3, done: true,
      });
    });
    expect(screen.getByText('Transcripts (1)')).toBeInTheDocument();
    expect(screen.getByText('Japanese transcript · older version · 1 line')).toBeInTheDocument();

    await user.click(screen.getByText('1:05'));
    expect(screen.getByTestId('location')).toHaveTextContent('/library/video/v1?tag=Music&epoch=100&t=65&lang=ja');
  });

  it('turns the icon into Advanced search once open', async () => {
    const onOpenAdvanced = vi.fn();
    const user = userEvent.setup();
    renderField({ onOpenAdvanced });
    await user.click(screen.getByRole('button', { name: 'Search all libraries' }));
    await user.click(screen.getByRole('button', { name: 'Advanced search' }));
    expect(onOpenAdvanced).toHaveBeenCalled();
  });

  it('closes and cancels with the close button', async () => {
    const user = userEvent.setup();
    renderField();
    await openAndType(user, 'rust');
    await screen.findByText('Videos (1)');
    await user.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('textbox', { name: 'Search all libraries' })).not.toBeInTheDocument();
    expect(window.electronAPI.cancelSearch).toHaveBeenCalled();
  });
});
