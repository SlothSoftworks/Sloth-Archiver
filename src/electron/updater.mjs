import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { resolveLatestRelease, mapPlatformToAssetName, detectMusl, fetchAndVerifyRelease } from './ytdlpRelease.mjs';

// A stalled --version probe (a wedged binary, a machine under heavy load)
// would otherwise leave this promise pending forever -- no resolve, no
// reject, nothing logged, and the update overlay has no cancel button
// (yt-dlp is a required dependency). This bounds it so a genuine hang
// surfaces as a real, logged, retryable error instead of an indefinite
// silent spinner.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Resolves with success/code instead of rejecting on a non-zero exit -- for
// probes where "it failed" is an expected, handled outcome (checking
// whether a binary is actually runnable). onLog, when given, is main.mjs's
// own log() (writes to userData/main.log, already viewable via Options ->
// "Open error log") -- passed through rather than imported directly so this
// module stays testable without an Electron `app` instance.
function probe(command, args, { onLog, timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOptions } = {}) {
    onLog?.(`[ytdlp-update] probing: ${command} ${args.join(' ')}`);
    return new Promise((resolve) => {
        const child = spawn(command, args, spawnOptions);
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            onLog?.(`[ytdlp-update] probe TIMED OUT after ${Math.round(timeoutMs / 1000)}s: ${command} ${args.join(' ')}`);
            resolve({ ok: false, stdout, stderr, timedOut: true });
        }, timeoutMs);
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });
        child.on('error', () => {
            clearTimeout(timer);
            if (timedOut) return;
            resolve({ ok: false, stdout, stderr });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return;
            resolve({ ok: code === 0, stdout, stderr });
        });
    });
}

// PyPI's version string ("2026.7.4") and yt-dlp's own --version output
// ("2026.07.04", zero-padded) refer to the same release but aren't equal as
// raw strings -- normalize each segment to an integer before comparing.
export function isNewerVersion(candidate, current) {
    const normalize = (v) => v.trim().split('.').map((seg) => parseInt(seg, 10) || 0);
    const a = normalize(candidate);
    const b = normalize(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff > 0;
    }
    return false;
}

export async function getCurrentYtdlpVersion(ytdlpPath, { onLog } = {}) {
    const result = await probe(ytdlpPath, ['--version'], { onLog });
    if (!result.ok) {
        throw new Error(result.timedOut ? 'Timed out reading the current yt-dlp version' : 'Failed to read current yt-dlp version');
    }
    return result.stdout.trim();
}

// Dereferencing copy: statSync follows symlinks, lstatSync doesn't. The
// extracted release directory can't just be fs.renameSync'd straight into
// place (it has to become `${liveDir}-staging` first, see verifyAndSwap
// below), and a naive recursive copy would leave a dangling reference if
// the source directory ever contains an absolute symlink.
function copyDereferenced(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyDereferenced(path.join(src, entry), path.join(dest, entry));
        }
    } else {
        fs.copyFileSync(src, dest);
    }
}

async function verifyAndSwap({ builtDir, liveDir, binaryName, onLog }) {
    const builtBinary = path.join(builtDir, binaryName);
    const verify = await probe(builtBinary, ['--version'], { onLog });
    if (!verify.ok) {
        throw new Error(verify.timedOut ? 'Freshly built yt-dlp binary timed out on its --version sanity check' : 'Freshly built yt-dlp binary failed its --version sanity check');
    }

    const finalStaging = `${liveDir}-staging`;
    fs.rmSync(finalStaging, { recursive: true, force: true });
    copyDereferenced(builtDir, finalStaging);
    if (process.platform !== 'win32') {
        fs.chmodSync(path.join(finalStaging, binaryName), 0o755);
    }

    const backup = `${liveDir}-previous`;
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(liveDir)) {
        fs.renameSync(liveDir, backup);
    }
    fs.renameSync(finalStaging, liveDir);
    fs.rmSync(backup, { recursive: true, force: true });

    return verify.stdout.trim();
}

// Fetches and GPG-verifies yt-dlp's own official release binary (see
// ytdlpRelease.mjs) and atomically swaps it into liveYtdlpBinDir. This is
// what main.mjs's ytdlp:startUpdate handler calls.
//
// isDownloadActive blocks starting an update while a download is in
// progress (and aborts one already in flight if a download starts
// mid-way) -- yt-dlp is a live subprocess dependency, so swapping its
// binary out from under an active download isn't safe. progress/log
// callbacks keep the renderer's overlay and userData/main.log informative.
export async function performYtdlpUpdate({ userDataDir, liveYtdlpBinDir, ytdlpBinaryName, isDownloadActive, onProgress, onLog }) {
    if (isDownloadActive && isDownloadActive()) {
        throw new Error('A download is currently in progress. Finish it before applying a yt-dlp update.');
    }

    onProgress?.('checking');
    onLog?.('[ytdlp-update] starting update (GitHub release)');
    const workDir = path.join(userDataDir, 'ytdlp-update-work');

    const release = await resolveLatestRelease();
    const assetName = mapPlatformToAssetName({ isMusl: detectMusl() });
    onLog?.(`[ytdlp-update] resolved latest release ${release.tag}, asset ${assetName}`);

    // fetchAndVerifyRelease itself emits 'fetching' -> 'verifying' ->
    // 'installing' as it downloads, checksum/signature-verifies, and
    // unzips -- no separate onProgress calls needed for that part here.
    const extractedDir = await fetchAndVerifyRelease({ release, assetName, workDir, onProgress, onLog });

    if (isDownloadActive && isDownloadActive()) {
        throw new Error('A download started while the update was downloading. Finish it, then try applying the update again.');
    }

    const newVersion = await verifyAndSwap({ builtDir: extractedDir, liveDir: liveYtdlpBinDir, binaryName: ytdlpBinaryName, onLog });

    fs.rmSync(workDir, { recursive: true, force: true });
    onProgress?.('done');
    onLog?.(`[ytdlp-update] update complete -> ${newVersion}`);
    return { version: newVersion };
}
