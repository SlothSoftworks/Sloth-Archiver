import fs from 'fs';

// A factory, not bare module-level functions, so this stays a pure Node
// module with no Electron dependency (same reasoning as library.mjs/
// updater.mjs) -- settingsPath (which needs app.getPath('userData')) is
// resolved once by main.mjs and injected here, rather than this module
// reaching for Electron's `app` itself.
export function createSettingsStore(settingsPath) {
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

    return { readSettings, writeSettings };
}

// Caps how many bulk-add items the renderer's queue (useBulkAddQueue.tsx)
// will download at once -- clamped here too, not just in the Options UI,
// since this value round-trips through a plain JSON settings file a user
// could hand-edit.
export const MAX_SIMULTANEOUS_DOWNLOADS_CEILING = 5;

export function clampMaxSimultaneousDownloads(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) return 1;
    return Math.min(Math.max(n, 1), MAX_SIMULTANEOUS_DOWNLOADS_CEILING);
}
