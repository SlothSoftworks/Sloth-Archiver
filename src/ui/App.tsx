
import { Route, Routes } from 'react-router-dom';
import './App.css'
import MainPage from './MainPage';
import Other from './other';

function App() {

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
