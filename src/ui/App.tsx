
import { Route, Routes } from 'react-router-dom';
import './App.css'
import MainPage from './MainPage';
import Other from './other';
import { electronAPIMock, electronAPIPythonDownloadMock } from '../../testing/mockData/electronAPIMocks.ts'

function App() {

  if (!window.electronAPI) {
    window.mockingElectron = "yes";
    window.electronAPI = electronAPIMock;
    window.electronAPIPythonDownload = electronAPIPythonDownloadMock;
  }

  return (
    <>
      <Routes>
        <Route path="/" element={<MainPage />}></Route>
        <Route path="/other" element={<Other />}/>
      </Routes>
    </>
  )
}

export default App
