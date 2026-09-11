import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveLatestRelease, mapPlatformToAssetName, detectMusl, fetchAndVerifyRelease } from '../src/electron/ytdlpRelease.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const workDir = path.join(rootDir, 'build', 'ytdlp-fetch');
const finalDist = path.join(rootDir, 'dist', 'ytdlp-bin');
const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

// Pinned so every SlothArchiver release bundles a known, reproducible
// yt-dlp version rather than "whatever GitHub's latest release happened to
// be at build time." Bump this by hand in the same commit as any other
// dependency-version bump.
const PINNED_YTDLP_TAG = '2026.08.19';

// Skips the whole download+verify+extract round trip on a repeat local
// build when the already-installed binary already reports the exact pinned
// version -- this is the slow part of `npm run build:electron` (a
// multi-dozen-MB network fetch plus signature verification) and the pinned
// tag rarely changes between builds. Falls through to a full re-fetch on
// *any* uncertainty (missing binary, wrong version, or the binary failing
// to even report its own version) rather than trusting a stale/corrupt
// install.
const existingBinaryPath = path.join(finalDist, binName);
if (fs.existsSync(existingBinaryPath)) {
    try {
        const currentVersion = execFileSync(existingBinaryPath, ['--version'], { encoding: 'utf-8' }).trim();
        if (currentVersion === PINNED_YTDLP_TAG) {
            console.log(`yt-dlp ${PINNED_YTDLP_TAG} already installed at ${existingBinaryPath} -- skipping fetch.`);
            process.exit(0);
        }
        console.log(`Installed yt-dlp is ${currentVersion}, pinned is ${PINNED_YTDLP_TAG} -- re-fetching.`);
    } catch {
        console.log(`Existing yt-dlp binary at ${existingBinaryPath} could not report its version -- re-fetching.`);
    }
}

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

console.log(`Fetched yt-dlp ${release.tag} -> ${path.join(finalDist, binName)}`);
