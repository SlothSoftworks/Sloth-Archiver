import React from 'react';
import {
  Card,
  Box,
  Stack,
  Skeleton,
  Divider,
  Paper,
  Grid,
} from '@mui/material';

const VideoDetailCardSkeleton: React.FC = () => {
  return (
    <>
    <Card elevation={3} sx={{ display: 'flex', p: 2, borderRadius: 4 }}>
      <Stack sx={{ width: '100%' }}>
        <Stack direction="row">
          <Box sx={{ width: '50%', pr: 2 }}>
            <Skeleton
              variant="rectangular"
              height={240}
              sx={{ borderRadius: 2, mb: 2 }}
            />

            <Paper sx={{ p: 1, border: '2px solid black', borderRadius: 2, height: '50%' }}>
              <Grid container spacing={{ xs: 1, sm: 1 }} columns={{ xs: 2, sm: 9, md: 12 }}>
                {Array.from({ length: 8 }).map((_, idx) => (
                  <Grid size={{ xs: 1, sm: 3 }} key={idx}>
                    <Skeleton variant="rounded" height={52} sx={{ borderRadius: 1 }} />
                  </Grid>
                ))}
              </Grid>
              <Divider flexItem sx={{ pt: 1 }} orientation="horizontal" />
              <Box sx={{ display: 'flex', alignItems: 'center', pt: 1 }}>
                <Skeleton variant="text" width={120} height={32} />
                <Skeleton variant="circular" width={20} height={20} sx={{ ml: 2 }} />
              </Box>
              <Box sx={{ pt: '3%' }}>
                <Skeleton variant="rounded" width="40%" height={32} />
              </Box>
            </Paper>
          </Box>

          <Box sx={{ width: '50%' }}>
            <Stack spacing={2} direction="row" justifyContent="space-between" alignItems="flex-start" mb={1}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Skeleton variant="text" width="70%" height={32} />
              </Box>
              <Box sx={{ flexShrink: 0, width: 90 }}>
                <Skeleton variant="text" width="100%" height={32} />
              </Box>
            </Stack>
            <Card>
              <Box sx={{ backgroundColor: 'primary.main', p: 1 }}>
                <Skeleton variant="text" width="30%" height={28} sx={{ bgcolor: 'rgba(255,255,255,0.3)' }} />
              </Box>
              <Box sx={{ p: 1, maxHeight: '45vh', height: '45vh' }}>
                {Array.from({ length: 10 }).map((_, idx) => (
                  <Skeleton key={idx} variant="text" width={idx % 3 === 2 ? '80%' : '100%'} height={24} />
                ))}
              </Box>
            </Card>
          </Box>
        </Stack>

        <Box sx={{ p: 2 }}>
          <Divider flexItem sx={{ mx: 3 }} orientation="horizontal" />
          <Stack direction="row" spacing={2} sx={{ pt: 1 }}>
            <Skeleton variant="text" width={100} height={28} />
            <Skeleton variant="text" width={80} height={28} />
          </Stack>
          <Skeleton variant="rounded" width="100%" height={4} sx={{ mt: 1 }} />
        </Box>
      </Stack>
    </Card>
    </>
  );
};

export default VideoDetailCardSkeleton;
