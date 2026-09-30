import { spawn } from 'child_process';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';

// SEC-008: image URLs come straight out of remote metadata (yt-dlp's info
// dict, a channel page's avatar list) -- i.e. from whoever authored the
// content -- so they're fetched defensively: https only, never to a
// loopback/private/link-local/otherwise-internal address (checked on the
// address actually connected to, every hop, so DNS rebinding can't slip
// past a check done earlier), a byte cap, an idle timeout plus an overall
// deadline, and a small redirect budget. Deliberately *not* a CDN host
// allowlist: the library covers any of yt-dlp's 1800+ sites, each with its
// own image CDN, and a list would silently break thumbnails for most of them.
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_IDLE_TIMEOUT_MS = 15_000;
export const IMAGE_TOTAL_TIMEOUT_MS = 60_000;
export const IMAGE_MAX_REDIRECTS = 3;

// Two separate lists on purpose: a single net.BlockList matches a plain
// IPv4 address against IPv6 rules via its mapped form, so the ::ffff:0:0/96
// rule below would otherwise block every IPv4 address there is.
const BLOCKED_IPV4 = new net.BlockList();
const BLOCKED_IPV6 = new net.BlockList();
for (const [prefix, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) {
    BLOCKED_IPV4.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
    ['::', 128], ['::1', 128],
    // IPv4-mapped/translated forms: a public CDN never answers with these,
    // and blocking the whole range avoids re-deriving the embedded v4.
    ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) {
    BLOCKED_IPV6.addSubnet(prefix, bits, 'ipv6');
}

// True for any address a remote-metadata-supplied URL must never reach.
// Anything that isn't a valid IP literal is treated as blocked too -- this
// is only ever called with an already-resolved address.
export function isBlockedAddress(address) {
    const family = net.isIP(address);
    if (family === 0) return true;
    return family === 6 ? BLOCKED_IPV6.check(address, 'ipv6') : BLOCKED_IPV4.check(address, 'ipv4');
}

// Parses and vets a URL before any request goes out: https only, and an IP
// literal host is checked here since Node skips the DNS lookup (and so the
// guarded lookup below) entirely for one. WHATWG URL parsing already
// normalizes odd IPv4 spellings (0x7f.1, 2130706433) to dotted form.
export function assertFetchableImageUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('Refusing to fetch image: not a valid URL');
    }
    if (url.protocol !== 'https:') {
        throw new Error(`Refusing to fetch image: ${url.protocol} is not https:`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedAddress(host)) {
        throw new Error('Refusing to fetch image: address is not publicly routable');
    }
    return url;
}

// dns.lookup wrapper for https.get's `lookup` option -- runs at connect time
// on every request/hop, so the address checked is the one actually used.
// Handles both callback shapes (single address, or `all: true`'s array,
// which Node's happy-eyeballs connect path asks for).
export function guardedLookup(hostname, options, callback) {
    dns.lookup(hostname, options, (err, address, family) => {
        if (err) {
            callback(err, address, family);
            return;
        }
        const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
        if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
            callback(new Error(`Refusing to fetch image: ${hostname} resolves to a non-public address`));
            return;
        }
        callback(null, address, family);
    });
}

function imageExtensionFor(contentType) {
    return contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
}

// Plain HTTPS GET, no new dependency -- avatar/video/playlist thumbnail URLs
// are already fully-formed CDN links, not something yt-dlp needs to fetch
// for us. Follows redirects manually since Node's https module doesn't. No
// yt-dlp/Electron dependency, so it's a plain export rather than part of the
// factory below.
//
// The body is streamed to a temp file beside the destination and only
// renamed into place once complete -- a failed/aborted fetch leaves the
// previous <baseName>.* image untouched instead of deleting it up front.
//
// `get` is https.get by default; injectable (along with the limits) so the
// guard behavior can be tested without a real network.
export function downloadImageToFile(url, destDir, baseName, {
    get = https.get,
    maxBytes = IMAGE_MAX_BYTES,
    idleTimeoutMs = IMAGE_IDLE_TIMEOUT_MS,
    totalTimeoutMs = IMAGE_TOTAL_TIMEOUT_MS,
    redirectsLeft = IMAGE_MAX_REDIRECTS,
} = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request = null;
        let tempPath = null;
        let fileStream = null;
        const deadline = setTimeout(() => fail(new Error('Image fetch timed out')), totalTimeoutMs);

        // createWriteStream opens its file asynchronously, so an rm issued
        // straight after destroy() can run before the file even exists and
        // leave a stray .part behind -- wait for the stream to close first.
        function cleanupTemp() {
            const pendingPath = tempPath;
            if (!pendingPath) return;
            tempPath = null;
            if (fileStream && !fileStream.closed) {
                fileStream.once('close', () => fs.rmSync(pendingPath, { force: true }));
                fileStream.destroy();
            } else {
                fs.rmSync(pendingPath, { force: true });
            }
        }
        function fail(err) {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            request?.destroy();
            cleanupTemp();
            reject(err);
        }
        function succeed(destPath) {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve(destPath);
        }

        function fetchHop(hopUrl, hopsLeft) {
            let parsed;
            try {
                parsed = assertFetchableImageUrl(hopUrl);
            } catch (err) {
                fail(err);
                return;
            }
            request = get(parsed, { lookup: guardedLookup }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (hopsLeft <= 0) {
                        fail(new Error('Failed to download image: too many redirects'));
                        return;
                    }
                    // A relative Location is legal -- resolve it against
                    // this hop rather than handing https.get a bare path.
                    let next;
                    try {
                        next = new URL(res.headers.location, parsed).href;
                    } catch {
                        fail(new Error('Failed to download image: invalid redirect'));
                        return;
                    }
                    fetchHop(next, hopsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    fail(new Error(`Failed to download image: HTTP ${res.statusCode}`));
                    return;
                }
                const declaredLength = Number(res.headers['content-length']);
                if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
                    res.resume();
                    fail(new Error('Failed to download image: larger than the size limit'));
                    return;
                }
                const ext = imageExtensionFor(res.headers['content-type'] || '');
                tempPath = path.join(destDir, `.${baseName}-${crypto.randomUUID()}.part`);
                fileStream = fs.createWriteStream(tempPath);
                let received = 0;
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (received > maxBytes) {
                        fail(new Error('Failed to download image: larger than the size limit'));
                    }
                });
                res.on('error', fail);
                res.on('aborted', () => fail(new Error('Failed to download image: connection aborted')));
                fileStream.on('error', fail);
                // 'close', not 'finish': the fd is only released at close,
                // and Windows refuses to rename a file that's still open.
                fileStream.on('close', () => {
                    if (settled) return;
                    try {
                        // Clear out any previous image first -- a re-fetch
                        // could land on a different extension than last
                        // time, and this keeps exactly one <baseName>.* file
                        // around rather than accumulating stale ones.
                        for (const existing of fs.readdirSync(destDir).filter((f) => f.startsWith(`${baseName}.`))) {
                            fs.rmSync(path.join(destDir, existing), { force: true });
                        }
                        const destPath = path.join(destDir, `${baseName}${ext}`);
                        fs.renameSync(tempPath, destPath);
                        tempPath = null;
                        succeed(destPath);
                    } catch (err) {
                        fail(err);
                    }
                });
                res.pipe(fileStream);
            });
            request.setTimeout(idleTimeoutMs, () => fail(new Error('Image fetch timed out')));
            request.on('error', fail);
        }

        fetchHop(url, redirectsLeft);
    });
}

// A channel's avatar isn't in a single video's own info dict -- it only
// shows up when yt-dlp extracts the *channel page* itself, a separate call
// per channel, not something piggybacked on the per-video fetch. --flat-
// playlist avoids resolving every video into a full info-dict (only the
// header is wanted), and --playlist-end 1 caps it to one entry.
function fetchChannelAvatarUrl(channelId, { ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, ytdlpSpawnEnv }) {
    return new Promise((resolve) => {
        const channelUrl = `https://www.youtube.com/channel/${channelId}`;
        const script = spawn(ytdlpPath, [
            '-J', '--no-warnings', '--flat-playlist', '--playlist-end', '1',
            '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), ...jsRuntimeArgs(), '--', channelUrl,
        ], { env: ytdlpSpawnEnv() });
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
                // 'avatar_uncropped' is yt-dlp's full-resolution synthetic
                // entry; falls back to the raw 'avatar' id if that's missing.
                const avatar = thumbnails.find((t) => t.id === 'avatar_uncropped') || thumbnails.find((t) => t.id === 'avatar');
                resolve(avatar ? avatar.url : null);
            } catch {
                resolve(null);
            }
        });
    });
}

// A factory (not bare exports) since ensureChannelIcon needs the yt-dlp
// spawn dependencies (ytdlpPath/ffmpegDir/cookiesArgs/jsRuntimeArgs/
// ytdlpSpawnEnv) and a log sink -- same pattern as settings.mjs/cookies.mjs,
// so this stays a pure Node module with those Electron-adjacent values
// injected by main.mjs rather than imported here.
export function createThumbnailFetchers({ ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, ytdlpSpawnEnv, onLog }) {
    // Best-effort, never throws -- a missing channel icon just falls back to
    // the generic folder icon, not a broken add-to-library action. force
    // skips the "already have one" check, used by the "refresh channel icon"
    // button.
    async function ensureChannelIcon(channelDir, channelId, { force = false } = {}) {
        if (!channelId) return;
        try {
            const hasIcon = !force && fs.existsSync(channelDir) && fs.readdirSync(channelDir).some((f) => f.startsWith('channel-icon.'));
            if (hasIcon) return;
            const avatarUrl = await fetchChannelAvatarUrl(channelId, { ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, ytdlpSpawnEnv });
            if (!avatarUrl) return;
            await downloadImageToFile(avatarUrl, channelDir, 'channel-icon');
        } catch (err) {
            onLog('[channel-icon] fetch failed', String(err));
        }
    }

    // Video-level (not per-epoch): one thumbnail lives directly in videoDir,
    // shared across every version. Unlike the channel avatar, the URL is
    // already in videoMetaData -- no extra yt-dlp call needed. Skips (rather
    // than force-refetching) once a video-thumbnail.* file exists.
    async function ensureVideoThumbnail(videoDir, thumbnailUrl) {
        if (!thumbnailUrl) return;
        try {
            const hasThumbnail = fs.existsSync(videoDir) && fs.readdirSync(videoDir).some((f) => f.startsWith('video-thumbnail.'));
            if (hasThumbnail) return;
            await downloadImageToFile(thumbnailUrl, videoDir, 'video-thumbnail');
        } catch (err) {
            onLog('[video-thumbnail] fetch failed', String(err));
        }
    }

    // Playlist-level, a sibling of the epoch folders -- unlike
    // ensureVideoThumbnail, always force-refetches rather than skipping once
    // a file exists: "the playlist's thumbnail" is whichever video is first
    // in the list *right now*, so it has to track that on every
    // write/refresh. Silently no-ops when the first entry has no
    // thumbnailUrl (empty playlist, or a dead first entry), deliberately
    // leaving whatever was cached in place as a fallback for "the playlist
    // emptied out later."
    async function ensurePlaylistThumbnail(playlistDir, thumbnailUrl) {
        if (!thumbnailUrl) return;
        try {
            await downloadImageToFile(thumbnailUrl, playlistDir, 'playlist-thumbnail');
        } catch (err) {
            onLog('[playlist-thumbnail] fetch failed', String(err));
        }
    }

    return { ensureChannelIcon, ensureVideoThumbnail, ensurePlaylistThumbnail };
}
