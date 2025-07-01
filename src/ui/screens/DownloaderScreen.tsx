import { useState } from 'react';
import Grid from '@mui/material/Grid';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import { styled } from '@mui/material/styles';
import './screens.css'
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import DownloadIcon from '@mui/icons-material/Download';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';

const Item = styled(Paper)(({ theme }) => ({
    backgroundColor: '#fff',
    ...theme.typography.body2,
    padding: theme.spacing(1),
    textAlign: 'center',
    color: (theme.vars ?? theme).palette.text.secondary,
    ...theme.applyStyles('dark', {
      backgroundColor: '#1A2027',
    }),
  }));

export default function DownloaderScreen() {

  const handlePickFolder = async () => {
    const result = await window.electronAPI.pickFolder();
    console.log(result);
  };

  const VisuallyHiddenInput = styled('input')({
    clip: 'rect(0 0 0 0)',
    clipPath: 'inset(50%)',
    height: 1,
    overflow: 'hidden',
    position: 'absolute',
    bottom: 0,
    left: 0,
    whiteSpace: 'nowrap',
    width: 1,
  });

  return (
    <>
    <div className='tabContent'>
        <Box sx={{ flexGrow: 1 }}>
        <Grid container spacing={2}>
            <Grid size={6}>
            <TextField fullWidth id="outlined-basic" label="URL" variant="filled" />
            </Grid>
            <Grid size={2}>
            <Button
              component="label"
              role={undefined}
              variant="contained"
              tabIndex={-1}
              startIcon={<DownloadIcon/>}
            >
              DIRECT DOWNLOAD
              <VisuallyHiddenInput
                type="file"
                onChange={(event) => console.log(event.target.files)}
                multiple
              />
            </Button>
            </Grid>
            <Grid size={2}>
            <Button onClick={handlePickFolder} fullWidth variant="contained"><LibraryAddIcon/></Button>
            </Grid>
            <Grid size={4}>
            <Item>size=4</Item>
            </Grid>
            <Grid size={8}>
            <Item>size=8</Item>
            </Grid>
        </Grid>
        </Box>
    </div>
    </>
  )
}
