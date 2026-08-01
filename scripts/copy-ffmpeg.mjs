import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist', 'ffmpeg');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const [name, srcPath] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobeStatic.path]]) {
    const destPath = path.join(outDir, name);
    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, 0o755);
}

console.log(`Copied ffmpeg/ffprobe binaries into ${outDir}`);
