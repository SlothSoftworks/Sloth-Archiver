import { IconButton, InputAdornment, TextField } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';

// Shared by every search bar in the Library tab -- a plain controlled input
// (the debounce itself lives in useLibrarySearch, not here) so this stays a
// dumb, reusable piece of UI. The clear button only appears once there's
// something to clear.
export default function LibrarySearchBar({ value, onChange, onClear, placeholder = 'Search titles...' }: {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  placeholder?: string;
}) {
  return (
    <TextField
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: value && (
            <InputAdornment position="end">
              <IconButton size="small" onClick={onClear} aria-label="Clear search" edge="end">
                <ClearIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
      sx={{ minWidth: 220 }}
    />
  );
}
