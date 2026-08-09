import fs from 'fs';
import path from 'path';
import https from 'https';
import { spawn } from 'child_process';

// Electron's main process is single-threaded -- a spawnSync call here would
// block ALL main-process work (every IPC handler, not just this one) for the
// full duration of each step, several seconds at a time for pip/PyInstaller.
// Everything below uses async spawn instead so the app (and the renderer's
// live progress display) stays responsive while an update runs.
function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, options);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`${command} ${args.join(' ')} exited with code ${code}: ${stderr}`));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// Same shape as run(), but resolves with success/code instead of rejecting on
// a non-zero exit -- for probes where "it failed" is an expected, handled outcome.
function probe(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, options);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });
        child.on('error', () => resolve({ ok: false, stdout, stderr }));
        child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    });
}

// Kept as a standalone constant rather than parsed out of
// src/python/requirements-build.txt: that file pins yt-dlp to an exact
// version on purpose (reproducible dev/CI builds), but the whole point of
// this module is to install the *latest* yt-dlp -- reusing that file as-is
// would silently re-pin every update to the same stale version. Keep this
// roughly in sync with requirements-build.txt's own PyInstaller constraint.
const PYINSTALLER_CONSTRAINT = 'pyinstaller>=6.10,<7';
const PYTHON_RUNTIME_MINOR = '3.11';
const PYTHON_BUILD_STANDALONE_REPO = 'astral-sh/python-build-standalone';

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'yt-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchJson(res.headers.location).then(resolve, reject);
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
                } catch (e) {
                    reject(new Error(`Failed to parse JSON from ${url}`));
                }
            });
        }).on('error', reject);
    });
}

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'yt-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadFile(res.headers.location, destPath).then(resolve, reject);
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
    });
}

export async function getLatestYtdlpVersionFromPyPI() {
    const data = await fetchJson('https://pypi.org/pypi/yt-dlp/json');
    return data.info.version;
}

// PyPI's version string ("2026.7.4") and yt-dlp's own --version output
// ("2026.07.04", zero-padded) refer to the same release but aren't equal as
// raw strings -- normalize each dot-separated segment to an integer before
// comparing, or every check would report an update available forever.
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

export async function getCurrentYtdlpVersion(ytdlpPath) {
    const result = await probe(ytdlpPath, ['--version']);
    if (!result.ok) {
        throw new Error('Failed to read current yt-dlp version');
    }
    return result.stdout.trim();
}

// python-build-standalone asset names look like:
//   cpython-3.11.15+20260728-x86_64-apple-darwin-install_only.tar.gz
//   cpython-3.11.15+20260728-aarch64-pc-windows-msvc-install_only.tar.gz
// Matched by regex (not an exact name) since the patch version and release
// tag both float independently of what we care about (minor version + platform/arch).
function findPythonRuntimeAsset(releaseJson) {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const platformPart = process.platform === 'win32' ? 'pc-windows-msvc' : 'apple-darwin';
    const pattern = new RegExp(`^cpython-${PYTHON_RUNTIME_MINOR.replace('.', '\\.')}\\.\\d+\\+\\d+-${arch}-${platformPart}-install_only\\.tar\\.gz$`);
    const asset = (releaseJson.assets || []).find((a) => pattern.test(a.name));
    if (!asset) {
        throw new Error(`No matching python-build-standalone asset found for ${process.platform}/${process.arch}`);
    }
    return asset;
}

function pythonExePath(runtimeDir) {
    return process.platform === 'win32'
        ? path.join(runtimeDir, 'python', 'python.exe')
        : path.join(runtimeDir, 'python', 'bin', 'python3');
}

// Lazy + one-time: only fetched the first time the user actually triggers an
// update, so the base app install size is unaffected (protects the work
// already done to keep the packaged app small).
async function ensurePythonRuntime(runtimeDir, onProgress) {
    const pythonExe = pythonExePath(runtimeDir);
    if (fs.existsSync(pythonExe)) {
        return pythonExe;
    }

    onProgress?.('fetching-python-runtime');
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeDir, { recursive: true });

    const release = await fetchJson(`https://api.github.com/repos/${PYTHON_BUILD_STANDALONE_REPO}/releases/latest`);
    const asset = findPythonRuntimeAsset(release);
    const archivePath = path.join(runtimeDir, asset.name);
    await downloadFile(asset.browser_download_url, archivePath);

    const extract = await probe('tar', ['-xzf', archivePath, '-C', runtimeDir]);
    fs.rmSync(archivePath, { force: true });
    if (!extract.ok) {
        throw new Error(`Failed to extract python runtime: ${extract.stderr}`);
    }

    if (!fs.existsSync(pythonExe)) {
        throw new Error('python-build-standalone archive did not contain the expected python executable');
    }
    return pythonExe;
}

// Pinned + one-time: installed once into the runtime and reused across every
// future update, mirroring how .venv-build already persists across local dev
// builds rather than being recreated on every invocation.
async function ensurePyinstaller(pythonExe, onProgress) {
    const check = await probe(pythonExe, ['-m', 'PyInstaller', '--version']);
    if (check.ok) {
        return;
    }
    onProgress?.('installing-pyinstaller');
    await run(pythonExe, ['-m', 'pip', 'install', '--quiet', PYINSTALLER_CONSTRAINT, 'certifi']);
}

async function rebuildYtdlp({ pythonExe, pythonSrcDir, stagingWorkDir, onProgress }) {
    onProgress?.('fetching-yt-dlp');
    // [default] pulls in yt-dlp-ejs (TD-010, reports/TechnicalDebt.md) -- the
    // JS-challenge solver scripts YouTube's nsig challenge needs, mirroring
    // scripts/build-ytdlp-bin.mjs's own requirements-build.txt pin so a
    // self-updated binary doesn't regress back to the un-bundled state.
    await run(pythonExe, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'yt-dlp[default]']);

    onProgress?.('building');
    const rawDist = path.join(stagingWorkDir, 'raw');
    const pyinstallerWorkDir = path.join(stagingWorkDir, 'work');
    fs.rmSync(rawDist, { recursive: true, force: true });
    fs.rmSync(pyinstallerWorkDir, { recursive: true, force: true });

    await run(pythonExe, [
        '-m', 'PyInstaller',
        '--onedir',
        '--name', 'yt-dlp',
        '--distpath', rawDist,
        '--workpath', pyinstallerWorkDir,
        '--specpath', pyinstallerWorkDir,
        '--collect-all', 'yt_dlp',
        '--collect-all', 'yt_dlp_ejs',
        '--noconfirm',
        path.join(pythonSrcDir, 'ytdlp_entrypoint.py'),
    ]);

    return path.join(rawDist, 'yt-dlp');
}

// Same manual dereferencing copy used by scripts/build-ytdlp-bin.mjs: PyInstaller's
// macOS onedir output uses an absolute symlink for _internal/Python that points back
// into this exact build's temp work dir, so a naive copy (or a plain rename across
// filesystems) can leave a dangling reference. statSync follows symlinks; lstatSync doesn't.
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

async function verifyAndSwap({ builtDir, liveDir, binaryName }) {
    const builtBinary = path.join(builtDir, binaryName);
    const verify = await probe(builtBinary, ['--version']);
    if (!verify.ok) {
        throw new Error('Freshly built yt-dlp binary failed its --version sanity check');
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

export async function performYtdlpUpdate({ userDataDir, pythonSrcDir, liveYtdlpBinDir, ytdlpBinaryName, isDownloadActive, onProgress }) {
    if (isDownloadActive && isDownloadActive()) {
        throw new Error('A download is currently in progress. Finish it before applying a yt-dlp update.');
    }

    onProgress?.('checking');
    const runtimeDir = path.join(userDataDir, 'python-runtime');
    const stagingWorkDir = path.join(userDataDir, 'ytdlp-update-work');

    const pythonExe = await ensurePythonRuntime(runtimeDir, onProgress);
    await ensurePyinstaller(pythonExe, onProgress);
    const builtDir = await rebuildYtdlp({ pythonExe, pythonSrcDir, stagingWorkDir, onProgress });

    onProgress?.('verifying');
    if (isDownloadActive && isDownloadActive()) {
        throw new Error('A download started while the update was building. Finish it, then try applying the update again.');
    }
    const newVersion = await verifyAndSwap({ builtDir, liveDir: liveYtdlpBinDir, binaryName: ytdlpBinaryName });

    fs.rmSync(stagingWorkDir, { recursive: true, force: true });
    onProgress?.('done');
    return { version: newVersion };
}
