import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const venvDir = path.join(rootDir, '.venv-build');
const rawDist = path.join(rootDir, 'dist', 'ytdlp-bin-raw');
const finalDist = path.join(rootDir, 'dist', 'ytdlp-bin');
const pyinstallerWorkDir = path.join(rootDir, 'build', 'pyinstaller');

const isWindows = process.platform === 'win32';

function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
    }
}

function commandExists(command) {
    return spawnSync(isWindows ? 'where' : 'which', [command]).status === 0;
}

// venv layout differs by platform: POSIX uses bin/, Windows uses Scripts/.
const venvBinDir = path.join(venvDir, isWindows ? 'Scripts' : 'bin');
const venvPython = path.join(venvBinDir, isWindows ? 'python.exe' : 'python');
const venvPyinstaller = path.join(venvBinDir, isWindows ? 'pyinstaller.exe' : 'pyinstaller');

if (!fs.existsSync(venvDir)) {
    const systemPython = !isWindows && commandExists('python3') ? 'python3' : 'python';
    run(systemPython, ['-m', 'venv', venvDir]);
}

run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
run(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', path.join(rootDir, 'src', 'python', 'requirements-build.txt')]);

fs.rmSync(rawDist, { recursive: true, force: true });
fs.rmSync(finalDist, { recursive: true, force: true });
fs.rmSync(pyinstallerWorkDir, { recursive: true, force: true });

run(venvPyinstaller, [
    '--onedir',
    '--name', 'yt-dlp',
    '--distpath', rawDist,
    '--workpath', pyinstallerWorkDir,
    '--specpath', pyinstallerWorkDir,
    '--collect-all', 'yt_dlp',
    '--noconfirm',
    path.join(rootDir, 'src', 'python', 'ytdlp_entrypoint.py'),
]);

// PyInstaller names the executable yt-dlp.exe on Windows, yt-dlp elsewhere.
const binName = fs.existsSync(path.join(rawDist, 'yt-dlp', 'yt-dlp.exe')) ? 'yt-dlp.exe' : 'yt-dlp';

fs.mkdirSync(finalDist, { recursive: true });
fs.cpSync(path.join(rawDist, 'yt-dlp'), finalDist, { recursive: true });
try {
    fs.chmodSync(path.join(finalDist, binName), 0o755);
} catch {
    // chmod is a no-op on Windows; ignore.
}
fs.rmSync(rawDist, { recursive: true, force: true });

console.log(`Built yt-dlp onedir binary -> ${path.join(finalDist, binName)}`);
