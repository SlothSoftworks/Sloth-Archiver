import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path'
import { spawn } from 'child_process';
import fs from "fs";
import crypto from 'crypto';
import http from 'node:http';
import os from 'node:os';

import { getSupportedVideoFilters, allVideoFilter } from './utils/constants.mjs';
import { getCurrentYtdlpVersion, isNewerVersion, performYtdlpUpdate } from './updater.mjs';
import { resolveLatestRelease, YTDLP_VERIFICATION_ERROR_CODE } from './ytdlpRelease.mjs';
import { writeLibraryEntry, overrideLibraryEntry, addLibraryVersion, refreshLibraryEntryMetadata, getLibraryIndex, refreshLibraryIndex, findVideoInIndex, recordLibraryDownload, swapLibraryDownload, deleteLibraryEntry, deleteLocalFiles, moveLibraryEntry, writePlaylistSnapshot, enrichPlaylistEntry, listPlaylistSnapshots, getPlaylistSnapshot, reconcilePlaylistSnapshot, undoPlaylistRefresh, deletePlaylistSnapshot, sanitizeForFilesystem, resolveInsideLibrary, libraryTagDir, DEFAULT_LIBRARY_DIR_NAME, listLibraryTags, createLibraryTag, listVideoTags, setVideoTag, addTagToVideos, removeVideosFromTags, transferVideoTags, checkAndRepairEpochFiles, PLAYLISTS_DIR_NAME, CLIPS_DIR_NAME, buildClipFilePath, recordClip, listClips, deleteClip, updateClipFile } from './library.mjs';
import { createSettingsStore, clampMaxSimultaneousDownloads, clampThumbnailSize, THUMBNAIL_SIZE_DEFAULT, clampLibrarySortField, clampLibrarySortDirection, clampThemeName } from './settings.mjs';
import { makeCookiesArgs, looksLikeNetscapeFormat, convertHeaderCookiesToNetscape, validateNetscapeLines, SUPPORTED_COOKIE_BROWSERS, reapStaleCookieCopies } from './cookies.mjs';
import { downloadImageToFile, createThumbnailFetchers } from './thumbnails.mjs';
import { createFfmpegRunner } from './ffmpegUtils.mjs';
import { ensurePlayablePreview } from './previewCache.mjs';
import { buildResolutions, reshapeVideoInfo, isDeadVideoInfo, createVideoInfoCache, fetchVideoInfo } from './videoInfo.mjs';
import { ERROR_KINDS, classifyDownloadError, isAutoRetryable, getBackoffMs, MAX_AUTO_RETRIES, recheckDiskSpaceIfAmbiguous } from './downloadErrors.mjs';

// Re-exported so main.test.mjs (and anything else importing these from
// './main.mjs') keeps working -- these are defined in cookies.mjs/videoInfo.mjs.
export { looksLikeNetscapeFormat, convertHeaderCookiesToNetscape, validateNetscapeLines, buildResolutions, reshapeVideoInfo, isDeadVideoInfo, makeCookiesArgs, reapStaleCookieCopies };

const logFile = path.join(app.getPath("userData"), "main.log");
function log(...args) {
    const msg = `${new Date().toISOString()} ${args.map(String).join(" ")}`;
    fs.appendFileSync(logFile, msg + "\n");
    console.log(msg);
}

// Catches crashes that would otherwise only ever show up in a terminal the
// packaged app doesn't have -- writes to the same main.log a user can open
// from the Options tab (see errorLog:* handlers below) instead of silently
// dying or spamming an invisible console.
process.on('uncaughtException', (err) => {
    log('[uncaughtException]', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (reason) => {
    log('[unhandledRejection]', reason && reason.stack ? reason.stack : String(reason));
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
// where yt-dlp's own postprocessing can never report real progress.
const ffmpegBinaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeBinaryName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
const ffmpegBinaryPath = path.join(ffmpegDir, ffmpegBinaryName);
const ffprobeBinaryPath = path.join(ffmpegDir, ffprobeBinaryName);

// Bundled the same way as ffmpeg/ffprobe above (read directly from
// extraResources, no userData relocation -- there's no Deno self-updater
// the way yt-dlp has one, so nothing ever needs to overwrite this at
// runtime). See jsRuntimeArgs below for why this is bundled at all.
const denoDir = isDev ? path.resolve(__dirname, '../deno') : path.join(process.resourcesPath, 'deno');
const denoBinaryName = process.platform === 'win32' ? 'deno.exe' : 'deno';
const denoBinaryPath = path.join(denoDir, denoBinaryName);

// extraResources (Contents/Resources on mac, the resources dir on Windows)
// isn't reliably writable without elevation, so the updater could never swap
// a fresh binary in there. Relocate to userData (always per-user-writable)
// once on first run, and treat that copy as the source of truth from then
// on in both dev and packaged builds.
const bundledYtdlpBinDir = isDev ? path.resolve(__dirname, '../ytdlp-bin') : path.join(process.resourcesPath, 'ytdlp-bin');
const userDataYtdlpBinDir = path.join(app.getPath('userData'), 'ytdlp-bin');

function ensureYtdlpBinInUserData() {
    if (!fs.existsSync(userDataYtdlpBinDir)) {
        fs.cpSync(bundledYtdlpBinDir, userDataYtdlpBinDir, { recursive: true });
    }
}
// Skipped under Vitest (sets this env var in its own worker processes) --
// the one module-load-time side effect here that would otherwise crash on
// import in a test, since bundledYtdlpBinDir only exists in a built dist/
// tree.
if (!process.env.VITEST) {
    ensureYtdlpBinInUserData();
}

const ytdlpPath = path.join(userDataYtdlpBinDir, ytdlpBinaryName);
const cookiesPath = path.join(app.getPath('userData'), 'cookies.txt');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const videoInfoCachePath = path.join(app.getPath('userData'), 'videoInfoCache.json');
const VIDEO_INFO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// yt-dlp needs a real JS runtime to solve YouTube's nsig signature challenge;
// without one, every real video/audio format silently disappears once a
// request is authenticated, leaving only storyboard formats. Points yt-dlp's
// "deno" provider at the bundled Deno binary rather than running Electron
// itself as Node: Deno sandboxes by default (no fs/net/env/subprocess access
// unless explicitly granted, and yt-dlp's own deno.py adds zero --allow-*
// flags), closing a gap the Electron-as-node approach couldn't -- Node's own
// --permission model has no equivalent of network denial at all. Verified
// directly against a real nsig solve before switching (see
// 0tempFiles/deno-vs-electron-node-sandboxing-comparison.md).
export function jsRuntimeArgs() {
    return ['--js-runtimes', `deno:${denoBinaryPath}`];
}

// Curated, not a full process.env copy -- Deno's own sandbox already denies
// env access by default, but this still matters for --cookies-from-browser
// (cookies.mjs), which needs HOME/USERPROFILE/APPDATA/LOCALAPPDATA to locate
// a browser's profile directory regardless of which JS runtime is in use.
const YTDLP_ENV_ALLOWLIST = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'TEMP', 'TMP', 'TMPDIR'];

export function ytdlpSpawnEnv() {
    const env = {};
    for (const key of YTDLP_ENV_ALLOWLIST) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
}

// Defense-in-depth for every IPC handler that hands a caller-supplied URL to
// yt-dlp. The renderer already validates (DownloaderScreen.tsx/BulkAddDialog
// via utils.ts's isValidUrl), but that's a UI nicety, not an IPC boundary --
// anything that reaches these handlers directly bypasses it. Rejecting
// non-http(s) here means a value like "--exec=..." or "file:///etc/passwd"
// never reaches yt-dlp's argv in the first place, on top of (not instead of)
// the '--' separator inserted before every URL argument below.
export function assertValidHttpUrl(url, label = 'URL') {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid ${label}.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Invalid ${label}: only http:// and https:// links are supported.`);
    }
    return parsed;
}

const { readSettings, writeSettings } = createSettingsStore(settingsPath);
export const cookiesArgs = makeCookiesArgs(readSettings, cookiesPath);

// Whether a saved cookie (the pasted-cookie file, or a cookies-from-browser
// choice) is allowed to outlive the app instance that saved it. Off means
// both get wiped at the start and end of every run -- so an authenticated
// session accidentally left saved can never quietly persist into a later
// launch, per the actual risk this setting exists for (a user getting into
// trouble with a platform's ToS over a cookie they forgot was still active).
//
// No explicit setting yet (a genuinely first run, or an upgrade from before
// this existed) defaults to whichever behavior keeps existing users
// unaffected: true if a cookies.txt is already sitting on disk (they were
// already relying on it persisting), false otherwise -- a fresh install
// starts on the safer, session-only default rather than inheriting the old
// always-persist behavior.
export function getCookiesPersistAcrossSessions() {
    const { cookiesPersistAcrossSessions } = readSettings();
    if (typeof cookiesPersistAcrossSessions === 'boolean') return cookiesPersistAcrossSessions;
    return fs.existsSync(cookiesPath);
}

// Called at both startup and shutdown (see app.on('before-quit') below) --
// covers both "clean up whatever a previous session left behind" and "don't
// leave anything behind for the next one," since either point alone would
// miss the other half (a crash skips shutdown; an upgrade skips startup
// cleanup for a file already written this run).
function clearSessionOnlyCookiesIfNeeded() {
    if (getCookiesPersistAcrossSessions()) return;
    if (fs.existsSync(cookiesPath)) {
        fs.unlinkSync(cookiesPath);
    }
    const settings = readSettings();
    if (settings.cookiesMode || settings.cookiesBrowser) {
        settings.cookiesMode = 'file';
        settings.cookiesBrowser = '';
        writeSettings(settings);
    }
}

clearSessionOnlyCookiesIfNeeded();
app.on('before-quit', clearSessionOnlyCookiesIfNeeded);

// cookies.txt holds a live, authenticated Google/YouTube session -- fixed up
// on every startup (not just at write time, see cookies:save below) so an
// existing file from before this app started restricting permissions gets
// corrected on upgrade too.
if (fs.existsSync(cookiesPath)) {
    try {
        fs.chmodSync(cookiesPath, 0o600);
    } catch (err) {
        log('[cookies] failed to restrict cookies.txt permissions', String(err));
    }
}

// Per-run cookie-jar copies (see makeCookiesArgs, cookies.mjs) age out on
// their own rather than being cleaned up by whichever process created them
// -- swept once now (catching anything an earlier, uncleanly-terminated run
// left behind) and periodically thereafter. unref() so this timer never
// keeps the app alive on its own.
reapStaleCookieCopies();
setInterval(reapStaleCookieCopies, 10 * 60 * 1000).unref();
const { readVideoInfoCache, writeVideoInfoCache } = createVideoInfoCache(videoInfoCachePath);
const { ensureChannelIcon, ensureVideoThumbnail, ensurePlaylistThumbnail } = createThumbnailFetchers({
    ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, ytdlpSpawnEnv, onLog: log,
});
const ffmpegRunner = createFfmpegRunner({ ffmpegBinaryPath, ffprobeBinaryPath, onLog: log, isDev });
const { getMediaDurationSeconds, getFfmpegVersion, runFfmpegWithProgress, convertWithFallback, clipAndConvert } = ffmpegRunner;

// Registers app-video:// as a privileged scheme so the Library tab's player
// can point <video>/<audio> at a downloaded file without loading it into
// renderer memory (an IPC-read-to-blob bridge doesn't scale to large files
// or support real seeking). Must run at module-evaluation time, before the
// app is ready. `stream`+`supportFetchAPI` are required for the net.fetch
// delegation in handleAppVideoRequest below; this app has no CSP today so
// `bypassCSP` is currently a no-op -- revisit if one is ever added.
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

// A last line of defense in case attacker-controlled markup or script ever
// reaches the renderer (e.g. through a bug in how remote video metadata gets
// displayed) -- most of these directives just describe what the app already
// only ever does:
//   - script-src 'self': the bundled JS is the only script source; nothing
//     inline, nothing eval'd, nothing from a CDN.
//   - style-src needs 'unsafe-inline' because MUI/Emotion inject <style>
//     tags at runtime for every component's CSS-in-JS -- there's no nonce
//     wired up for that, and CSS injection (unlike script injection) can't
//     itself run code, so this is a deliberately accepted trade-off rather
//     than an oversight.
//   - img-src allows any https host (plus the local app-video:// scheme)
//     because thumbnails come from whichever platform a video was fetched
//     from (YouTube, SoundCloud, TikTok, Instagram, ...), not one fixed CDN.
//   - media-src is scoped to this origin and app-video:// -- video playback
//     never loads from a remote URL directly.
//   - frame-src only allows the one iframe embed this app ever creates.
//   - connect-src 'self' because the renderer never calls fetch/XHR itself;
//     every network request goes through the main process over IPC.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: app-video:",
    "media-src 'self' app-video:",
    "font-src 'self'",
    "frame-src https://www.youtube-nocookie.com",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

// Serves the renderer bundle over a real loopback HTTP origin, replacing
// mainWindow.loadFile()'s file:// origin. A custom app:// protocol
// (standard/secure: true) does NOT work here: Chromium's Referer-generation
// gate checks the document's scheme against a hardcoded http(s) allowlist,
// separate from the privileged-scheme flags, so custom schemes never
// produce a Referer. A missing Referer is what breaks the YouTube iframe
// embed elsewhere in the app; only a genuine http:// origin clears that
// gate. 127.0.0.1-only (not 0.0.0.0) and port 0 (an OS-picked ephemeral
// port) keep this unreachable from the network.
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
                // Sent on every response, not just the HTML document -- a
                // browser only ever enforces it for the document response,
                // so it's a harmless no-op on the JS/CSS asset responses.
                res.writeHead(200, { 'Content-Type': mimeTypeForPath(resolvedPath), 'Content-Security-Policy': CONTENT_SECURITY_POLICY });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// Handles app-video://local/<encodeURIComponent(absolutePath)> requests.
// Guard-railed against the configured libraryDir via resolveInsideLibrary
// (library.mjs), the same check every destructive library operation uses --
// defense in depth, since the renderer only ever constructs these URLs from
// data it already has.
//
// Uses net.fetch() against a file:// URL as the byte-stream source, but does
// NOT trust net.fetch's own status/headers for the response handed back.
// Chromium treats a protocol.handle response as a
// genuine network response, not the trusted path a real file:// navigation
// gets -- it needs Accept-Ranges/Content-Range/206 spelled out explicitly on
// every response, including the first un-ranged one, or
// video.seekable.end() stays 0 and the scrub bar silently does nothing. So
// the Range math is done here ourselves; net.fetch is only ever asked for
// the exact byte range already decided.
// NO_STORE_HEADERS goes on every single response this handler returns,
// success or failure. Chromium treats a protocol.handle response as a
// genuine, cacheable network response (see the file-level comment on why
// this handler already can't rely on real file:// navigation's own
// behavior) -- without an explicit no-store, a request that 404s once (e.g.
// a library entry's stored path going stale, see checkAndRepairEpochFiles/
// library.mjs) can get served straight back out of cache on every later
// request for that exact same URL, even after the file genuinely reappears
// on disk and this handler itself would now answer differently. Bumping the
// player's own cacheBustKey works around this for an already-mounted
// player (a new URL was never cached), but a *fresh* one (e.g. after
// navigating away and back to the same video) resets that counter back to
// its initial value and requests the identical URL that failed before --
// with no-store, the handler is guaranteed to be asked fresh every time
// either way, rather than depending on the query string alone.
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

async function handleAppVideoRequest(request) {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.slice(1));

    const { libraryDir } = readSettings();
    const resolvedFilePath = resolveInsideLibrary(libraryDir, filePath);
    if (!resolvedFilePath) {
        return new Response('Forbidden', { status: 403, headers: NO_STORE_HEADERS });
    }

    let stat;
    try {
        stat = fs.statSync(resolvedFilePath);
    } catch {
        return new Response('Not Found', { status: 404, headers: NO_STORE_HEADERS });
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
                headers: { 'Content-Range': `bytes */${fileSize}`, ...NO_STORE_HEADERS },
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
                headers: { 'Content-Range': `bytes */${fileSize}`, ...NO_STORE_HEADERS },
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
            ...NO_STORE_HEADERS,
        };
        if (status === 206) {
            headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
        }

        return new Response(innerResponse.body, { status, headers });
    } catch (err) {
        log('[app-video] fetch error', String(err));
        return new Response('Internal Error', { status: 500, headers: NO_STORE_HEADERS });
    }
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
    // A different library root may not even have the previously-active
    // tag's folder -- reset to the one tag every library can always resolve.
    settings.activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME;
    writeSettings(settings);
    // Switching to a different library folder mid-session should reflect
    // immediately, not show whatever the previous folder's scan found.
    refreshLibraryIndex(dir, DEFAULT_LIBRARY_DIR_NAME);
    return { success: true, libraryDir: dir };
});

// SubLibrary switching -- listTags enumerates real tag folders (library.json
// present) directly under libraryDir; getActiveLibraryTag/setActiveLibraryTag
// track which one the Library tab is currently scanning/writing into. Same
// "no fallback default, deliberate choice" stance as libraryDir itself isn't
// needed here since DEFAULT_LIBRARY_DIR_NAME is always a safe, always-valid
// default -- unlike libraryDir, there's no "unset" state worth representing.
ipcMain.handle('library:listTags', async () => {
    const { libraryDir } = readSettings();
    if (!libraryDir) return { tags: [] };
    return { tags: listLibraryTags(libraryDir) };
});

ipcMain.handle('library:createTag', async (e, name) => {
    const { libraryDir } = readSettings();
    try {
        const tag = createLibraryTag(libraryDir, name);
        // "Auto-switch to it when done" -- the whole point of creating one.
        const settings = readSettings();
        settings.activeLibraryTag = tag.folderName;
        writeSettings(settings);
        await refreshLibraryIndex(libraryDir, tag.folderName);
        return { success: true, tag };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Video tags -- an unrelated, per-video concept from the sublibrary
// switching above (hence "videoTag(s)" naming throughout, never bare
// "tag"). All three scope to whichever sublibrary is currently active.
ipcMain.handle('library:listVideoTags', async () => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    if (!libraryDir) return { tags: {} };
    return { tags: listVideoTags(libraryDir, activeLibraryTag) };
});

ipcMain.handle('library:setVideoTag', async (e, { tagName, videoId, applied }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const { tags } = setVideoTag({ libraryDir, libraryTag: activeLibraryTag, tagName, videoId, applied });
    return { success: true, tags };
});

ipcMain.handle('library:tagVideos', async (e, { videoIds, tagName }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const { tags } = addTagToVideos({ libraryDir, libraryTag: activeLibraryTag, tagName, videoIds });
    return { success: true, tags };
});

ipcMain.handle('settings:getActiveLibraryTag', async () => {
    const { libraryDir, activeLibraryTag } = readSettings();
    const resolvedTag = activeLibraryTag || DEFAULT_LIBRARY_DIR_NAME;
    // Resolved server-side (not string-concatenated in the renderer) so
    // "Open library folder" gets a real, OS-correct path -- libraryDir may
    // be empty (no library configured yet), in which case there's nothing
    // meaningful to resolve.
    return {
        activeLibraryTag: resolvedTag,
        activeLibraryTagDir: libraryDir ? libraryTagDir(libraryDir, resolvedTag) : '',
    };
});

ipcMain.handle('settings:setActiveLibraryTag', async (e, tag) => {
    const settings = readSettings();
    settings.activeLibraryTag = tag || DEFAULT_LIBRARY_DIR_NAME;
    writeSettings(settings);
    // Same "reflect immediately" reasoning as settings:setLibraryDir above.
    await refreshLibraryIndex(settings.libraryDir, settings.activeLibraryTag);
    return { success: true, activeLibraryTag: settings.activeLibraryTag };
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

ipcMain.handle('settings:getLibrarySort', async () => {
    const { librarySortField, librarySortDirection } = readSettings();
    return {
        sortField: clampLibrarySortField(librarySortField),
        sortDirection: clampLibrarySortDirection(librarySortDirection),
    };
});

ipcMain.handle('settings:setLibrarySort', async (e, { sortField, sortDirection } = {}) => {
    const settings = readSettings();
    settings.librarySortField = clampLibrarySortField(sortField);
    settings.librarySortDirection = clampLibrarySortDirection(sortDirection);
    writeSettings(settings);
    return { success: true, sortField: settings.librarySortField, sortDirection: settings.librarySortDirection };
});

ipcMain.handle('settings:getThemeMode', async () => {
    const { themeMode } = readSettings();
    // Dark is the default for a fresh install (paired with SlothUI as the
    // default theme name, see THEME_NAME_DEFAULT) -- only an explicit
    // 'light' choice overrides it, so this checks for 'light' rather than
    // defaulting to it.
    return { themeMode: themeMode === 'light' ? 'light' : 'dark' };
});

ipcMain.handle('settings:setThemeMode', async (e, mode) => {
    const settings = readSettings();
    settings.themeMode = mode === 'dark' ? 'dark' : 'light';
    writeSettings(settings);
    return { success: true, themeMode: settings.themeMode };
});

ipcMain.handle('settings:getThemeName', async () => {
    const { themeName } = readSettings();
    return { themeName: clampThemeName(themeName) };
});

ipcMain.handle('settings:setThemeName', async (e, name) => {
    const settings = readSettings();
    settings.themeName = clampThemeName(name);
    writeSettings(settings);
    return { success: true, themeName: settings.themeName };
});

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

ipcMain.handle('settings:getThumbnailSize', async () => {
    const { thumbnailSize } = readSettings();
    return { thumbnailSize: clampThumbnailSize(thumbnailSize ?? THUMBNAIL_SIZE_DEFAULT) };
});

ipcMain.handle('settings:setThumbnailSize', async (e, value) => {
    const settings = readSettings();
    settings.thumbnailSize = clampThumbnailSize(value);
    writeSettings(settings);
    return { success: true, thumbnailSize: settings.thumbnailSize };
});

// User-added muxers for the Library view's "convert to" ffmpeg utility,
// beyond the small hardcoded popular set (LibraryVideoDetail.tsx) -- a plain
// string list, not validated against ffmpeg's own muxer list.
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
    const { libraryDir, activeLibraryTag: libraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    return getLibraryIndex(libraryDir, libraryTag);
});

ipcMain.handle('library:refreshIndex', async () => {
    const { libraryDir, activeLibraryTag: libraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    return refreshLibraryIndex(libraryDir, libraryTag);
});

// User-triggered from the Library tab's channel view -- unlike the
// fire-and-forget calls below, this one is awaited so the button can show a
// loading state and the caller gets back a fresh index once it's done.
ipcMain.handle('library:refreshChannelIcon', async (e, { channelFolderName, channelId }) => {
    const { libraryDir, activeLibraryTag: libraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const channelDir = path.join(libraryTagDir(libraryDir, libraryTag), channelFolderName);
    await ensureChannelIcon(channelDir, channelId, { force: true });
    return refreshLibraryIndex(libraryDir, libraryTag);
});

// The channel-icon/video-thumbnail fetches below are fire-and-forget, so
// "add to library" reports success immediately -- but that only means the
// *next* index refresh picks them up. This notifies any open window once
// both fetches (and the index refresh after them) finish, so an
// already-mounted Library tab picks up the change on its own -- see
// LibraryScreen.tsx's onLibraryBackgroundUpdate listener.
function notifyLibraryBackgroundUpdate() {
    BrowserWindow.getAllWindows()[0]?.webContents.send('library:backgroundUpdate');
}

// targetTag lets the renderer's "add to library" picker (only shown once
// more than one sublibrary exists) send a video somewhere other than
// whatever's currently active, without switching the active tag itself --
// bulk-add (useBulkAddQueue.tsx) reuses this same channel per item, sending
// the one tag chosen for the whole batch. Omitted (single-tag libraries,
// or "just use what's active"), it falls back to the active tag.
ipcMain.handle('library:addEntry', async (e, videoMetaData, targetTag) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const libraryTag = targetTag || activeLibraryTag;
    const result = writeLibraryEntry({ libraryDir, libraryTag, videoMetaData });
    await refreshLibraryIndex(libraryDir, libraryTag);
    Promise.all([
        ensureChannelIcon(result.channelDir, videoMetaData.channelId),
        ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir, libraryTag)).then(notifyLibraryBackgroundUpdate);
    // epoch included alongside videoDir -- bulk-add (useBulkAddQueue.tsx) needs
    // it immediately to kick off a download for the entry it just created,
    // without a second round-trip to look it back up.
    return { success: true, videoDir: result.videoDir, epoch: String(result.metadata.addedEpoch) };
});

// targetTag: the replacement write must land back in the same sublibrary
// the entry being overridden actually came from -- same "explicit tag,
// defaulting to active" pattern as library:addEntry's targetTag.
ipcMain.handle('library:overrideEntry', async (e, { videoMetaData, existingVideoDir }, targetTag) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const libraryTag = targetTag || activeLibraryTag;
    const result = overrideLibraryEntry({ libraryDir, libraryTag, videoMetaData, existingVideoDir });
    await refreshLibraryIndex(libraryDir, libraryTag);
    Promise.all([
        ensureChannelIcon(result.channelDir, videoMetaData.channelId),
        ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir, libraryTag)).then(notifyLibraryBackgroundUpdate);
    return { success: true, videoDir: result.videoDir };
});

// Additive counterpart to overrideEntry -- adds a new epoch under an
// already-tracked video's existing videoDir instead of replacing it. Used by
// both "Add as new version" (Downloader tab's duplicate dialog) and
// "Download new version" (Library tab's video detail view).
ipcMain.handle('library:addVersion', async (e, { videoDir, videoMetaData }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const result = addLibraryVersion({ libraryDir, videoDir, videoMetaData });
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    Promise.all([
        ensureChannelIcon(path.dirname(result.videoDir), videoMetaData.channelId),
        ensureVideoThumbnail(result.videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir, activeLibraryTag)).then(notifyLibraryBackgroundUpdate);
    return { success: true, videoDir: result.videoDir, epoch: result.epoch, metadata: result.metadata };
});

// "Refresh from YouTube" on the version currently displayed -- the renderer
// already fetched fresh videoMetaData (getVideoInfoPython, same as every
// other refresh/add path) before calling this; this just writes it into the
// existing epoch in place, see refreshLibraryEntryMetadata's own comment.
ipcMain.handle('library:refreshEntry', async (e, { videoDir, epoch, videoMetaData }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const metadata = refreshLibraryEntryMetadata({ libraryDir, videoDir, epoch, videoMetaData });
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    Promise.all([
        ensureChannelIcon(path.dirname(videoDir), videoMetaData.channelId),
        ensureVideoThumbnail(videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir, activeLibraryTag)).then(notifyLibraryBackgroundUpdate);
    return { success: true, metadata };
});

// On-demand only -- called when the video detail view (LibraryVideoDetail.tsx)
// opens a given epoch, never as part of a bulk scan (see
// checkAndRepairEpochFiles's own comment, library.mjs, for why). No
// libraryTag involved: videoDir is already a full, known absolute path
// (same as recordDownload/deleteEntry/etc.), tag-agnostic like those.
ipcMain.handle('library:checkAndRepairEpochFiles', async (e, { videoDir, epoch }) => {
    const { libraryDir } = readSettings();
    try {
        const result = checkAndRepairEpochFiles({ libraryDir, videoDir, epoch });
        if (result.videoRepaired || result.audioRepaired) {
            const { activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
            refreshLibraryIndex(libraryDir, activeLibraryTag).then(notifyLibraryBackgroundUpdate);
        }
        return { success: true, ...result };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Flat-playlist entries carry more than just id/title/url for free: each
// entry already has its own `thumbnails[]` array and, when YouTube resolves
// it during the flat listing, a `timestamp`. Falls back to the predictable
// i.ytimg.com CDN URL pattern when the array is empty.
export function pickBestThumbnail(id, thumbnails) {
    if (Array.isArray(thumbnails) && thumbnails.length > 0) {
        const best = thumbnails.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
        if (best.url) return best.url;
    }
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

// Bulk-add's playlist path -- same --flat-playlist mechanism as
// fetchChannelAvatarUrl above, just without --playlist-end 1, so this lists
// every entry in source order. Not the YouTube Data API: playlistItems.list
// requires an API key/OAuth token with no keyless variant, and the public
// no-auth playlist RSS feed caps out at 15 videos -- neither fits "every
// video, in order." yt-dlp needs no new credential and already does this
// reliably elsewhere in this file.
function fetchPlaylistEntries(playlistUrl) {
    return new Promise((resolve, reject) => {
        const script = spawn(ytdlpPath, [
            '-J', '--no-warnings', '--flat-playlist',
            '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), ...jsRuntimeArgs(), '--', playlistUrl,
        ], { env: ytdlpSpawnEnv() });
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
                    // No `|| e.id` fallback -- that would silently turn "no
                    // title" into a title that's just the raw video ID. Leave
                    // it null and let isDeadTitle() (library.mjs) decide.
                    title: e.title || null,
                    url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
                    thumbnailUrl: pickBestThumbnail(e.id, e.thumbnails),
                    // YYYYMMDD, matching reshapeVideoInfo's uploadDate format
                    // elsewhere, so entries from this listing and entries
                    // enriched later are never in two different date formats.
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
        assertValidHttpUrl(playlistUrl, 'playlist URL');
        const playlist = await fetchPlaylistEntries(playlistUrl);
        // Snapshot saved every time a playlist is fetched (see
        // library.mjs's writePlaylistSnapshot). Always saved into whichever
        // sublibrary is currently active -- unlike adding a video, playlist
        // saves don't get their own target-tag picker.
        const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
        if (libraryDir) {
            const index = await getLibraryIndex(libraryDir, activeLibraryTag);
            const result = writePlaylistSnapshot({
                libraryDir,
                libraryTag: activeLibraryTag,
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
            // Fire-and-forget, same as the video/channel thumbnail caches.
            ensurePlaylistThumbnail(result.playlistDir, playlist.entries[0]?.thumbnailUrl);
        }
        return { success: true, entries: playlist.entries, playlistId: playlist.id };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Called once per bulk-add item belonging to a previously-saved playlist
// snapshot, right after that item's own info is fetched (see
// useBulkAddQueue.tsx's processItem) -- patches that entry with the real
// title/date/thumbnail so a future re-fetch, even after the video goes dead
// on YouTube, doesn't lose it (see enrichPlaylistEntry's never-regress guard).
ipcMain.handle('library:enrichPlaylistEntry', async (e, { playlistId, videoId, title, uploadDate, thumbnailUrl }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    if (!libraryDir || !playlistId) {
        return { success: false };
    }
    try {
        enrichPlaylistEntry({ libraryDir, libraryTag: activeLibraryTag, playlistId, videoId, title, uploadDate, thumbnailUrl });
        return { success: true };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Backs the Library tab's Playlists section -- list/detail read straight off
// whatever's already saved, no network call.
ipcMain.handle('library:listPlaylists', async () => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    if (!libraryDir) return { playlists: [] };
    return { playlists: listPlaylistSnapshots({ libraryDir, libraryTag: activeLibraryTag }) };
});

ipcMain.handle('library:getPlaylist', async (e, playlistId) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    if (!libraryDir) return { playlist: null };
    return { playlist: await getPlaylistSnapshot({ libraryDir, libraryTag: activeLibraryTag, playlistId }) };
});

// The explicit "Refresh" action -- re-fetches the playlist from yt-dlp using
// its saved originalUrl, then reconciles (see reconcilePlaylistSnapshot,
// library.mjs, for the merge rules). Deliberately separate from
// library:fetchPlaylistEntries above (still a no-op past the first save) --
// refresh only ever happens through this explicit action.
ipcMain.handle('library:refreshPlaylist', async (e, playlistId) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    if (!libraryDir) {
        return { success: false, message: 'No library folder configured.' };
    }
    try {
        const index = await getLibraryIndex(libraryDir, activeLibraryTag);
        const saved = await getPlaylistSnapshot({ libraryDir, libraryTag: activeLibraryTag, playlistId, index });
        if (!saved || !saved.originalUrl) {
            return { success: false, message: 'This playlist has no saved snapshot to refresh.' };
        }
        const fresh = await fetchPlaylistEntries(saved.originalUrl);
        const result = reconcilePlaylistSnapshot({
            libraryDir,
            libraryTag: activeLibraryTag,
            playlistId,
            freshEntries: fresh.entries.map((entry) => ({
                videoId: entry.id,
                title: entry.title,
                url: entry.url,
                thumbnailUrl: entry.thumbnailUrl,
                uploadDate: entry.uploadDate,
            })),
            freshTitle: fresh.title,
            freshUploader: fresh.uploader,
            index,
        });
        const playlistDir = path.join(libraryTagDir(libraryDir, activeLibraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
        ensurePlaylistThumbnail(playlistDir, result.entries[0]?.thumbnailUrl);
        return result;
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

ipcMain.handle('library:undoPlaylistRefresh', async (e, playlistId) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    if (!libraryDir) {
        return { success: false, message: 'No library folder configured.' };
    }
    try {
        return undoPlaylistRefresh({ libraryDir, libraryTag: activeLibraryTag, playlistId });
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Deletes only the playlist's own saved snapshot -- never the videos it
// references, which is why there's no equivalent of deleteLibraryEntry's
// videoDeleted flag here for the UI to react to.
ipcMain.handle('library:deletePlaylist', async (e, playlistId) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    if (!libraryDir) {
        return { success: false, message: 'No library folder configured.' };
    }
    try {
        return deletePlaylistSnapshot({ libraryDir, libraryTag: activeLibraryTag, playlistId });
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Checked by the renderer before calling addEntry, so a duplicate can be
// caught with a warning dialog instead of silently piling up a redundant
// epoch folder for a video that's already tracked.
// libraryTag: scoped to whichever sublibrary the caller actually cares
// about (e.g. the target of an in-progress add), defaulting to active when
// omitted -- a dedup check against the wrong sublibrary would either miss a
// real duplicate or flag a false one.
ipcMain.handle('library:findVideo', async (e, videoId, libraryTag) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const index = await getLibraryIndex(libraryDir, libraryTag || activeLibraryTag);
    const match = findVideoInIndex(index, videoId);
    if (!match) {
        return { found: false };
    }
    return { found: true, channelDisplayName: match.channel.displayName, videoDir: match.video.videoDir };
});

ipcMain.handle('library:recordDownload', async (e, { videoDir, epoch, filePath, resolution, format, kind }) => {
    recordLibraryDownload({ videoDir, epoch, filePath, resolution, format, kind });
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    return { success: true };
});

ipcMain.handle('library:swapDownload', async (e, { videoDir, epoch, tempFilePath, oldFilePath, resolution, format, kind }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const metadata = swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath, resolution, format, kind });
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    return metadata;
});

ipcMain.handle('library:deleteEntry', async (e, { videoDir, epoch }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const { videoDeleted } = deleteLibraryEntry({ libraryDir, videoDir, epoch });
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    return { success: true, videoDeleted };
});

// Batched counterpart to library:deleteEntry -- deletes N whole videos (no
// per-entry epoch targeting) and refreshes the library index once at the
// end instead of once per item. Used by the Library tab's bulk-select
// "Delete selected" action.
ipcMain.handle('library:deleteEntries', async (e, { videoDirs }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const results = videoDirs.map((videoDir) => {
        try {
            const { videoId } = deleteLibraryEntry({ libraryDir, videoDir });
            return { videoDir, success: true, videoId };
        } catch (err) {
            return { videoDir, success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    // One batched read-modify-write of the sublibrary's tag map instead of
    // touching it per video -- see removeVideosFromTags (library.mjs).
    removeVideosFromTags(libraryDir, activeLibraryTag, results.filter((r) => r.success && r.videoId).map((r) => r.videoId));
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    return { success: results.every((r) => r.success), results };
});

// Batched "Move selected" -- moves N whole videos into a different
// sublibrary tag (see moveLibraryEntry, library.mjs) and refreshes the
// *active* tag's index once at the end, same shape as deleteEntries/
// deleteLocalFiles above: the moved videos vanish from whatever's currently
// being viewed (the source), and the target tag's own index will scan fresh
// the next time someone actually switches to it (getLibraryIndex's cache is
// keyed per-tag, so there's nothing stale to bust there).
ipcMain.handle('library:moveEntries', async (e, { videoDirs, targetTag }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const results = videoDirs.map((videoDir) => {
        try {
            const { videoId } = moveLibraryEntry({ libraryDir, videoDir, targetTag });
            return { videoDir, success: true, videoId };
        } catch (err) {
            return { videoDir, success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    // One batched transfer of the moved videos' tag membership from the
    // source sublibrary's manifest to the target's, instead of touching
    // either file per video -- see transferVideoTags (library.mjs).
    transferVideoTags(libraryDir, activeLibraryTag, targetTag, results.filter((r) => r.success && r.videoId).map((r) => r.videoId));
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    return { success: results.every((r) => r.success), results };
});

// Batched "Delete local files" -- removes downloaded media across every
// epoch of each video without touching the tracked library entries
// themselves (see deleteLocalFiles, library.mjs). Same result shape as
// library:deleteEntries for the same reason: the renderer needs to know
// exactly which ones failed to report back accurately.
ipcMain.handle('library:deleteLocalFiles', async (e, { videoDirs }) => {
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    const results = videoDirs.map((videoDir) => {
        try {
            deleteLocalFiles({ libraryDir, videoDir });
            return { videoDir, success: true };
        } catch (err) {
            return { videoDir, success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    await refreshLibraryIndex(libraryDir, activeLibraryTag);
    return { success: results.every((r) => r.success), results };
});

// Kick off the initial scan in the background at startup -- deliberately not
// awaited, since this could be scanning an arbitrarily large library.
// getLibraryIndex reuses this same in-flight scan when the Library tab asks.
{
    const { libraryDir, activeLibraryTag = DEFAULT_LIBRARY_DIR_NAME } = readSettings();
    getLibraryIndex(libraryDir, activeLibraryTag);
}

// A literal fs.existsSync(filePath) isn't enough: postprocessors (MP3
// extraction, format recode) append their target extension rather than
// writing to the exact chosen path (see findFinalFile() below) -- so a real
// prior download would fail an exact-match check. Match by prefix instead.
ipcMain.handle('system:pathExists', async (e, filePath) => {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    try {
        return fs.readdirSync(dir).some((f) => f.startsWith(base));
    } catch {
        return false;
    }
});

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

    // mode: 0o600 -- this holds a live, authenticated session; no reason
    // for it to be group/world-readable under a typical umask.
    fs.writeFileSync(cookiesPath, content, { encoding: 'utf-8', mode: 0o600 });
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
    // path/savedAtEpoch back the Options screen's "where is this and how
    // old is it" disclosure, alongside the existing loaded/count chip.
    const { mtimeMs } = fs.statSync(cookiesPath);
    return { loaded: true, cookieCount: valid, path: cookiesPath, savedAtEpoch: mtimeMs };
});

ipcMain.handle('cookies:getConfig', async () => {
    const { cookiesMode, cookiesBrowser } = readSettings();
    return {
        cookiesMode: cookiesMode === 'browser' ? 'browser' : 'file',
        cookiesBrowser: cookiesBrowser || '',
        supportedBrowsers: SUPPORTED_COOKIE_BROWSERS,
        cookiesPersistAcrossSessions: getCookiesPersistAcrossSessions(),
    };
});

ipcMain.handle('cookies:setPersistAcrossSessions', async (e, persist) => {
    const settings = readSettings();
    settings.cookiesPersistAcrossSessions = !!persist;
    writeSettings(settings);
    return { success: true, cookiesPersistAcrossSessions: settings.cookiesPersistAcrossSessions };
});

ipcMain.handle('cookies:setConfig', async (e, { cookiesMode, cookiesBrowser }) => {
    // An empty cookiesBrowser is allowed through even in 'browser' mode --
    // it's the explicit "Clear" state, which cookiesArgs() already treats as
    // a no-op fallback. Only a real, unsupported value is rejected.
    if (cookiesMode === 'browser' && cookiesBrowser && !SUPPORTED_COOKIE_BROWSERS.includes(cookiesBrowser)) {
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
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            // Safe to enable: the preload script only touches contextBridge
            // and ipcRenderer, both of which work fine sandboxed.
            sandbox: true,
        },
    });

    // Every link the app itself renders (a video's original URL, the repo
    // link, a linkified description) is meant to open in the user's real
    // browser, not as a new Electron window -- a new Electron window would
    // otherwise inherit this one's preload script and IPC access. http(s)
    // links are handed off to the OS's default browser; everything else
    // (including a window.open() with no real destination) is just refused.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const { protocol: urlProtocol } = new URL(url);
            if (urlProtocol === 'http:' || urlProtocol === 'https:') {
                shell.openExternal(url);
            }
        } catch {
            // Not a parseable URL -- nothing to open.
        }
        return { action: 'deny' };
    });

    // This app is a single-page app that never navigates away from its own
    // loaded document (in-app routing changes only the URL hash, which isn't
    // a navigation as far as Electron is concerned). Any other top-level
    // navigation attempt -- e.g. a compromised page trying to replace the
    // whole window with attacker-controlled content -- is refused outright.
    const rendererOrigin = `http://127.0.0.1:${port}`;
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(`${rendererOrigin}/`) && url !== rendererOrigin) {
            event.preventDefault();
        }
    });

    mainWindow.loadURL(`${rendererOrigin}/index.html`);
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
    const result = await dialog.showSaveDialog({
        title: 'Save Video',
        buttonLabel: 'Save',
        defaultPath: path.join(baseDir, defaultName),
        filters: getSupportedVideoFilters(),
        ...options
    });
    if (!result.canceled && result.filePath) rememberAppPath(result.filePath);
    return result;
})

ipcMain.handle('getVideoInfoPython', async (event, url) => {
    assertValidHttpUrl(url, 'video URL');
    return fetchVideoInfo(url, {
        ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, ytdlpSpawnEnv, readVideoInfoCache, writeVideoInfoCache, cacheTtlMs: VIDEO_INFO_CACHE_TTL_MS, onLog: log,
    });
});

export function needsDirectFfmpegPass({ format, resolution }) {
    if (resolution && resolution.toLowerCase() === 'mp3') return true;
    return !!format && !['undefined', 'dflt'].includes(format);
}

// The extension actually produced by the direct ffmpeg pass above -- MP3
// wins over an explicit format choice since resolution:'mp3' means audio-only
// regardless of the format dropdown. Returns null when no postprocessing
// happens (yt-dlp's own download/merge picks its own extension untouched).
export function ffmpegTargetExtension({ format, resolution }) {
    if (resolution && resolution.toLowerCase() === 'mp3') return 'mp3';
    if (format && !['undefined', 'dflt'].includes(format)) return format.toLowerCase();
    return null;
}

// yt-dlp auto-appends the right extension to an extension-less outtmpl, but
// our own ffmpeg postprocess pass (runFfmpegWithProgress) needs a real
// extension to pick a muxer. outputPath can arrive two ways, both wrong for
// ffmpeg: the Library view's deterministic path has no extension at all, and
// the Downloader tab's Save-dialog path always carries a video extension
// (no MP3 filter option), so an MP3 selection would mux audio into a file
// merely named .mp4. Stripping whatever extension is there and appending the
// real target one fixes both.
export function withTargetExtension(outputPath, ext) {
    const { dir, name } = path.parse(outputPath);
    return path.join(dir, `${name}.${ext}`);
}

// yt-dlp itself only downloads (and merges video+audio streams, when both
// are selected) -- MP3 extraction and format recode are handled by our own
// direct ffmpeg pass afterward (see runFfmpegWithProgress), since yt-dlp's
// own postprocessing can never report real progress for those.
// outputPath is either the user's final chosen path or a raw intermediate
// temp path -- the caller decides which, this function downloads to
// whatever it's given.
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
        ...jsRuntimeArgs(),
        '-o', outputPath || '%(title)s.%(ext)s',
    ];

    if (resolution && resolution.toLowerCase() === 'mp3') {
        // Audio only -- no reason to download a video track when we extract
        // audio ourselves afterward.
        args.push('-f', 'bestaudio/best');
    } else {
        // 'best' (not a number) is the Downloader tab's simplified
        // multi-platform flow -- no resolution picker there, since a real
        // per-height quality ladder isn't consistently available outside
        // YouTube (SoundCloud is audio-only; TikTok/Instagram typically
        // expose one real quality). yt-dlp's generic "best, merge if needed"
        // selector is the right default with no meaningful height to
        // constrain against.
        args.push('-f', resolution === 'best' ? 'bestvideo*+bestaudio/best' : `bestvideo[height<=${resolution}]+bestaudio/best`);
        // Without this, yt-dlp's merge step picks MKV whenever the chosen
        // pair isn't natively MP4-safe (e.g. Opus audio) -- which Chromium's
        // <video> element can't play at all (see LibraryVideoPlayer.tsx's
        // PLAYABLE_VIDEO_EXTENSIONS). This only picks the stream-copy
        // container, it doesn't transcode, and modern ffmpeg's MP4 muxer
        // already supports every codec this selector can produce, so it's a
        // free fix. Only applies to this default path -- an explicit format
        // choice goes through the ffmpeg postprocess pass instead.
        args.push('--merge-output-format', 'mp4');
    }

    // "overwrite" forces a full re-download; anything else leaves yt-dlp's
    // own default in place, which already resumes a partial file via range
    // requests and skips one that's already complete.
    if (overwriteMode === 'overwrite') {
        args.push('--force-overwrites');
    }

    args.push('--', videoUrl);
    return args;
}

// yt-dlp postprocessors append their target extension to the requested
// outtmpl rather than swapping it (e.g. "video.mp4" + mp3 extraction ->
// "video.mp4.mp3"), not a documented contract worth hardcoding against --
// look at what actually landed on disk instead.
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
    } catch {
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

// Tracked so the updater can refuse to swap the live yt-dlp binary out from
// under a process that's actively using it.
let activeDownloadCount = 0;

// requestId -> in-flight yt-dlp ChildProcess. Populated for the lifetime of
// each attempt (including across auto-retries) so cancelDownload and the
// stall-timeout sweep below can both reach the right process without either
// one needing its own separate tracking. Keyed by requestId (not pid), since
// that's the only handle the renderer has.
const activeDownloadProcesses = new Map();

// requestIds a cancelDownload call has already killed -- the killed process's
// own 'close' event still fires afterward with a non-zero exit code, and
// without this set it would be misclassified as a normal (and possibly
// auto-retried) failure instead of a deliberate cancellation.
const cancelledDownloadRequestIds = new Set();

// requestId -> a canceller for a download that's currently *waiting* between
// auto-retry attempts (no ChildProcess exists yet during that wait, so
// activeDownloadProcesses alone can't be cancelled during it) -- without
// this, hitting Cancel while the UI reads "Retrying in 30s..." would
// silently do nothing until the next attempt actually started.
const pendingRetryCancellers = new Map();

// No progress line for this long during the actual *download* is treated as
// a stall and killed -- deliberately not a fixed total-duration cap, since
// this app's own differentiator is handling very long downloads (9+ hour
// videos per the README); only *silence* is suspicious, not overall length.
// Does NOT apply while a postprocessor (e.g. yt-dlp's own audio+video
// Merger) is running -- see inPostprocess in attemptDownload below for why.
const STALL_TIMEOUT_MS = 5 * 60 * 1000;
const STALL_CHECK_INTERVAL_MS = 30 * 1000;

// yt-dlp spawns ffmpeg as its own child process for merging/remuxing, so a
// plain child.kill() can orphan it. detached:true (POSIX only) puts the
// child in its own process group so
// -pid kills the whole group; Windows has no such group concept, so
// taskkill's /T (tree) flag does the equivalent there instead.
function killDownloadProcessTree(child) {
    if (!child || child.killed) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
}

ipcMain.handle('cancelDownload', (event, requestId) => {
    const pendingRetry = pendingRetryCancellers.get(requestId);
    if (pendingRetry) {
        pendingRetryCancellers.delete(requestId);
        pendingRetry();
        return { cancelled: true };
    }
    const child = activeDownloadProcesses.get(requestId);
    if (!child) return { cancelled: false };
    cancelledDownloadRequestIds.add(requestId);
    killDownloadProcessTree(child);
    return { cancelled: true };
});

ipcMain.handle('downloadVideoWithProgressUpdates', (event, options) => {
    // requestId is echoed onto every message on this shared/unscoped
    // broadcast channel -- generated renderer-side, so every consumer of
    // this handler can filter to just its own in-flight download.
    const send = (msg) => BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', { ...msg, requestId: options.requestId });

    try {
        assertValidHttpUrl(options.videoUrl, 'video URL');
    } catch (err) {
        // Reported over the same 'progressUpdate' channel every other
        // download failure uses, rather than a rejected promise -- the
        // renderer only ever listens for this handler's outcome there (see
        // useDownloadVideo.tsx), never on this call's own return value.
        send({ type: 'error', payload: { message: err.message, kind: ERROR_KINDS.UNKNOWN, retryable: false } });
        return;
    }

    activeDownloadCount++;

    // MP3 extraction and format recode need our own ffmpeg pass afterward,
    // so yt-dlp downloads to a raw intermediate file in a dedicated temp
    // dir -- deliberately outside the final directory so it
    // can never spuriously match findFinalFile's prefix-based lookups.
    const postprocess = needsDirectFfmpegPass(options);
    // Only used in place of options.outputPath inside the postprocess branch
    // below -- see withTargetExtension for why the caller's path can't be
    // trusted as-is for that step.
    const postprocessOutputPath = postprocess
        ? withTargetExtension(options.outputPath, ffmpegTargetExtension(options))
        : options.outputPath;
    let rawDir = null;
    let downloadArgs;
    if (postprocess) {
        // Derived from outputPath (not a random UUID) so retrying the same
        // download reuses the same raw dir -- otherwise every retry would
        // restart yt-dlp's download from scratch, losing the resume
        // behavior even when a partial raw file already existed.
        const rawDirId = crypto.createHash('sha1').update(options.outputPath).digest('hex').slice(0, 16);
        rawDir = path.join(app.getPath('temp'), 'sloth-archiver-raw', rawDirId);
        if (options.overwriteMode === 'overwrite') {
            fs.rmSync(rawDir, { recursive: true, force: true });
        }
        fs.mkdirSync(rawDir, { recursive: true });
        downloadArgs = buildDownloadArgs({ ...options, outputPath: path.join(rawDir, 'raw.%(ext)s') });
    } else {
        downloadArgs = buildDownloadArgs(options);
    }

    log(`[download] ${options.requestId} starting: url=${options.videoUrl} resolution=${options.resolution} format=${options.format} postprocess=${postprocess} outputPath=${options.outputPath}`);

    // Only actually decrements/untracks once -- called from whichever branch
    // (success, or a failure that's giving up rather than retrying) turns out
    // to be this download's true end.
    function finishDownload() {
        activeDownloadCount--;
        activeDownloadProcesses.delete(options.requestId);
    }

    // Classification is per-attempt (stderr/spawnError are attempt-local),
    // but the retry decision spans the whole logical download -- an
    // auto-retryable failure re-invokes attemptDownload instead of finishing.
    // A retry reuses the same downloadArgs/rawDir as the first attempt, so it
    // resumes from whatever yt-dlp already partially wrote rather than
    // restarting from zero.
    async function handleFailure({ kind, message }, attempt) {
        if (kind === ERROR_KINDS.CANCELLED) {
            log(`[download] ${options.requestId} attempt ${attempt} cancelled: ${message}`);
            finishDownload();
            if (rawDir) fs.rmSync(rawDir, { recursive: true, force: true });
            send({ type: 'error', payload: { message, kind, retryable: false } });
            return;
        }
        if (isAutoRetryable(kind) && attempt < MAX_AUTO_RETRIES) {
            const nextAttemptInMs = getBackoffMs(attempt);
            log(`[download] ${options.requestId} attempt ${attempt} failed (${kind}): ${message} -- retrying (attempt ${attempt + 1}) in ${nextAttemptInMs}ms`);
            send({ type: 'retrying', payload: { attempt: attempt + 1, kind, message, nextAttemptInMs } });
            const timer = setTimeout(() => {
                pendingRetryCancellers.delete(options.requestId);
                attemptDownload(attempt + 1);
            }, nextAttemptInMs);
            pendingRetryCancellers.set(options.requestId, () => {
                clearTimeout(timer);
                handleFailure({ kind: ERROR_KINDS.CANCELLED, message: 'Cancelled.' }, attempt);
            });
            return;
        }
        log(`[download] ${options.requestId} attempt ${attempt} failed (${kind}): ${message} -- giving up`);
        finishDownload();
        if (rawDir) fs.rmSync(rawDir, { recursive: true, force: true });
        send({ type: 'error', payload: { message, kind, retryable: false } });
    }

    function attemptDownload(attempt) {
        log(`[download] ${options.requestId} attempt ${attempt} spawning: ${ytdlpPath} ${downloadArgs.join(' ')}`);
        // detached only on POSIX -- see killDownloadProcessTree above.
        const script = spawn(ytdlpPath, downloadArgs, { detached: process.platform !== 'win32', env: ytdlpSpawnEnv() });
        activeDownloadProcesses.set(options.requestId, script);

        let error = '';
        let lastActivity = Date.now();
        // Guards against the stall sweep and the process's own
        // error/close events both trying to resolve this same attempt --
        // whichever happens first wins, the other is a no-op.
        let settled = false;
        const touch = () => { lastActivity = Date.now(); };
        // yt-dlp's postprocess progress-template (see POSTPROCESS| handling
        // in parseLine below) only ever reports 'started' and 'finished' --
        // there's no real progress heartbeat for the time in between, which
        // for something like an audio+video Merger on a very long recording
        // can legitimately run well past STALL_TIMEOUT_MS with zero output.
        // Confirmed to have actually caused a stuck-in-a-loop bug: the
        // watchdog was killing an in-progress (not hung, just silent) merge,
        // classifying it as a stall, and auto-retrying -- which restarts the
        // merge from scratch every time, forever. The stall watchdog exists
        // to catch a genuinely dead *network* transfer; it has no way to
        // distinguish that from "ffmpeg is still working," so it's suspended
        // entirely for the whole postprocessing phase rather than guessed at
        // with a longer fixed timeout.
        let inPostprocess = false;
        // dev-only throttle for the (very high-volume, once-per-second-ish)
        // download PROGRESS lines -- logging every one of those for a
        // multi-hour download would make main.log unreadable, so only the
        // low-volume status transitions (below) are always logged, and raw
        // in-progress percentages are sampled at most this often.
        let lastDevProgressLogAt = 0;
        const DEV_PROGRESS_LOG_INTERVAL_MS = 30 * 1000;

        const stallCheck = setInterval(() => {
            if (settled || inPostprocess || Date.now() - lastActivity < STALL_TIMEOUT_MS) return;
            settled = true;
            clearInterval(stallCheck);
            log(`[download] ${options.requestId} attempt ${attempt} STALLED -- no progress/output for ${Math.round((Date.now() - lastActivity) / 1000)}s, killing process tree`);
            killDownloadProcessTree(script);
            handleFailure({ kind: ERROR_KINDS.STALLED, message: 'No progress for several minutes -- the connection may have dropped.' }, attempt);
        }, STALL_CHECK_INTERVAL_MS);

        script.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearInterval(stallCheck);
            activeDownloadProcesses.delete(options.requestId);
            const classified = classifyDownloadError({ spawnError: err });
            log(`[download] ${options.requestId} attempt ${attempt} failed to spawn yt-dlp: ${err.message}`);
            handleFailure(classified, attempt);
        });

        function parseLine(line) {
            touch();
            if (line.startsWith('PROGRESS|')) {
                const [, status, downloadedBytes, totalBytes, percent, eta, speed] = line.split('|');
                if (status === 'downloading') {
                    // High-volume (near-continuous for the life of the
                    // download) -- only sampled in dev mode, see
                    // DEV_PROGRESS_LOG_INTERVAL_MS above.
                    if (isDev && Date.now() - lastDevProgressLogAt >= DEV_PROGRESS_LOG_INTERVAL_MS) {
                        lastDevProgressLogAt = Date.now();
                        log(`[download] ${options.requestId} attempt ${attempt} downloading: ${percent.trim()} eta=${eta} speed=${speed.trim()} (${downloadedBytes}/${totalBytes} bytes)`);
                    }
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
                    log(`[download] ${options.requestId} attempt ${attempt} yt-dlp reports download finished`);
                    send({ type: 'downloadDone', payload: {} });
                }
            } else if (line.startsWith('POSTPROCESS|')) {
                const [, status, processor] = line.split('|');
                // Always logged, unlike PROGRESS| above -- postprocess
                // (e.g. yt-dlp's own audio+video Merger) only ever emits a
                // handful of these per download, and this is exactly the
                // stage that's been observed hanging with no other feedback.
                log(`[download] ${options.requestId} attempt ${attempt} postprocess ${status}: ${processor}`);
                // See inPostprocess's own comment above the stall watchdog:
                // suspend stall-based auto-retry for the whole span between a
                // postprocessor starting and finishing, since yt-dlp reports
                // nothing in between it can be judged against.
                if (status === 'finished') {
                    inPostprocess = false;
                } else {
                    inPostprocess = true;
                }
                send({
                    type: 'postprocessing',
                    payload: { stage: status === 'started' ? 'start' : status, processor },
                });
            } else if (isDev) {
                // Any other stdout line (yt-dlp's own non-progress chatter --
                // e.g. "[Merger] Merging formats into ...", extractor debug
                // output) -- dev-only since this is otherwise unfiltered.
                log(`[download] ${options.requestId} attempt ${attempt} stdout: ${line}`);
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
            touch();
            if (line.startsWith('PROGRESS|') || line.startsWith('POSTPROCESS|')) {
                parseLine(line);
            } else {
                error += line + '\n';
                // Previously console.error-only, invisible in a packaged
                // build with no attached terminal -- this is where a real
                // ffmpeg/merge failure's actual explanation lands, so it now
                // always goes to main.log too, not just dev mode.
                log(`[download] ${options.requestId} attempt ${attempt} stderr: ${line}`);
                console.error('yt-dlp stderr:', line);
            }
        }));

        script.on('close', async (code) => {
            if (settled) return;
            settled = true;
            clearInterval(stallCheck);
            activeDownloadProcesses.delete(options.requestId);
            log(`[download] ${options.requestId} attempt ${attempt} yt-dlp exited with code ${code}`);

            if (cancelledDownloadRequestIds.delete(options.requestId)) {
                handleFailure({ kind: ERROR_KINDS.CANCELLED, message: 'Cancelled.' }, attempt);
                return;
            }

            if (code !== 0) {
                let classified = classifyDownloadError({ stderr: error, exitCode: code });
                classified.kind = await recheckDiskSpaceIfAmbiguous(classified.kind, options.outputPath);
                handleFailure(classified, attempt);
                return;
            }

            if (!postprocess) {
                finishDownload();
                const finalFile = findFinalFile(options.outputPath);
                log(`[download] ${options.requestId} attempt ${attempt} done -> ${finalFile}`);
                rememberAppPath(finalFile);
                send({ type: 'done', payload: { filename: finalFile } });
                return;
            }

            try {
                const rawFile = findRawDownloadedFile(rawDir);
                log(`[download] ${options.requestId} attempt ${attempt} yt-dlp finished, starting direct ffmpeg postprocess pass: rawFile=${rawFile} target=${postprocessOutputPath}`);
                const duration = await getMediaDurationSeconds(rawFile);
                log(`[download] ${options.requestId} attempt ${attempt} probed raw file duration: ${duration}s`);
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
                finishDownload();
                log(`[download] ${options.requestId} attempt ${attempt} postprocess complete -> ${postprocessOutputPath}`);
                rememberAppPath(postprocessOutputPath);
                send({ type: 'done', payload: { filename: postprocessOutputPath } });
            } catch (err) {
                // Our own direct ffmpeg pass, not yt-dlp -- still worth the
                // same "don't trust the wrapped error" disk-space recheck.
                // Not routed into the auto-retry ladder above: unlike a
                // network hiccup, a postprocess failure is usually a
                // deterministic cause (corrupt intermediate file, unsupported
                // codec) that retrying won't fix.
                const rawMessage = err instanceof Error ? err.message : String(err);
                const kind = await recheckDiskSpaceIfAmbiguous(ERROR_KINDS.UNKNOWN, options.outputPath);
                log(`[download] ${options.requestId} attempt ${attempt} postprocess FAILED (${kind}): ${rawMessage}`);
                finishDownload();
                if (rawDir) fs.rmSync(rawDir, { recursive: true, force: true });
                send({ type: 'error', payload: { message: rawMessage, kind, retryable: false } });
            }
        });
    }

    attemptDownload(0);
});

// --- Library view: ffmpeg utilities (extract MP3, convert format, extract
// clip, embed metadata) ---------------------------------------------------
// These all run ffmpeg directly against an *already-downloaded* library
// file, so they're kept separate from downloadVideoWithProgressUpdates/
// 'progressUpdate' above rather than overloading that pipeline's meaning --
// one shared broadcast channel here, same "one at a time" assumption as
// elsewhere in this app.

// The handlers below need to trust an inputPath/outputPath that isn't always
// inside the configured library -- e.g. embedding metadata into a file just
// downloaded from the plain Downloader tab, or a clip exported to wherever a
// save dialog put it. Rather than trust the renderer's word for where those
// live, the main process remembers the exact paths it itself just handed
// back (a save dialog's chosen path, a finished download's resolved file)
// and only accepts those, plus anything inside the library. A bounded set
// rather than a single "last path" since multiple downloads/exports can be
// in flight or recently finished at once.
const RECENT_APP_PATHS_LIMIT = 200;
const recentAppPaths = new Set();
export function rememberAppPath(filePath) {
    if (!filePath) return;
    recentAppPaths.delete(filePath); // re-insert to bump recency
    recentAppPaths.add(filePath);
    if (recentAppPaths.size > RECENT_APP_PATHS_LIMIT) {
        recentAppPaths.delete(recentAppPaths.values().next().value);
    }
}

// Resolves candidatePath if it's inside the configured library or one of the
// paths remembered above; null otherwise. Sibling to resolveInsideLibrary
// (library.mjs), for callers below whose legitimate paths aren't always
// inside libraryDir.
export function resolveAppOrLibraryPath(libraryDir, candidatePath) {
    return resolveInsideLibrary(libraryDir, candidatePath)
        || (candidatePath && recentAppPaths.has(candidatePath) ? path.resolve(candidatePath) : null);
}

// Matches every shape FfmpegUtilitiesPanel.tsx's own timestamp helpers can
// produce: formatClipTimestampInput (typed input, anywhere from a bare
// seconds value up to HH:MM:SS) and formatSecondsAsClipTimestamp (the
// "set from current playback position" default fill, always HH:MM:SS with
// unbounded hours for a very long video). Rejects anything else -- start/end
// are spliced directly into ffmpeg's -ss/-to argv slots, so this is what
// stands between a crafted string and an injected ffmpeg option.
const CLIP_TIMESTAMP_PATTERN = /^\d{1,6}(:\d{2}){0,2}$/;
export function isValidClipTimestamp(value) {
    return typeof value === 'string' && CLIP_TIMESTAMP_PATTERN.test(value);
}

function sendFfmpegUtilityProgress(msg) {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ffmpegUtilityProgress', msg);
}

// A separate channel from ffmpegUtilityProgress above, not that same channel
// with a discriminating `type` -- LibraryVideoDetail.tsx already keeps its
// own always-on, whole-screen-lifetime listener on ffmpegUtilityProgress
// (for the instrument panel's Convert/Extract-clip/etc. progress), cleaned
// up via ipcRenderer.removeAllListeners. LibraryVideoPlayer itself needs its
// own independent subscribe/unsubscribe lifecycle (mounted/unmounted per
// player instance, not per screen) -- sharing one channel between the two
// would mean either one's cleanup call silently kills the other's listener
// too. Safe as a single global "one at a time" broadcast here for the same
// reason ffmpegUtilityProgress already is: only one LibraryVideoPlayer is
// ever actually mounted at a time in this app.
function sendPreviewGenerationProgress(percent) {
    BrowserWindow.getAllWindows()[0]?.webContents.send('previewGenerationProgress', { percent });
}

// Generic "export a derived file" save dialog -- distinct from
// dialog:saveVideoFile (hardcoded to video-download filters and the
// configured download dir) since these exports can be audio, a different
// container, or an arbitrary "Other" format. Defaults to the source file's
// own folder rather than the configured download dir, since these exports
// are edits of a library file the user is already looking at.
ipcMain.handle('dialog:saveExportedFile', async (e, { defaultName, extensions, inputPath }) => {
    const { downloadDir } = readSettings();
    const baseDir = (inputPath && path.dirname(inputPath)) || downloadDir || app.getPath('downloads');
    const result = await dialog.showSaveDialog({
        title: 'Save File',
        buttonLabel: 'Save',
        defaultPath: path.join(baseDir, sanitizeForFilesystem(defaultName)),
        filters: [{ name: 'File', extensions }, ...allVideoFilter],
    });
    if (!result.canceled && result.filePath) rememberAppPath(result.filePath);
    return result;
});

ipcMain.handle('library:extractMp3', async (e, { inputPath, outputPath }) => {
    const { libraryDir } = readSettings();
    const resolvedInput = resolveInsideLibrary(libraryDir, inputPath);
    const resolvedOutput = resolveAppOrLibraryPath(libraryDir, outputPath);
    if (!resolvedInput || !resolvedOutput) {
        return { success: false, message: 'Refusing to read or write outside the configured library folder.' };
    }
    try {
        const duration = await getMediaDurationSeconds(resolvedInput);
        await runFfmpegWithProgress({
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            codecArgs: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'],
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
        });
        return { success: true, outputPath: resolvedOutput };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Backs LibraryVideoPlayer's preview-compatibility layer: for a local file
// whose container/codecs Chromium can't play natively (MKV and friends),
// generates (or reuses a cached) playback-only .mp4 derivative -- see
// previewCache.mjs for the remux-vs-reencode decision and cache/invalidation
// rules. Never touches filePath itself. Progress goes over its own dedicated
// channel (sendPreviewGenerationProgress above), not ffmpegUtilityProgress --
// see that function's own comment for why sharing it isn't safe here.
ipcMain.handle('library:ensurePlayablePreview', async (e, { filePath }) => {
    return ensurePlayablePreview({
        filePath,
        ffmpegRunner,
        onProgress: sendPreviewGenerationProgress,
    });
});

ipcMain.handle('library:convertFormat', async (e, { inputPath, outputPath, format, forceReencode = false }) => {
    const { libraryDir } = readSettings();
    const resolvedInput = resolveInsideLibrary(libraryDir, inputPath);
    const resolvedOutput = resolveAppOrLibraryPath(libraryDir, outputPath);
    if (!resolvedInput || !resolvedOutput) {
        return { success: false, message: 'Refusing to read or write outside the configured library folder.' };
    }
    try {
        const duration = await getMediaDurationSeconds(resolvedInput);
        await convertWithFallback({
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            format,
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
            forceReencode,
        });
        return { success: true, outputPath: resolvedOutput };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// start/end are passed straight through to ffmpeg's own -ss/-to, which
// already accepts the flexible time formats the UI's fields take -- so they
// pass through unparsed, but isValidClipTimestamp below still gates them
// against the shape this app's own UI can ever actually produce, since
// they're spliced directly into ffmpeg's argv. Both as output options
// (after -i), so they're unambiguous timestamps in the source's timeline --
// slower to seek than input-side -ss, but -c copy never decodes video either
// way, so it's only an I/O cost. -c copy snaps to the nearest keyframe
// rather than an exact frame, a documented tradeoff; frame-accurate
// re-encoded cuts are a deliberately separate, not-yet-offered option.
// Arbitrary-output-path clip export: unlike library:createClip below, this
// never touches clips.json and writes wherever the caller (a save dialog)
// picked, for player instances with no "library video entry" to attach a
// clip to (e.g. LibraryVideoPlayerWithTools's standaloneClipping mode, or
// its "also save as a file" checkbox). Shares clipAndConvert with
// library:createClip so format/forceReencode behave identically either way.
ipcMain.handle('library:extractClip', async (e, { inputPath, outputPath, start, end, format, forceReencode = false }) => {
    const { libraryDir } = readSettings();
    const resolvedInput = resolveInsideLibrary(libraryDir, inputPath);
    const resolvedOutput = resolveAppOrLibraryPath(libraryDir, outputPath);
    if (!resolvedInput || !resolvedOutput) {
        return { success: false, message: 'Refusing to read or write outside the configured library folder.' };
    }
    if (!isValidClipTimestamp(start) || !isValidClipTimestamp(end)) {
        return { success: false, message: 'Invalid clip start/end timestamp.' };
    }
    try {
        const targetFormat = format && format !== 'source' ? format : null;
        const startSeconds = parseClipTimestampSeconds(start);
        const endSeconds = parseClipTimestampSeconds(end);
        await clipAndConvert({
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            start,
            startSeconds,
            end,
            format: targetFormat,
            totalDurationSeconds: Math.max(0, endSeconds - startSeconds),
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
            forceReencode,
        });
        return { success: true, outputPath: resolvedOutput };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// HH:MM:SS -> seconds. Mirrors FfmpegUtilitiesPanel.tsx's own (renderer-side,
// module-private) copy -- can't be imported across the process boundary, so
// duplicated here, same as this codebase's other small cross-process helpers.
function parseClipTimestampSeconds(value) {
    const parts = (value || '').split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
}

// Clip Collection feature: trims + optionally converts in one ffmpeg pass
// and writes straight into <videoDir>/clips/, unlike library:extractClip
// above (which takes a pre-picked outputPath from a save dialog and never
// touches clips.json). videoDir is the video's own folder, not an epoch --
// clips are video-level, independent of which version they were cut from.
ipcMain.handle('library:createClip', async (e, { videoDir, inputPath, start, end, format, clipName, forceReencode = false }) => {
    const { libraryDir } = readSettings();
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    const resolvedInput = resolveInsideLibrary(libraryDir, inputPath);
    if (!resolvedVideoDir || !resolvedInput) {
        return { success: false, message: 'Refusing to read or write outside the configured library folder.' };
    }
    if (!isValidClipTimestamp(start) || !isValidClipTimestamp(end)) {
        return { success: false, message: 'Invalid clip start/end timestamp.' };
    }
    try {
        const targetFormat = format === 'source' ? null : format;
        const ext = targetFormat || path.extname(resolvedInput).slice(1) || 'mp4';
        const outputPath = buildClipFilePath(resolvedVideoDir, clipName, ext);
        if (fs.existsSync(outputPath)) {
            return { success: false, message: 'A clip with this name already exists for this video.' };
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        const startSeconds = parseClipTimestampSeconds(start);
        const endSeconds = parseClipTimestampSeconds(end);
        await clipAndConvert({
            inputPath: resolvedInput,
            outputPath,
            start,
            startSeconds,
            end,
            format: targetFormat,
            totalDurationSeconds: Math.max(0, endSeconds - startSeconds),
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
            forceReencode,
        });

        const durationSeconds = await getMediaDurationSeconds(outputPath);
        const clip = recordClip({
            libraryDir,
            videoDir: resolvedVideoDir,
            fileName: path.basename(outputPath),
            title: clipName,
            durationSeconds,
        });
        return { success: true, clip };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

ipcMain.handle('library:getClips', async (e, { videoDir }) => {
    const { libraryDir } = readSettings();
    try {
        return { success: true, clips: listClips({ libraryDir, videoDir }) };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err), clips: [] };
    }
});

ipcMain.handle('library:deleteClip', async (e, { videoDir, clipId }) => {
    const { libraryDir } = readSettings();
    try {
        return deleteClip({ libraryDir, videoDir, clipId });
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Converts a saved clip to another format "in place" -- the clip keeps its
// id/title/createdAt, only its underlying file (and clips.json's fileName/
// durationSeconds for it) change. ffmpeg can't read and write the same file
// at once, so this converts into a randomly-named temp file inside clips/
// first, and only deletes the original + renames the temp file into its
// final <title>.<newExt> spot once the conversion has actually succeeded --
// same temp-then-rename shape as swapLibraryDownload (library.mjs) uses for
// quality swaps, chosen specifically so a failed conversion never touches
// the original file at all.
ipcMain.handle('library:convertClip', async (e, { videoDir, clipId, format, forceReencode = false }) => {
    const { libraryDir } = readSettings();
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        return { success: false, message: 'Refusing to convert a clip outside the configured library folder.' };
    }
    let tempPath = null;
    try {
        const clips = listClips({ libraryDir, videoDir: resolvedVideoDir });
        const clip = clips.find((c) => c.id === clipId);
        if (!clip) return { success: false, message: 'Clip not found.' };

        const clipsDir = path.join(resolvedVideoDir, CLIPS_DIR_NAME);
        const oldPath = path.join(clipsDir, clip.fileName);
        const targetFileName = `${sanitizeForFilesystem(clip.title)}.${format}`;
        // Checked upfront, before spending any ffmpeg time on a conversion
        // that can never be saved -- same duplicate-name rule recordClip
        // enforces on clip creation.
        if (clips.some((c) => c.id !== clipId && c.fileName === targetFileName)) {
            return { success: false, message: 'A clip with this name already exists for this video.' };
        }

        tempPath = path.join(clipsDir, `${crypto.randomUUID()}.${format}`);
        const duration = await getMediaDurationSeconds(oldPath);
        await convertWithFallback({
            inputPath: oldPath,
            outputPath: tempPath,
            format,
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
            forceReencode,
        });

        fs.rmSync(oldPath, { force: true });
        const targetPath = path.join(clipsDir, targetFileName);
        fs.renameSync(tempPath, targetPath);
        tempPath = null;

        const durationSeconds = await getMediaDurationSeconds(targetPath);
        const updatedClip = updateClipFile({
            libraryDir,
            videoDir: resolvedVideoDir,
            clipId,
            fileName: targetFileName,
            durationSeconds,
        });
        return { success: true, clip: updatedClip };
    } catch (err) {
        if (tempPath) fs.rmSync(tempPath, { force: true });
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Edits "in place" from the user's perspective, but ffmpeg can never read
// and write the same file at once -- same temp-then-rename pattern
// swapLibraryDownload (library.mjs) uses for quality swaps: write to
// video.new.<ext> first, only delete the working file and rename once
// ffmpeg succeeds. Doesn't touch metadata.json -- only the bytes at that
// same path change.
//
// thumbnailPath (video-thumbnail.*, may be jpg/png/webp) is embedded as
// cover art when given. -map drops any pre-existing cover so re-running
// this replaces it rather than stacking old covers. The cover stream is
// always re-encoded to mjpeg since webp isn't a valid embedded-cover codec
// for ID3/mov -- everything else stays -c copy, no quality loss.
ipcMain.handle('library:embedMetadata', async (e, { inputPath, metadataTags, thumbnailPath, kind }) => {
    // Broader than resolveInsideLibrary alone: this is also used from the
    // plain Downloader tab (OtherPlatformDownloadCard.tsx), where inputPath
    // is a file that was never added to the library -- just downloaded to
    // wherever dialog:saveVideoFile put it.
    const { libraryDir } = readSettings();
    const resolvedInput = resolveAppOrLibraryPath(libraryDir, inputPath);
    if (!resolvedInput) {
        return { success: false, message: 'Refusing to modify a file outside the configured library folder.' };
    }
    // Downloader-tab callers only have yt-dlp's remote thumbnail URL, not a
    // pre-cached local file -- fetch it here into a temp file whenever
    // thumbnailPath looks like a URL instead of a local path.
    let downloadedThumbnailPath = null;
    try {
        const ext = path.extname(resolvedInput);
        const tempPath = `${resolvedInput.slice(0, -ext.length)}.new${ext}`;
        const duration = await getMediaDurationSeconds(resolvedInput);
        const metadataArgs = Object.entries(metadataTags || {})
            .filter(([, value]) => !!value)
            .flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);

        if (thumbnailPath && /^https?:\/\//i.test(thumbnailPath)) {
            try {
                downloadedThumbnailPath = await downloadImageToFile(thumbnailPath, os.tmpdir(), `embed-thumb-${crypto.randomUUID()}`);
                thumbnailPath = downloadedThumbnailPath;
            } catch (err) {
                log('[embed-metadata] thumbnail fetch failed', String(err));
                thumbnailPath = null;
            }
        } else if (thumbnailPath) {
            // Not a URL -- a locally-cached thumbnail is always inside the
            // library (channel-icon.*/video-thumbnail.*, see thumbnails.mjs),
            // so unlike inputPath there's no "just downloaded" case to allow
            // for here. An unresolvable path degrades to "no cover art"
            // rather than failing the whole embed, same as a failed fetch
            // above.
            thumbnailPath = resolveInsideLibrary(libraryDir, thumbnailPath);
        }

        const hasThumbnail = !!thumbnailPath && fs.existsSync(thumbnailPath);
        // Audio (mp3) has no pre-existing video stream, so the cover becomes
        // v:0; a video file's own stream is always v:0 (mapped first below),
        // so the cover lands at v:1.
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
            inputPath: resolvedInput,
            outputPath: tempPath,
            extraInputArgs: hasThumbnail ? ['-i', thumbnailPath] : [],
            codecArgs: ['-c', 'copy', ...streamMapArgs, ...coverArgs, ...metadataArgs],
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
        });
        fs.rmSync(resolvedInput, { force: true });
        fs.renameSync(tempPath, resolvedInput);
        return { success: true };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
        if (downloadedThumbnailPath) fs.rmSync(downloadedThumbnailPath, { force: true });
    }
});

ipcMain.handle('ytdlp:checkForUpdate', async () => {
    const current = await getCurrentYtdlpVersion(ytdlpPath);

    // GitHub Releases -- the same source performYtdlpUpdate actually fetches
    // and verifies the binary from below -- rather than PyPI, which was only
    // ever a proxy for "what version is latest" and could in principle
    // disagree with the real update source.
    try {
        const release = await resolveLatestRelease();
        return { current, latest: release.tag, updateAvailable: isNewerVersion(release.tag, current) };
    } catch (err) {
        log('[ytdlp-check] failed to resolve the latest release (offline?):', err instanceof Error ? err.message : String(err));
        return { current, latest: null, updateAvailable: false };
    }
});

ipcMain.handle('ytdlp:startUpdate', async () => {
    // The second arg rides along on the same 'ytdlpUpdateProgress' broadcast
    // channel as `stage` -- unlike a thrown Error's own properties (e.g.
    // err.code below), which don't survive the trip from ipcMain.handle's
    // throw to ipcRenderer.invoke's rejection, this is a plain
    // structured-cloned object and arrives at the renderer intact.
    const send = (stage, extra) => BrowserWindow.getAllWindows()[0]?.webContents.send('ytdlpUpdateProgress', { stage, ...extra });
    try {
        const result = await performYtdlpUpdate({
            userDataDir: app.getPath('userData'),
            liveYtdlpBinDir: userDataYtdlpBinDir,
            ytdlpBinaryName,
            isDownloadActive: () => activeDownloadCount > 0,
            onProgress: send,
            onLog: log,
        });
        return { success: true, version: result.version };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('[ytdlp-update] update failed:', message);
        send('error', { verificationFailure: err?.code === YTDLP_VERIFICATION_ERROR_CODE });
        throw err instanceof Error ? err : new Error(message);
    }
});

// yt-dlp is a vital dependency -- if the user declines a required update at
// startup, the app can't function, so it quits rather than continuing in a
// broken state.
ipcMain.handle('app:quit', async () => {
    app.quit();
});

// app.getVersion() already reads package.json's "version" field -- surfaced
// to the renderer so users can report exactly which build they're on.
ipcMain.handle('app:getVersion', async () => {
    return app.getVersion();
});

// Surfaced the same way as app:getVersion above, for the About dialog's
// bundled-dependency versions (MainPage.tsx).
ipcMain.handle('system:getFfmpegVersion', async () => {
    return getFfmpegVersion();
});

ipcMain.handle('system:openFileInDirectory', async (e, filepath) => {
    shell.showItemInFolder(filepath);
});
// shell.showItemInFolder, for a directory path, reveals its *parent* folder
// with that directory selected -- not what "open this folder" means.
// shell.openPath opens the given folder's own contents directly.
ipcMain.handle('system:openDirectory', async (e, dirPath) => {
    shell.openPath(dirPath);
});

// Opens a file in the OS's default app (e.g. QuickTime/VLC for a video).
// Deliberately unconditional on file type -- a generically useful escape
// hatch even for formats the in-app player already handles, not just MKV
// (which Chromium's <video> element can't play at all).
ipcMain.handle('system:openFileExternally', async (e, filepath) => {
    shell.openPath(filepath);
});

// Renderer-side errors (window.onerror/unhandledrejection, see App.tsx)
// can't write to main.log directly -- no fs access under
// contextIsolation/sandbox -- so they're forwarded here.
ipcMain.handle('errorLog:report', async (e, { message, stack }) => {
    log('[rendererError]', stack || message || 'Unknown renderer error');
});

ipcMain.handle('errorLog:getInfo', async () => {
    return { exists: fs.existsSync(logFile), path: logFile };
});

ipcMain.handle('errorLog:open', async () => {
    shell.openPath(logFile);
});
