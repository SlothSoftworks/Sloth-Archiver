// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import dayjs from 'dayjs';
import ChannelVideoTable, { filterRowsByDate, isDateFilterActive, sortRows, nextSort, type ChannelVideoTableRow } from './ChannelVideoTable';

// Several tests here render 100+ MUI table rows and click through them with
// userEvent, which runs close to the default 5 s when the whole suite is
// running in parallel.
vi.setConfig({ testTimeout: 20000 });

// Local-time noon on the given day, as Unix seconds: the table filters by
// calendar day in local time, so this lands on the intended day anywhere.
function noon(year: number, month: number, day: number) {
  return new Date(year, month - 1, day, 12, 0, 0).getTime() / 1000;
}

// 120 rows, newest first: "Video 001" is 2024-03-01, each next one a day older.
function makeRows(count = 120): ChannelVideoTableRow[] {
  const first = dayjs(new Date(2024, 2, 1, 12, 0, 0));
  return Array.from({ length: count }, (_, i) => ({
    id: `id${i + 1}`,
    title: `Video ${String(i + 1).padStart(3, '0')}`,
    approxTimestamp: first.subtract(i, 'day').unix(),
    durationSeconds: 60 + i,
  }));
}

let latestSelection: ReadonlySet<string> = new Set();

function Harness({ rows, initialSelection = [], compact = false }: { rows: ChannelVideoTableRow[]; initialSelection?: string[]; compact?: boolean }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initialSelection));
  latestSelection = selected;
  return (
    <ChannelVideoTable
      rows={rows}
      selectedIds={selected}
      onSelectedIdsChange={setSelected}
      compact={compact}
      emptyMessage="Nothing here."
      searchPlaceholder="Search videos..."
      ariaLabel="Videos"
      toolbarActions={<button>toolbar action</button>}
    />
  );
}

function bodyTitles() {
  return screen.getAllByRole('checkbox', { name: /^Select Video/ }).map((box) => box.getAttribute('aria-label')!.replace('Select ', ''));
}

function headerCheckbox() {
  return screen.getByRole('checkbox', { name: /^Select all/ });
}

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByPlaceholderText('Search videos...'), text);
}

async function typeDate(user: ReturnType<typeof userEvent.setup>, pickerIndex: number, digits: string) {
  await user.click(screen.getAllByRole('spinbutton', { name: 'Month' })[pickerIndex]);
  await user.keyboard(digits);
}

describe('filterRowsByDate', () => {
  const rows = [
    { id: 'a', approxTimestamp: noon(2024, 3, 1) },
    { id: 'b', approxTimestamp: noon(2024, 2, 20) },
    { id: 'c', approxTimestamp: noon(2023, 12, 31) },
    { id: 'd', approxTimestamp: null },
  ];
  const ids = (filtered: { id: string }[]) => filtered.map((r) => r.id);
  const day = (year: number, month: number, date: number) => dayjs(new Date(year, month - 1, date));

  it('returns every row, including undated ones, when no date is set', () => {
    expect(filterRowsByDate(rows, { mode: 'on', date: null })).toBe(rows);
    expect(filterRowsByDate(rows, { mode: 'between', from: null, to: null })).toBe(rows);
    expect(isDateFilterActive({ mode: 'on', date: null })).toBe(false);
    expect(isDateFilterActive({ mode: 'on', date: dayjs('not a date') })).toBe(false);
  });

  it('matches a single calendar day, whatever the time of day', () => {
    expect(ids(filterRowsByDate(rows, { mode: 'on', date: day(2024, 2, 20) }))).toEqual(['b']);
    expect(ids(filterRowsByDate(rows, { mode: 'on', date: day(2024, 2, 20).hour(23) }))).toEqual(['b']);
    expect(ids(filterRowsByDate(rows, { mode: 'on', date: day(2024, 2, 21) }))).toEqual([]);
  });

  it('treats a range as inclusive at both ends', () => {
    expect(ids(filterRowsByDate(rows, { mode: 'between', from: day(2024, 2, 20), to: day(2024, 3, 1) }))).toEqual(['a', 'b']);
    expect(ids(filterRowsByDate(rows, { mode: 'between', from: day(2024, 2, 21), to: day(2024, 2, 29) }))).toEqual([]);
  });

  it('allows a range that is open at either end', () => {
    expect(ids(filterRowsByDate(rows, { mode: 'between', from: day(2024, 1, 1), to: null }))).toEqual(['a', 'b']);
    expect(ids(filterRowsByDate(rows, { mode: 'between', from: null, to: day(2024, 2, 20) }))).toEqual(['b', 'c']);
    expect(isDateFilterActive({ mode: 'between', from: null, to: day(2024, 2, 20) })).toBe(true);
  });

  it('leaves out rows with no date while a filter is active', () => {
    expect(ids(filterRowsByDate(rows, { mode: 'between', from: day(2000, 1, 1), to: null }))).not.toContain('d');
  });
});

describe('ChannelVideoTable', () => {
  it('shows the first page of rows with title, approximate date and length, plus the toolbar actions', () => {
    render(<Harness rows={makeRows()} />);
    expect(bodyTitles()).toHaveLength(50);
    expect(bodyTitles()[0]).toBe('Video 001');
    const firstRow = screen.getByRole('checkbox', { name: 'Select Video 001' }).closest('tr')!;
    expect(within(firstRow).getByText('~2024')).toBeInTheDocument();
    expect(within(firstRow).getByText('1:00')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Length' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'toolbar action' })).toBeInTheDocument();
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Videos' })).toBeInTheDocument();
  });

  it('shows the empty message with no rows, and a different one when a filter matches nothing', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness rows={[]} />);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
    expect(headerCheckbox()).toBeDisabled();
    unmount();

    render(<Harness rows={makeRows(3)} />);
    await search(user, 'zzz');
    expect(await screen.findByText('No videos match the filter.')).toBeInTheDocument();
  });

  it('pages through the rows and changes the page size', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows()} />);
    expect(screen.getByText('1–50 of 120')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(bodyTitles()[0]).toBe('Video 051');
    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(bodyTitles()).toEqual(Array.from({ length: 20 }, (_, i) => `Video ${101 + i}`));

    await user.click(screen.getByRole('combobox', { name: /Rows per page/ }));
    await user.click(screen.getByRole('option', { name: '100' }));
    expect(bodyTitles()).toHaveLength(100);
    expect(bodyTitles()[0]).toBe('Video 001');
  });

  it('filters by title and goes back to the first page', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows()} />);
    await user.click(screen.getByRole('button', { name: 'Go to next page' }));

    await search(user, 'video 11');
    await waitFor(() => expect(bodyTitles()).toEqual(['Video 110', 'Video 111', 'Video 112', 'Video 113', 'Video 114', 'Video 115', 'Video 116', 'Video 117', 'Video 118', 'Video 119']));
    expect(screen.getByText('0 selected · 10 match the filter')).toBeInTheDocument();
    expect(screen.getByText('1–10 of 10')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(bodyTitles()).toHaveLength(50));
  });

  it('filters to a single date typed into the picker, and clears it again', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows()} />);
    await typeDate(user, 0, '02202024');

    await waitFor(() => expect(bodyTitles()).toEqual(['Video 011']));
    expect(screen.getByText('0 selected · 1 match the filter')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear date filter' }));
    expect(bodyTitles()).toHaveLength(50);
    expect(screen.queryByRole('button', { name: 'Clear date filter' })).not.toBeInTheDocument();
  });

  it('filters to an inclusive range, including one with only a start', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows()} />);
    await user.click(screen.getByRole('button', { name: 'Between' }));

    await typeDate(user, 0, '02272024');
    await waitFor(() => expect(bodyTitles()).toEqual(['Video 001', 'Video 002', 'Video 003', 'Video 004']));

    await typeDate(user, 1, '02282024');
    await waitFor(() => expect(bodyTitles()).toEqual(['Video 003', 'Video 004']));
    expect(screen.getByText('0 selected · 2 match the filter')).toBeInTheDocument();
  });

  it('excludes undated rows while a date filter is active', async () => {
    const user = userEvent.setup();
    const rows = [...makeRows(2), { id: 'undated', title: 'Video undated', approxTimestamp: null }];
    render(<Harness rows={rows} />);
    expect(bodyTitles()).toContain('Video undated');
    await user.click(screen.getByRole('button', { name: 'Between' }));
    await typeDate(user, 0, '01012000');
    await waitFor(() => expect(bodyTitles()).toEqual(['Video 001', 'Video 002']));
  });

  it('selects and deselects single rows', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows(5)} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Video 002' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Video 004' }));
    expect([...latestSelection]).toEqual(['id2', 'id4']);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(headerCheckbox()).toHaveAttribute('data-indeterminate', 'true');

    await user.click(screen.getByRole('checkbox', { name: 'Select Video 002' }));
    expect([...latestSelection]).toEqual(['id4']);
  });

  it('the header checkbox selects every row on every page, then deselects them', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows()} />);
    expect(headerCheckbox()).not.toBeChecked();
    expect(headerCheckbox()).toHaveAttribute('data-indeterminate', 'false');

    await user.click(headerCheckbox());
    expect(latestSelection.size).toBe(120);
    expect(headerCheckbox()).toBeChecked();
    expect(screen.getByText('120 selected')).toBeInTheDocument();

    await user.click(headerCheckbox());
    expect(latestSelection.size).toBe(0);
  });

  it('with a filter, select-all takes only the matching rows across pages, skips disabled ones, and keeps the earlier selection', async () => {
    const user = userEvent.setup();
    const rows = makeRows().map((row) => (row.id === 'id105' ? { ...row, disabledReason: 'In library' } : row));
    render(<Harness rows={rows} initialSelection={['id1', 'id2']} />);
    await user.click(screen.getByRole('combobox', { name: /Rows per page/ }));
    await user.click(screen.getByRole('option', { name: '25' }));

    // "video 0" matches Video 001..099: four pages of 25.
    await search(user, 'video 0');
    await waitFor(() => expect(screen.getByText('2 selected · 99 match the filter')).toBeInTheDocument());
    expect(bodyTitles()).toHaveLength(25);
    // Two of the 99 matching rows were already selected.
    expect(headerCheckbox()).toHaveAttribute('data-indeterminate', 'true');

    await user.click(headerCheckbox());
    expect(latestSelection.size).toBe(99);
    expect(headerCheckbox()).toBeChecked();

    await user.clear(screen.getByPlaceholderText('Search videos...'));
    await search(user, 'video 10');
    await waitFor(() => expect(screen.getByText('99 selected · 10 match the filter')).toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'Select Video 105' })).toBeDisabled();
    expect(within(screen.getByRole('checkbox', { name: 'Select Video 105' }).closest('tr')!).getByText('In library')).toBeInTheDocument();
    expect(headerCheckbox()).not.toBeChecked();

    await user.click(headerCheckbox());
    // 99 from the first search + the 9 selectable "Video 10x" rows; the disabled one is left out.
    expect(latestSelection.size).toBe(108);
    expect(latestSelection.has('id105')).toBe(false);
    expect(latestSelection.has('id1')).toBe(true);
    expect(headerCheckbox()).toBeChecked();

    // Deselecting under this filter only drops this filter's rows.
    await user.click(headerCheckbox());
    expect(latestSelection.size).toBe(99);
    expect(latestSelection.has('id100')).toBe(false);
    expect(latestSelection.has('id1')).toBe(true);
  });

  it('shows badges on a row', () => {
    const rows = [{ id: 'a', title: 'Video members', approxTimestamp: null, badges: ['Members only'] }];
    render(<Harness rows={rows} />);
    expect(screen.getByText('Members only')).toBeInTheDocument();
  });

  it('renders a title as text, never as markup', () => {
    const rows = [{ id: 'a', title: '<img src=x onerror=alert(1)>', approxTimestamp: null }];
    render(<Harness rows={rows} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('td img')).toBeNull();
  });

  it('compact hides the length column', () => {
    render(<Harness rows={makeRows(2)} compact />);
    expect(screen.queryByRole('columnheader', { name: 'Length' })).not.toBeInTheDocument();
    expect(screen.queryByText('1:00')).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  });
});

describe('sortRows / nextSort', () => {
  const row = (id: string, title: string, approxTimestamp: number | null) => ({ id, title, approxTimestamp });
  const rows = [
    row('a', 'banana 10', noon(2024, 3, 1)),
    row('b', 'Apple', null),
    row('c', 'banana 2', noon(2022, 1, 1)),
    row('d', 'apple', noon(2024, 3, 1)),
    row('e', 'Cherry', null),
    row('f', 'Écoute', noon(2023, 6, 1)),
  ];
  const ids = (sorted: { id: string }[]) => sorted.map((r) => r.id).join('');

  it('returns the rows as given when there is no sort', () => {
    expect(sortRows(rows, null)).toBe(rows);
  });

  it('sorts titles ignoring case, with numbers in numeric order and ties in the given order', () => {
    expect(ids(sortRows(rows, { field: 'title', direction: 'asc' }))).toBe('bdcaef');
    expect(ids(sortRows(rows, { field: 'title', direction: 'desc' }))).toBe('feacbd');
    expect(ids(rows)).toBe('abcdef');
  });

  it('sorts dates with undated rows last in both directions and ties in the given order', () => {
    expect(ids(sortRows(rows, { field: 'date', direction: 'asc' }))).toBe('cfadbe');
    expect(ids(sortRows(rows, { field: 'date', direction: 'desc' }))).toBe('adfcbe');
  });

  it('steps a column through ascending, descending and back to no sort, and starts over on another column', () => {
    expect(nextSort(null, 'title')).toEqual({ field: 'title', direction: 'asc' });
    expect(nextSort({ field: 'title', direction: 'asc' }, 'title')).toEqual({ field: 'title', direction: 'desc' });
    expect(nextSort({ field: 'title', direction: 'desc' }, 'title')).toBeNull();
    expect(nextSort({ field: 'title', direction: 'desc' }, 'date')).toEqual({ field: 'date', direction: 'asc' });
  });
});

describe('ChannelVideoTable: sorting', () => {
  function header(name: string) {
    return screen.getByRole('columnheader', { name: new RegExp(name) });
  }

  async function clickSort(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(within(header(name)).getByRole('button'));
  }

  it('starts in the given order with no column marked as sorted', () => {
    render(<Harness rows={makeRows(5)} />);
    expect(bodyTitles()).toEqual(['Video 001', 'Video 002', 'Video 003', 'Video 004', 'Video 005']);
    expect(header('Title')).not.toHaveAttribute('aria-sort');
    expect(header('Date')).not.toHaveAttribute('aria-sort');
  });

  it('sorts by title ascending, then descending, then returns to the given order', async () => {
    const user = userEvent.setup();
    const rows = [
      { id: 'a', title: 'beta', approxTimestamp: noon(2024, 1, 3) },
      { id: 'b', title: 'Alpha', approxTimestamp: noon(2024, 1, 2) },
      { id: 'c', title: 'gamma', approxTimestamp: noon(2024, 1, 1) },
    ];
    render(<Harness rows={rows} />);
    const titles = () => screen.getAllByRole('checkbox', { name: /^Select (?!all)/ }).map((box) => box.getAttribute('aria-label')!.replace('Select ', ''));

    await clickSort(user, 'Title');
    expect(titles()).toEqual(['Alpha', 'beta', 'gamma']);
    expect(header('Title')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Date')).not.toHaveAttribute('aria-sort');

    await clickSort(user, 'Title');
    expect(titles()).toEqual(['gamma', 'beta', 'Alpha']);
    expect(header('Title')).toHaveAttribute('aria-sort', 'descending');

    await clickSort(user, 'Title');
    expect(titles()).toEqual(['beta', 'Alpha', 'gamma']);
    expect(header('Title')).not.toHaveAttribute('aria-sort');
  });

  it('sorts by date both ways with undated rows last, and switching column drops the other sort', async () => {
    const user = userEvent.setup();
    const rows = [
      { id: 'a', title: 'Video middle', approxTimestamp: noon(2023, 1, 1) },
      { id: 'b', title: 'Video undated', approxTimestamp: null },
      { id: 'c', title: 'Video newest', approxTimestamp: noon(2024, 1, 1) },
      { id: 'd', title: 'Video oldest', approxTimestamp: noon(2022, 1, 1) },
    ];
    render(<Harness rows={rows} />);

    await clickSort(user, 'Date');
    expect(bodyTitles()).toEqual(['Video oldest', 'Video middle', 'Video newest', 'Video undated']);
    expect(header('Date')).toHaveAttribute('aria-sort', 'ascending');

    await clickSort(user, 'Date');
    expect(bodyTitles()).toEqual(['Video newest', 'Video middle', 'Video oldest', 'Video undated']);
    expect(header('Date')).toHaveAttribute('aria-sort', 'descending');

    await clickSort(user, 'Title');
    expect(bodyTitles()).toEqual(['Video middle', 'Video newest', 'Video oldest', 'Video undated']);
    expect(header('Title')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Date')).not.toHaveAttribute('aria-sort');
  });

  it('sorts across pages, after filtering, and goes back to the first page', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows()} />);
    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(bodyTitles()[0]).toBe('Video 051');

    // Oldest first: the given order is newest first, so this is the reverse.
    await clickSort(user, 'Date');
    expect(screen.getByText('1–50 of 120')).toBeInTheDocument();
    expect(bodyTitles()[0]).toBe('Video 120');
    expect(bodyTitles()[49]).toBe('Video 071');
    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(bodyTitles()[0]).toBe('Video 070');

    await search(user, 'video 11');
    await waitFor(() => expect(bodyTitles()).toEqual(['Video 119', 'Video 118', 'Video 117', 'Video 116', 'Video 115', 'Video 114', 'Video 113', 'Video 112', 'Video 111', 'Video 110']));
    expect(screen.getByText('0 selected · 10 match the filter')).toBeInTheDocument();
  });

  it('leaves the selection alone and select-all still means every row matching the filter', async () => {
    const user = userEvent.setup();
    const rows = makeRows().map((row) => (row.id === 'id120' ? { ...row, disabledReason: 'In library' } : row));
    render(<Harness rows={rows} initialSelection={['id1', 'id2']} />);

    await clickSort(user, 'Title');
    await clickSort(user, 'Title');
    expect(bodyTitles()[0]).toBe('Video 120');
    expect([...latestSelection]).toEqual(['id1', 'id2']);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(headerCheckbox()).toHaveAttribute('data-indeterminate', 'true');

    await user.click(headerCheckbox());
    expect(latestSelection.size).toBe(119);
    expect(latestSelection.has('id120')).toBe(false);
    expect(headerCheckbox()).toBeChecked();
  });

  it('works on the compact table too', async () => {
    const user = userEvent.setup();
    render(<Harness rows={makeRows(3)} compact />);
    await clickSort(user, 'Date');
    expect(bodyTitles()).toEqual(['Video 003', 'Video 002', 'Video 001']);
    expect(header('Date')).toHaveAttribute('aria-sort', 'ascending');
  });
});
