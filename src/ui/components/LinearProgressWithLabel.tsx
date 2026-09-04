import { Box, LinearProgress, Typography } from '@mui/material';
import type { LinearProgressProps } from '@mui/material/LinearProgress';

// value = the "truly finished" progress (postprocessing, or a plain
// download with no postprocess step), valueBuffer = the "how much has
// loaded" progress underneath it -- the same visual metaphor as a video
// player's seek bar.
//
// indeterminate switches to MUI's own indeterminate variant (a bar that
// animates with no fixed endpoint) instead -- for stages that have no real
// percentage to show at all (e.g. yt-dlp's own merge step, which only
// reports started/finished), rather than displaying a fake fixed value that
// reads as a stuck/broken progress bar.
export default function LinearProgressWithLabel(props: LinearProgressProps & { value: number; valueBuffer: number; indeterminate?: boolean }) {
  const { value, valueBuffer, indeterminate, ...rest } = props;
  const displayValue = value > 0 ? value : valueBuffer;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Box sx={{ width: '100%', mr: 1 }}>
        <LinearProgress variant={indeterminate ? 'indeterminate' : 'buffer'} {...rest} value={value} valueBuffer={valueBuffer} />
      </Box>
      {!indeterminate &&
        <Box sx={{ minWidth: 35 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{`${Math.round(displayValue)}%`}</Typography>
        </Box>}
    </Box>
  );
}
