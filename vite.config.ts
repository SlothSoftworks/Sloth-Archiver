import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path';

// https://vite.dev/config/

export default defineConfig ({
  root: path.resolve(__dirname, 'src', 'ui'),
  plugins: [react()],
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist', 'renderer'),
    emptyOutDir: true,
  }
})