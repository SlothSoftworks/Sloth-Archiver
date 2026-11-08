// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import AdvancedSearchDialog from './AdvancedSearchDialog';
import type { SearchProgress, SearchResults } from '../../types/electron-api';

const base = { tag: 'Music', tagName: 'Music', videoDir: '/lib/Music/c/v1', videoId: 'v1', platform: 'youtube', title: 'Rust talk', channel: 'Chan', thumbnailPath: null };
const RESULTS: SearchResults = {
  videos: { items: [{ ...base, kind: 'video', matches: [{ field: 'title', text: 'Rust talk', ranges: [[0, 4]] }] }], total: 1 },
  clips: { items: [], total: 0 },
  playlists: { items: [], total: 0 },
};
const EMPTY: SearchResults = { videos: { items: [], total: 0 }, clips: { items: [], total: 0 }, playlists: { items: [], total: 0 } };

let progressCallback: ((progress: SearchProgress) => void) | null;

beforeEach(() => {
  progressCallback = null;
  window.electronAPI = {
    ...window.electronAPI,
    listLibraryTags: vi.fn().mockResolvedValue({ tags: [{ tagName: 'Default', folderName: 'DefaultLibrary', createdEpoch: 1 }, { tagName: 'Music', folderName: 'Music', createdEpoch: 2 }] }),
    searchLibrary: vi.fn().mockResolvedValue({ success: true, results: RESULTS, pending: { descriptions: false, transcripts: false } }),
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

function renderDialog(props: Partial<{ open: boolean; seedText: string; onClose: () => void }> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const ui = (open: boolean) => (
    <MemoryRouter>
      <AdvancedSearchDialog open={open} onClose={onClose} seedText={props.seedText} />
      <Location />
    </MemoryRouter>
  );
  const utils = render(ui(props.open ?? true));
  return { ...utils, onClose, setOpen: (open: boolean) => utils.rerender(ui(open)) };
}

const lastRequest = () => {
  const calls = (window.electronAPI.searchLibrary as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0];
};

async function chooseType(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Search type' }));
  await user.click(screen.getByRole('option', { name }));
}

describe('AdvancedSearchDialog', () => {
  it('runs a text search over every sublibrary with the default fields', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Search for'), 'rust{Enter}');

    expect(lastRequest()).toMatchObject({
      query: { mode: 'text', text: 'rust' },
      scope: { notes: true, clips: true, playlists: true, descriptions: false, transcripts: false, tags: null },
    });
    expect(await screen.findByText('Videos (1)')).toBeInTheDocument();
  });

  it('starts from the quick search text when its own query is empty', async () => {
    renderDialog({ seedText: 'carried over' });
    expect(screen.getByLabelText('Search for')).toHaveValue('carried over');
  });

  it('flags an invalid regex and won\'t run it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await chooseType(user, 'Regex pattern');
    await user.type(screen.getByLabelText('Pattern'), '(oops');
    expect(screen.getByText(/^Invalid pattern:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });

  it('builds AND/OR terms, up to five', async () => {
    const user = userEvent.setup();
    renderDialog();
    await chooseType(user, 'Terms (AND / OR)');
    await user.type(screen.getByLabelText('Term 1'), 'alpha');
    await user.type(screen.getByLabelText('Term 2'), 'beta');
    await user.click(screen.getByRole('combobox', { name: 'Join term 2' }));
    await user.click(screen.getByRole('option', { name: 'OR' }));
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByRole('button', { name: 'Add term' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(lastRequest().query).toEqual({
      mode: 'terms',
      terms: [{ text: 'alpha', op: 'and' }, { text: 'beta', op: 'or' }, { text: '', op: 'and' }, { text: '', op: 'and' }, { text: '', op: 'and' }],
    });
  });

  it('limits the search to the chosen sublibraries and fields', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('checkbox', { name: 'Default' }));
    await user.click(screen.getByRole('checkbox', { name: 'Notes' }));
    await user.click(screen.getByRole('checkbox', { name: 'Descriptions' }));
    await user.type(screen.getByLabelText('Search for'), 'rust{Enter}');

    expect(lastRequest().scope).toEqual({ notes: false, clips: true, playlists: true, descriptions: true, transcripts: false, tags: ['Music'] });

    await user.click(screen.getByRole('checkbox', { name: 'Music' }));
    expect(screen.getByText('Pick at least one sublibrary.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });

  it('streams description matches into their own group', async () => {
    window.electronAPI.searchLibrary = vi.fn().mockResolvedValue({ success: true, results: EMPTY, pending: { descriptions: true, transcripts: false } });
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('checkbox', { name: 'Descriptions' }));
    await user.type(screen.getByLabelText('Search for'), 'compiler{Enter}');
    expect(await screen.findByTestId('description-search-progress')).toBeInTheDocument();

    await act(async () => {
      progressCallback!({
        searchId: lastRequest().searchId,
        kind: 'descriptions',
        items: [{ ...base, kind: 'description', matches: [{ field: 'description', text: 'all about compilers', ranges: [[10, 18]] }] }],
        matched: 1, scanned: 4, total: 4, done: true,
      });
    });
    expect(screen.getByText('Descriptions (1)')).toBeInTheDocument();
    expect(screen.getByText(/Description:/)).toBeInTheDocument();
  });

  it('keeps the search and its results when closed and reopened', async () => {
    const user = userEvent.setup();
    const { setOpen } = renderDialog();
    await user.type(screen.getByLabelText('Search for'), 'rust{Enter}');
    await screen.findByText('Videos (1)');

    setOpen(false);
    await waitFor(() => expect(screen.queryByText('Videos (1)')).not.toBeInTheDocument());
    setOpen(true);
    expect(await screen.findByText('Videos (1)')).toBeInTheDocument();
    expect(screen.getByLabelText('Search for')).toHaveValue('rust');
  });

  it('opens a result and closes itself', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.type(screen.getByLabelText('Search for'), 'rust{Enter}');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Rust talk/ }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/library/video/v1?tag=Music');
  });

  it('shows a search error from main', async () => {
    window.electronAPI.searchLibrary = vi.fn().mockResolvedValue({ success: false, message: 'Invalid pattern: nope' });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Search for'), 'rust{Enter}');
    expect(await screen.findByText('Invalid pattern: nope')).toBeInTheDocument();
  });
});
