import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { unzip, findChecksumForAsset } from './ytdlpRelease.mjs';

// Zero third-party dependencies, same reason as ytdlpRelease.mjs: imported
// by a plain pre-build Node script (scripts/fetch-deno-bin.mjs), nothing
// PATH-resolved. `unzip`/`findChecksumForAsset` are reused directly rather
// than duplicated -- both are already generic (a plain ZIP reader, a plain
// "<hex digest>  <filename>" line parser), and Deno's own per-asset
// checksum files use that exact same line format (confirmed directly
// against a real downloaded `deno-x86_64-apple-darwin.zip.sha256sum`). The
// small network helpers below (fetchJson/downloadFile/downloadText) are
// still independent copies, matching ytdlpRelease.mjs's own stated reason
// for not sharing those: each release-fetching module has to keep working
// standalone.

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Distinguishes "the downloaded release didn't match its own published
// checksum" from every other failure mode below (network errors, timeouts,
// a malformed .sha256sum) -- callers use this the same way
// YTDLP_VERIFICATION_ERROR_CODE is used, to tell the user the problem is
// with the external Deno release itself, not with this app.
export const DENO_VERIFICATION_ERROR_CODE = 'DENO_VERIFICATION_FAILED';

function verificationError(message) {
    const err = new Error(message);
    err.code = DENO_VERIFICATION_ERROR_CODE;
    return err;
}

function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'sloth-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchJson(res.headers.location, { timeoutMs }).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Request to ${url} failed with status ${res.statusCode}`));
                res.resume();
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error(`Failed to parse JSON from ${url}`));
                }
            });
        }).on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
    });
}

function downloadFile(url, destPath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'sloth-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadFile(res.headers.location, destPath, { timeoutMs }).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Download from ${url} failed with status ${res.statusCode}`));
                res.resume();
                return;
            }
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => fileStream.close(() => resolve()));
            fileStream.on('error', reject);
        }).on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Download from ${url} timed out after ${Math.round(timeoutMs / 1000)}s of inactivity`));
        });
    });
}

function downloadText(url, opts) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'sloth-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadText(res.headers.location, opts).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Request to ${url} failed with status ${res.statusCode}`));
                res.resume();
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
    });
}

// Deno's official per-platform/arch release assets -- confirmed directly
// against the real v2.9.5 release (`gh api repos/denoland/deno/releases/
// tags/v2.9.5`). Unlike yt-dlp, there's no separate musl variant in Deno's
// own release matrix.
export function mapPlatformToAssetName({ platform = process.platform, arch = process.arch } = {}) {
    if (platform === 'darwin') {
        if (arch === 'arm64') return 'deno-aarch64-apple-darwin.zip';
        if (arch === 'x64') return 'deno-x86_64-apple-darwin.zip';
        throw new Error(`Unsupported macOS architecture: ${arch}`);
    }
    if (platform === 'win32') {
        if (arch === 'arm64') return 'deno-aarch64-pc-windows-msvc.zip';
        if (arch === 'x64') return 'deno-x86_64-pc-windows-msvc.zip';
        throw new Error(`Unsupported Windows architecture: ${arch}`);
    }
    if (platform === 'linux') {
        if (arch === 'arm64') return 'deno-aarch64-unknown-linux-gnu.zip';
        if (arch === 'x64') return 'deno-x86_64-unknown-linux-gnu.zip';
        throw new Error(`Unsupported Linux architecture: ${arch}`);
    }
    throw new Error(`Unsupported platform: ${platform}`);
}

// Same pin-shortcut shape as ytdlpRelease.mjs's own resolveLatestRelease --
// with `pin`, resolves with no network call at all (what the build script
// always uses, for a reproducible pinned version); without it, resolves
// Deno's real latest GitHub release once.
export async function resolveLatestRelease({ pin } = {}) {
    if (pin) {
        return { tag: pin };
    }
    const release = await fetchJson('https://api.github.com/repos/denoland/deno/releases/latest');
    return { tag: release.tag_name, assets: release.assets };
}

function assetDownloadUrl(tag, assetName) {
    return `https://github.com/denoland/deno/releases/download/${tag}/${assetName}`;
}

// The orchestration entry point -- downloads assetName plus its own
// `<assetName>.sha256sum` companion file (confirmed directly: a single line,
// same "<hex digest>  <filename>" format yt-dlp's combined SHA2-256SUMS
// uses, just scoped to one asset instead of every asset in the release),
// verifies the asset's SHA-256 against it, and only on success unzips the
// asset into a fresh subdirectory of workDir.
//
// Deliberately weaker than ytdlpRelease.mjs's fetchAndVerifyRelease in one
// specific way: Deno's own releases ship no GPG/detached signature at all,
// only this checksum file -- so this can only prove "the download matches
// what GitHub is currently serving as this asset," not "this is what Deno's
// maintainers actually signed." Same verification tier ffmpeg-static/
// ffprobe-static already get today (no signature check either); not a new
// category of risk, just extended to a third bundled binary. Still fails
// closed: any missing checksum file, missing entry, or mismatch throws and
// nothing gets extracted.
export async function fetchAndVerifyDenoRelease({ release, assetName, workDir, onProgress, onLog }) {
    fs.mkdirSync(workDir, { recursive: true });
    const assetPath = path.join(workDir, assetName);

    onProgress?.('fetching');
    onLog?.(`[deno-release] downloading ${assetName} (${release.tag})`);
    await downloadFile(assetDownloadUrl(release.tag, assetName), assetPath);

    onLog?.(`[deno-release] downloading ${assetName}.sha256sum`);
    const sumsText = await downloadText(assetDownloadUrl(release.tag, `${assetName}.sha256sum`));

    onProgress?.('verifying');
    const expectedChecksum = findChecksumForAsset(sumsText, assetName);
    if (!expectedChecksum) {
        throw verificationError(`${assetName}.sha256sum has no entry for ${assetName} -- refusing to install an unverified binary`);
    }

    const actualChecksum = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
    if (actualChecksum !== expectedChecksum) {
        throw verificationError(`Checksum mismatch for ${assetName}: expected ${expectedChecksum}, got ${actualChecksum}`);
    }
    onLog?.(`[deno-release] ${assetName} checksum verified`);

    onProgress?.('installing');
    const extractDir = path.join(workDir, 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    unzip(assetPath, extractDir);

    // Deno's official zips contain exactly one entry, already named
    // `deno`/`deno.exe` (confirmed directly: `unzip -l` on the real macOS
    // asset shows a single top-level `deno` entry, no wrapper directory,
    // no _internal/ the way yt-dlp's onedir layout has) -- no rename step
    // needed, unlike ytdlpRelease.mjs's renameLauncherToCanonicalName.
    // Explicit chmod regardless of the ZIP's own Unix-permission bits,
    // matching copy-ffmpeg.mjs's same defensive chmod after copying a
    // third-party binary into place.
    if (process.platform !== 'win32') {
        fs.chmodSync(path.join(extractDir, 'deno'), 0o755);
    }

    return extractDir;
}
