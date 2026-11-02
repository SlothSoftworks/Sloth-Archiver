import { Box, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Button, Table, TableBody, TableCell, TableRow } from '@mui/material';

const SHORTCUTS: [keys: string[], action: string][] = [
  [['Space', 'K'], 'Play / pause'],
  [['←', '→', 'J', 'L'], 'Back / forward 5 seconds'],
  [['Shift + ←', 'Shift + →'], 'Back / forward 10 seconds'],
  [[',', '.'], 'Pause and step back / forward one frame'],
  [['0', '–', '9'], 'Jump to 0% – 90% of the video'],
  [['↑', '↓'], 'Volume up / down'],
  [['M'], 'Mute'],
  [['F'], 'Fullscreen'],
  [['<', '>'], 'Slower / faster'],
  [['Cmd/Ctrl + S'], 'Copy the current frame to the clipboard'],
  [['Cmd/Ctrl + J', 'Cmd/Ctrl + L'], 'Mark clip start / end here'],
  [['Shift + J', 'Shift + L'], 'Jump to the clip start / end marker'],
  [['Shift + I'], 'Show this list'],
];

function Key({ label }: { label: string }) {
  if (label === '–') return <Box component="span" sx={{ mx: 0.5 }}>–</Box>;
  return (
    <Box
      component="kbd"
      sx={{
        display: 'inline-block', px: 0.75, py: 0.25, mr: 0.5, mb: 0.5,
        border: 1, borderColor: 'divider', borderRadius: 1,
        fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  );
}

export default function PlayerShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Keyboard shortcuts</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 1 }}>Click the video first so it has focus.</DialogContentText>
        <Table size="small">
          <TableBody>
            {SHORTCUTS.map(([keys, action]) => (
              <TableRow key={action}>
                <TableCell sx={{ width: '40%' }}>{keys.map((k, i) => <Key key={i} label={k} />)}</TableCell>
                <TableCell>{action}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
