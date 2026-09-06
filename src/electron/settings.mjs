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
// SlothUI is the default for a fresh install -- 'default' (plain MUI) is
// still fully supported and one toggle away, just no longer what a new user
// sees before ever touching Options.
export const THEME_NAME_DEFAULT = 'slothui';

export function clampThemeName(value) {
    return THEME_NAMES.includes(value) ? value : THEME_NAME_DEFAULT;
}

// Bounds for the Library tab's thumbnail-size slider (LibraryBottomBar.tsx).
// 160px floor keeps a video card's title/quality-chip row from wrapping
// awkwardly; 360px ceiling still fits 2+ columns at typical content widths.
// 220px default approximates the old fixed sm:6/md:4 breakpoint sizing, so
// existing users see an unsurprising layout until they touch the slider.
export const THUMBNAIL_SIZE_MIN = 160;
export const THUMBNAIL_SIZE_MAX = 360;
export const THUMBNAIL_SIZE_DEFAULT = 220;

export function clampThumbnailSize(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return THUMBNAIL_SIZE_DEFAULT;
    return Math.min(Math.max(n, THUMBNAIL_SIZE_MIN), THUMBNAIL_SIZE_MAX);
}
