// Plain ESM, no Electron/DOM dependency of its own -- lives under
// src/electron/ (rather than a new top-level shared/ folder) purely for
// packaging reasons: scripts/copy-electron.mjs already copies this whole
// directory into the packaged app as-is, so main.mjs can import this at
// runtime with no extra build-config changes. The renderer's own copy
// (src/utils/utils.ts) imports it too -- Vite bundles it into the renderer
// build like any other source file, regardless of which folder it lives in.
export function isYouTubeUrl(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        return hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'music.youtube.com' || hostname === 'youtu.be';
    } catch {
        return false;
    }
}

const CHANNEL_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
// 'live' is deliberately absent: /@handle/live redirects to whatever the
// channel is streaming right now, a single video rather than the channel.
const CHANNEL_TABS = new Set(['videos', 'featured', 'shorts', 'streams', 'playlists', 'community', 'posts', 'about', 'podcasts', 'releases', 'courses', 'store', 'membership', 'search']);

// Returns the channel's regular-uploads tab, https://www.youtube.com/<id>/videos,
// for any channel link form, or null for anything that is not a channel.
// The path segments are reused exactly as URL parsed them (already
// percent-encoded), so nothing from the input can change the URL's shape.
export function parseYouTubeChannelUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!CHANNEL_HOSTS.has(parsed.hostname)) return null;
    if (parsed.searchParams.has('v') || parsed.searchParams.has('list')) return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    let channelPath;
    let rest;
    if (segments[0]?.startsWith('@') && segments[0].length > 1) {
        channelPath = segments[0];
        rest = segments.slice(1);
    } else if (segments[0] === 'channel' && CHANNEL_ID_PATTERN.test(segments[1] || '')) {
        channelPath = `channel/${segments[1]}`;
        rest = segments.slice(2);
    } else if ((segments[0] === 'c' || segments[0] === 'user') && segments[1]) {
        channelPath = `${segments[0]}/${segments[1]}`;
        rest = segments.slice(2);
    } else {
        return null;
    }
    if (rest.length > 1) return null;
    if (rest.length === 1 && !CHANNEL_TABS.has(rest[0].toLowerCase())) return null;
    return `https://www.youtube.com/${channelPath}/videos`;
}

export function isYouTubeChannelUrl(url) {
    return parseYouTubeChannelUrl(url) !== null;
}
