import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path'
import { spawn } from 'child_process';
import fs from "fs";

import { getSupportedVideoFilters } from './utils/constants.mjs';

const logFile = path.join(app.getPath("userData"), "main.log");
function log(...args) {
    const msg = args.map(String).join(" ");
    fs.appendFileSync(logFile, msg + "\n");
    console.log(msg);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

const indexPath = path.join(__dirname, '../renderer/index.html');
const ytdlpPath = isDev ? path.resolve(__dirname, '../ytdlp-bin/yt-dlp') : path.join(process.resourcesPath, 'ytdlp-bin', 'yt-dlp');
const ffmpegDir = isDev ? path.resolve(__dirname, '../ffmpeg') : path.join(process.resourcesPath, 'ffmpeg');

app.on("ready", () => {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    mainWindow.loadFile(indexPath);
    if (isDev) mainWindow.webContents.openDevTools();
})

ipcMain.handle('dialog:openFolder', async (e, options) => dialog.showOpenDialog({
    properties: ['openDirectory'],
    ...options
}));

ipcMain.handle('dialog:saveVideoFile', async (e, defaultName = 'ytVid', options) => dialog.showSaveDialog({
    title: 'Save Video',
    buttonLabel: 'Save',
    defaultPath: `${app.getPath('downloads')}/${defaultName}`,
    filters: getSupportedVideoFilters(),
    ...options
}))

function buildResolutions(info) {
    const seen = new Set();
    const resolutions = [];

    for (const fmt of info.formats || []) {
        const height = fmt.height;
        if (fmt.vcodec === 'none' || !height) continue;
        if (seen.has(height)) continue;
        seen.add(height);

        let size = fmt.filesize || fmt.filesize_approx;
        if (!size && fmt.tbr && info.duration) {
            size = (fmt.tbr * info.duration / 8) * 1024;
        }

        resolutions.push({
            resolution: String(height),
            filesizeMb: size != null ? Math.round((size / (1024 * 1024)) * 100) / 100 : null,
            ext: fmt.ext,
        });
    }

    if (resolutions.length > 0) {
        const smallest = resolutions.reduce((a, b) => Number(a.resolution) < Number(b.resolution) ? a : b);
        resolutions.push({ ...smallest, resolution: 'MP3' });
    }

    return resolutions;
}

function reshapeVideoInfo(info) {
    return {
        id: info.id,
        title: info.title,
        resolutions: buildResolutions(info),
        thumbnail: info.thumbnail,
        additionalThumbnails: info.thumbnails,
        description: info.description,
        channelId: info.channel_id,
        duration: info.duration,
        durationString: info.duration_string,
        originalUrl: info.original_url,
        categories: info.categories,
        tags: info.tags,
        releaseTimestamp: info.release_timestamp,
        uploader: info.uploader,
        uploaderId: info.uploader_id,
        uploaderUrl: info.uploader_url,
        uploadDate: info.upload_date,
        playlist: info.playlist,
        playlistIndex: info.playlist_index,
        fullTitle: info.fulltitle,
        sourceFormat: info.ext,
        language: info.language,
    };
}

ipcMain.handle('getVideoInfoPython', async (event, url) => {
    return new Promise((resolve, reject) => {
        const script = spawn(ytdlpPath, ['-J', '--no-warnings', '--ffmpeg-location', ffmpegDir, url]);
        let data = '';
        let error = '';

        script.on('error', (err) => {
            reject(new Error(`Failed to start yt-dlp: ${err.message}`));
        });

        script.stdout.on('data', (output) => {
            data += output.toString();
        });
        script.stderr.on('data', err => {
            error += err.toString();
        });

        script.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(error || `yt-dlp exited with code ${code}`));
            } else {
                try {
                    const info = JSON.parse(data);
                    resolve({ success: true, data: { response: reshapeVideoInfo(info) } });
                } catch (e) {
                    reject(new Error('Failed to parse video data'));
                }
            }
        });
    });
});

function buildDownloadArgs({ videoUrl, outputPath, format, resolution }) {
    // Note: --print (even "after_move:...") makes yt-dlp buffer ALL stdout/stderr
    // until the process is about to exit, defeating live progress reporting entirely.
    // The final file is instead located on disk after the process closes (see findFinalFile).
    //
    // Note: the download progress-template deliberately omits %(progress.filename)s.
    // It's unused by the renderer, and yt-dlp's output filename comes from the video
    // title/outputPath, which frequently contains "|" (e.g. "Song | Artist") -- with
    // filename in the middle of a "|"-delimited line, that silently misaligns every
    // field after it.
    const args = [
        '--newline',
        '--no-warnings',
        // The user explicitly chose to download via a save dialog; always perform a
        // real download rather than silently skipping if a same-named file already
        // exists at that path (yt-dlp's default), which looks identical to a frozen UI.
        '--force-overwrites',
        '--progress-template', 'download:PROGRESS|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._percent_str)s|%(progress.eta)s|%(progress._speed_str)s',
        '--progress-template', 'postprocess:POSTPROCESS|%(progress.status)s|%(progress.postprocessor)s',
        '--ffmpeg-location', ffmpegDir,
        '-o', outputPath || '%(title)s.%(ext)s',
    ];

    if (resolution && resolution.toLowerCase() === 'mp3') {
        args.push('-f', 'bestvideo[height<=144]+bestaudio/best');
        args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K');
    } else {
        args.push('-f', `bestvideo[height<=${resolution}]+bestaudio/best`);
        if (format && !['undefined', 'dflt'].includes(format)) {
            args.push('--recode-video', format);
        }
    }

    args.push(videoUrl);
    return args;
}

// yt-dlp postprocessors append their target extension to the requested
// outtmpl rather than swapping it (e.g. "video.mp4" + mp3 extraction ->
// "video.mp4.mp3"), and that behavior isn't a documented, stable contract
// worth hardcoding. Instead, look at what actually landed on disk.
function findFinalFile(outputPath) {
    const dir = path.dirname(outputPath);
    const base = path.basename(outputPath);
    try {
        const matches = fs.readdirSync(dir)
            .filter((f) => f.startsWith(base))
            .map((f) => {
                const full = path.join(dir, f);
                return { full, mtimeMs: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        return matches.length > 0 ? matches[0].full : outputPath;
    } catch (e) {
        return outputPath;
    }
}

ipcMain.handle('downloadVideoWithProgressUpdates', (event, options) => {
    const script = spawn(ytdlpPath, buildDownloadArgs(options));

    let error = '';

    const send = (msg) => BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', msg);

    script.on('error', (err) => {
        send({ type: 'error', payload: { message: `Failed to start yt-dlp: ${err.message}` } });
    });

    function parseLine(line) {
        if (line.startsWith('PROGRESS|')) {
            const [, status, downloadedBytes, totalBytes, percent, eta, speed] = line.split('|');
            if (status === 'downloading') {
                send({
                    type: 'progress',
                    payload: {
                        downloadedBytes: Number(downloadedBytes) || null,
                        totalBytes: Number(totalBytes) || null,
                        percent: percent.trim(),
                        eta: eta === 'NA' ? null : Number(eta),
                        speed: speed.trim(),
                    },
                });
            } else if (status === 'finished') {
                send({ type: 'downloadDone', payload: {} });
            }
        } else if (line.startsWith('POSTPROCESS|')) {
            const [, status, processor] = line.split('|');
            send({
                type: 'postprocessing',
                payload: { stage: status === 'started' ? 'start' : status, processor },
            });
        }
    }

    // yt-dlp writes download progress and --print output to stdout, but
    // postprocess progress-template lines to stderr, so both streams need parsing.
    function makeLineReader(onLine) {
        let buffer = '';
        return (chunk) => {
            buffer += chunk.toString();
            let lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(onLine);
        };
    }

    script.stdout.on('data', makeLineReader(parseLine));

    script.stderr.on('data', makeLineReader((line) => {
        if (line.startsWith('PROGRESS|') || line.startsWith('POSTPROCESS|')) {
            parseLine(line);
        } else {
            error += line + '\n';
            console.error('yt-dlp stderr:', line);
        }
    }));

    script.on('close', (code) => {
        if (code !== 0) {
            send({ type: 'error', payload: { message: error || `Download failed with code ${code}` } });
        } else {
            send({ type: 'done', payload: { filename: findFinalFile(options.outputPath) } });
        }
    })

});

// openDirectory

ipcMain.handle('system:openFileInDirectory', async (e, filepath) => {
    shell.showItemInFolder(filepath);
});
ipcMain.handle('system:openDirectory', async (e, path) => {
    shell.showItemInFolder(path);
});
