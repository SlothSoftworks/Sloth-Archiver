import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path'
import { spawn } from 'child_process';
import fs from "fs";
import crypto from 'crypto';
import http from 'node:http';
import os from 'node:os';

import { getSupportedVideoFilters, allVideoFilter } from './utils/constants.mjs';
import { getLatestYtdlpVersionFromPyPI, getCurrentYtdlpVersion, isNewerVersion, performYtdlpUpdate } from './updater.mjs';
import { writeLibraryEntry, overrideLibraryEntry, addLibraryVersion, refreshLibraryEntryMetadata, getLibraryIndex, refreshLibraryIndex, findVideoInIndex, recordLibraryDownload, swapLibraryDownload, deleteLibraryEntry, deleteLocalFiles, writePlaylistSnapshot, enrichPlaylistEntry, listPlaylistSnapshots, getPlaylistSnapshot, reconcilePlaylistSnapshot, undoPlaylistRefresh, deletePlaylistSnapshot, sanitizeForFilesystem, resolveInsideLibrary, PLAYLISTS_DIR_NAME, CLIPS_DIR_NAME, buildClipFilePath, recordClip, listClips, deleteClip, updateClipFile } from './library.mjs';
import { createSettingsStore, clampMaxSimultaneousDownloads, clampThumbnailSize, THUMBNAIL_SIZE_DEFAULT } from './settings.mjs';
import { makeCookiesArgs, looksLikeNetscapeFormat, convertHeaderCookiesToNetscape, validateNetscapeLines, SUPPORTED_COOKIE_BROWSERS } from './cookies.mjs';
import { downloadImageToFile, createThumbnailFetchers } from './thumbnails.mjs';
import { createFfmpegRunner } from './ffmpegUtils.mjs';
import { buildResolutions, reshapeVideoInfo, isDeadVideoInfo, createVideoInfoCache, fetchVideoInfo } from './videoInfo.mjs';

// Re-exported so main.test.mjs (and anything else importing these from
// './main.mjs') keeps working unchanged -- these now live in cookies.mjs/
// videoInfo.mjs, but main.mjs is still where the rest of the codebase looks
// for them.
export { looksLikeNetscapeFormat, convertHeaderCookiesToNetscape, validateNetscapeLines, buildResolutions, reshapeVideoInfo, isDeadVideoInfo };

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

// Bundled the same way as ffmpeg/ffprobe above -- yt-dlp needs a real JS
// runtime to solve YouTube's nsig signature challenge (TD-010, reports/
// TechnicalDebt.md); without one, every real video/audio format silently
// disappears once a request is authenticated, leaving only storyboard
// formats. Bundled rather than relying on the user having Node/Deno
// installed, matching this app's zero-external-dependency approach.
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
const pythonSrcDir = isDev ? path.resolve(__dirname, '../../src/python') : path.join(process.resourcesPath, 'python-src');

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

// Points yt-dlp at the bundled deno binary rather than letting it search the
// system PATH (which the "js-runtimes" default probe does on its own, but
// only for a runtime it happens to find -- not guaranteed on a real user's
// machine). See denoBinaryPath's own comment (TD-010) for why this exists.
export function jsRuntimeArgs() {
    return ['--js-runtimes', `deno:${denoBinaryPath}`];
}

const { readSettings, writeSettings } = createSettingsStore(settingsPath);
export const cookiesArgs = makeCookiesArgs(readSettings, cookiesPath);
const { readVideoInfoCache, writeVideoInfoCache } = createVideoInfoCache(videoInfoCachePath);
const { ensureChannelIcon, ensureVideoThumbnail, ensurePlaylistThumbnail } = createThumbnailFetchers({
    ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, onLog: log,
});
const { getMediaDurationSeconds, runFfmpegWithProgress, convertWithFallback, clipAndConvert } = createFfmpegRunner({ ffmpegBinaryPath, ffprobeBinaryPath });

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

// Serves the renderer bundle over a real loopback HTTP origin, replacing
// mainWindow.loadFile()'s file:// origin. A custom app:// protocol
// (standard/secure: true) does NOT work here: Chromium's Referer-generation
// gate checks the document's scheme against a hardcoded http(s) allowlist,
// separate from the privileged-scheme flags, so custom schemes never
// produce a Referer (confirmed both by precedent -- Tauri hits the same
// issue -- and empirically via a captured Network request). A missing
// Referer is what breaks the YouTube iframe embed elsewhere in the app
// (required since late 2025); only a genuine http:// origin clears that
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
                res.writeHead(200, { 'Content-Type': mimeTypeForPath(resolvedPath) });
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
// Uses net.fetch() against a file:// URL as the byte-stream source (fixed an
// earlier "AbortError" bug from hand-rolling a Node fs.ReadStream-to-Response
// conversion), but does NOT trust net.fetch's own status/headers for the
// response handed back. Chromium treats a protocol.handle response as a
// genuine network response, not the trusted path a real file:// navigation
// gets -- it needs Accept-Ranges/Content-Range/206 spelled out explicitly on
// every response, including the first un-ranged one, or
// video.seekable.end() stays 0 and the scrub bar silently does nothing. So
// the Range math is done here ourselves; net.fetch is only ever asked for
// the exact byte range already decided.
async function handleAppVideoRequest(request) {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.slice(1));

    const { libraryDir } = readSettings();
    const resolvedFilePath = resolveInsideLibrary(libraryDir, filePath);
    if (!resolvedFilePath) {
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
    const { libraryDir } = readSettings();
    return getLibraryIndex(libraryDir);
});

ipcMain.handle('library:refreshIndex', async () => {
    const { libraryDir } = readSettings();
    return refreshLibraryIndex(libraryDir);
});

// User-triggered from the Library tab's channel view -- unlike the
// fire-and-forget calls below, this one is awaited so the button can show a
// loading state and the caller gets back a fresh index once it's done.
ipcMain.handle('library:refreshChannelIcon', async (e, { channelFolderName, channelId }) => {
    const { libraryDir } = readSettings();
    const channelDir = path.join(libraryDir, channelFolderName);
    await ensureChannelIcon(channelDir, channelId, { force: true });
    return refreshLibraryIndex(libraryDir);
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

// "Refresh from YouTube" on the version currently displayed -- the renderer
// already fetched fresh videoMetaData (getVideoInfoPython, same as every
// other refresh/add path) before calling this; this just writes it into the
// existing epoch in place, see refreshLibraryEntryMetadata's own comment.
ipcMain.handle('library:refreshEntry', async (e, { videoDir, epoch, videoMetaData }) => {
    const { libraryDir } = readSettings();
    const metadata = refreshLibraryEntryMetadata({ libraryDir, videoDir, epoch, videoMetaData });
    await refreshLibraryIndex(libraryDir);
    Promise.all([
        ensureChannelIcon(path.dirname(videoDir), videoMetaData.channelId),
        ensureVideoThumbnail(videoDir, videoMetaData.thumbnail),
    ]).then(() => refreshLibraryIndex(libraryDir)).then(notifyLibraryBackgroundUpdate);
    return { success: true, metadata };
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
            '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), ...jsRuntimeArgs(), playlistUrl,
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
        const playlist = await fetchPlaylistEntries(playlistUrl);
        // Snapshot saved every time a playlist is fetched (see
        // library.mjs's writePlaylistSnapshot).
        const { libraryDir } = readSettings();
        if (libraryDir) {
            const index = await getLibraryIndex(libraryDir);
            const result = writePlaylistSnapshot({
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

// Backs the Library tab's Playlists section -- list/detail read straight off
// whatever's already saved, no network call.
ipcMain.handle('library:listPlaylists', async () => {
    const { libraryDir } = readSettings();
    if (!libraryDir) return { playlists: [] };
    return { playlists: listPlaylistSnapshots({ libraryDir }) };
});

ipcMain.handle('library:getPlaylist', async (e, playlistId) => {
    const { libraryDir } = readSettings();
    if (!libraryDir) return { playlist: null };
    return { playlist: await getPlaylistSnapshot({ libraryDir, playlistId }) };
});

// The explicit "Refresh" action -- re-fetches the playlist from yt-dlp using
// its saved originalUrl, then reconciles (see reconcilePlaylistSnapshot,
// library.mjs, for the merge rules). Deliberately separate from
// library:fetchPlaylistEntries above (still a no-op past the first save) --
// refresh only ever happens through this explicit action.
ipcMain.handle('library:refreshPlaylist', async (e, playlistId) => {
    const { libraryDir } = readSettings();
    if (!libraryDir) {
        return { success: false, message: 'No library folder configured.' };
    }
    try {
        const index = await getLibraryIndex(libraryDir);
        const saved = await getPlaylistSnapshot({ libraryDir, playlistId, index });
        if (!saved || !saved.originalUrl) {
            return { success: false, message: 'This playlist has no saved snapshot to refresh.' };
        }
        const fresh = await fetchPlaylistEntries(saved.originalUrl);
        const result = reconcilePlaylistSnapshot({
            libraryDir,
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
        const playlistDir = path.join(libraryDir, PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
        ensurePlaylistThumbnail(playlistDir, result.entries[0]?.thumbnailUrl);
        return result;
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

ipcMain.handle('library:undoPlaylistRefresh', async (e, playlistId) => {
    const { libraryDir } = readSettings();
    if (!libraryDir) {
        return { success: false, message: 'No library folder configured.' };
    }
    try {
        return undoPlaylistRefresh({ libraryDir, playlistId });
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// Deletes only the playlist's own saved snapshot -- never the videos it
// references, which is why there's no equivalent of deleteLibraryEntry's
// videoDeleted flag here for the UI to react to.
ipcMain.handle('library:deletePlaylist', async (e, playlistId) => {
    const { libraryDir } = readSettings();
    if (!libraryDir) {
        return { success: false, message: 'No library folder configured.' };
    }
    try {
        return deletePlaylistSnapshot({ libraryDir, playlistId });
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

// Batched counterpart to library:deleteEntry -- deletes N whole videos (no
// per-entry epoch targeting) and refreshes the library index once at the
// end instead of once per item. Used by the Library tab's bulk-select
// "Delete selected" action.
ipcMain.handle('library:deleteEntries', async (e, { videoDirs }) => {
    const { libraryDir } = readSettings();
    const results = videoDirs.map((videoDir) => {
        try {
            deleteLibraryEntry({ libraryDir, videoDir });
            return { videoDir, success: true };
        } catch (err) {
            return { videoDir, success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    await refreshLibraryIndex(libraryDir);
    return { success: results.every((r) => r.success), results };
});

// Batched "Delete local files" -- removes downloaded media across every
// epoch of each video without touching the tracked library entries
// themselves (see deleteLocalFiles, library.mjs). Same result shape as
// library:deleteEntries for the same reason: the renderer needs to know
// exactly which ones failed to report back accurately.
ipcMain.handle('library:deleteLocalFiles', async (e, { videoDirs }) => {
    const { libraryDir } = readSettings();
    const results = videoDirs.map((videoDir) => {
        try {
            deleteLocalFiles({ libraryDir, videoDir });
            return { videoDir, success: true };
        } catch (err) {
            return { videoDir, success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    await refreshLibraryIndex(libraryDir);
    return { success: results.every((r) => r.success), results };
});

// Kick off the initial scan in the background at startup -- deliberately not
// awaited, since this could be scanning an arbitrarily large library.
// getLibraryIndex reuses this same in-flight scan when the Library tab asks.
getLibraryIndex(readSettings().libraryDir);

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

ipcMain.handle('getVideoInfoPython', async (event, url) => fetchVideoInfo(url, {
    ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, readVideoInfoCache, writeVideoInfoCache, cacheTtlMs: VIDEO_INFO_CACHE_TTL_MS,
}));

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
// own postprocessing can never report real progress for those (TD-004).
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
        // Audio only -- the old bestvideo[height<=144]+bestaudio selector downloaded
        // a throwaway low-res video track purely to feed yt-dlp's own extract-audio
        // postprocessor. Now that we extract audio ourselves, there's no reason to
        // download video at all.
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

    args.push(videoUrl);
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

ipcMain.handle('downloadVideoWithProgressUpdates', (event, options) => {
    activeDownloadCount++;
    // requestId is echoed onto every message on this shared/unscoped
    // broadcast channel (TD-008) -- generated renderer-side, so every
    // consumer of this handler can filter to just its own in-flight
    // download.
    const send = (msg) => BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', { ...msg, requestId: options.requestId });

    // MP3 extraction and format recode need our own ffmpeg pass afterward
    // (TD-004), so yt-dlp downloads to a raw intermediate file in a
    // dedicated temp dir -- deliberately outside the final directory so it
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
        // restart yt-dlp's download from scratch, losing TD-001's resume
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
// file, so they're kept separate from downloadVideoWithProgressUpdates/
// 'progressUpdate' above rather than overloading that pipeline's meaning --
// one shared broadcast channel here, same "one at a time" assumption as
// elsewhere in this app (see TD-008, reports/TechnicalDebt.md).
function sendFfmpegUtilityProgress(msg) {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ffmpegUtilityProgress', msg);
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

ipcMain.handle('library:convertFormat', async (e, { inputPath, outputPath, format, forceReencode = false }) => {
    try {
        const duration = await getMediaDurationSeconds(inputPath);
        await convertWithFallback({
            inputPath,
            outputPath,
            format,
            totalDurationSeconds: duration,
            onProgress: (percent) => sendFfmpegUtilityProgress({ type: 'progress', percent }),
            forceReencode,
        });
        return { success: true, outputPath };
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
});

// start/end are passed straight through to ffmpeg's own -ss/-to, which
// already accepts the flexible time formats the UI's fields take -- no need
// to parse/validate them ourselves. Both as output options (after -i), so
// they're unambiguous timestamps in the source's timeline -- slower to seek
// than input-side -ss, but -c copy never decodes video either way, so it's
// only an I/O cost. -c copy snaps to the nearest keyframe rather than an
// exact frame, a documented tradeoff; frame-accurate re-encoded cuts are a
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
    if (!resolvedVideoDir) {
        return { success: false, message: 'Refusing to write outside the configured library folder.' };
    }
    try {
        const targetFormat = format === 'source' ? null : format;
        const ext = targetFormat || path.extname(inputPath).slice(1) || 'mp4';
        const outputPath = buildClipFilePath(resolvedVideoDir, clipName, ext);
        if (fs.existsSync(outputPath)) {
            return { success: false, message: 'A clip with this name already exists for this video.' };
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        const startSeconds = parseClipTimestampSeconds(start);
        const endSeconds = parseClipTimestampSeconds(end);
        await clipAndConvert({
            inputPath,
            outputPath,
            start,
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
    // Downloader-tab callers only have yt-dlp's remote thumbnail URL, not a
    // pre-cached local file -- fetch it here into a temp file whenever
    // thumbnailPath looks like a URL instead of a local path.
    let downloadedThumbnailPath = null;
    try {
        const ext = path.extname(inputPath);
        const tempPath = `${inputPath.slice(0, -ext.length)}.new${ext}`;
        const duration = await getMediaDurationSeconds(inputPath);
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
    } finally {
        if (downloadedThumbnailPath) fs.rmSync(downloadedThumbnailPath, { force: true });
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
            onLog: log,
        });
        return { success: true, version: result.version };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('[ytdlp-update] update failed:', message);
        send('error');
        throw err instanceof Error ? err : new Error(message);
    }
});

// yt-dlp is a vital dependency -- if the user declines a required update at
// startup, the app can't function, so it quits rather than continuing in a
// broken state.
ipcMain.handle('app:quit', async () => {
    app.quit();
});

// app.getVersion() already reads package.json's "version" field (Electron's
// own behavior, no extra bookkeeping needed) -- surfaced to the renderer so
// alpha testers can report exactly which build they're on.
ipcMain.handle('app:getVersion', async () => {
    return app.getVersion();
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
    log('[rendererError]', new Date().toISOString(), stack || message || 'Unknown renderer error');
});

ipcMain.handle('errorLog:getInfo', async () => {
    return { exists: fs.existsSync(logFile), path: logFile };
});

ipcMain.handle('errorLog:open', async () => {
    shell.openPath(logFile);
});
