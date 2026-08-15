import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// .venv-build's own python/pip binaries record an absolute path back to
// whichever account's Python created them (Windows venvs are launcher stubs
// that redirect to that recorded path, not self-contained copies) -- reusing
// it from a *different* Windows account than the one that built it fails
// with "Access is denied" (that account's profile folder is off-limits).
// This deletes the stale venv so build-ytdlp-bin.mjs recreates it fresh
// under whichever account is currently running the build.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const venvDir = path.join(rootDir, '.venv-build');

fs.rmSync(venvDir, { recursive: true, force: true });
console.log(`Removed ${venvDir}`);
