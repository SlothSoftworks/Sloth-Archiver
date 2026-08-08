import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path'
import { spawn } from 'child_process';
import fs from "fs";
import crypto from 'crypto';
import http from 'node:http';
import https from 'node:https';

import { getSupportedVideoFilters, allVideoFilter } from './utils/constants.mjs';
import { getLatestYtdlpVersionFromPyPI, getCurrentYtdlpVersion, isNewerVersion, performYtdlpUpdate } from './updater.mjs';
import { writeLibraryEntry, overrideLibraryEntry, addLibraryVersion, getLibraryIndex, refreshLibraryIndex, findVideoInIndex, recordLibraryDownload, swapLibraryDownload, deleteLibraryEntry, writePlaylistSnapshot, enrichPlaylistEntry, sanitizeForFilesystem } from './library.mjs';

const logFile = path.join(app.getPath("userData"), "main.log");
function log(...args) {
    const msg = args.map(String).join(" ");
    fs.appendFileSync(logFile, msg + "\n");
    console.log(msg);
}

// Catches crashes that would otherwise only ever show up in a terminal the
// packaged app doesn't have -- writes to the same main.log a user can open
// from the Options tab (see errorLog:* handlers below) instead of silently
// dying or spamming an invisible console.
process.on('uncaughtException', (err) => {
    log('[uncaughtException]', new Date().toISOString(), err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (reason) => {
    log('[unhandledRejection]', new Date().toISOString(), reason && reason.stack ? reason.stack : String(reason));
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

const rendererDir = path.join(__dirname, '../renderer');
const ytdlpBinaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const ffmpegDir = isDev ? path.resolve(__dirname, '../ffmpeg') : path.join(process.resourcesPath, 'ffmpeg');
// Still passed to yt-dlp via --ffmpeg-location for the merge step (combining
// separate video+audio streams) it still handles internally -- only MP3
// extraction/format recode move to spawning these binaries directly (see
// runFfmpegWithProgress), since those are the slow, re-encode-y operations
// where yt-dlp's own postprocessing can never report real progress (TD-004).
const ffmpegBinaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeBinaryName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
const ffmpegBinaryPath = path.join(ffmpegDir, ffmpegBinaryName);
const ffprobeBinaryPath = path.join(ffmpegDir, ffprobeBinaryName);

// The bundled ytdlp-bin lives under extraResources (Contents/Resources on
// mac, the installed resources dir on Windows), which isn't reliably
// writable without elevation -- so the updater can never swap a fresh binary
// in there. Instead, relocate to userData (always per-user-writable) once on
// first run, and treat that copy as the one true source of truth from then
// on, in both dev and packaged builds, so update logic behaves identically
// either way.
const bundledYtdlpBinDir = isDev ? path.resolve(__dirname, '../ytdlp-bin') : path.join(process.resourcesPath, 'ytdlp-bin');
const userDataYtdlpBinDir = path.join(app.getPath('userData'), 'ytdlp-bin');
const pythonSrcDir = isDev ? path.resolve(__dirname, '../../src/python') : path.join(process.resourcesPath, 'python-src');

function ensureYtdlpBinInUserData() {
    if (!fs.existsSync(userDataYtdlpBinDir)) {
        fs.cpSync(bundledYtdlpBinDir, userDataYtdlpBinDir, { recursive: true });
    }
}
// Skipped under Vitest (which sets this env var in its own worker processes,
// never in a real Electron launch) -- this is the one module-load-time side
// effect in this file that would otherwise crash on import in a test, since
// bundledYtdlpBinDir only exists in a built dist/ tree. Everything else here
// only touches a mocked 'electron' module and is harmless to run on import.
if (!process.env.VITEST) {
    ensureYtdlpBinInUserData();
}

const ytdlpPath = path.join(userDataYtdlpBinDir, ytdlpBinaryName);
const cookiesPath = path.join(app.getPath('userData'), 'cookies.txt');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const videoInfoCachePath = path.join(app.getPath('userData'), 'videoInfoCache.json');
const VIDEO_INFO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Browsers yt-dlp's own --cookies-from-browser supports reading a cookie
// database from directly (its documented keyring list) -- kept here as the
// single source of truth for both validating settings:setCookiesConfig and
// populating the Options screen's dropdown.
const SUPPORTED_COOKIE_BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];

// 'browser' mode takes priority whenever a browser is actually configured --
// switching modes in Options doesn't delete the saved cookies.txt file, so a
// leftover file from a previous 'file'-mode setup should never silently win
// again once the user has moved to 'browser' mode.
export function cookiesArgs() {
    const { cookiesMode, cookiesBrowser } = readSettings();
    if (cookiesMode === 'browser' && SUPPORTED_COOKIE_BROWSERS.includes(cookiesBrowser)) {
        return ['--cookies-from-browser', cookiesBrowser];
    }
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

// Registers app-video:// as a privileged scheme so the Library tab's player
// can point <video>/<audio> at an arbitrary downloaded file without loading
// the whole thing into renderer memory (the alternative, an IPC-read-to-blob
// bridge, doesn't scale to large video files and can't support real
// seeking). Must run at module-evaluation time, before the app is ready.
// `stream`+`supportFetchAPI` are required for net.fetch delegation below to
// work; `bypassCSP`/`secure`/`standard` are part of the documented working
// recipe for this exact net.fetch-based handler (see handleAppVideoRequest) --
// this app has no CSP today so bypassCSP is a no-op either way, revisit if a
// CSP is ever added.
protocol.registerSchemesAsPrivileged([
    { scheme: 'app-video', privileges: { standard: true, secure: true, stream: true, bypassCSP: true, corsEnabled: true, supportFetchAPI: true } },
]);

export function mimeTypeForPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html';
    if (ext === '.js') return 'text/javascript';
    if (ext === '.css') return 'text/css';
    return 'application/octet-stream';
}

// Serves the renderer bundle (index.html + assets) over a real loopback
// HTTP origin, replacing mainWindow.loadFile()'s file:// origin. Tried a
// custom app:// protocol first (standard: true, secure: true) -- that does
// NOT work: Chromium's Referer-generation gate checks the document's scheme
// against a hardcoded http(s)-family allowlist, entirely separate from the
// privileged-scheme flags, so custom schemes never produce a Referer no
// matter how they're registered (confirmed both by precedent -- Tauri apps
// hit the identical issue serving from tauri://, electron/electron#38749-
// adjacent territory -- and empirically here via a captured Network request
// showing no referer header at all under app://). file://'s missing Referer
// is what breaks the YouTube iframe embed elsewhere in the app (YouTube's
// embed player has required one since late 2025); only a genuine http://
// origin clears that gate. 127.0.0.1-only (not 0.0.0.0) and port 0 (OS
// picks an unused ephemeral port) keep this unreachable from the network.
function startRendererServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const { pathname } = new URL(req.url, 'http://localhost');
            const resolvedPath = path.join(rendererDir, pathname === '/' ? '/index.html' : pathname);
            const relative = path.relative(rendererDir, resolvedPath);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            fs.readFile(resolvedPath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': mimeTypeForPath(resolvedPath) });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// Handles app-video://local/<encodeURIComponent(absolutePath)> requests.
// Guard-railed against the configured libraryDir with the exact same
// path.relative check deleteLibraryEntry (library.mjs) already uses --
// defense in depth, since the renderer only ever constructs these URLs
// itself from data it already has, never from arbitrary input.
//
// Uses net.fetch() against a file:// URL as the byte-stream source (that's
// what fixed an earlier "AbortError: The operation was aborted" bug from
// hand-rolling a Node fs.ReadStream-to-Response conversion), but does NOT
// trust net.fetch's own status/headers for the response we hand back.
// Chromium treats a protocol.handle response as a genuine network response,
// not the same trusted path as a real file:// navigation -- it needs
// Accept-Ranges/Content-Range/206 spelled out explicitly on every response,
// including the very first un-ranged one, or video.seekable.end() stays 0
// and clicking the scrub bar silently does nothing (playback still works,
// only seeking is affected -- that's the exact, documented symptom of this
// gap). So the Range math is done here, ourselves, same as the guard-rail
// above; net.fetch is only ever asked for the exact byte range already
// decided, purely as a stream source.
async function handleAppVideoRequest(request) {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.slice(1));

    const { libraryDir } = readSettings();
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedFilePath = path.resolve(filePath);
    const relative = path.relative(resolvedLibraryDir, resolvedFilePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return new Response('Forbidden', { status: 403 });
    }

    let stat;
    try {
        stat = fs.statSync(resolvedFilePath);
    } catch {
        return new Response('Not Found', { status: 404 });
    }
    const fileSize = stat.size;

    let start = 0;
    let end = fileSize - 1;
    let status = 200;
    const range = request.headers.get('Range');
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const hasStart = match && match[1] !== '';
        const hasEnd = match && match[2] !== '';
        if (!match || (!hasStart && !hasEnd)) {
            return new Response('Range Not Satisfiable', {
                status: 416,
                headers: { 'Content-Range': `bytes */${fileSize}` },
            });
        }
        if (hasStart) {
            start = parseInt(match[1], 10);
            end = hasEnd ? parseInt(match[2], 10) : fileSize - 1;
        } else {
            // Suffix form (bytes=-500): the number is a length counted from
            // the end of the file, not an absolute end offset.
            const suffixLength = parseInt(match[2], 10);
            start = Math.max(fileSize - suffixLength, 0);
            end = fileSize - 1;
        }
        if (start > end || start < 0 || end >= fileSize) {
            return new Response('Range Not Satisfiable', {
                status: 416,
                headers: { 'Content-Range': `bytes */${fileSize}` },
            });
        }
        status = 206;
    }

    try {
        const innerResponse = await net.fetch(pathToFileURL(resolvedFilePath).toString(), {
            headers: { Range: `bytes=${start}-${end}` },
            signal: request.signal,
        });

        const headers = {
            'Content-Type': innerResponse.headers.get('Content-Type') || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
        };
        if (status === 206) {
            headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
        }

        return new Response(innerResponse.body, { status, headers });
    } catch (err) {
        log('[app-video] fetch error', String(err));
        return new Response('Internal Error', { status: 500 });
    }
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

// Testing convenience: lets the UI evict a single cached entry without waiting
// out the week-long TTL or clearing the whole cache file by hand.
ipcMain.handle('videoInfoCache:deleteEntry', async (e, url) => {
    const cache = readVideoInfoCache();
    const existed = url in cache;
    delete cache[url];
    writeVideoInfoCache(cache);
    return { success: true, existed };
});

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

// Unlike downloadDir, deliberately no fallback to a default location here --
// the library is a persistent archive location the user should choose
// deliberately, not one we should guess at.
ipcMain.handle('settings:getLibraryDir', async () => {
    const { libraryDir } = readSettings();
    return { libraryDir: libraryDir || '' };
});

ipcMain.handle('settings:setLibraryDir', async (e, dir) => {
    const settings = readSettings();
    settings.libraryDir = dir;
    writeSettings(settings);
    // Switching to a different library folder mid-session should reflect
    // immediately, not show whatever the previous folder's scan found.
    refreshLibraryIndex(dir);
    return { success: true, libraryDir: dir };
});

ipcMain.handle('settings:getLibraryViewMode', async () => {
    const { libraryViewMode } = readSettings();
    return { libraryViewMode: libraryViewMode === 'video' ? 'video' : 'channel' };
});

ipcMain.handle('settings:setLibraryViewMode', async (e, mode) => {
    const settings = readSettings();
    settings.libraryViewMode = mode === 'video' ? 'video' : 'channel';
    writeSettings(settings);
    return { success: true, libraryViewMode: settings.libraryViewMode };
});

ipcMain.handle('settings:getThemeMode', async () => {
    const { themeMode } = readSettings();
    return { themeMode: themeMode === 'dark' ? 'dark' : 'light' };
});

ipcMain.handle('settings:setThemeMode', async (e, mode) => {
    const settings = readSettings();
    settings.themeMode = mode === 'dark' ? 'dark' : 'light';
    writeSettings(settings);
    return { success: true, themeMode: settings.themeMode };
});

// User-added muxers for the Library view's "convert to" ffmpeg utility,
// beyond the small hardcoded popular set (LibraryVideoDetail.tsx) -- kept as
// a plain string list, no validation against ffmpeg's own real muxer list
// here (that's a concern for whenever the actual conversion gets wired up).
// Caps how many bulk-add items the renderer's queue (useBulkAddQueue.tsx)
// will download at once -- clamped here too, not just in the Options UI,
// since this value round-trips through a plain JSON settings file a user
// could hand-edit. Default of 1 preserves today's sequential behavior for
// anyone who never touches this setting.
const MAX_SIMULTANEOUS_DOWNLOADS_CEILING = 5;

function clampMaxSimultaneousDownloads(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) return 1;
    return Math.min(Math.max(n, 1), MAX_SIMULTANEOUS_DOWNLOADS_CEILING);
}

ipcMain.handle('settings:getMaxSimultaneousDownloads', async () => {
    const { maxSimultaneousDownloads } = readSettings();
    return { maxSimultaneousDownloads: clampMaxSimultaneousDownloads(maxSimultaneousDownloads ?? 1) };
});

ipcMain.handle('settings:setMaxSimultaneousDownloads', async (e, value) => {
    const settings = readSettings();
    settings.maxSimultaneousDownloads = clampMaxSimultaneousDownloads(value);
    writeSettings(settings);
    return { success: true, maxSimultaneousDownloads: settings.maxSimultaneousDownloads };
});

ipcMain.handle('settings:getCustomConvertFormats', async () => {
    const { customConvertFormats } = readSettings();
    return { customConvertFormats: Array.isArray(customConvertFormats) ? customConvertFormats : [] };
});

ipcMain.handle('settings:setCustomConvertFormats', async (e, formats) => {
    const settings = readSettings();
    settings.customConvertFormats = Array.isArray(formats) ? formats : [];
    writeSettings(settings);
    return { success: true, customConvertFormats: settings.customConvertFormats };
});

ipcMain.handle('library:getIndex', async () => {
    const { libraryDir } = readSettings();
    return getLibraryIndex(libraryDir);
});

ipcMain.handle('library:refreshIndex', async () => {
    const { libraryDir } = readSettings();
    return refreshLibraryIndex(libraryDir);
});

// A channel's avatar isn't in a single video's own info dict -- it only
// shows up when yt-dlp extracts the *channel page* itself (a separate code
// path in yt-dlp's own YouTube extractor, confirmed directly against its
// source: channel/tab metadata -- title, channel_id, and a `thumbnails`
// array carrying the avatar -- is parsed once from the channel header,
// independently of resolving any individual video entries). So this is a
// genuinely separate yt-dlp call, once per channel, not something that can
// be piggybacked on the per-video fetch already happening elsewhere.
// --flat-playlist avoids resolving every video in the channel into a full
// info-dict (this app only wants the header), and --playlist-end 1 caps it
// to looking at just one entry rather than flat-listing the whole channel.
function fetchChannelAvatarUrl(channelId) {
    return new Promise((resolve) => {
        const channelUrl = `https://www.youtube.com/channel/${channelId}`;
        const script = spawn(ytdlpPath, [
            '-J', '--no-warnings', '--flat-playlist', '--playlist-end', '1',
            '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), channelUrl,
        ]);
        let data = '';
        script.on('error', () => resolve(null));
        script.stdout.on('data', (chunk) => { data += chunk.toString(); });
        script.stderr.on('data', () => {});
        script.on('close', (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }
            try {
                const thumbnails = JSON.parse(data).thumbnails || [];
                // 'avatar_uncropped' is the full-resolution synthetic entry
                // yt-dlp's own extractor derives from whatever raw avatar
                // thumbnail the channel page embeds -- falls back to a raw
                // 'avatar'-id entry if that's ever missing (a resilience
                // margin against yt-dlp/YouTube changes, not a confirmed
                // real-world case).
                const avatar = thumbnails.find((t) => t.id === 'avatar_uncropped') || thumbnails.find((t) => t.id === 'avatar');
                resolve(avatar ? avatar.url : null);
            } catch {
                resolve(null);
            }
        });
    });
}

// Plain HTTPS GET, no new dependency -- avatar URLs are already fully-formed
// CDN links, not something yt-dlp needs to fetch for us. Follows redirects
// manually since Node's https module doesn't.
function downloadImageToFile(url, destDir, baseName, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                res.resume();
                downloadImageToFile(res.headers.location, destDir, baseName, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
                return;
            }
            const contentType = res.headers['content-type'] || '';
            const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';

            // Clear out any previous image first -- a re-fetch could land on a
            // different extension than last time, and this keeps exactly one
            // <baseName>.* file around rather than accumulating stale ones.
            for (const existing of fs.readdirSync(destDir).filter((f) => f.startsWith(`${baseName}.`))) {
                fs.rmSync(path.join(destDir, existing), { force: true });
            }

            const destPath = path.join(destDir, `${baseName}${ext}`);
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => resolve(destPath));
            fileStream.on('error', reject);
        }).on('error', reject);
    });
}

// Best-effort, never throws -- a missing channel icon just means the UI
// falls back to the generic folder icon, not a broken add-to-library action.
// force skips the "already have one" check -- used by the user-facing
// "refresh channel icon" button, since the whole point there is to re-fetch
// even though one already exists (the channel's avatar may have changed).
async function ensureChannelIcon(channelDir, channelId, { force = false } = {}) {
    if (!channelId) return;
    try {
        const hasIcon = !force && fs.existsSync(channelDir) && fs.readdirSync(channelDir).some((f) => f.startsWith('channel-icon.'));
        if (hasIcon) return;
        const avatarUrl = await fetchChannelAvatarUrl(channelId);
        if (!avatarUrl) return;
        await downloadImageToFile(avatarUrl, channelDir, 'channel-icon');
    } catch (err) {
        log('[channel-icon] fetch failed', String(err));
    }
}

// Video-level (not per-epoch): one thumbnail lives directly in videoDir,
// shared across every version, since the point is a stable, offline-capable
// preview image for the video as a whole rather than something that should
// change on every re-download. Unlike the channel avatar, the thumbnail URL
// is already sitting in videoMetaData (yt-dlp's per-video info dict) --
// no extra yt-dlp call needed, just the same downloadImageToFile reuse.
// Skips (rather than force-refetching) once a video-thumbnail.* file exists,
// so adding a new version of an already-tracked video is a no-op here.
async function ensureVideoThumbnail(videoDir, thumbnailUrl) {
    if (!thumbnailUrl) return;
    try {
        const hasThumbnail = fs.existsSync(videoDir) && fs.readdirSync(videoDir).some((f) => f.startsWith('video-thumbnail.'));
        if (hasThumbnail) return;
        await downloadImageToFile(thumbnailUrl, videoDir, 'video-thumbnail');
    } catch (err) {
        log('[video-thumbnail] fetch failed', String(err));
    }
}

// User-triggered from the Library tab's channel view -- unlike the
// fire-and-forget calls below, this one is awaited so the button can show a
// loading state and the caller gets back a fresh index once it's done.
ipcMain.handle('library:refreshChannelIcon', async (e, { channelFolderName, channelId }) => {
    const { libraryDir } = readSettings();
    const channelDir = path.join(libraryDir, channelFolderName);
    await ensureChannelIcon(channelDir, channelId, { force: true });
    return refreshLibraryIndex(libraryDir);
});

// The channel-icon/video-thumbnail fetches below are fire-and-forget (no
// `await`, so "add to library" reports success immediately rather than
// waiting on an extra yt-dlp + image-download round trip) -- but that alone
// only means the *next* index refresh picks them up. If the Library tab is
// already mounted and the user doesn't happen to re-navigate or hit manual
// refresh afterward, the icon/thumbnail silently never appears even once
// the background fetch is done. This notifies any open window once both
// fetches (and the index refresh that follows them) actually finish, so an
// already-mounted Library tab can silently pick up the change on its own --
// see LibraryScreen.tsx's onLibraryBackgroundUpdate listener.
function notifyLibraryBackgroundUpdate() {
    BrowserWindow.getAllWindows()[0]?.webContents.send('library:backgroundUpdate');
}

ipcMain.handle('library:addEntry', async (e, videoMetaData) => {
    const { libraryDir } = readSettings();
    const result = writeLibraryEntry({ libraryDir, videoMetaData });
    await refreshLibraryIndex(libraryDir);
    Promise.all([
        ensureChannelIcon(result.channelDir, videoMetaData.channelId),
        ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir)).then(notifyLibraryBackgroundUpdate);
    // epoch included alongside videoDir -- bulk-add (useBulkAddQueue.tsx) needs
    // it immediately to kick off a download for the entry it just created,
    // without a second round-trip to look it back up.
    return { success: true, videoDir: result.videoDir, epoch: String(result.metadata.addedEpoch) };
});

ipcMain.handle('library:overrideEntry', async (e, { videoMetaData, existingVideoDir }) => {
    const { libraryDir } = readSettings();
    const result = overrideLibraryEntry({ libraryDir, videoMetaData, existingVideoDir });
    await refreshLibraryIndex(libraryDir);
    Promise.all([
        ensureChannelIcon(result.channelDir, videoMetaData.channelId),
        ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir)).then(notifyLibraryBackgroundUpdate);
    return { success: true, videoDir: result.videoDir };
});

// Additive counterpart to overrideEntry -- adds a new epoch under an
// already-tracked video's existing videoDir instead of replacing it. Used by
// both "Add as new version" (Downloader tab's duplicate dialog) and
// "Download new version" (Library tab's video detail view).
ipcMain.handle('library:addVersion', async (e, { videoDir, videoMetaData }) => {
    const { libraryDir } = readSettings();
    const result = addLibraryVersion({ libraryDir, videoDir, videoMetaData });
    await refreshLibraryIndex(libraryDir);
    Promise.all([
        ensureChannelIcon(path.dirname(result.videoDir), videoMetaData.channelId),
        ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir)).then(notifyLibraryBackgroundUpdate);
    return { success: true, videoDir: result.videoDir, epoch: result.epoch, metadata: result.metadata };
});

// Flat-playlist entries carry more than just id/title/url for free (no extra
// per-video fetch) -- confirmed directly against a real playlist: each entry
// already has its own `thumbnails[]` array and (when YouTube happens to
// resolve it during the flat listing, not guaranteed) a `timestamp`. Picking
// the largest thumbnail and converting the timestamp when present costs
// nothing extra; falling back to the same predictable i.ytimg.com CDU URL
// pattern already used for the bulk-add sidepanel's thumbnails when the
// array is empty, and leaving uploadDate null when timestamp isn't resolved
// (a full per-video fetch would be needed for that reliably, which defeats
// the point of flat-listing an entire playlist cheaply).
export function pickBestThumbnail(id, thumbnails) {
    if (Array.isArray(thumbnails) && thumbnails.length > 0) {
        const best = thumbnails.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
        if (best.url) return best.url;
    }
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

// Bulk-add's playlist path -- same --flat-playlist mechanism as
// fetchChannelAvatarUrl above, just without --playlist-end 1, so this lists
// every entry (in source order) instead of capping at one. No YouTube Data
// API involved: playlistItems.list unconditionally requires an API key/OAuth
// token (confirmed against Google's own docs, no keyless variant exists),
// and the public no-auth playlist RSS feed caps out at the 15 most recent
// videos -- neither fits "every video, in source order." yt-dlp needs no new
// credential and already does this reliably elsewhere in this file.
function fetchPlaylistEntries(playlistUrl) {
    return new Promise((resolve, reject) => {
        const script = spawn(ytdlpPath, [
            '-J', '--no-warnings', '--flat-playlist',
            '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), playlistUrl,
        ]);
        let data = '';
        let error = '';
        script.on('error', (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)));
        script.stdout.on('data', (chunk) => { data += chunk.toString(); });
        script.stderr.on('data', (chunk) => { error += chunk.toString(); });
        script.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(error || `yt-dlp exited with code ${code}`));
                return;
            }
            try {
                const info = JSON.parse(data);
                const entries = (info.entries || []).map((e) => ({
                    id: e.id,
                    // No `|| e.id` fallback here -- that would silently turn
                    // "yt-dlp gave us no title" into a title that's just the
                    // raw video ID, indistinguishable from a real (if
                    // coincidentally id-shaped) title downstream. Leave it
                    // null and let isDeadTitle()/writePlaylistSnapshot
                    // (library.mjs) decide what a missing title means.
                    title: e.title || null,
                    url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
                    thumbnailUrl: pickBestThumbnail(e.id, e.thumbnails),
                    // YYYYMMDD, matching the format getVideoInfoPython's
                    // reshapeVideoInfo already uses for uploadDate elsewhere
                    // (info.upload_date) -- so entries enriched later
                    // (enrichPlaylistEntry) and entries filled in from this
                    // flat listing are never in two different date formats.
                    uploadDate: e.timestamp ? new Date(e.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '') : null,
                }));
                resolve({
                    id: info.id,
                    title: info.title,
                    uploader: info.uploader,
                    originalUrl: info.original_url || info.webpage_url || playlistUrl,
                    entries,
                });
            } catch {
                reject(new Error('Failed to parse playlist listing.'));
            }
        });
    });
}

ipcMain.handle('library:fetchPlaylistEntries', async (e, playlistUrl) => {
    try {
        const playlist = await fetchPlaylistEntries(playlistUrl);
        // Snapshot saved every time a playlist is fetched -- not surfaced to
        // the renderer yet (versioning/a playlist view are future work, see
        // library.mjs's writePlaylistSnapshot), just persisted so that data
        // exists from day one instead of needing to be reconstructed later.
        const { libraryDir } = readSettings();
        if (libraryDir) {
            const index = await getLibraryIndex(libraryDir);
            writePlaylistSnapshot({
                libraryDir,
                playlistId: playlist.id,
                title: playlist.title,
                uploader: playlist.uploader,
                originalUrl: playlist.originalUrl,
                entries: playlist.entries.map((entry) => ({
                    videoId: entry.id,
                    title: entry.title,
                    url: entry.url,
                    thumbnailUrl: entry.thumbnailUrl,
                    uploadDate: entry.uploadDate,
                })),
                index,
            });
        }
        return { success: true, entries: playlist.entries, playlistId: playlist.id };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Called once per bulk-add item that turns out to belong to a
// previously-saved playlist snapshot, right after that item's own real info
// has actually been fetched (see useBulkAddQueue.tsx's processItem) --
// patches just that one entry with the real title/date/thumbnail now known,
// instead of leaving it stuck with whatever the cheap flat-listing guessed.
// This is exactly the scenario the spec calls out: if the video later
// disappears from YouTube, a *future* re-fetch of the playlist would only
// ever see a dead, title-less entry for it -- but by then this real data is
// already saved and won't be overwritten (see enrichPlaylistEntry's own
// never-regress guard).
ipcMain.handle('library:enrichPlaylistEntry', async (e, { playlistId, videoId, title, uploadDate, thumbnailUrl }) => {
    const { libraryDir } = readSettings();
    if (!libraryDir || !playlistId) {
        return { success: false };
    }
    try {
        enrichPlaylistEntry({ libraryDir, playlistId, videoId, title, uploadDate, thumbnailUrl });
        return { success: true };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Checked by the renderer before calling addEntry, so a duplicate can be
// caught with a warning dialog instead of silently piling up a redundant
// epoch folder for a video that's already tracked.
ipcMain.handle('library:findVideo', async (e, videoId) => {
    const { libraryDir } = readSettings();
    const index = await getLibraryIndex(libraryDir);
    const match = findVideoInIndex(index, videoId);
    if (!match) {
        return { found: false };
    }
    return { found: true, channelDisplayName: match.channel.displayName, videoDir: match.video.videoDir };
});

ipcMain.handle('library:recordDownload', async (e, { videoDir, epoch, filePath, resolution, format, kind }) => {
    recordLibraryDownload({ videoDir, epoch, filePath, resolution, format, kind });
    const { libraryDir } = readSettings();
    await refreshLibraryIndex(libraryDir);
    return { success: true };
});

ipcMain.handle('library:swapDownload', async (e, { videoDir, epoch, tempFilePath, oldFilePath, resolution, format, kind }) => {
    const { libraryDir } = readSettings();
    const metadata = swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath, resolution, format, kind });
    await refreshLibraryIndex(libraryDir);
    return metadata;
});

ipcMain.handle('library:deleteEntry', async (e, { videoDir, epoch }) => {
    const { libraryDir } = readSettings();
    const { videoDeleted } = deleteLibraryEntry({ libraryDir, videoDir, epoch });
    await refreshLibraryIndex(libraryDir);
    return { success: true, videoDeleted };
});

// Kick off the initial scan in the background at startup -- deliberately not
// awaited (unlike ensureYtdlpBinInUserData's one-time small copy above, this
// could be scanning an arbitrarily large library). getLibraryIndex reuses
// this same in-flight scan rather than starting a redundant one when the
// Library tab asks for it.
getLibraryIndex(readSettings().libraryDir);

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
export function looksLikeNetscapeFormat(text) {
    return /^\s*#/.test(text) || /^[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]*$/m.test(text);
}

export function convertHeaderCookiesToNetscape(text) {
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
export function validateNetscapeLines(content) {
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

ipcMain.handle('cookies:getConfig', async () => {
    const { cookiesMode, cookiesBrowser } = readSettings();
    return {
        cookiesMode: cookiesMode === 'browser' ? 'browser' : 'file',
        cookiesBrowser: cookiesBrowser || '',
        supportedBrowsers: SUPPORTED_COOKIE_BROWSERS,
    };
});

ipcMain.handle('cookies:setConfig', async (e, { cookiesMode, cookiesBrowser }) => {
    if (cookiesMode === 'browser' && !SUPPORTED_COOKIE_BROWSERS.includes(cookiesBrowser)) {
        throw new Error(`Unsupported browser: ${cookiesBrowser}`);
    }
    const settings = readSettings();
    settings.cookiesMode = cookiesMode === 'browser' ? 'browser' : 'file';
    settings.cookiesBrowser = cookiesBrowser || '';
    writeSettings(settings);
    return { success: true, cookiesMode: settings.cookiesMode, cookiesBrowser: settings.cookiesBrowser };
});

app.on("ready", async () => {
    protocol.handle('app-video', handleAppVideoRequest);

    const rendererServer = await startRendererServer();
    const { port } = rendererServer.address();

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
    mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);
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

// Matches runFfmpegWithProgress's own '-b:a 192k' for the actual MP3
// extraction pass -- the estimate has to agree with what really gets
// encoded, or it's not an estimate of anything real.
const MP3_BITRATE_KBPS = 192;

export function buildResolutions(info) {
    const seen = new Set();
    const resolutions = [];

    // Every real download is bestvideo+bestaudio merged (see
    // buildDownloadArgs), so a video-only format's own filesize always
    // understates the actual merged output -- add the best available
    // audio-only track's size to every video resolution's estimate below,
    // same way yt-dlp itself would pick "bestaudio".
    const audioFormats = (info.formats || []).filter((fmt) => fmt.vcodec === 'none' && fmt.acodec && fmt.acodec !== 'none');
    const bestAudio = audioFormats.reduce((best, fmt) => ((fmt.abr || 0) > (best?.abr || 0) ? fmt : best), null);
    let bestAudioSize = bestAudio ? (bestAudio.filesize || bestAudio.filesize_approx) : null;
    if (!bestAudioSize && bestAudio?.abr && info.duration) {
        bestAudioSize = (bestAudio.abr * 1000 * info.duration) / 8;
    }

    for (const fmt of info.formats || []) {
        const height = fmt.height;
        if (fmt.vcodec === 'none' || !height) continue;
        if (seen.has(height)) continue;
        seen.add(height);

        let size = fmt.filesize || fmt.filesize_approx;
        // tbr is decimal kbps (per-thousand), not binary -- kilobits-to-bytes
        // is *1000/8, not *1024/8.
        if (!size && fmt.tbr && info.duration) {
            size = (fmt.tbr * 1000 * info.duration) / 8;
        }
        if (size != null && bestAudioSize) {
            size += bestAudioSize;
        }

        resolutions.push({
            resolution: String(height),
            filesizeMb: size != null ? Math.round((size / (1024 * 1024)) * 100) / 100 : null,
            ext: fmt.ext,
        });
    }

    // A real, audio-only estimate -- not a leftover clone of the smallest
    // video resolution's (video-track) byte count, which is what this used
    // to be and had nothing to do with an actual MP3's size.
    if (resolutions.length > 0) {
        const mp3Size = info.duration ? (MP3_BITRATE_KBPS * 1000 * info.duration) / 8 : null;
        resolutions.push({
            resolution: 'MP3',
            filesizeMb: mp3Size != null ? Math.round((mp3Size / (1024 * 1024)) * 100) / 100 : null,
            ext: 'mp3',
        });
    }

    return resolutions;
}

export function reshapeVideoInfo(info) {
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

// A video is effectively dead (unavailable/private/deleted/region-locked)
// even when yt-dlp still exits 0 and hands back a parseable info dict --
// --ignore-no-formats-error (below) exists specifically to let that
// non-fatal case through rather than hard-failing on format-selector
// resolution. Two independent signals, either one enough on its own:
// no downloadable formats at all (buildResolutions came back empty -- not
// even MP3, which itself requires at least one real video-height entry
// today), or no channel/uploader at all -- yt-dlp can't resolve who
// uploaded a video it can't actually load the real page for, so a real,
// available video never has both null.
export function isDeadVideoInfo(response) {
    if (!response.resolutions || response.resolutions.length === 0) return true;
    if (!response.channelId && !response.uploader) return true;
    return false;
}

ipcMain.handle('getVideoInfoPython', async (event, url) => {
    const cache = readVideoInfoCache();
    const cached = cache[url];
    if (cached && Date.now() - cached.savedEpoch < VIDEO_INFO_CACHE_TTL_MS) {
        // Self-healing: a dead-video response cached before this check
        // existed (or from a transient gap) doesn't get served as valid
        // forever -- drop it and fall through to a real, fresh fetch below
        // instead of returning early.
        if (!isDeadVideoInfo(cached.response)) {
            return { success: true, data: { response: cached.response, fromCache: true } };
        }
        delete cache[url];
        writeVideoInfoCache(cache);
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
                    // --ignore-no-formats-error (see above) makes yt-dlp swallow real
                    // extraction failures -- most commonly YouTube's "Sign in to
                    // confirm you're not a bot" bot-check when no cookies are loaded
                    // -- entirely internally: exit code 0, empty stderr, just a
                    // degraded JSON blob (formats: [], duration/channel_id missing,
                    // title/uploader still present from the flat webpage data).
                    // Without this check that silently saved as a real library entry
                    // with an empty download-quality list and no way to tell why.
                    // A selector-mismatch (the case the flag above is actually for)
                    // always leaves formats non-empty, so this only catches genuine
                    // extraction failures.
                    if (!info.formats || info.formats.length === 0) {
                        reject(new Error('yt-dlp could not retrieve any downloadable formats for this video. This usually means YouTube blocked the request (e.g. "Sign in to confirm you\'re not a bot") -- load a cookie or enable "cookies from browser" in Options and try again.'));
                        return;
                    }
                    const response = reshapeVideoInfo(info);
                    // Reject before this ever gets cached or handed to a
                    // caller that would otherwise go on to create a library
                    // folder for a video with nothing real to archive.
                    if (isDeadVideoInfo(response)) {
                        reject(new Error('No downloadable formats found for this video -- it may be unavailable, private, or region-locked.'));
                        return;
                    }
                    const freshCache = readVideoInfoCache();
                    freshCache[url] = { savedEpoch: Date.now(), response };
                    writeVideoInfoCache(freshCache);
                    resolve({ success: true, data: { response, fromCache: false } });
                } catch (e) {
                    reject(new Error('Failed to parse video data'));
                }
            }
        });
    });
});

export function needsDirectFfmpegPass({ format, resolution }) {
    if (resolution && resolution.toLowerCase() === 'mp3') return true;
    return !!format && !['undefined', 'dflt'].includes(format);
}

// The extension actually produced by the direct ffmpeg pass above -- MP3
// wins over an explicit format choice since resolution:'mp3' means audio-only
// regardless of whatever format dropdown value happens to be selected.
// Returns null when no postprocessing happens (yt-dlp's own download/merge
// picks its own correct extension in that case, untouched here).
export function ffmpegTargetExtension({ format, resolution }) {
    if (resolution && resolution.toLowerCase() === 'mp3') return 'mp3';
    if (format && !['undefined', 'dflt'].includes(format)) return format.toLowerCase();
    return null;
}

// yt-dlp auto-appends the right extension to an extension-less outtmpl, but
// our own ffmpeg postprocess pass (runFfmpegWithProgress) does not -- it
// needs a real extension (or -f) to pick a muxer at all. outputPath handed
// in here can arrive two ways, both wrong for ffmpeg: the Library view's
// deterministic path has no extension whatsoever (ffmpeg fails outright --
// the "MP3 download fails" bug), and the Downloader tab's Save-dialog path
// always carries a video extension (mp4/mkv/3gp -- there's no MP3 filter
// option), which for an MP3 selection means ffmpeg happily muxes MP3 audio
// into a file merely *named* .mp4 (the "saves as video.mp4" bug). Stripping
// whatever extension is already there and appending the real target one
// fixes both regardless of which path the caller supplied.
export function withTargetExtension(outputPath, ext) {
    const { dir, name } = path.parse(outputPath);
    return path.join(dir, `${name}.${ext}`);
}

// yt-dlp itself only ever downloads (and merges separate video+audio streams,
// when both are selected) from here on -- MP3 extraction and format recode
// are handled by our own direct ffmpeg pass afterward (see
// runFfmpegWithProgress), since yt-dlp's own postprocessing can never report
// real progress for those (TD-004). outputPath is either the user's final
// chosen path (no postprocessing needed) or a raw intermediate path in a temp
// dir (postprocessing needed) -- the caller decides which, this function just
// downloads to whatever it's given.
export function buildDownloadArgs({ videoUrl, outputPath, resolution, overwriteMode }) {
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
        // Audio only -- the old bestvideo[height<=144]+bestaudio selector downloaded
        // a throwaway low-res video track purely to feed yt-dlp's own extract-audio
        // postprocessor. Now that we extract audio ourselves, there's no reason to
        // download video at all.
        args.push('-f', 'bestaudio/best');
    } else {
        args.push('-f', `bestvideo[height<=${resolution}]+bestaudio/best`);
        // Without this, yt-dlp's own merge step picks MKV by default whenever the
        // chosen video+audio pair isn't natively MP4-safe (e.g. Opus audio) --
        // which Chromium's <video> element (this app's own Library player) can't
        // play at all, container aside from codecs (see LibraryVideoPlayer.tsx's
        // PLAYABLE_VIDEO_EXTENSIONS). --merge-output-format only picks the
        // container for the stream-copy merge, it doesn't transcode, and modern
        // ffmpeg's MP4 muxer already supports every codec combination yt-dlp's own
        // format selector above can produce (H.264/VP9/AV1 video, AAC/Opus audio),
        // so this is a free fix with no quality/compatibility cost. Only applies
        // to this default (no explicit format chosen) path -- an explicit format
        // choice (Downloader tab) still goes through the direct ffmpeg postprocess
        // pass instead and picks its own target container there.
        args.push('--merge-output-format', 'mp4');
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
export function findFinalFile(outputPath) {
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

// yt-dlp downloaded to a raw.%(ext)s template in a dedicated per-download temp
// dir (nothing else lives there), so whatever single file landed is the one we want.
export function findRawDownloadedFile(rawDir) {
    const match = fs.readdirSync(rawDir).find((f) => f.startsWith('raw.'));
    if (!match) {
        throw new Error('yt-dlp finished but no raw downloaded file was found');
    }
    return path.join(rawDir, match);
}

function getMediaDurationSeconds(filePath) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffprobeBinaryPath, ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `ffprobe exited with code ${code}`));
                return;
            }
            try {
                const duration = parseFloat(JSON.parse(stdout).format.duration);
                resolve(Number.isFinite(duration) ? duration : 0);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output'));
            }
        });
    });
}

// ffmpeg's stderr is a wall of banner/build-config/stream-metadata noise even
// on success, and on failure the real cause is buried in there as plain text
// (there's no separate structured error output). This extracts just the
// root-cause line rather than surfacing the whole dump to the user: strip
// every line that's recognizably banner/metadata/progress noise, then take
// the *first* remaining line that looks like an actual error -- the first
// one is the root cause, later ones tend to be consequences of it (e.g. "-to
// value smaller than -ss; aborting." followed by "Error opening output
// file..." -- the first line is the fix-worthy one). Falls back to a plain
// generic message if nothing recognizable survives the filtering, rather
// than risk dumping something huge/useless.
const FFMPEG_NOISE_LINE = /^(ffmpeg version|built with|configuration:|lib(avutil|avcodec|avformat|avdevice|avfilter|swscale|swresample|postproc)|Input #\d|Duration:|Stream #|Stream mapping:|Press \[q\]|frame=|size=|time=|bitrate=|speed=|\s*Metadata:$|\s*(major_brand|minor_version|compatible_brands|title|artist|date|encoder|description|handler_name|vendor_id|comment|composer|genre)\s*:)/i;
const FFMPEG_ERROR_KEYWORDS = /\b(error|invalid|cannot|could not|no such|permission denied|failed|unable|aborting|not found|no space|unknown|unrecognized)\b/i;
const FFMPEG_LINE_PREFIX = /^\[[^\]]*\]\s*/;

// The extracted root-cause line is still raw ffmpeg jargon ("-to value
// smaller than -ss; aborting." means nothing to a non-technical user) --
// this translates the handful of causes we can actually expect to hit from
// this app's own ffmpeg invocations into plain language. Matched against the
// already-extracted single line, not the full dump, so each pattern only
// needs to account for ffmpeg's own wording, not where it appears.
const FFMPEG_FRIENDLY_ERRORS = [
    { pattern: /-to value smaller than -ss/i, message: 'The clip end time must be after the start time.' },
    { pattern: /permission denied/i, message: 'Permission denied while writing the output file -- check that the destination folder is writable.' },
    { pattern: /no space left on device/i, message: 'Not enough free disk space to finish this operation.' },
    { pattern: /(unknown output format|unable to find a suitable output format|unknown encoder|unknown codec)/i, message: 'This output format isn\'t supported by the bundled ffmpeg build -- try a different format.' },
    { pattern: /no such file or directory/i, message: 'A required file could not be found (it may have been moved or deleted).' },
    { pattern: /moov atom not found|invalid data found when processing input/i, message: 'The source file appears to be corrupted or incomplete.' },
];

function summarizeFfmpegError(stderr, code) {
    const candidateLines = (stderr || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !FFMPEG_NOISE_LINE.test(line));
    const rootCause = candidateLines.find((line) => FFMPEG_ERROR_KEYWORDS.test(line));
    const message = (rootCause || candidateLines.at(-1) || '').replace(FFMPEG_LINE_PREFIX, '').trim();
    if (!message) return `ffmpeg failed to process this file (exit code ${code}).`;
    const friendly = FFMPEG_FRIENDLY_ERRORS.find(({ pattern }) => pattern.test(message));
    if (friendly) return friendly.message;
    return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

// Bypasses yt-dlp's own postprocessing entirely -- see TD-004. yt-dlp runs its
// postprocessing ffmpeg subprocess with a blocking call that only reads output
// after the process exits, so it can never report real progress; spawning
// ffmpeg ourselves with -progress pipe:1 gives a genuine, continuous percentage.
function runFfmpegWithProgress({ inputPath, outputPath, codecArgs, totalDurationSeconds, onProgress, extraInputArgs = [] }) {
    return new Promise((resolve, reject) => {
        const args = ['-i', inputPath, ...extraInputArgs, ...codecArgs, '-progress', 'pipe:1', '-y', outputPath];
        const proc = spawn(ffmpegBinaryPath, args);
        let stderr = '';
        let buffer = '';

        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                const match = line.match(/^out_time_us=(\d+)/);
                if (match && totalDurationSeconds > 0) {
                    const percent = Math.min(100, (Number(match[1]) / (totalDurationSeconds * 1_000_000)) * 100);
                    onProgress?.(percent);
                }
            }
        });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(summarizeFfmpegError(stderr, code)));
            } else {
                resolve();
            }
        });
    });
}

// Try a fast remux first (no quality loss, just a container swap); fall back
// to a full re-encode if the source codec isn't compatible with the target
// container. Reasonably close to yt-dlp's own remux-preferred behavior
// without hand-maintaining a codec/container compatibility matrix ourselves.
// Shared by the download-time format recode below and the Library view's
// standalone "Convert to" ffmpeg utility.
async function convertWithFallback({ inputPath, outputPath, format, totalDurationSeconds, onProgress }) {
    try {
        await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: ['-c', 'copy'], totalDurationSeconds, onProgress });
    } catch {
        // WebM is spec'd to only hold VP8/VP9/AV1 video + Vorbis/Opus audio --
        // falling back to libx264/aac universally would produce a file labeled
        // .webm that isn't actually valid WebM.
        const reencodeCodecArgs = (format || '').toLowerCase() === 'webm'
            ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']
            : ['-c:v', 'libx264', '-c:a', 'aac'];
        await runFfmpegWithProgress({ inputPath, outputPath, codecArgs: reencodeCodecArgs, totalDurationSeconds, onProgress });
    }
}

// Tracked so the updater can refuse to swap the live yt-dlp binary out from
// under a process that's actively using it.
let activeDownloadCount = 0;

ipcMain.handle('downloadVideoWithProgressUpdates', (event, options) => {
    activeDownloadCount++;
    // requestId is echoed onto every message on this shared/unscoped
    // broadcast channel (TD-008) -- generated renderer-side by
    // useDownloadVideo.tsx's startDownload(), not here, so every consumer of
    // this handler (manual download, Library-view download, the bulk-add
    // queue) can filter to just its own in-flight download.
    const send = (msg) => BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', { ...msg, requestId: options.requestId });

    // MP3 extraction and format recode need our own ffmpeg pass afterward (TD-004),
    // so yt-dlp downloads to a raw intermediate file in a dedicated temp dir instead
    // of the user's final chosen path -- deliberately outside that directory so it
    // can never spuriously match findFinalFile's/checkFileExists' prefix-based
    // lookups for the real target.
    const postprocess = needsDirectFfmpegPass(options);
    // Only ever used in place of options.outputPath inside the postprocess
    // branch below -- see withTargetExtension for why the caller-supplied
    // path can't be trusted as-is for that step.
    const postprocessOutputPath = postprocess
        ? withTargetExtension(options.outputPath, ffmpegTargetExtension(options))
        : options.outputPath;
    let rawDir = null;
    let downloadArgs;
    if (postprocess) {
        // Derived from outputPath (not a random UUID) so retrying the same download
        // reuses the same raw dir -- otherwise every retry of an MP3/recode download
        // would start yt-dlp's own download from scratch even when a partial raw file
        // already existed, silently losing the resume behavior TD-001 relies on.
        const rawDirId = crypto.createHash('sha1').update(options.outputPath).digest('hex').slice(0, 16);
        rawDir = path.join(app.getPath('temp'), 'yt-archiver-raw', rawDirId);
        if (options.overwriteMode === 'overwrite') {
            fs.rmSync(rawDir, { recursive: true, force: true });
        }
        fs.mkdirSync(rawDir, { recursive: true });
        downloadArgs = buildDownloadArgs({ ...options, outputPath: path.join(rawDir, 'raw.%(ext)s') });
    } else {
        downloadArgs = buildDownloadArgs(options);
    }

    const script = spawn(ytdlpPath, downloadArgs);

    let error = '';

    script.on('error', (err) => {
        activeDownloadCount--;
        if (rawDir) fs.rmSync(rawDir, { recursive: true, force: true });
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

    script.on('close', async (code) => {
        if (code !== 0) {
            activeDownloadCount--;
            if (rawDir) fs.rmSync(rawDir, { recursive: true, force: true });
            send({ type: 'error', payload: { message: error || `Download failed with code ${code}` } });
            return;
        }

        if (!postprocess) {
            activeDownloadCount--;
            send({ type: 'done', payload: { filename: findFinalFile(options.outputPath) } });
            return;
        }

        try {
            const rawFile = findRawDownloadedFile(rawDir);
            const duration = await getMediaDurationSeconds(rawFile);
            const onFfmpegProgress = (postprocessPercent) => send({
                type: 'postprocessing',
                payload: { stage: 'progress', processor: 'ffmpeg', postprocessPercent },
            });

            if (options.resolution && options.resolution.toLowerCase() === 'mp3') {
                await runFfmpegWithProgress({
                    inputPath: rawFile,
                    outputPath: postprocessOutputPath,
                    codecArgs: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'],
                    totalDurationSeconds: duration,
                    onProgress: onFfmpegProgress,
                });
            } else {
                await convertWithFallback({
                    inputPath: rawFile,
                    outputPath: postprocessOutputPath,
                    format: options.format,
                    totalDurationSeconds: duration,
                    onProgress: onFfmpegProgress,
                });
            }

            fs.rmSync(rawDir, { recursive: true, force: true });
            activeDownloadCount--;
            send({ type: 'done', payload: { filename: postprocessOutputPath } });
        } catch (err) {
            activeDownloadCount--;
            send({ type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
        }
    })

});

// --- Library view: ffmpeg utilities (extract MP3, convert format, extract
// clip, embed metadata) ---------------------------------------------------
// These all run ffmpeg directly against an *already-downloaded* library
// file (not a fresh yt-dlp download), so they're deliberately kept separate
// from downloadVideoWithProgressUpdates/'progressUpdate' above rather than
// overloading that pipeline's meaning -- one shared broadcast channel here,
// same "one at a time" assumption as everywhere else in this app (see
// TD-008, reports/TechnicalDebt.md).
function sendFfmpegUtilityProgress(msg) {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ffmpegUtilityProgress', msg);
}

// Generic "export a derived file" save dialog -- distinct from
// dialog:saveVideoFile (which is hardcoded to video-download filters and the
// configured download dir) since these exports can be audio, a different
// container, or an arbitrary user-typed "Other" format. defaultName is
// sanitized the same way library folder/file names already are, since it's
// often derived straight from a video's title. Defaults to the source file's
// own folder (inputPath) rather than the configured download dir -- these
// exports are edits of a library file the user is already looking at, so
// saving next to it is the more useful default; falls back to the download
// dir/OS downloads folder only when no inputPath is given.
ipcMain.handle('dialog:saveExportedFile', async (e, { defaultName, extensions, inputPath }) => {
    const { downloadDir } = readSettings();
    const baseDir = (inputPath && path.dirname(inputPath)) || downloadDir || app.getPath('downloads');
    return dialog.showSaveDialog({
        title: 'Save File',
        buttonLabel: 'Save',
        defaultPath: path.join(baseDir, sanitizeForFilesystem(defaultName)),
        filters: [{ name: 'File', extensions }, ...allVideoFilter],
    });
});

ipcMain.handle('library:extractMp3', async (e, { inputPath, outputPath }) => {
    try {
        const duration = await getMediaDurationSeconds(inputPath);
        await runFfmpegWithProgress({
            inputPath,
            outputPath,
            codecArgs: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'],
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
        });
        return { success: true, outputPath };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

ipcMain.handle('library:convertFormat', async (e, { inputPath, outputPath, format }) => {
    try {
        const duration = await getMediaDurationSeconds(inputPath);
        await convertWithFallback({
            inputPath,
            outputPath,
            format,
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
        });
        return { success: true, outputPath };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// start/end are passed straight through to ffmpeg's own -ss/-to, which
// already accepts the flexible time formats the UI's plain text fields take
// (SS, MM:SS, HH:MM:SS[.ms]) -- no need to parse/validate them ourselves.
// Both as output options (after -i), not input-seeking, so they're
// unambiguous absolute timestamps in the source's own timeline -- slower to
// seek than input-side -ss on a long file, but -c copy never decodes video
// either way, so it's still just an I/O cost, not a CPU one. -c copy snaps
// to the nearest keyframe rather than an exact frame (a real, documented
// tradeoff, not a bug) -- a full re-encode for frame-accurate cuts is a
// deliberately separate, not-yet-offered option.
ipcMain.handle('library:extractClip', async (e, { inputPath, outputPath, start, end }) => {
    try {
        await runFfmpegWithProgress({
            inputPath,
            outputPath,
            codecArgs: ['-ss', start, '-to', end, '-c', 'copy'],
            totalDurationSeconds: 0,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
        });
        return { success: true, outputPath };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Edits "in place" from the user's perspective, but ffmpeg can never read
// and write the same file at once -- same safe temp-then-rename pattern
// swapLibraryDownload (library.mjs) already established for quality swaps:
// write to a distinct video.new.<ext> path first, only delete the working
// file and rename the new one into its exact place once ffmpeg actually
// succeeds, so a failed/interrupted run never touches the original.
// Doesn't touch metadata.json at all -- downloadedFilePath/Resolution/Format
// are all unchanged, only the bytes at that same path are.
//
// thumbnailPath (the video-level video-thumbnail.* file, may be jpg/png/webp
// -- see downloadImageToFile) is embedded as cover art alongside the plain
// text tags, when given. -map explicitly drops any video stream(s) beyond
// the real one (video's own v:0) / any pre-existing cover on audio, so
// re-running this doesn't accumulate a stack of old covers -- each run
// replaces whatever cover was there with the current thumbnail. The cover
// stream itself is always re-encoded to mjpeg (never copied) since a webp
// thumbnail isn't a valid embedded-cover codec for ID3/mov -- everything
// else stays -c copy, no quality loss.
ipcMain.handle('library:embedMetadata', async (e, { inputPath, metadataTags, thumbnailPath, kind }) => {
    try {
        const ext = path.extname(inputPath);
        const tempPath = `${inputPath.slice(0, -ext.length)}.new${ext}`;
        const duration = await getMediaDurationSeconds(inputPath);
        const metadataArgs = Object.entries(metadataTags || {})
            .filter(([, value]) => !!value)
            .flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);

        const hasThumbnail = !!thumbnailPath && fs.existsSync(thumbnailPath);
        // Audio (mp3) has no pre-existing video stream, so the embedded cover
        // becomes v:0; a video file's real video stream is always v:0 (it's
        // mapped first below), so the cover lands at v:1.
        const coverStreamIndex = kind === 'audio' ? 0 : 1;
        const streamMapArgs = hasThumbnail
            ? (kind === 'audio' ? ['-map', '0:a', '-map', '1'] : ['-map', '0:v:0', '-map', '0:a?', '-map', '1'])
            : [];
        const coverArgs = hasThumbnail
            ? [
                `-c:v:${coverStreamIndex}`, 'mjpeg',
                `-disposition:v:${coverStreamIndex}`, 'attached_pic',
                `-metadata:s:v:${coverStreamIndex}`, 'title=Album cover',
                `-metadata:s:v:${coverStreamIndex}`, 'comment=Cover (front)',
                ...(kind === 'audio' ? ['-id3v2_version', '3'] : []),
            ]
            : [];

        await runFfmpegWithProgress({
            inputPath,
            outputPath: tempPath,
            extraInputArgs: hasThumbnail ? ['-i', thumbnailPath] : [],
            codecArgs: ['-c', 'copy', ...streamMapArgs, ...coverArgs, ...metadataArgs],
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
        });
        fs.rmSync(inputPath, { force: true });
        fs.renameSync(tempPath, inputPath);
        return { success: true };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

ipcMain.handle('ytdlp:checkForUpdate', async () => {
    const [latest, current] = await Promise.all([
        getLatestYtdlpVersionFromPyPI(),
        getCurrentYtdlpVersion(ytdlpPath),
    ]);
    return { current, latest, updateAvailable: isNewerVersion(latest, current) };
});

ipcMain.handle('ytdlp:startUpdate', async () => {
    const send = (stage) => BrowserWindow.getAllWindows()[0]?.webContents.send('ytdlpUpdateProgress', { stage });
    try {
        const result = await performYtdlpUpdate({
            userDataDir: app.getPath('userData'),
            pythonSrcDir,
            liveYtdlpBinDir: userDataYtdlpBinDir,
            ytdlpBinaryName,
            isDownloadActive: () => activeDownloadCount > 0,
            onProgress: send,
        });
        return { success: true, version: result.version };
    } catch (err) {
        send('error');
        throw err instanceof Error ? err : new Error(String(err));
    }
});

// yt-dlp is a vital dependency -- if the user declines a required update at
// startup, the app can't function, so it quits rather than continuing in a
// broken state.
ipcMain.handle('app:quit', async () => {
    app.quit();
});

ipcMain.handle('system:openFileInDirectory', async (e, filepath) => {
    shell.showItemInFolder(filepath);
});
// Was previously (and incorrectly, unused until now) implemented with
// shell.showItemInFolder, which for a directory path reveals its *parent*
// folder with that directory selected -- not what "open this folder" means.
// shell.openPath opens the given folder's own contents directly.
ipcMain.handle('system:openDirectory', async (e, dirPath) => {
    shell.openPath(dirPath);
});

// Opens a file in the OS's default app for it (e.g. QuickTime/VLC for a
// video) -- shell.openPath works for files just as well as directories.
// Deliberately unconditional on file type: it's a generically useful escape
// hatch (different codec/hardware support, a bigger window) even for
// formats the in-app player already handles, not just the MKV case
// Chromium's <video> element can't play at all.
ipcMain.handle('system:openFileExternally', async (e, filepath) => {
    shell.openPath(filepath);
});

// Renderer-side errors (window.onerror/unhandledrejection, see App.tsx)
// can't write to main.log directly -- the renderer has no fs access under
// contextIsolation/sandbox -- so they're forwarded here to share the same
// log file main-process crashes already go to.
ipcMain.handle('errorLog:report', async (e, { message, stack }) => {
    log('[rendererError]', new Date().toISOString(), stack || message || 'Unknown renderer error');
});

ipcMain.handle('errorLog:getInfo', async () => {
    return { exists: fs.existsSync(logFile), path: logFile };
});

ipcMain.handle('errorLog:open', async () => {
    shell.openPath(logFile);
});
