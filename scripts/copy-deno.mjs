import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Bundled so yt-dlp can solve YouTube's JS signature ("nsig") challenge
// without depending on the end user having any JS runtime installed --
// TD-010 (reports/TechnicalDebt.md). The `deno` npm package has no JS-level
// export for its binary path (unlike ffmpeg-static/ffprobe-static), so its
// location is resolved the same way Node itself would resolve the package.
const require = createRequire(import.meta.url);
const denoPkgDir = path.dirname(require.resolve('deno/package.json'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist', 'deno');

const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'deno.exe' : 'deno';
const srcPath = path.join(denoPkgDir, binaryName);

if (!fs.existsSync(srcPath)) {
    throw new Error(`deno binary not found at ${srcPath} -- did the deno package's postinstall run?`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const destPath = path.join(outDir, binaryName);
fs.copyFileSync(srcPath, destPath);
fs.chmodSync(destPath, 0o755);

console.log(`Copied deno binary into ${outDir}`);
