import React from 'react';
import {
  Card,
  CardContent,
  Box,
  Stack,
  Skeleton,
  Typography,
  Divider,
  Paper,
  Grid,
} from '@mui/material';

const VideoDetailCardSkeleton: React.FC = () => {
  return (
    <>
    <Card elevation={0} sx={{ display: 'flex', p: 2, borderRadius: 4 }}>
      <Box sx={{ width: '50%', pr: 2}}>
        <Skeleton
            variant="rectangular"
            height={240}
        />


        <Box sx={{ p:2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {Array.from({ length: 8 }).map((_, idx) => (
            <Skeleton
              key={idx}
              variant="rounded"
              width={120}
              height={36}
              sx={{ borderRadius: 1 }}
            />
          ))}
        </Box>
      </Box>

      <Box sx={{ width: '50%' }}>
        <Stack spacing={6} direction="row" justifyContent="left" mb={1}>
            <Grid size={8}>
                <Skeleton variant="text" width="70%" height={32} />
            </Grid>
            <Grid sx={{whiteSpace: 'nowrap'}} size={2} justifyContent={'right'}>
                <Skeleton variant="text" width="100%" height={32} />
            </Grid>
        </Stack>
            <Stack spacing={1} direction="row" justifyContent="left">
                <Skeleton variant="text" width="0%" height={32} />
            </Stack>
            <Skeleton variant="text" width="100%" height={32} />
            <Skeleton variant="text" width="100%" height={32} />
            <Skeleton variant="text" width="100%" height={32} />
            <Skeleton variant="text" width="100%" height={32} />
      </Box>
    </Card>
    </>
  );
};

export default VideoDetailCardSkeleton;
