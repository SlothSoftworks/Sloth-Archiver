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

// ffmpeg-static/ffprobe-static resolve to ffmpeg.exe/ffprobe.exe on Windows --
// preserve that extension rather than always writing an extensionless name,
// mirroring the ytdlpBinaryName pattern already used for the yt-dlp binary.
// --ffmpeg-location hands yt-dlp a directory (its own lenient resolution
// tolerates a missing extension), but anything that constructs an exact path
// and spawns it directly does not.
const isWindows = process.platform === 'win32';
for (const [name, srcPath] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobeStatic.path]]) {
    const destName = isWindows ? `${name}.exe` : name;
    const destPath = path.join(outDir, destName);
    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, 0o755);
}

console.log(`Copied ffmpeg/ffprobe binaries into ${outDir}`);
