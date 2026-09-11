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

export const MAX_SIMULTANEOUS_DOWNLOADS_CEILING = 5;

export function clampMaxSimultaneousDownloads(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) return 1;
    return Math.min(Math.max(n, 1), MAX_SIMULTANEOUS_DOWNLOADS_CEILING);
}

// Mirrors LibraryScreen.tsx's own SortField/SortDirection unions -- kept as
// a plain string list here (not imported from the renderer) since this is a
// Node module with no dependency on renderer-side TypeScript.
export const LIBRARY_SORT_FIELDS = ['title', 'uploadDate', 'dateAdded', 'channel', 'downloaded', 'quality'];
export const LIBRARY_SORT_FIELD_DEFAULT = 'title';

export function clampLibrarySortField(value) {
    return LIBRARY_SORT_FIELDS.includes(value) ? value : LIBRARY_SORT_FIELD_DEFAULT;
}

export function clampLibrarySortDirection(value) {
    return value === 'desc' ? 'desc' : 'asc';
}

// The overall theme (color palette/typography), independent of light/dark
// mode -- 'default' is this app's original plain-MUI look, 'slothui' is the
// palette pulled from SlothArchiver-info's landing page (see theme.ts).
export const THEME_NAMES = ['default', 'slothui'];
export const THEME_NAME_DEFAULT = 'slothui';

export function clampThemeName(value) {
    return THEME_NAMES.includes(value) ? value : THEME_NAME_DEFAULT;
}

export const THUMBNAIL_SIZE_MIN = 160;
export const THUMBNAIL_SIZE_MAX = 360;
export const THUMBNAIL_SIZE_DEFAULT = 220;

export function clampThumbnailSize(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return THUMBNAIL_SIZE_DEFAULT;
    return Math.min(Math.max(n, THUMBNAIL_SIZE_MIN), THUMBNAIL_SIZE_MAX);
}

export const RESUME_TRACKING_MODES = ['never', 'always', 'custom'];
export const RESUME_TRACKING_MODE_DEFAULT = 'custom';

export function clampResumeTrackingMode(value) {
    return RESUME_TRACKING_MODES.includes(value) ? value : RESUME_TRACKING_MODE_DEFAULT;
}

export const RESUME_MIN_DURATION_SECONDS_DEFAULT = 1200;

export function clampResumeMinDurationSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return RESUME_MIN_DURATION_SECONDS_DEFAULT;
    return Math.floor(n);
}
