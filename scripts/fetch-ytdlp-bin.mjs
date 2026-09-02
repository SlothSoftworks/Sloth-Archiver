import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveLatestRelease, mapPlatformToAssetName, detectMusl, fetchAndVerifyRelease } from '../src/electron/ytdlpRelease.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const workDir = path.join(rootDir, 'build', 'ytdlp-fetch');
const finalDist = path.join(rootDir, 'dist', 'ytdlp-bin');

// Pinned so every SlothArchiver release bundles a known, reproducible
// yt-dlp version rather than "whatever GitHub's latest release happened to
// be at build time" -- the direct replacement for
// requirements-build.txt's own version pin. Bump this by hand in the same
// commit as any other dependency-version bump.
const PINNED_YTDLP_TAG = '2026.08.19';

fs.rmSync(workDir, { recursive: true, force: true });
fs.rmSync(finalDist, { recursive: true, force: true });

const release = await resolveLatestRelease({ pin: PINNED_YTDLP_TAG });
const assetName = mapPlatformToAssetName({ isMusl: detectMusl() });

console.log(`Fetching yt-dlp ${release.tag} (${assetName})...`);
const extractedDir = await fetchAndVerifyRelease({
    release,
    assetName,
    workDir,
    onProgress: (stage) => console.log(`[fetch-ytdlp-bin] ${stage}`),
    onLog: (msg) => console.log(msg),
});

// fetchAndVerifyRelease's ZIP extraction lands the launcher (already renamed
// to the canonical yt-dlp/yt-dlp.exe, see renameLauncherToCanonicalName) +
// _internal/ directly in extractedDir, with no extra top-level wrapper
// folder (confirmed against the real macOS asset) -- so this is just a
// rename into place, matching the final shape package.json's
// `dist/ytdlp-bin/` extraResources entry already expects.
fs.renameSync(extractedDir, finalDist);
fs.rmSync(workDir, { recursive: true, force: true });

const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
console.log(`Fetched yt-dlp ${release.tag} -> ${path.join(finalDist, binName)}`);
