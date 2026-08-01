
import { Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import './App.css'
import MainPage from './MainPage';
import Other from './other';
import { electronAPIMock, electronAPIPythonDownloadMock } from '../../testing/mockData/electronAPIMocks.ts'
import theme from './theme';

function App() {

  if (!window.electronAPI) {
    window.mockingElectron = "yes";
    window.electronAPI = electronAPIMock;
    window.electronAPIPythonDownload = electronAPIPythonDownloadMock;
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Routes>
        <Route path="/" element={<MainPage />}></Route>
        <Route path="/other" element={<Other />}/>
      </Routes>
    </ThemeProvider>
  )
}

export default App
