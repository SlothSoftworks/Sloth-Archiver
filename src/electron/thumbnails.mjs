import { spawn } from 'child_process';
import https from 'node:https';
import fs from 'fs';
import path from 'path';

// Plain HTTPS GET, no new dependency -- avatar/video/playlist thumbnail URLs
// are already fully-formed CDN links, not something yt-dlp needs to fetch
// for us. Follows redirects manually since Node's https module doesn't. No
// yt-dlp/Electron dependency, so it's a plain export rather than part of the
// factory below.
export function downloadImageToFile(url, destDir, baseName, redirectsLeft = 5) {
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

// A channel's avatar isn't in a single video's own info dict -- it only
// shows up when yt-dlp extracts the *channel page* itself, a separate call
// per channel, not something piggybacked on the per-video fetch. --flat-
// playlist avoids resolving every video into a full info-dict (only the
// header is wanted), and --playlist-end 1 caps it to one entry.
function fetchChannelAvatarUrl(channelId, { ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs }) {
    return new Promise((resolve) => {
        const channelUrl = `https://www.youtube.com/channel/${channelId}`;
        const script = spawn(ytdlpPath, [
            '-J', '--no-warnings', '--flat-playlist', '--playlist-end', '1',
            '--ffmpeg-location', ffmpegDir, ...cookiesArgs(), ...jsRuntimeArgs(), channelUrl,
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
// spawn dependencies (ytdlpPath/ffmpegDir/cookiesArgs/jsRuntimeArgs) and a
// log sink -- same pattern as settings.mjs/cookies.mjs, so this stays a pure
// Node module with those Electron-adjacent values injected by main.mjs
// rather than imported here.
export function createThumbnailFetchers({ ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs, onLog }) {
    // Best-effort, never throws -- a missing channel icon just falls back to
    // the generic folder icon, not a broken add-to-library action. force
    // skips the "already have one" check, used by the "refresh channel icon"
    // button.
    async function ensureChannelIcon(channelDir, channelId, { force = false } = {}) {
        if (!channelId) return;
        try {
            const hasIcon = !force && fs.existsSync(channelDir) && fs.readdirSync(channelDir).some((f) => f.startsWith('channel-icon.'));
            if (hasIcon) return;
            const avatarUrl = await fetchChannelAvatarUrl(channelId, { ytdlpPath, ffmpegDir, cookiesArgs, jsRuntimeArgs });
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
