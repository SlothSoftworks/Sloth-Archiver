import { Box, LinearProgress, Typography } from '@mui/material';
import type { LinearProgressProps } from '@mui/material/LinearProgress';

// value = the "truly finished" progress (postprocessing, or a plain
// download with no postprocess step), valueBuffer = the "how much has
// loaded" progress underneath it -- the same visual metaphor as a video
// player's seek bar.
export default function LinearProgressWithLabel(props: LinearProgressProps & { value: number; valueBuffer: number }) {
  const { value, valueBuffer } = props;
  const displayValue = value > 0 ? value : valueBuffer;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Box sx={{ width: '100%', mr: 1 }}>
        <LinearProgress variant="buffer" {...props} />
      </Box>
      <Box sx={{ minWidth: 35 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{`${Math.round(displayValue)}%`}</Typography>
      </Box>
    </Box>
  );
}
