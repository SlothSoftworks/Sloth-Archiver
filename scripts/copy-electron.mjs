import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Replaces the cpx dependency (previously "cpx \"src/electron/**/*\" dist/electron")
// -- cpx pulls in a long-abandoned chokidar/braces chain flagged by npm audit,
// and its own fix suggests *downgrading* it, which fixes nothing. fs.cpSync
// does the same recursive directory copy with zero dependencies, matching the
// pattern already used for ytdlp-bin in main.js.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src', 'electron');
const outDir = path.join(rootDir, 'dist', 'electron');

fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(srcDir, outDir, { recursive: true });

console.log(`Copied ${srcDir} -> ${outDir}`);
