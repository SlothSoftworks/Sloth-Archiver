import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist', 'ytdlp-bin');
const destPath = path.join(outDir, 'yt-dlp');

// Pin to a specific yt-dlp release. Bump deliberately, and update the checksum
// below from https://github.com/yt-dlp/yt-dlp/releases/download/<version>/SHA2-256SUMS
const YTDLP_VERSION = '2026.07.04';
const YTDLP_SHA256 = '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos`;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log(`Downloading yt-dlp ${YTDLP_VERSION} from ${YTDLP_URL}`);
const response = await fetch(YTDLP_URL, { redirect: 'follow' });
if (!response.ok) {
    throw new Error(`Failed to download yt-dlp: HTTP ${response.status}`);
}
const buffer = Buffer.from(await response.arrayBuffer());

const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
if (actualSha256 !== YTDLP_SHA256) {
    throw new Error(`yt-dlp checksum mismatch: expected ${YTDLP_SHA256}, got ${actualSha256}`);
}

fs.writeFileSync(destPath, buffer);
fs.chmodSync(destPath, 0o755);

console.log(`Verified checksum and wrote ${destPath}`);
