// Plain ESM, no Electron/DOM dependency of its own -- lives under
// src/electron/ (rather than a new top-level shared/ folder) purely for
// packaging reasons: scripts/copy-electron.mjs already copies this whole
// directory into the packaged app as-is, so main.js can import this at
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
