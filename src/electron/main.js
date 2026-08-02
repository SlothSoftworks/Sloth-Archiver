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
const ytdlpBinaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const ytdlpPath = isDev ? path.resolve(__dirname, '../ytdlp-bin', ytdlpBinaryName) : path.join(process.resourcesPath, 'ytdlp-bin', ytdlpBinaryName);
const ffmpegDir = isDev ? path.resolve(__dirname, '../ffmpeg') : path.join(process.resourcesPath, 'ffmpeg');
const cookiesPath = path.join(app.getPath('userData'), 'cookies.txt');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const videoInfoCachePath = path.join(app.getPath('userData'), 'videoInfoCache.json');
const VIDEO_INFO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cookiesArgs() {
    return fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];
}

function readSettings() {
    try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
        return {};
    }
}

function writeSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

// Keyed by the raw input URL. Different URL forms for the same video (a
// youtu.be link vs. the canonical watch?v= form, extra query params, etc.)
// won't match each other -- that's an acceptable cache miss (falls through to
// a real fetch), not a correctness problem.
function readVideoInfoCache() {
    try {
        return JSON.parse(fs.readFileSync(videoInfoCachePath, 'utf-8'));
    } catch {
        return {};
    }
}

function writeVideoInfoCache(cache) {
    fs.writeFileSync(videoInfoCachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

ipcMain.handle('settings:getDownloadDir', async () => {
    const { downloadDir } = readSettings();
    return { downloadDir: downloadDir || app.getPath('downloads') };
});

ipcMain.handle('settings:setDownloadDir', async (e, dir) => {
    const settings = readSettings();
    settings.downloadDir = dir;
    writeSettings(settings);
    return { success: true, downloadDir: dir };
});

// A literal fs.existsSync(filePath) isn't enough here: postprocessors (MP3
// extraction, format recode) don't write to the exact chosen path, they
// append their target extension onto it (see findFinalFile() below, which
// exists for the same reason) -- so a real prior download under one of those
// modes would silently fail an exact-match check and never surface this
// existing-file prompt at all. Match by prefix instead, same as findFinalFile.
ipcMain.handle('system:pathExists', async (e, filePath) => {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    try {
        return fs.readdirSync(dir).some((f) => f.startsWith(base));
    } catch {
        return false;
    }
});

// Accepts either a real Netscape cookies.txt export (the format yt-dlp's own
// docs recommend, produced by browser extensions like "Get cookies.txt"), or
// a raw "name=value; name2=value2" cookie-header string as copied straight
// out of a browser's DevTools Network tab -- normalizing the latter into
// Netscape format so yt-dlp's --cookies flag can consume it either way.
function looksLikeNetscapeFormat(text) {
    return /^\s*#/.test(text) || /^[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]*$/m.test(text);
}

function convertHeaderCookiesToNetscape(text) {
    const farFutureExpiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5;
    // A real cookie-header string is a single logical line. Pasting a long one
    // out of a wrapped display (e.g. a chat code block) can pick up stray
    // line breaks at the wrap points, which would otherwise silently sever a
    // cookie's value mid-token and cascade into corrupting everything after
    // it. Collapsing embedded newlines first makes that class of paste-damage
    // harmless.
    const normalized = text.replace(/[\r\n]+/g, '');
    const lines = ['# Netscape HTTP Cookie File'];
    for (const pair of normalized.split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const name = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!name) continue;
        // The header was captured from a request to youtube.com, so that's
        // the only domain we know the value is valid for -- but yt-dlp's
        // YouTube extractor also makes requests that aren't strictly scoped
        // to youtube.com (Google's shared account-auth infrastructure). A
        // cookie jar that only recognizes .youtube.com won't get attached to
        // those, even though a real browser's cookie store would apply here
        // more broadly. Registering each cookie under both domains costs
        // nothing (cookie jars key by domain+path+name, so this can't
        // conflict) and maximizes the chance it's actually sent where needed.
        for (const domain of ['.youtube.com', '.google.com']) {
            lines.push([domain, 'TRUE', '/', 'TRUE', String(farFutureExpiry), name, value].join('\t'));
        }
    }
    // Validity/skip counts are derived centrally in validateNetscapeLines
    // (by the caller) rather than tracked here, so they're correct for both
    // this converted output and a raw Netscape passthrough alike.
    return lines.join('\n') + '\n';
}

// Regardless of which input path produced it, verify the final file is
// actually well-formed Netscape cookie format (every non-comment, non-blank
// line has exactly 7 tab-separated fields) before trusting it -- a raw
// Netscape paste can suffer the exact same wrapped-copy corruption as the
// header-string path. "valid" counts *distinct cookie names*, not lines --
// a single cookie may legitimately appear on more than one line (e.g. our
// own dual .youtube.com/.google.com registration, or a real export that has
// entries for both youtube.com and www.youtube.com), and reporting raw line
// counts back to the user would overstate how many cookies were loaded.
function validateNetscapeLines(content) {
    const validNames = new Set();
    let invalid = 0;
    for (const line of content.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const fields = line.split('\t');
        if (fields.length === 7) {
            validNames.add(fields[5]);
        } else {
            invalid++;
        }
    }
    return { valid: validNames.size, invalid };
}

ipcMain.handle('cookies:save', async (event, cookieText) => {
    const trimmed = (cookieText || '').trim();
    if (!trimmed) {
        throw new Error('Cookie text is empty');
    }

    const content = looksLikeNetscapeFormat(trimmed) ? trimmed : convertHeaderCookiesToNetscape(trimmed);

    const { valid, invalid } = validateNetscapeLines(content);
    if (valid === 0) {
        throw new Error('No valid cookies could be parsed from that text.');
    }

    fs.writeFileSync(cookiesPath, content, 'utf-8');
    return { success: true, cookieCount: valid, skipped: invalid };
});

ipcMain.handle('cookies:delete', async () => {
    if (fs.existsSync(cookiesPath)) {
        fs.unlinkSync(cookiesPath);
    }
    return { success: true };
});

ipcMain.handle('cookies:status', async () => {
    if (!fs.existsSync(cookiesPath)) {
        return { loaded: false, cookieCount: 0 };
    }
    const { valid } = validateNetscapeLines(fs.readFileSync(cookiesPath, 'utf-8'));
    return { loaded: true, cookieCount: valid };
});

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
    // createDirectory only affects macOS (shows a "New Folder" button in the
    // panel); Windows' native folder picker already always allows this.
    properties: ['openDirectory', 'createDirectory'],
    ...options
}));

ipcMain.handle('dialog:saveVideoFile', async (e, defaultName = 'ytVid', options) => {
    const { downloadDir } = readSettings();
    const baseDir = downloadDir || app.getPath('downloads');
    return dialog.showSaveDialog({
        title: 'Save Video',
        buttonLabel: 'Save',
        defaultPath: path.join(baseDir, defaultName),
        filters: getSupportedVideoFilters(),
        ...options
    });
})

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
    const cached = readVideoInfoCache()[url];
    if (cached && Date.now() - cached.savedEpoch < VIDEO_INFO_CACHE_TTL_MS) {
        return { success: true, data: { response: cached.response, fromCache: true } };
    }

    return new Promise((resolve, reject) => {
        // --ignore-no-formats-error matters here specifically: -J alone does NOT
        // put yt-dlp into a formats-only mode that skips format-selector
        // resolution (only --list-formats/--simulate do that). So even a pure
        // metadata dump still tries to resolve yt-dlp's *default* format
        // selector against the available formats, and aborts the whole call
        // with "Requested format is not available" if that fails -- e.g. when
        // an authenticated session's format list doesn't happen to satisfy
        // the default selector. We don't need format resolution at all here,
        // only the raw formats list embedded in the JSON, so this flag makes
        // that failure mode non-fatal. Verified directly: reproduced this
        // exact error with a deliberately-unmatchable -f selector (no cookies
        // needed) and confirmed this flag alone makes -J succeed regardless.
        const script = spawn(ytdlpPath, ['-J', '--no-warnings', '--ignore-no-formats-error', '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), url]);
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
                    const response = reshapeVideoInfo(info);
                    const cache = readVideoInfoCache();
                    cache[url] = { savedEpoch: Date.now(), response };
                    writeVideoInfoCache(cache);
                    resolve({ success: true, data: { response, fromCache: false } });
                } catch (e) {
                    reject(new Error('Failed to parse video data'));
                }
            }
        });
    });
});

function buildDownloadArgs({ videoUrl, outputPath, format, resolution, overwriteMode }) {
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
        '--progress-template', 'download:PROGRESS|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._percent_str)s|%(progress.eta)s|%(progress._speed_str)s',
        '--progress-template', 'postprocess:POSTPROCESS|%(progress.status)s|%(progress.postprocessor)s',
        '--ffmpeg-location', ffmpegDir,
        ...cookiesArgs(),
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

    // Overwrite behavior is a real user choice now (see the renderer's existing-file
    // dialog), not a hardcoded flag: "overwrite" forces a full re-download, anything
    // else (no existing file, or the user chose "resume") leaves yt-dlp's own default
    // behavior in place -- which already resumes a partial file via range requests and
    // skips re-downloading a file that's already complete.
    if (overwriteMode === 'overwrite') {
        args.push('--force-overwrites');
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
