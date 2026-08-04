import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path'
import { spawn } from 'child_process';
import fs from "fs";
import crypto from 'crypto';
import http from 'node:http';
import https from 'node:https';

import { getSupportedVideoFilters } from './utils/constants.mjs';
import { getLatestYtdlpVersionFromPyPI, getCurrentYtdlpVersion, isNewerVersion, performYtdlpUpdate } from './updater.mjs';
import { writeLibraryEntry, overrideLibraryEntry, addLibraryVersion, getLibraryIndex, refreshLibraryIndex, findVideoInIndex, recordLibraryDownload, swapLibraryDownload, deleteLibraryEntry } from './library.mjs';

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
ensureYtdlpBinInUserData();

const ytdlpPath = path.join(userDataYtdlpBinDir, ytdlpBinaryName);
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

function mimeTypeForPath(filePath) {
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

ipcMain.handle('library:addEntry', async (e, videoMetaData) => {
    const { libraryDir } = readSettings();
    const result = writeLibraryEntry({ libraryDir, videoMetaData });
    await refreshLibraryIndex(libraryDir);
    // Fire-and-forget: fetches+caches the channel's avatar in the background
    // so it works offline, without making the user wait on an extra yt-dlp
    // call before "add to library" reports success. Picked up on the next
    // index refresh (manual refresh, or navigating back into the channel).
    ensureChannelIcon(result.channelDir, videoMetaData.channelId).then(() => refreshLibraryIndex(libraryDir));
    ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail).then(() => refreshLibraryIndex(libraryDir));
    return { success: true, videoDir: result.videoDir };
});

ipcMain.handle('library:overrideEntry', async (e, { videoMetaData, existingVideoDir }) => {
    const { libraryDir } = readSettings();
    const result = overrideLibraryEntry({ libraryDir, videoMetaData, existingVideoDir });
    await refreshLibraryIndex(libraryDir);
    ensureChannelIcon(result.channelDir, videoMetaData.channelId).then(() => refreshLibraryIndex(libraryDir));
    ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail).then(() => refreshLibraryIndex(libraryDir));
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
    ensureChannelIcon(path.dirname(result.videoDir), videoMetaData.channelId).then(() => refreshLibraryIndex(libraryDir));
    ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail).then(() => refreshLibraryIndex(libraryDir));
    return { success: true, videoDir: result.videoDir, epoch: result.epoch, metadata: result.metadata };
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

ipcMain.handle('library:recordDownload', async (e, { videoDir, epoch, filePath, resolution, format }) => {
    recordLibraryDownload({ videoDir, epoch, filePath, resolution, format });
    const { libraryDir } = readSettings();
    await refreshLibraryIndex(libraryDir);
    return { success: true };
});

ipcMain.handle('library:swapDownload', async (e, { videoDir, epoch, tempFilePath, oldFilePath, resolution, format }) => {
    const { libraryDir } = readSettings();
    const metadata = swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath, resolution, format });
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

function buildResolutions(info) {
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

function needsDirectFfmpegPass({ format, resolution }) {
    if (resolution && resolution.toLowerCase() === 'mp3') return true;
    return !!format && !['undefined', 'dflt'].includes(format);
}

// The extension actually produced by the direct ffmpeg pass above -- MP3
// wins over an explicit format choice since resolution:'mp3' means audio-only
// regardless of whatever format dropdown value happens to be selected.
// Returns null when no postprocessing happens (yt-dlp's own download/merge
// picks its own correct extension in that case, untouched here).
function ffmpegTargetExtension({ format, resolution }) {
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
function withTargetExtension(outputPath, ext) {
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
function buildDownloadArgs({ videoUrl, outputPath, resolution, overwriteMode }) {
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

// yt-dlp downloaded to a raw.%(ext)s template in a dedicated per-download temp
// dir (nothing else lives there), so whatever single file landed is the one we want.
function findRawDownloadedFile(rawDir) {
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

// Bypasses yt-dlp's own postprocessing entirely -- see TD-004. yt-dlp runs its
// postprocessing ffmpeg subprocess with a blocking call that only reads output
// after the process exits, so it can never report real progress; spawning
// ffmpeg ourselves with -progress pipe:1 gives a genuine, continuous percentage.
function runFfmpegWithProgress({ inputPath, outputPath, codecArgs, totalDurationSeconds, onProgress }) {
    return new Promise((resolve, reject) => {
        const args = ['-i', inputPath, ...codecArgs, '-progress', 'pipe:1', '-y', outputPath];
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
                reject(new Error(stderr || `ffmpeg exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

// Tracked so the updater can refuse to swap the live yt-dlp binary out from
// under a process that's actively using it.
let activeDownloadCount = 0;

ipcMain.handle('downloadVideoWithProgressUpdates', (event, options) => {
    activeDownloadCount++;
    const send = (msg) => BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', msg);

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
                // Try a fast remux first (no quality loss, just a container swap);
                // fall back to a full re-encode if the source codec isn't compatible
                // with the target container. Reasonably close to yt-dlp's own
                // remux-preferred behavior without hand-maintaining a codec/container
                // compatibility matrix ourselves.
                try {
                    await runFfmpegWithProgress({
                        inputPath: rawFile,
                        outputPath: postprocessOutputPath,
                        codecArgs: ['-c', 'copy'],
                        totalDurationSeconds: duration,
                        onProgress: onFfmpegProgress,
                    });
                } catch {
                    // WebM is spec'd to only hold VP8/VP9/AV1 video + Vorbis/Opus
                    // audio -- falling back to libx264/aac universally would produce
                    // a file labeled .webm that isn't actually valid WebM.
                    const reencodeCodecArgs = (options.format || '').toLowerCase() === 'webm'
                        ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']
                        : ['-c:v', 'libx264', '-c:a', 'aac'];
                    await runFfmpegWithProgress({
                        inputPath: rawFile,
                        outputPath: postprocessOutputPath,
                        codecArgs: reencodeCodecArgs,
                        totalDurationSeconds: duration,
                        onProgress: onFfmpegProgress,
                    });
                }
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
