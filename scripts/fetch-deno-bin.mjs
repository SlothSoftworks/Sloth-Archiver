import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveLatestRelease, mapPlatformToAssetName, fetchAndVerifyDenoRelease } from '../src/electron/denoRelease.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const workDir = path.join(rootDir, 'build', 'deno-fetch');
const finalDist = path.join(rootDir, 'dist', 'deno');
const binName = process.platform === 'win32' ? 'deno.exe' : 'deno';

// Pinned so every SlothArchiver release bundles a known, reproducible Deno
// version rather than "whatever GitHub's latest release happened to be at
// build time" -- same reasoning as fetch-ytdlp-bin.mjs's own
// PINNED_YTDLP_TAG. This exact version (v2.9.5) was validated end-to-end
// this session against a real yt-dlp nsig solve. Bump by hand in the same
// commit as any other dependency-version bump.
const PINNED_DENO_TAG = 'v2.9.5';

// Same repeat-local-build shortcut as fetch-ytdlp-bin.mjs -- skips the
// download+verify+extract round trip when the already-installed binary
// already reports the pinned version. `deno --version`'s first line is
// `deno <version>` with no "v" prefix (unlike the release tag, which has
// one) -- add it back before comparing. Falls through to a full re-fetch on
// any uncertainty (missing binary, wrong version, unparseable output, or a
// binary that fails to even run).
const existingBinaryPath = path.join(finalDist, binName);
if (fs.existsSync(existingBinaryPath)) {
    try {
        const versionOutput = execFileSync(existingBinaryPath, ['--version'], { encoding: 'utf-8' });
        const match = /^deno (\S+)/.exec(versionOutput);
        const currentVersion = match ? `v${match[1]}` : null;
        if (currentVersion === PINNED_DENO_TAG) {
            console.log(`Deno ${PINNED_DENO_TAG} already installed at ${existingBinaryPath} -- skipping fetch.`);
            process.exit(0);
        }
        console.log(`Installed Deno is ${currentVersion ?? '(unparseable)'}, pinned is ${PINNED_DENO_TAG} -- re-fetching.`);
    } catch {
        console.log(`Existing Deno binary at ${existingBinaryPath} could not report its version -- re-fetching.`);
    }
}

fs.rmSync(workDir, { recursive: true, force: true });
fs.rmSync(finalDist, { recursive: true, force: true });

const release = await resolveLatestRelease({ pin: PINNED_DENO_TAG });
const assetName = mapPlatformToAssetName();

console.log(`Fetching Deno ${release.tag} (${assetName})...`);
const extractedDir = await fetchAndVerifyDenoRelease({
    release,
    assetName,
    workDir,
    onProgress: (stage) => console.log(`[fetch-deno-bin] ${stage}`),
    onLog: (msg) => console.log(msg),
});

// fetchAndVerifyDenoRelease's ZIP extraction lands the single `deno`/
// `deno.exe` binary directly in extractedDir, with no wrapper folder --
// confirmed against the real macOS asset -- so this is just a rename into
// place, matching the final shape package.json's `dist/deno/`
// extraResources entry expects.
fs.renameSync(extractedDir, finalDist);
fs.rmSync(workDir, { recursive: true, force: true });

console.log(`Fetched Deno ${release.tag} -> ${path.join(finalDist, binName)}`);
