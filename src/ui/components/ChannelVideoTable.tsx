import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Checkbox,
  Chip,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ClearIcon from '@mui/icons-material/Clear';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import type { Dayjs } from 'dayjs';
import LibrarySearchBar from './LibrarySearchBar';
import { useLibrarySearch } from '../hooks/useLibrarySearch';
import { formatApproxDate, formatDurationSeconds } from '../../utils/utils.ts';

export type ChannelVideoTableRow = {
  id: string;
  title: string;
  // Unix seconds, approximate (see formatApproxDate).
  approxTimestamp: number | null;
  durationSeconds?: number | null;
  // Set to make the row unselectable; shown on the row as the reason why.
  disabledReason?: string;
  badges?: string[];
};

export type ChannelVideoDateFilter =
  | { mode: 'on'; date: Dayjs | null }
  | { mode: 'between'; from: Dayjs | null; to: Dayjs | null };

export function isDateFilterActive(filter: ChannelVideoDateFilter): boolean {
  return filter.mode === 'on' ? !!filter.date?.isValid() : !!filter.from?.isValid() || !!filter.to?.isValid();
}

// Compares by calendar day in local time. A range is inclusive at both ends
// and may be open at either one. A row with no date never matches an active
// filter: there is nothing to say it falls inside it.
export function filterRowsByDate<Row extends { approxTimestamp: number | null }>(rows: Row[], filter: ChannelVideoDateFilter): Row[] {
  if (!isDateFilterActive(filter)) return rows;
  const from = filter.mode === 'on' ? filter.date : filter.from;
  const to = filter.mode === 'on' ? filter.date : filter.to;
  const start = from?.isValid() ? from.startOf('day').unix() : -Infinity;
  const end = to?.isValid() ? to.endOf('day').unix() : Infinity;
  return rows.filter((row) => row.approxTimestamp !== null && row.approxTimestamp >= start && row.approxTimestamp <= end);
}

export type ChannelVideoSort = { field: 'title' | 'date'; direction: 'asc' | 'desc' };

const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// null keeps the order the rows were given in. Ties keep that order too
// (Array.prototype.sort is stable), and a row with no date sorts after every
// dated one in both directions: "unknown" is neither oldest nor newest.
export function sortRows<Row extends { title: string; approxTimestamp: number | null }>(rows: Row[], sort: ChannelVideoSort | null): Row[] {
  if (!sort) return rows;
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.field === 'title') return [...rows].sort((a, b) => sign * titleCollator.compare(a.title, b.title));
  return [...rows].sort((a, b) => {
    if (a.approxTimestamp === null || b.approxTimestamp === null) {
      return (a.approxTimestamp === null ? 1 : 0) - (b.approxTimestamp === null ? 1 : 0);
    }
    return sign * (a.approxTimestamp - b.approxTimestamp);
  });
}

// Each click on a column steps through ascending, descending, then back to
// the given order.
export function nextSort(current: ChannelVideoSort | null, field: ChannelVideoSort['field']): ChannelVideoSort | null {
  if (current?.field !== field) return { field, direction: 'asc' };
  return current.direction === 'asc' ? { field, direction: 'desc' } : null;
}

const ROWS_PER_PAGE_OPTIONS = [25, 50, 100];

const VideoRow = memo(function VideoRow({ row, selected, compact, onToggle }: {
  row: ChannelVideoTableRow;
  selected: boolean;
  compact: boolean;
  onToggle: (id: string) => void;
}) {
  const disabled = !!row.disabledReason;
  return (
    <TableRow hover={!disabled} selected={selected} sx={disabled ? { opacity: 0.6 } : undefined}>
      <TableCell padding="checkbox">
        <Checkbox
          size="small"
          checked={selected}
          disabled={disabled}
          onChange={() => onToggle(row.id)}
          slotProps={{ input: { 'aria-label': `Select ${row.title || row.id}` } }}
        />
      </TableCell>
      <TableCell sx={{ maxWidth: 0, width: '100%' }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" noWrap title={row.title}>{row.title || row.id}</Typography>
          {row.disabledReason && <Chip size="small" variant="outlined" label={row.disabledReason} />}
          {row.badges?.map((badge) => <Chip key={badge} size="small" color="warning" variant="outlined" label={badge} />)}
        </Stack>
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatApproxDate(row.approxTimestamp)}</TableCell>
      {!compact && <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{formatDurationSeconds(row.durationSeconds)}</TableCell>}
    </TableRow>
  );
});

// A selectable, searchable, date-filterable list of videos. Purely
// presentational: the caller owns the rows and the selection, so the same
// table serves any "review a list of videos before adding them" screen.
export default function ChannelVideoTable({ rows, selectedIds, onSelectedIdsChange, compact = false, emptyMessage, toolbarActions, searchPlaceholder, ariaLabel }: {
  rows: ChannelVideoTableRow[];
  selectedIds: ReadonlySet<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
  compact?: boolean;
  emptyMessage: string;
  toolbarActions?: ReactNode;
  searchPlaceholder?: string;
  ariaLabel?: string;
}) {
  const { query, setQuery, isSearching, filtered: searched, clear } = useLibrarySearch(rows, (row) => row.title);
  const [dateFilter, setDateFilter] = useState<ChannelVideoDateFilter>({ mode: 'on', date: null });
  const [sort, setSort] = useState<ChannelVideoSort | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  const filtered = useMemo(() => filterRowsByDate(searched, dateFilter), [searched, dateFilter]);
  const dateActive = isDateFilterActive(dateFilter);
  const filterActive = isSearching || dateActive;

  const lastPage = Math.max(0, Math.ceil(filtered.length / rowsPerPage) - 1);
  const currentPage = Math.min(page, lastPage);
  // Sorting only changes the order rows are shown in: selection and what
  // select-all covers are both still defined by the filter alone.
  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);
  const pageRows = useMemo(() => sorted.slice(currentPage * rowsPerPage, (currentPage + 1) * rowsPerPage), [sorted, currentPage, rowsPerPage]);

  const selectable = useMemo(() => filtered.filter((row) => !row.disabledReason), [filtered]);
  const selectedInFilter = selectable.filter((row) => selectedIds.has(row.id)).length;
  const allSelected = selectable.length > 0 && selectedInFilter === selectable.length;

  // Read through a ref so the row callback keeps one identity and a
  // keystroke in the search box does not re-render every row.
  const latest = useRef({ selectedIds, onSelectedIdsChange });
  latest.current = { selectedIds, onSelectedIdsChange };
  const toggleRow = useCallback((id: string) => {
    const next = new Set(latest.current.selectedIds);
    if (!next.delete(id)) next.add(id);
    latest.current.onSelectedIdsChange(next);
  }, []);

  // Acts on every row matching the current filter, on every page, and
  // leaves whatever was selected under an earlier filter alone.
  const toggleAll = () => {
    const next = new Set(selectedIds);
    for (const row of selectable) {
      if (allSelected) next.delete(row.id);
      else next.add(row.id);
    }
    onSelectedIdsChange(next);
  };

  const changeSort = (field: ChannelVideoSort['field']) => {
    setSort((current) => nextSort(current, field));
    setPage(0);
  };

  const sortableHeader = (field: ChannelVideoSort['field'], label: string) => (
    <TableCell sortDirection={sort?.field === field ? sort.direction : false}>
      <TableSortLabel
        // MUI hides the arrow of an unsorted column until it is hovered,
        // which leaves no hint that the column can be sorted at all.
        sx={{ '& .MuiTableSortLabel-icon': { opacity: 0.35 }, '&.Mui-active .MuiTableSortLabel-icon': { opacity: 1 } }}
        active={sort?.field === field}
        direction={sort?.field === field ? sort.direction : 'asc'}
        onClick={() => changeSort(field)}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );

  const changeDateFilter = (next: ChannelVideoDateFilter) => {
    setDateFilter(next);
    setPage(0);
  };

  const pickerSlotProps = { textField: { size: 'small' as const, sx: { width: compact ? 150 : 170 } } };

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Stack spacing={1} sx={{ minHeight: 0, flex: 1 }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          useFlexGap
          // The search bar's own 220px minimum does not leave room for the
          // date filter beside it in the narrower compact table.
          sx={{ flexWrap: 'wrap', '& > .MuiTextField-root': compact ? { minWidth: 140, flex: 1 } : undefined }}
        >
          <LibrarySearchBar
            value={query}
            onChange={(value) => { setQuery(value); setPage(0); }}
            onClear={() => { clear(); setPage(0); }}
            placeholder={searchPlaceholder}
          />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={dateFilter.mode}
            onChange={(_event, mode: 'on' | 'between' | null) => {
              if (mode === 'on') changeDateFilter({ mode: 'on', date: null });
              if (mode === 'between') changeDateFilter({ mode: 'between', from: null, to: null });
            }}
            aria-label="Date filter type"
          >
            <ToggleButton value="on">On date</ToggleButton>
            <ToggleButton value="between">Between</ToggleButton>
          </ToggleButtonGroup>
          {dateFilter.mode === 'on' ? (
            <DatePicker
              label="Date"
              value={dateFilter.date}
              onChange={(date) => changeDateFilter({ mode: 'on', date })}
              slotProps={pickerSlotProps}
            />
          ) : (
            <>
              <DatePicker
                label="From"
                value={dateFilter.from}
                maxDate={dateFilter.to ?? undefined}
                onChange={(from) => changeDateFilter({ ...dateFilter, from })}
                slotProps={pickerSlotProps}
              />
              <DatePicker
                label="To"
                value={dateFilter.to}
                minDate={dateFilter.from ?? undefined}
                onChange={(to) => changeDateFilter({ ...dateFilter, to })}
                slotProps={pickerSlotProps}
              />
            </>
          )}
          {dateActive &&
            <Tooltip title="Clear date filter">
              <IconButton
                size="small"
                aria-label="Clear date filter"
                onClick={() => changeDateFilter(dateFilter.mode === 'on' ? { mode: 'on', date: null } : { mode: 'between', from: null, to: null })}
              >
                <ClearIcon fontSize="small" />
              </IconButton>
            </Tooltip>}
        </Stack>
        {/* The actions share the selection line rather than the filter row,
            which has no room left for them at ordinary window widths. */}
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Typography variant="caption" color="text.secondary">
            {selectedIds.size} selected{filterActive ? ` · ${filtered.length} match the filter` : ''}
          </Typography>
          {toolbarActions}
        </Stack>
        <TableContainer sx={{ flex: 1, minHeight: 120, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Table stickyHeader size="small" aria-label={ariaLabel} sx={compact ? { '& .MuiTableCell-root': { py: 0.25, px: 1 } } : undefined}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={allSelected}
                    indeterminate={selectedInFilter > 0 && !allSelected}
                    disabled={selectable.length === 0}
                    onChange={toggleAll}
                    slotProps={{ input: { 'aria-label': filterActive ? 'Select all matching videos' : 'Select all videos' } }}
                  />
                </TableCell>
                {sortableHeader('title', 'Title')}
                {sortableHeader('date', 'Date')}
                {!compact && <TableCell align="right">Length</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {pageRows.map((row) => (
                <VideoRow key={row.id} row={row} selected={selectedIds.has(row.id)} compact={compact} onToggle={toggleRow} />
              ))}
              {filtered.length === 0 &&
                <TableRow>
                  <TableCell colSpan={compact ? 3 : 4}>
                    <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                      {rows.length === 0 ? emptyMessage : 'No videos match the filter.'}
                    </Typography>
                  </TableCell>
                </TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={filtered.length}
          page={currentPage}
          onPageChange={(_event, nextPage) => setPage(nextPage)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }}
          rowsPerPageOptions={ROWS_PER_PAGE_OPTIONS}
          sx={{ flexShrink: 0 }}
        />
      </Stack>
    </LocalizationProvider>
  );
}
