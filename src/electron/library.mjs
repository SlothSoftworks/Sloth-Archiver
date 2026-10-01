import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { previewCachePathFor } from './previewCache.mjs';

// Windows reserves these as device names -- CON, PRN.txt, con, etc. all refer
// to the device, not an ordinary file/folder, regardless of case or extension.
// A folder named exactly one of these can't be created at all.
const WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// Top-level reserved folder name for playlist snapshots
// (<libraryDir>/DefaultLibrary/playlists/<playlistId>/<epoch>/metadata.json)
// -- a sibling of channel folders inside a tag folder, not one itself.
// scanLibrary() skips it so it's never mistaken for a channel.
export const PLAYLISTS_DIR_NAME = 'playlists';

// Video-level reserved folder name (sibling of epoch folders, e.g.
// <videoDir>/clips/<clipfile>) for trimmed/converted clips derived from a
// video's downloaded file -- same "reserved name scanLibrary must skip"
// pattern as PLAYLISTS_DIR_NAME, just one level down (video, not library
// root).
export const CLIPS_DIR_NAME = 'clips';

// Top-level reserved folder name for non-YouTube library entries (see
// SlothArchiver-dossier plan for non-YouTube platform support), a sibling of
// real per-uploader channel folders -- same reserved-name pattern as
// PLAYLISTS_DIR_NAME/CLIPS_DIR_NAME above.
export const NONYT_DIR_NAME = 'NonYT';

// SubLibrary / tag library feature (see
// SlothArchiver-dossier/futureSpecsFeedback.md's decided design): every tag,
// including the default untagged case, is a same-filesystem subfolder
// directly under libraryDir -- <libraryDir>/<TagName>/<channel>/<video>/
// <epoch>, uniform for every tag. DEFAULT_LIBRARY_DIR_NAME is just the one
// tag every library starts with; every channel/playlist write and
// scanLibrary's own walk goes through libraryTagDir() below rather than
// libraryDir directly, so switching/adding tags is just a different tagName
// argument, not a different code path.
//
// Deliberately NOT retroactive: a library populated before this layer
// existed (flat channel folders directly under libraryDir) is not migrated
// by this -- accepted deliberately, a clean break rather than migration
// complexity this early in development.
export const DEFAULT_LIBRARY_DIR_NAME = 'DefaultLibrary';

// Per-tag manifest living inside each tag folder -- date created, its tag
// name, and whatever else a future tag-management UI ends up needing,
// without inferring any of it from the folder name alone. Also what
// listLibraryTags() below uses to tell a real tag folder from an unrelated
// one that happens to sit alongside it in libraryDir.
const LIBRARY_METADATA_FILE_NAME = 'library.json';

export function libraryTagDir(libraryDir, tagName = DEFAULT_LIBRARY_DIR_NAME) {
    return path.join(libraryDir, tagName);
}

function libraryTagManifestPath(libraryDir, tagName) {
    return path.join(libraryTagDir(libraryDir, tagName), LIBRARY_METADATA_FILE_NAME);
}

// Read-only counterpart to ensureLibraryTagMetadata below -- returns null
// (never creates anything) so the video-tag functions further down can tell
// "no manifest yet" apart from "manifest exists but has no tags field".
function readLibraryTagManifest(libraryDir, tagName) {
    try {
        return JSON.parse(fs.readFileSync(libraryTagManifestPath(libraryDir, tagName), 'utf-8'));
    } catch {
        return null;
    }
}

function writeLibraryTagManifest(libraryDir, tagName, metadata) {
    fs.writeFileSync(libraryTagManifestPath(libraryDir, tagName), JSON.stringify(metadata, null, 2), 'utf-8');
}

// Lazily creates a tag folder + its library.json manifest the first time
// something is actually about to be written into it. For DEFAULT_LIBRARY_DIR_NAME
// specifically this is never eager (not at app start, not when libraryDir is
// first configured) and never a migration of anything that predates this
// layer -- callers rely on that. A no-op past the first call for a given
// (libraryDir, tagName) pair, which also makes it safe to call unconditionally
// from createLibraryTag()'s own eager creation path below.
//
// The manifest's own name field was renamed tagName -> sublibraryName (to
// stop colliding with the unrelated per-video "tags" concept below) without
// a migration step -- a sublibrary folder written before this rename still
// only has `tagName` on disk, so every reader falls back to it. New writes
// only ever produce sublibraryName; the on-disk key is the only thing that
// changed, the JS-facing shape returned to callers/the renderer is untouched.
function ensureLibraryTagMetadata(libraryDir, tagName = DEFAULT_LIBRARY_DIR_NAME) {
    const dir = libraryTagDir(libraryDir, tagName);
    const metadataPath = path.join(dir, LIBRARY_METADATA_FILE_NAME);
    if (fs.existsSync(metadataPath)) {
        try {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            if (metadata.sublibraryName) return metadata;
            return { ...metadata, sublibraryName: metadata.tagName };
        } catch {
            // Falls through to rewrite a fresh one below if the existing
            // file is somehow corrupt.
        }
    }
    fs.mkdirSync(dir, { recursive: true });
    const metadata = { sublibraryName: tagName, createdEpoch: Date.now() };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return metadata;
}

// Library import (libraryExport.mjs): recreates a sublibrary from an export
// under its original display name and creation date, rather than
// createLibraryTag's "name = folder name, created now". A no-op for a folder
// that already has a manifest.
export function ensureImportedLibraryTag(libraryDir, folderName, sublibraryName, createdEpoch) {
    const metadataPath = libraryTagManifestPath(libraryDir, folderName);
    if (fs.existsSync(metadataPath)) return ensureLibraryTagMetadata(libraryDir, folderName);
    fs.mkdirSync(libraryTagDir(libraryDir, folderName), { recursive: true });
    const metadata = { sublibraryName: sublibraryName || folderName, createdEpoch: Number.isFinite(createdEpoch) ? createdEpoch : Date.now() };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return metadata;
}

// Enumerates every real tag/sublibrary folder directly under libraryDir --
// "real" meaning it has a parseable library.json, same test a random
// unrelated folder a user happens to keep alongside their library would
// fail. Returns [] for a not-yet-existing/empty libraryDir rather than
// throwing, same tolerant stance scanLibrary takes.
export function listLibraryTags(libraryDir) {
    if (!libraryDir || !fs.existsSync(libraryDir)) return [];

    const tags = [];
    let entries;
    try {
        entries = fs.readdirSync(libraryDir, { withFileTypes: true });
    } catch {
        return [];
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metadataPath = path.join(libraryDir, entry.name, LIBRARY_METADATA_FILE_NAME);
        try {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            const sublibraryName = metadata.sublibraryName || metadata.tagName;
            if (!sublibraryName) continue;
            tags.push({ tagName: sublibraryName, folderName: entry.name, createdEpoch: metadata.createdEpoch || null });
        } catch {
            continue;
        }
    }
    tags.sort((a, b) => (a.createdEpoch || 0) - (b.createdEpoch || 0));
    return tags;
}

// Eagerly creates a brand-new sublibrary -- unlike DEFAULT_LIBRARY_DIR_NAME's
// own lazy creation, this is a deliberate, explicit user action ("Add new
// sublibrary"), so the folder + library.json are created immediately, not on
// first write. requestedName goes through the same sanitizer channel names
// already use, and creation is refused outright if anything -- a real tag or
// just an unrelated file/folder -- already exists at that path, rather than
// silently reusing or clobbering it.
export function createLibraryTag(libraryDir, requestedName) {
    if (!libraryDir) {
        throw new Error('No library folder is configured -- set one in Options first.');
    }
    const folderName = sanitizeForFilesystem(requestedName);
    const dir = libraryTagDir(libraryDir, folderName);
    if (fs.existsSync(dir)) {
        throw new Error(`"${folderName}" already exists in your library folder -- pick a different name.`);
    }
    const metadata = ensureLibraryTagMetadata(libraryDir, folderName);
    return { tagName: metadata.sublibraryName, folderName, createdEpoch: metadata.createdEpoch };
}

// Video tags -- a small map living in the SAME per-sublibrary library.json
// manifest as sublibraryName/createdEpoch (not a per-video file), keyed by
// tag name to an array of videoIds carrying that tag within this
// sublibrary. Piggybacking on this file (already read once per sublibrary,
// not once per video) avoids scanLibrary needing a second per-video file
// read it doesn't already do. Deliberately named videoTag(s) everywhere,
// never bare "tag", to stay unambiguous against the unrelated sublibrary
// concept above.
export function listVideoTags(libraryDir, tagName = DEFAULT_LIBRARY_DIR_NAME) {
    const manifest = readLibraryTagManifest(libraryDir, tagName);
    return (manifest && manifest.tags) || {};
}

// Single video/single tag toggle, used by the video-detail popover (the
// only place a tag is ever removed) and, with applied:true, its "create a
// new tag" field -- creating the tag key on first use needs no separate
// function. Removing the last videoId under a tag deletes that key
// entirely, so unchecking a video's last tag doesn't leave a permanent
// empty entry cluttering the picker.
export function setVideoTag({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, tagName, videoId, applied }) {
    ensureLibraryTagMetadata(libraryDir, libraryTag);
    const manifest = readLibraryTagManifest(libraryDir, libraryTag) || {};
    const tags = { ...(manifest.tags || {}) };
    const current = tags[tagName] || [];
    if (applied) {
        if (!current.includes(videoId)) tags[tagName] = [...current, videoId];
    } else if (current.includes(videoId)) {
        const next = current.filter((id) => id !== videoId);
        if (next.length === 0) delete tags[tagName];
        else tags[tagName] = next;
    }
    writeLibraryTagManifest(libraryDir, libraryTag, { ...manifest, tags });
    return { tags };
}

// Bulk add for "Tag selected" -- one read-modify-write appending every
// given videoId into one tag's array (deduped), regardless of how many
// videos were selected. Add-only by design (removal only ever happens
// per-video, via setVideoTag above).
export function addTagToVideos({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, tagName, videoIds }) {
    ensureLibraryTagMetadata(libraryDir, libraryTag);
    const manifest = readLibraryTagManifest(libraryDir, libraryTag) || {};
    const tags = { ...(manifest.tags || {}) };
    const current = new Set(tags[tagName] || []);
    for (const id of videoIds) current.add(id);
    tags[tagName] = [...current];
    writeLibraryTagManifest(libraryDir, libraryTag, { ...manifest, tags });
    return { tags };
}

// Called once after a whole bulk-delete loop finishes (not per video, see
// library:deleteEntries in main.mjs) -- prunes every deleted videoId out of
// every tag in this sublibrary in one read-modify-write, dropping a tag
// entirely if removing these ids empties it. A no-op write is skipped
// entirely when nothing in the manifest actually referenced any of them.
export function removeVideosFromTags(libraryDir, libraryTag, videoIds) {
    if (!videoIds || videoIds.length === 0) return;
    const manifest = readLibraryTagManifest(libraryDir, libraryTag);
    if (!manifest || !manifest.tags) return;
    const remove = new Set(videoIds);
    let changed = false;
    const tags = {};
    for (const [name, ids] of Object.entries(manifest.tags)) {
        const kept = ids.filter((id) => !remove.has(id));
        if (kept.length !== ids.length) changed = true;
        if (kept.length > 0) tags[name] = kept;
    }
    if (!changed) return;
    writeLibraryTagManifest(libraryDir, libraryTag, { ...manifest, tags });
}

// Called once after a whole bulk-move loop finishes (see
// library:moveEntries in main.mjs) -- each moved video keeps whatever tag
// names it already had, only which sublibrary's manifest holds the
// association changes. Exactly two writes total (one per manifest file)
// regardless of how many videos moved or how many tags were involved.
export function transferVideoTags(libraryDir, sourceTag, targetTag, videoIds) {
    if (!videoIds || videoIds.length === 0) return;
    const sourceManifest = readLibraryTagManifest(libraryDir, sourceTag);
    if (!sourceManifest || !sourceManifest.tags) return;

    const moving = new Set(videoIds);
    const movedByTag = {};
    let sourceChanged = false;
    const sourceTags = {};
    for (const [name, ids] of Object.entries(sourceManifest.tags)) {
        const kept = [];
        const moved = [];
        for (const id of ids) (moving.has(id) ? moved : kept).push(id);
        if (moved.length > 0) {
            movedByTag[name] = moved;
            sourceChanged = true;
        }
        if (kept.length > 0) sourceTags[name] = kept;
    }
    if (!sourceChanged) return;
    writeLibraryTagManifest(libraryDir, sourceTag, { ...sourceManifest, tags: sourceTags });

    ensureLibraryTagMetadata(libraryDir, targetTag);
    const targetManifest = readLibraryTagManifest(libraryDir, targetTag) || {};
    const targetTags = { ...(targetManifest.tags || {}) };
    for (const [name, ids] of Object.entries(movedByTag)) {
        const current = new Set(targetTags[name] || []);
        for (const id of ids) current.add(id);
        targetTags[name] = [...current];
    }
    writeLibraryTagManifest(libraryDir, targetTag, { ...targetManifest, tags: targetTags });
}

// Bumped whenever buildEpochMetadata's/writePlaylistSnapshot's own written
// shape gains a field a stale entry won't have. Exported so the renderer can
// compare an entry's stored `schemaVersion` against "what would get written
// today" and surface a "this entry predates newer features, refresh it"
// notice -- see LibraryVideoDetail.tsx/PlaylistsSection.tsx's own duplicated
// copy of these two numbers.
export const CURRENT_VIDEO_SCHEMA_VERSION = 5;
export const CURRENT_PLAYLIST_SCHEMA_VERSION = 2;

// One cross-platform sanitizer using Windows' illegal-character set as the
// superset (rather than branching per-OS) -- keeps folder names identical if
// the library is ever copied between a Mac and a Windows machine, which
// matters given archival/portability is the whole point of this feature.
export function sanitizeForFilesystem(input, maxLength = 100) {
    if (!input) return 'untitled';
    let cleaned = input
        // \x00-\x1F is deliberate: control characters are as illegal in a filename as < > : etc.
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // eslint-disable-line no-control-regex
        .replace(/[.\s]+$/, '')
        .trim();
    cleaned = cleaned.slice(0, maxLength) || 'untitled';
    // Video folders are already protected from this by their " [videoId]"
    // suffix (e.g. "CON [xxxxxxxxxxx]" isn't itself a reserved name), but
    // channel folders have no such suffix -- a channel literally named "CON"
    // would otherwise fail to create on Windows entirely.
    if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
        cleaned += '_';
    }
    return cleaned;
}

// The one safety invariant every destructive/write operation below (and
// handleAppVideoRequest, main.mjs) depends on: never touch a path outside the
// configured library folder. Returns the resolved absolute path when
// targetPath is genuinely inside libraryDir, or null otherwise -- callers
// that need to throw do so themselves with their own wording; main.mjs's
// app-video:// handler instead turns a null into a 403 response.
//
// No configured library means nothing is inside it -- not "anything under
// the process's cwd", which is what path.resolve('') would silently turn an
// unset libraryDir into. Both sides are compared by their real (symlink-
// resolved) location, so a symlink placed inside the library that points
// outside it is rejected rather than followed. The returned path is still
// the plain path.resolve() form, not the realpath, so callers keep seeing
// the same path shape they passed in (e.g. macOS's /var vs /private/var).
// path.relative() output that climbs out of its base: exactly "..", or
// starting with a "../" segment. Not a bare startsWith('..') -- that also
// matched a legitimate folder whose *name* begins with two dots (a channel
// called "..Something", or the sanitizer's ".._.._x"), refusing it as if it
// were outside the library.
function climbsOutOfBase(relative) {
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function resolveInsideLibrary(libraryDir, targetPath) {
    if (!libraryDir || !targetPath) return null;
    const realLibraryDir = realpathOfExistingPrefix(libraryDir);
    // A filesystem root can't be picked as the library any more
    // (validateDirectorySetting, settings.mjs -- SEC-014), but a value saved
    // before that check existed would otherwise make the whole disk "inside".
    if (path.parse(realLibraryDir).root === realLibraryDir) return null;
    const resolvedTarget = path.resolve(targetPath);
    const relative = path.relative(realLibraryDir, realpathOfExistingPrefix(resolvedTarget));
    if (!relative || climbsOutOfBase(relative)) {
        return null;
    }
    return resolvedTarget;
}

// fs.realpathSync throws for a path that doesn't exist yet, but plenty of
// resolveInsideLibrary's callers legitimately ask about one (a temp file
// about to be written, a folder about to be created). Resolves the deepest
// ancestor that does exist and re-appends the rest unchanged -- a
// not-yet-existing segment can't be a symlink, so nothing is lost.
function realpathOfExistingPrefix(targetPath) {
    const resolved = path.resolve(targetPath);
    const pending = [];
    let current = resolved;
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...pending);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return resolved;
            pending.unshift(path.basename(current));
            current = parent;
        }
    }
}

export function channelFolderName(channel) {
    return sanitizeForFilesystem(channel || 'Unknown Channel');
}

// Keyed on videoId, not title -- YouTube titles can change after upload, and
// videoId is stable and already unique on its own. Also shrinks the Windows
// MAX_PATH=260 worst case, though channel-folder length and libraryDir depth
// remain unbounded.
export function videoFolderName(videoId) {
    return sanitizeForFilesystem(videoId);
}

// Non-YouTube video identity/path hash: sha256("${extractorKey}:${id}"),
// truncated to 16 hex chars (64 bits) -- short enough to keep the deeper
// NonYT/<platform>/<hash>/<epoch>/ path well under Windows' MAX_PATH=260,
// and 64 bits is far past any realistic collision risk for a single user's
// personal archive. Falls back to hashing originalUrl when id is missing,
// since id uniqueness isn't guaranteed by every yt-dlp extractor.
export function nonYoutubeVideoHash(extractorKey, id, originalUrl) {
    const input = id ? `${extractorKey}:${id}` : originalUrl;
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// <videoDir>/clips/clips.json -- one JSON array of clip records per video.
// Kept minimal: title/extension are derivable from the clip's own filename;
// this only holds what scanLibrary/ClipCollectionView need cheaply without
// re-invoking ffprobe on every scan.
// Record shape: { id, fileName, title, createdAt, durationSeconds, clipTimestamps }
// clipTimestamps holds the exact start/end timestamp strings ffmpeg was
// invoked with to produce the clip -- not recomputed from durationSeconds,
// since that's a post-hoc length, not the original in/out points -- so
// ClipCollectionView can hand them back to the original video's player
// (see "Mark clip on original video").
function clipsManifestPath(videoDir) {
    return path.join(videoDir, CLIPS_DIR_NAME, 'clips.json');
}

function readClipsManifest(videoDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(clipsManifestPath(videoDir), 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeClipsManifest(videoDir, clips) {
    fs.mkdirSync(path.join(videoDir, CLIPS_DIR_NAME), { recursive: true });
    fs.writeFileSync(clipsManifestPath(videoDir), JSON.stringify(clips, null, 2), 'utf-8');
}

// Deterministic on-disk path for a given clip name + extension -- shared by
// the createClip IPC handler (main.mjs) and anything else that needs to
// agree on what "the same name" resolves to.
export function buildClipFilePath(videoDir, clipName, extension) {
    return path.join(videoDir, CLIPS_DIR_NAME, `${sanitizeForFilesystem(clipName)}.${extension}`);
}

// Full per-clip list, for the Clip Collection view -- fetched on demand
// (library:getClips), not part of the main library index (see scanLibrary's
// own cheap clipCount instead). Drops manifest entries whose file no longer
// exists on disk rather than surfacing them as broken.
export function listClips({ libraryDir, videoDir }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to read clips outside the configured library folder.');
    }
    const clipsDir = path.join(resolvedVideoDir, CLIPS_DIR_NAME);
    return readClipsManifest(resolvedVideoDir).filter((c) => fs.existsSync(path.join(clipsDir, c.fileName)));
}

// Records a clip already written to disk (by ffmpegUtils.mjs's
// clipAndConvert) into clips.json -- mirrors recordLibraryDownload's
// "ffmpeg already wrote the bytes, this just updates the JSON side" split.
// Throws on a duplicate fileName rather than silently overwriting or
// auto-renaming (product decision); the IPC handler turns this into an
// inline dialog error for the renderer.
export function recordClip({ libraryDir, videoDir, fileName, title, durationSeconds, clipTimestamps }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to record a clip outside the configured library folder.');
    }
    const manifest = readClipsManifest(resolvedVideoDir);
    if (manifest.some((c) => c.fileName === fileName)) {
        throw new Error('A clip with this name already exists for this video.');
    }
    const clip = { id: crypto.randomUUID(), fileName, title, createdAt: Date.now(), durationSeconds, clipTimestamps };
    writeClipsManifest(resolvedVideoDir, [...manifest, clip]);
    return clip;
}

// Updates a clip's fileName/durationSeconds in the manifest after
// main.mjs's convertClip handler has already converted the file in place and
// swapped it into position on disk -- this call is purely the JSON-side
// update, mirroring recordClip's own "ffmpeg already wrote the bytes, this
// just updates the JSON side" split. Throws on a fileName collision with a
// *different* clip, same rule and message as recordClip.
export function updateClipFile({ libraryDir, videoDir, clipId, fileName, durationSeconds }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to update a clip outside the configured library folder.');
    }
    const manifest = readClipsManifest(resolvedVideoDir);
    const clip = manifest.find((c) => c.id === clipId);
    if (!clip) {
        throw new Error('Clip not found.');
    }
    if (manifest.some((c) => c.id !== clipId && c.fileName === fileName)) {
        throw new Error('A clip with this name already exists for this video.');
    }
    const updated = { ...clip, fileName, durationSeconds };
    writeClipsManifest(resolvedVideoDir, manifest.map((c) => (c.id === clipId ? updated : c)));
    return updated;
}

// Mirrors deleteLibraryEntry's containment + rmSync pattern, scoped to one
// clip file plus its manifest entry. Clips are identified by generated id,
// not fileName, so callers never need to escape a user-entered filename.
export function deleteClip({ libraryDir, videoDir, clipId }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to delete a clip outside the configured library folder.');
    }
    const clipsDir = path.join(resolvedVideoDir, CLIPS_DIR_NAME);
    const manifest = readClipsManifest(resolvedVideoDir);
    const clip = manifest.find((c) => c.id === clipId);
    if (!clip) {
        return { success: false };
    }
    fs.rmSync(path.join(clipsDir, clip.fileName), { force: true });
    // Orphaned otherwise if this clip ever needed a preview derivative (e.g.
    // saved in its source format and that format wasn't natively playable) --
    // the whole-clipsDir removal below already covers the "last clip"
    // case, this covers deleting one of several.
    fs.rmSync(previewCachePathFor(path.join(clipsDir, clip.fileName)), { force: true });
    const remaining = manifest.filter((c) => c.id !== clipId);
    if (remaining.length === 0) {
        // No clips left -- remove the whole clips/ folder (manifest included)
        // rather than leaving an empty directory + an empty clips.json behind.
        fs.rmSync(clipsDir, { recursive: true, force: true });
    } else {
        writeClipsManifest(resolvedVideoDir, remaining);
    }
    return { success: true };
}

// Fields every entry shares regardless of platform -- factored out so
// buildYoutubeEpochMetadata/buildGenericEpochMetadata below build on the same
// base instead of two independently drifting copies. uploaderId/timestamp/
// license/categories/tags/music are schemaVersion 5 additions (see
// SlothArchiver-dossier's non-YouTube platform support plan) captured
// uniformly off reshapeVideoInfo's own shape for every platform, YouTube
// included, even though only generic entries' UI surfaces them today.
function buildCommonEpochMetadata(videoMetaData, addedEpoch) {
    const { id, title, fullTitle, description, thumbnail, originalUrl, duration, durationString, uploadDate, uploader, resolutions, uploaderId, timestamp, license, categories, tags, music } = videoMetaData;
    return {
        schemaVersion: CURRENT_VIDEO_SCHEMA_VERSION,
        videoId: id,
        channel: uploader || null,
        title: title || null,
        fullTitle: fullTitle || null,
        description: description || null,
        thumbnail: thumbnail || null,
        originalUrl: originalUrl || null,
        duration: duration || null,
        durationString: durationString || null,
        uploadDate: uploadDate || null,
        addedEpoch,
        // Captured at add-time, not fetched live at download-time -- can go
        // stale if the source changes available qualities later. Entries
        // written before this field existed just won't have it.
        resolutions: resolutions || [],
        // Adding a video/version and downloading its file are separate
        // actions -- filled in by recordLibraryDownload() once a download
        // completes.
        downloadedFilePath: null,
        downloadedResolution: null,
        downloadedFormat: null,
        lastPlaybackPositionSeconds: null,
        uploaderId: uploaderId || null,
        timestamp: timestamp || null,
        license: license || null,
        categories: categories || null,
        tags: tags || null,
        music: music || null,
    };
}

// YouTube entries keep channelId -- the one identity field genuinely
// YouTube-specific -- and MP3 as a separate, coexisting artifact (its own
// downloadedAudioFilePath slot, audio.mp3 alongside video.<ext>).
function buildYoutubeEpochMetadata(videoMetaData, addedEpoch) {
    return {
        ...buildCommonEpochMetadata(videoMetaData, addedEpoch),
        platform: videoMetaData.platform || 'youtube',
        channelId: videoMetaData.channelId || null,
        downloadedAudioFilePath: null,
    };
}

// Generic (non-YouTube) entries have no channelId concept -- "who made this"
// is channel/uploaderId instead -- and no separate audio slot: an audio-only
// download (e.g. SoundCloud's only option) writes into the same
// downloadedFilePath/downloadedResolution/downloadedFormat fields any other
// resolution choice would, so it plays through the one real library player
// instead of a bare native <audio> element.
function buildGenericEpochMetadata(videoMetaData, addedEpoch) {
    return {
        ...buildCommonEpochMetadata(videoMetaData, addedEpoch),
        platform: videoMetaData.platform,
        channelId: null,
        downloadedAudioFilePath: null,
    };
}

// Shared by writeLibraryEntry (new video) and addLibraryVersion (new version
// of an existing video) so both ever build exactly one metadata shape per
// platform -- dispatches on videoMetaData.platform so every caller
// (writeLibraryEntry, addLibraryVersion, refreshLibraryEntryMetadata,
// overrideLibraryEntry) stays platform-agnostic. Falsy/'youtube' is the
// YouTube branch (backward compatible with entries that predate this field);
// anything else is generic.
function buildEpochMetadata(videoMetaData, addedEpoch) {
    const isYoutube = !videoMetaData.platform || videoMetaData.platform === 'youtube';
    return isYoutube ? buildYoutubeEpochMetadata(videoMetaData, addedEpoch) : buildGenericEpochMetadata(videoMetaData, addedEpoch);
}

export function writeLibraryEntry({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, videoMetaData }) {
    const { id, uploader, platform, extractorKey, originalUrl } = videoMetaData;
    if (!id) {
        throw new Error('videoMetaData.id is required to add a library entry');
    }
    if (!libraryDir) {
        throw new Error('No library folder is configured -- set one in Options first.');
    }

    ensureLibraryTagMetadata(libraryDir, libraryTag);
    // Non-YouTube entries live under a reserved NonYT/<platform>/ subtree,
    // grouped by platform instead of by uploader (see NONYT_DIR_NAME's own
    // comment) -- <hash> replaces the usual videoId folder name since a raw
    // id/URL isn't guaranteed filesystem-safe or collision-free across
    // extractors the way a YouTube videoId is. Every other write function
    // (addLibraryVersion/refreshLibraryEntryMetadata/overrideLibraryEntry)
    // takes an already-resolved videoDir, so only this path-computing
    // function needs the branch.
    const isGeneric = !!platform && platform !== 'youtube';
    const channelDir = isGeneric
        ? path.join(libraryTagDir(libraryDir, libraryTag), NONYT_DIR_NAME, platform)
        : path.join(libraryTagDir(libraryDir, libraryTag), channelFolderName(uploader));
    const videoDir = isGeneric
        ? path.join(channelDir, nonYoutubeVideoHash(extractorKey, id, originalUrl))
        : path.join(channelDir, videoFolderName(id));
    const addedEpoch = Date.now();
    const epochDir = path.join(videoDir, String(addedEpoch));
    fs.mkdirSync(epochDir, { recursive: true });

    const metadata = buildEpochMetadata(videoMetaData, addedEpoch);
    fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    return { channelDir, videoDir, epochDir, metadata };
}

// "Add new version" -- additive counterpart to overrideLibraryEntry. Adds a
// new epoch under an already-known videoDir rather than re-deriving
// channelDir/videoDir from videoMetaData: if the channel/title drifted since
// the video was first tracked, re-deriving could land the new version in a
// different folder than its own history.
export function addLibraryVersion({ libraryDir, videoDir, videoMetaData }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to add a version outside the configured library folder.');
    }

    const addedEpoch = Date.now();
    const epochDir = path.join(resolvedVideoDir, String(addedEpoch));
    fs.mkdirSync(epochDir, { recursive: true });

    const metadata = buildEpochMetadata(videoMetaData, addedEpoch);
    fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    return { videoDir: resolvedVideoDir, epochDir, epoch: String(addedEpoch), metadata };
}

// "Refresh from YouTube" on a single already-tracked version -- re-fetches
// current metadata and writes it into the *same* epoch, unlike the two other
// update paths: overrideLibraryEntry replaces the whole video, and
// addLibraryVersion adds a brand-new epoch. Neither fits "this version's data
// went stale -- update it in place." Download bookkeeping
// (downloadedFilePath/Resolution/Format/AudioFilePath) is carried over from
// the existing metadata rather than reset -- refreshing metadata never
// touches what's already on disk for this version.
export function refreshLibraryEntryMetadata({ libraryDir, videoDir, epoch, videoMetaData }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to refresh a path outside the configured library folder.');
    }

    const metadataPath = path.join(resolvedVideoDir, epoch, 'metadata.json');
    const existing = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    const fresh = buildEpochMetadata(videoMetaData, existing.addedEpoch);
    const merged = {
        ...fresh,
        downloadedFilePath: existing.downloadedFilePath ?? null,
        downloadedResolution: existing.downloadedResolution ?? null,
        downloadedFormat: existing.downloadedFormat ?? null,
        downloadedAudioFilePath: existing.downloadedAudioFilePath ?? null,
        lastPlaybackPositionSeconds: existing.lastPlaybackPositionSeconds ?? null,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
}

// Called after a download into the library completes -- updates the epoch's
// metadata.json in place rather than writing a new epoch (fulfilling an
// already-tracked entry isn't a new version). kind distinguishes the video
// slot from the coexisting MP3 slot -- 'audio' only touches
// downloadedAudioFilePath, leaving the video fields untouched, and vice versa.
export function recordLibraryDownload({ videoDir, epoch, filePath, resolution, format, kind = 'video' }) {
    const metadataPath = path.join(videoDir, epoch, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    if (kind === 'audio') {
        metadata.downloadedAudioFilePath = filePath;
    } else {
        metadata.downloadedFilePath = filePath;
        metadata.downloadedResolution = resolution || null;
        metadata.downloadedFormat = format || null;
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return metadata;
}

// Grabs a single frame at timestampSeconds and writes it to outputPath.
// Shared by extractLocalFileThumbnail's own best-effort heuristic below and
// the explicit "change thumbnail" flow (replaceLibraryThumbnail) -- unlike
// extractLocalFileThumbnail, this never swallows errors itself; whether a
// failure is fatal is entirely the caller's call.
export async function extractFrameToFile({ ffmpegRunner, inputPath, outputPath, timestampSeconds }) {
    await ffmpegRunner.runFfmpegWithProgress({
        inputPath,
        outputPath,
        codecArgs: ['-frames:v', '1'],
        totalDurationSeconds: 0,
        preInputArgs: timestampSeconds > 0 ? ['-ss', String(timestampSeconds)] : [],
    });
}

// Re-encodes a still image into the fixed video-thumbnail.jpg shape via
// ffmpeg (the same tool already on hand, rather than pulling in an image
// library just for this one conversion) -- ffmpeg treats a single-image
// input as a one-frame source, so the same "-frames:v 1" output args apply.
export async function convertImageToThumbnail({ ffmpegRunner, inputPath, outputPath }) {
    await ffmpegRunner.runFfmpegWithProgress({
        inputPath,
        outputPath,
        codecArgs: ['-frames:v', '1'],
        totalDurationSeconds: 0,
    });
}

// Explicit, user-initiated thumbnail replacement (the video player's "Change
// thumbnail" context menu item) -- unlike extractLocalFileThumbnail below,
// errors are never swallowed: the caller (the library:changeThumbnail IPC
// handler) surfaces them back to the dialog that triggered this. Always
// normalizes to video-thumbnail.jpg regardless of source, so the on-disk
// path never changes; clears out any pre-existing video-thumbnail.* file
// first (mirrors thumbnails.mjs's own downloadImageToFile cleanup) so an
// extension change (e.g. .png -> .jpg) never leaves a stale file behind.
export async function replaceLibraryThumbnail({ videoDir, ffmpegRunner, source }) {
    for (const existing of fs.readdirSync(videoDir).filter((f) => f.startsWith('video-thumbnail.'))) {
        fs.rmSync(path.join(videoDir, existing), { force: true });
    }
    const outputPath = path.join(videoDir, 'video-thumbnail.jpg');
    if (source.type === 'timestamp') {
        await extractFrameToFile({ ffmpegRunner, inputPath: source.videoFilePath, outputPath, timestampSeconds: source.timestampSeconds });
    } else {
        await convertImageToThumbnail({ ffmpegRunner, inputPath: source.imageFilePath, outputPath });
    }
    return outputPath;
}

// Best-effort thumbnail extraction shared by every addLocalFileEntry mode --
// same "never throws" spirit as thumbnails.mjs's own ensureVideoThumbnail: a
// missing/unextractable frame (e.g. an audio-only source) must never fail the
// whole add. offsetSeconds mirrors "3s in, or 10% of a short clip" so it
// never lands past a very short file's own end.
async function extractLocalFileThumbnail({ ffmpegRunner, filePath, videoDir, durationSeconds }) {
    try {
        const offsetSeconds = durationSeconds > 0 ? Math.min(3, durationSeconds / 10) : 0;
        await extractFrameToFile({
            ffmpegRunner, inputPath: filePath, outputPath: path.join(videoDir, 'video-thumbnail.jpg'), timestampSeconds: offsetSeconds,
        });
    } catch {
        // Best-effort -- e.g. no video stream to grab a frame from.
    }
}

// Adds a local (non-yt-dlp) file to the library: copies the source file into
// a new/existing epoch and catalogs it, without ever downloading anything.
// Assumes the caller (the library:addLocalFile IPC handler) has already run
// the duplicate check via findVideoInIndex -- same division of labor as
// DownloaderScreen.tsx's handleAddToLibrary, which checks findLibraryVideo
// itself before ever calling addEntry. This function does not repeat that
// check, so calling it for an id that's already tracked (mode: 'add') would
// silently create a second, competing entry for the same file.
//
// ffmpegRunner is injected (never imported directly), mirroring
// ensurePlayablePreview's (previewCache.mjs) own DI shape -- keeps this
// module free of a hard ffmpeg dependency, consistent with every other
// library.mjs function.
//
// mode 'add' derives a fresh id/videoDir from the file path itself (via
// nonYoutubeVideoHash's originalUrl-fallback branch, since a local file has
// no id/URL of its own); 'override'/'addVersion' instead write into the
// already-known videoDir a duplicate check turned up, mirroring how
// overrideLibraryEntry/addLibraryVersion are already called elsewhere.
export async function addLocalFileEntry({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, sourceFilePath, formFields = {}, ffmpegRunner, mode = 'add', videoDir }) {
    const absoluteFilePath = path.resolve(sourceFilePath);
    const extension = path.extname(absoluteFilePath).slice(1).toLowerCase();

    const [streams, formatTags, durationSeconds] = await Promise.all([
        ffmpegRunner.probeMediaStreams(absoluteFilePath).catch(() => []),
        ffmpegRunner.getMediaFormatTags(absoluteFilePath).catch(() => ({})),
        ffmpegRunner.getMediaDurationSeconds(absoluteFilePath).catch(() => 0),
    ]);
    const videoStream = streams.find((s) => s.codecType === 'video');

    const videoMetaData = {
        id: nonYoutubeVideoHash('local', null, absoluteFilePath),
        extractorKey: 'local',
        platform: 'local',
        originalUrl: null,
        title: formFields.title || null,
        fullTitle: formFields.title || null,
        description: formFields.description || formatTags.comment || null,
        thumbnail: null,
        duration: durationSeconds || null,
        durationString: null,
        uploadDate: formFields.uploadDate || null,
        uploader: formFields.uploader || null,
        uploaderId: null,
        timestamp: null,
        license: formFields.license || null,
        categories: formFields.categories || null,
        tags: formFields.tags || null,
        music: formFields.music || null,
        resolutions: [],
    };

    let epochDir;
    let resolvedVideoDir;
    let epoch;
    if (mode === 'override') {
        const result = overrideLibraryEntry({ libraryDir, libraryTag, videoMetaData, existingVideoDir: videoDir });
        resolvedVideoDir = result.videoDir;
        epochDir = result.epochDir;
        epoch = String(result.metadata.addedEpoch);
    } else if (mode === 'addVersion') {
        const result = addLibraryVersion({ libraryDir, videoDir, videoMetaData });
        resolvedVideoDir = result.videoDir;
        epochDir = result.epochDir;
        epoch = result.epoch;
    } else {
        const result = writeLibraryEntry({ libraryDir, libraryTag, videoMetaData });
        resolvedVideoDir = result.videoDir;
        epochDir = result.epochDir;
        epoch = String(result.metadata.addedEpoch);
    }

    // Temp-then-rename, same pattern as swapLibraryDownload -- a copy that
    // dies partway through must never leave a truncated file masquerading as
    // the real download at its final name.
    const tempFilePath = path.join(epochDir, `video.tmp${path.extname(absoluteFilePath)}`);
    const finalFilePath = path.join(epochDir, `video${path.extname(absoluteFilePath)}`);
    try {
        await fsp.copyFile(absoluteFilePath, tempFilePath);
        fs.renameSync(tempFilePath, finalFilePath);
    } catch (err) {
        fs.rmSync(tempFilePath, { force: true });
        // 'add' created a brand-new videoDir just for this entry -- remove
        // the whole thing rather than leaving a cataloged video with no
        // file. 'override'/'addVersion' only created a new epoch under an
        // already-existing (and otherwise untouched) videoDir, so only that
        // epoch is rolled back.
        fs.rmSync(mode === 'add' ? resolvedVideoDir : epochDir, { recursive: true, force: true });
        throw err;
    }

    await extractLocalFileThumbnail({ ffmpegRunner, filePath: finalFilePath, videoDir: resolvedVideoDir, durationSeconds });

    const metadata = recordLibraryDownload({
        videoDir: resolvedVideoDir,
        epoch,
        filePath: finalFilePath,
        resolution: videoStream?.height ? String(videoStream.height) : undefined,
        format: extension,
        kind: 'video',
    });

    return { videoDir: resolvedVideoDir, epoch, metadata };
}

// Deliberately doesn't refresh the in-memory library index the way
// recordLibraryDownload does -- this write is frequent and cheap, and
// nothing in the library grid reflects it.
export function savePlaybackPosition({ videoDir, epoch, positionSeconds }) {
    const metadataPath = path.join(videoDir, epoch, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    metadata.lastPlaybackPositionSeconds = positionSeconds;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return metadata;
}

// "Download different quality" -- safety rule: never replace in place.
// tempFilePath is wherever the just-completed download landed (a distinct
// "video.new.<ext>" path, never the live file's own path), so a
// failed/interrupted download never touches the working file. Only called
// after startDownload's isDone/isError confirms the new file is real and
// complete.
export function swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath, resolution, format, kind = 'video' }) {
    const resolvedTempFilePath = resolveInsideLibrary(libraryDir, tempFilePath);
    if (!resolvedTempFilePath) {
        throw new Error('Refusing to swap in a file outside the configured library folder.');
    }

    const resolvedVideoDir = path.resolve(videoDir);
    // The deterministic "video.<ext>"/"audio.<ext>" slot downloads live at
    // (see LibraryVideoDetail.tsx's outputPath) -- re-derived from the temp
    // file's own extension since a quality swap can also change format.
    const baseName = kind === 'audio' ? 'audio' : 'video';
    const targetPath = path.join(resolvedVideoDir, epoch, `${baseName}${path.extname(resolvedTempFilePath)}`);

    if (oldFilePath) {
        const resolvedOldFilePath = path.resolve(oldFilePath);
        if (resolvedOldFilePath !== resolvedTempFilePath && fs.existsSync(resolvedOldFilePath)) {
            fs.rmSync(resolvedOldFilePath, { force: true });
        }
    }
    if (targetPath !== resolvedTempFilePath && fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true });
    }
    fs.renameSync(resolvedTempFilePath, targetPath);

    const metadataPath = path.join(resolvedVideoDir, epoch, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    if (kind === 'audio') {
        metadata.downloadedAudioFilePath = targetPath;
    } else {
        metadata.downloadedFilePath = targetPath;
        metadata.downloadedResolution = resolution || null;
        metadata.downloadedFormat = format || null;
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return metadata;
}

// Every epoch of one video shares the same videoId, so reading it off any
// single one is enough -- used right before a whole-video delete removes
// the folder these live in.
function findAnyEpochVideoId(videoDir) {
    let entries;
    try {
        entries = fs.readdirSync(videoDir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === CLIPS_DIR_NAME) continue;
        try {
            const metadata = JSON.parse(fs.readFileSync(path.join(videoDir, entry.name, 'metadata.json'), 'utf-8'));
            if (metadata.videoId) return metadata.videoId;
        } catch {
            continue;
        }
    }
    return null;
}

// Guard-railed against libraryDir even though videoDir always originates
// from our own index -- deleting is destructive enough to be worth defense
// in depth. epoch, when given, deletes just that one version instead of the
// whole video. Deliberately does NOT compute "the new latest remaining
// version" itself -- scanLibrary()'s tolerant newest-valid-epoch logic
// already does that on next refresh, and duplicating the rule here would
// risk the two drifting apart. Callers just need videoDeleted, to decide
// whether to navigate back to the library root or let a refresh pick the
// new latest.
export function deleteLibraryEntry({ libraryDir, videoDir, epoch }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to delete a path outside the configured library folder.');
    }

    if (!epoch) {
        // Read before the rmSync below removes it -- every epoch's
        // metadata.json shares the same videoId, so any one of them will
        // do. Callers use this to prune the video out of the sublibrary's
        // tag map in one batched write after a whole bulk-delete finishes,
        // rather than per video (see library:deleteEntries in main.mjs).
        const videoId = findAnyEpochVideoId(resolvedVideoDir);
        fs.rmSync(resolvedVideoDir, { recursive: true, force: true });
        return { videoDeleted: true, videoId };
    }

    fs.rmSync(path.join(resolvedVideoDir, epoch), { recursive: true, force: true });
    const anyEpochsRemain = fs.existsSync(resolvedVideoDir)
        && fs.readdirSync(resolvedVideoDir, { withFileTypes: true }).some((e) => e.isDirectory());
    if (!anyEpochsRemain) {
        fs.rmSync(resolvedVideoDir, { recursive: true, force: true });
        return { videoDeleted: true };
    }
    return { videoDeleted: false };
}

// Removes just the downloaded media (video and/or separately-downloaded
// audio) across EVERY epoch of a video, leaving the library entry and its
// per-epoch metadata.json in place -- unlike deleteLibraryEntry, this is not
// destructive to the tracked entry itself, only to the files it points at.
// Used by the Library tab's bulk-select "Delete local files" action, which
// deliberately has no per-version targeting (that's what a video's own
// detail view is for) -- every version's file goes in one call.
export function deleteLocalFiles({ libraryDir, videoDir }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to delete files outside the configured library folder.');
    }
    if (!fs.existsSync(resolvedVideoDir)) {
        return { filesDeleted: 0 };
    }

    let filesDeleted = 0;
    for (const entry of fs.readdirSync(resolvedVideoDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const metadataPath = path.join(resolvedVideoDir, entry.name, 'metadata.json');
        if (!fs.existsSync(metadataPath)) continue;

        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        let changed = false;
        if (metadata.downloadedFilePath && fs.existsSync(metadata.downloadedFilePath)) {
            fs.rmSync(metadata.downloadedFilePath, { force: true });
            // Orphaned otherwise: previewCache.mjs's cache-hit check only
            // ever compares against a source file that, from here on, no
            // longer exists to invalidate against.
            fs.rmSync(previewCachePathFor(metadata.downloadedFilePath), { force: true });
            filesDeleted++;
        }
        if (metadata.downloadedFilePath) {
            metadata.downloadedFilePath = null;
            metadata.downloadedResolution = null;
            metadata.downloadedFormat = null;
            changed = true;
        }
        if (metadata.downloadedAudioFilePath && fs.existsSync(metadata.downloadedAudioFilePath)) {
            fs.rmSync(metadata.downloadedAudioFilePath, { force: true });
            filesDeleted++;
        }
        if (metadata.downloadedAudioFilePath) {
            metadata.downloadedAudioFilePath = null;
            changed = true;
        }
        if (changed) {
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
        }
    }
    return { filesDeleted };
}

// Every epoch's metadata.json under videoDir stores downloadedFilePath/
// downloadedAudioFilePath as absolute paths (see checkAndRepairEpochFiles'
// own comment on why that's inherently fragile) -- moveLibraryEntry below
// just renamed the whole folder tree out from under those paths, so unlike
// the reactive, best-effort repair checkAndRepairEpochFiles does (searching
// for a similarly-named file when a path merely turns out to be stale),
// this one knows *exactly* what changed: every epoch's own two path fields
// get the old videoDir prefix swapped for the new one, deterministically.
// clips.json is untouched on purpose -- it only ever stores clip fileNames,
// resolved against videoDir fresh at read time, so a folder move can't make
// those stale in the first place.
//
// Also returns the video's videoId (every epoch shares the same one, so the
// first metadata.json parsed is enough) -- moveLibraryEntry passes it back
// up so callers can transfer the video's tag membership in one batched
// write after a whole bulk-move finishes, rather than per video (see
// library:moveEntries in main.mjs).
function repairMovedEpochPaths(oldVideoDir, newVideoDir) {
    let epochEntries;
    try {
        epochEntries = fs.readdirSync(newVideoDir, { withFileTypes: true });
    } catch {
        return { videoId: null };
    }
    let videoId = null;
    for (const entry of epochEntries) {
        if (!entry.isDirectory() || entry.name === CLIPS_DIR_NAME) continue;
        const metadataPath = path.join(newVideoDir, entry.name, 'metadata.json');
        let metadata;
        try {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        } catch {
            continue;
        }
        if (!videoId && metadata.videoId) videoId = metadata.videoId;
        let changed = false;
        if (metadata.downloadedFilePath && metadata.downloadedFilePath.startsWith(oldVideoDir)) {
            metadata.downloadedFilePath = newVideoDir + metadata.downloadedFilePath.slice(oldVideoDir.length);
            changed = true;
        }
        if (metadata.downloadedAudioFilePath && metadata.downloadedAudioFilePath.startsWith(oldVideoDir)) {
            metadata.downloadedAudioFilePath = newVideoDir + metadata.downloadedAudioFilePath.slice(oldVideoDir.length);
            changed = true;
        }
        if (changed) {
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
        }
    }
    return { videoId };
}

// Moves one video (every epoch, its clips/ folder, its own video-thumbnail.*
// -- the whole videoDir tree as one unit) into a different sublibrary tag,
// under the same channel folder name it already had. Every tag lives on the
// same filesystem under the same libraryDir by design (see
// DEFAULT_LIBRARY_DIR_NAME's own comment), so this is a plain, atomic
// fs.renameSync -- no cross-filesystem copy+verify+delete needed.
//
// Channel data is copied "if needed" only: if the target sublibrary doesn't
// already have a folder for this channel, it's created and the source's
// channel-icon.* (if any) is copied into it; if the target channel folder
// already exists, it's left completely alone. Deliberately does NOT touch
// the *source* channel folder afterward, even if this was its last video --
// no cleanup, no re-counting, on purpose (a decided scope cut: moving and
// cleanup are separate responsibilities; an orphaned source channel
// folder -- just a channel-icon.* with no videos left under it -- is left
// for a future dedicated cleanup pass, not this function).
export function moveLibraryEntry({ libraryDir, videoDir, targetTag }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to move a path outside the configured library folder.');
    }
    if (!targetTag) {
        throw new Error('No target sublibrary given.');
    }

    const sourceChannelDir = path.dirname(resolvedVideoDir);
    const channelDirName = path.basename(sourceChannelDir);
    const videoDirName = path.basename(resolvedVideoDir);

    ensureLibraryTagMetadata(libraryDir, targetTag);
    const targetChannelDir = path.join(libraryTagDir(libraryDir, targetTag), channelDirName);
    const targetVideoDir = path.join(targetChannelDir, videoDirName);

    if (fs.existsSync(targetVideoDir)) {
        throw new Error('This video already exists in the target sublibrary.');
    }

    const targetChannelDirExisted = fs.existsSync(targetChannelDir);
    fs.mkdirSync(targetChannelDir, { recursive: true });
    if (!targetChannelDirExisted) {
        const iconEntry = fs.existsSync(sourceChannelDir)
            && fs.readdirSync(sourceChannelDir, { withFileTypes: true }).find((e) => e.isFile() && e.name.startsWith('channel-icon.'));
        if (iconEntry) {
            fs.copyFileSync(path.join(sourceChannelDir, iconEntry.name), path.join(targetChannelDir, iconEntry.name));
        }
    }

    fs.renameSync(resolvedVideoDir, targetVideoDir);
    const { videoId } = repairMovedEpochPaths(resolvedVideoDir, targetVideoDir);

    return { videoDir: targetVideoDir, videoId };
}

// "Override" means replace the tracked entry, not add another version.
// Deletes existingVideoDir exactly as given (from an earlier
// findVideoInIndex lookup) rather than re-deriving it from videoMetaData --
// if the title or channel display name drifted, writeLibraryEntry could land
// on a different path than the one being replaced, missing the real old
// folder.
export function overrideLibraryEntry({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, videoMetaData, existingVideoDir }) {
    if (existingVideoDir && fs.existsSync(existingVideoDir)) {
        fs.rmSync(existingVideoDir, { recursive: true, force: true });
    }
    return writeLibraryEntry({ libraryDir, libraryTag, videoMetaData });
}

// downloadedFilePath/downloadedAudioFilePath are absolute paths, captured
// once at download time and never recomputed -- if the library folder tree
// ever moves (a user reorganizing by hand, or this project's own DefaultLibrary
// migration landing under an already-populated library folder), every
// stored path silently goes stale: playback, "open file location", and every
// ffmpeg action all read this same field directly. Deliberately NOT checked
// during scanLibrary -- that would mean a stat() per downloaded file on every
// single library scan, most of which nobody's about to look at. Instead this
// is called on demand, scoped to one video's one epoch, when the video
// detail view actually opens it (see checkAndRepairEpochFiles below) --
// "repair the one thing the user is looking at right now," not "audit the
// whole library eagerly."
//
// Only ever *repairs* a confirmed-missing path to a confirmed-present one at
// the file's own current, correct epoch folder (matched by the deterministic
// 'video.<ext>'/'audio.<ext>' naming swapLibraryDownload always writes
// under) -- never invents a path, never nulls one out just because it's
// missing (that could just as easily be removable/network media that's
// temporarily unmounted, not a real deletion).
//
// NOTE for the future "move between libraries" (SubLibrary tag-switch) work:
// moving a video's folder between tags will hit this exact same staleness
// unless that feature also rewrites these two fields itself -- don't rely on
// this on-demand repair alone for that case, since it only fires when a user
// actually opens the affected video, not proactively on the move itself.
function repairStaleDownloadedPath(epochDir, storedPath, expectedPrefix) {
    if (!storedPath || fs.existsSync(storedPath)) return storedPath;
    let entries;
    try {
        entries = fs.readdirSync(epochDir, { withFileTypes: true });
    } catch {
        return storedPath;
    }
    // Anchored, single-extension match only -- deliberately excludes
    // swapLibraryDownload's own transient 'video.new.<ext>' temp file, which
    // can briefly coexist with the real one mid-swap and must never be
    // mistaken for it.
    const pattern = new RegExp(`^${expectedPrefix}\\.[A-Za-z0-9]+$`);
    const match = entries.find((e) => e.isFile() && pattern.test(e.name));
    return match ? path.join(epochDir, match.name) : storedPath;
}

// The on-demand entry point itself -- called once when the video detail view
// opens a given epoch (LibraryVideoDetail.tsx), not as part of any bulk
// scan. Checks whichever of downloadedFilePath/downloadedAudioFilePath are
// actually set, repairs what it can, and reports back what's still missing
// so the UI can warn the user (re-download, or restore the file manually)
// rather than silently failing on the first play/open attempt.
export function checkAndRepairEpochFiles({ libraryDir, videoDir, epoch }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to check files outside the configured library folder.');
    }
    const epochDir = path.join(resolvedVideoDir, epoch);
    const metadataPath = path.join(epochDir, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

    let changed = false;
    let videoRepaired = false;
    let audioRepaired = false;

    if (metadata.downloadedFilePath) {
        const repaired = repairStaleDownloadedPath(epochDir, metadata.downloadedFilePath, 'video');
        if (repaired !== metadata.downloadedFilePath) {
            metadata.downloadedFilePath = repaired;
            changed = true;
            videoRepaired = true;
        }
    }
    if (metadata.downloadedAudioFilePath) {
        const repaired = repairStaleDownloadedPath(epochDir, metadata.downloadedAudioFilePath, 'audio');
        if (repaired !== metadata.downloadedAudioFilePath) {
            metadata.downloadedAudioFilePath = repaired;
            changed = true;
            audioRepaired = true;
        }
    }

    if (changed) {
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    }

    return {
        metadata,
        videoRepaired,
        audioRepaired,
        // Still broken even after the repair attempt above -- distinct from
        // "was never downloaded" (the field is simply null/absent), which
        // isn't something to warn about at all.
        videoMissing: !!metadata.downloadedFilePath && !fs.existsSync(metadata.downloadedFilePath),
        audioMissing: !!metadata.downloadedAudioFilePath && !fs.existsSync(metadata.downloadedAudioFilePath),
    };
}

// Video-level, not per-epoch -- ensureVideoThumbnail (main.mjs) saves
// exactly one video-thumbnail.* file directly in videoDir, a sibling of the
// epoch folders, same pattern as channel-icon.* one level up. Accepts
// already-fetched directory entries (scanLibrary already has them from its
// own walk) to avoid a redundant readdir; fetches its own otherwise.
export function findVideoThumbnailPath(videoDir, entries = null) {
    const dirEntries = entries || fs.readdirSync(videoDir, { withFileTypes: true });
    const thumbnailEntry = dirEntries.find((e) => e.isFile() && e.name.startsWith('video-thumbnail.'));
    return thumbnailEntry ? path.join(videoDir, thumbnailEntry.name) : null;
}

// Inner video/epoch walk, one level down from a channel-shaped folder --
// shared by scanLibrary's two directory shapes below (a real per-uploader
// channel folder, and a NonYT/<platform> synthetic one) so the walk logic
// exists in exactly one place. Returns null when the folder is unreadable or
// has no valid video in it, so both callers can just `continue` on a falsy
// result the same way the old single inline loop did.
// PERF-001 (reports/PerformanceAnalysis.md): the scan used to await one
// fs.promises call after another -- three or so per video -- and each
// awaited call costs several thread-pool round trips (an fsp.readFile is
// open + stat + read + close), ~185 us each on the benchmark machine
// against ~6 us for readFileSync. That overhead, not disk speed, was the
// scan's cost: ~32 s warm for a 100k-video library. The walk now reads
// synchronously and hands the event loop back every SCAN_YIELD_INTERVAL_MS,
// so IPC (download progress, other handlers) still gets a turn at least
// that often while a big library scans. The trade-off: on very slow storage
// (a network share) one blocking read can now hold the main process for
// that read's own latency, where the async version wouldn't have.
const SCAN_YIELD_INTERVAL_MS = 8;

export function createScanYielder() {
    let lastYield = performance.now();
    return async function yieldIfDue() {
        if (performance.now() - lastYield < SCAN_YIELD_INTERVAL_MS) return;
        await new Promise((resolve) => setImmediate(resolve));
        lastYield = performance.now();
    };
}

// One video folder's index entry -- its epochs (newest first), latest
// valid metadata, thumbnail and clip count -- or null when it has no epoch
// with readable metadata (such a folder is left out of the index). Shared
// by the full scan and patchLibraryIndex, so both build identical entries.
function readVideoEntry(videoPath, videoFolderName) {
    let epochEntries;
    try {
        epochEntries = fs.readdirSync(videoPath, { withFileTypes: true });
    } catch {
        return null;
    }

    // Epoch folder names are Date.now() timestamps -- numeric descending
    // sort puts the most recent attempt first. clips/ is a reserved
    // sibling directory (CLIPS_DIR_NAME), explicitly excluded here the
    // same way PLAYLISTS_DIR_NAME is excluded one level up -- without
    // this it would fall into this filter, sort unpredictably
    // (Number('clips') is NaN), and only be skipped by the
    // metadata.json read below happening to fail.
    const epochNames = epochEntries
        .filter((e) => e.isDirectory() && e.name !== CLIPS_DIR_NAME)
        .map((e) => e.name)
        .sort((a, b) => Number(b) - Number(a));

    let metadata = null;
    let latestEpoch = null;
    const epochs = [];
    for (const epochName of epochNames) {
        try {
            const raw = fs.readFileSync(path.join(videoPath, epochName, 'metadata.json'), 'utf-8');
            const epochMetadata = JSON.parse(raw);
            epochs.push({ epoch: epochName, metadata: epochMetadata });
            if (!metadata) {
                metadata = epochMetadata;
                latestEpoch = epochName;
            }
        } catch {
            continue;
        }
    }

    if (!metadata) return null;

    // Cheap (one JSON parse) -- only the count rides along in the main
    // index; the full per-clip list is fetched lazily via
    // library:getClips when the Clip Collection view actually opens.
    // Skipped outright when there's no clips/ folder (most videos):
    // a failed read costs a thrown ENOENT per video, measurably more
    // than the listing check.
    const hasClipsDir = epochEntries.some((e) => e.isDirectory() && e.name === CLIPS_DIR_NAME);
    const clipCount = hasClipsDir ? readClipsManifest(videoPath).length : 0;

    return {
        videoFolderName,
        videoDir: videoPath,
        latestEpoch,
        metadata,
        epochs,
        thumbnailPath: findVideoThumbnailPath(videoPath, epochEntries),
        clipCount,
    };
}

// Newest-added first; ties broken by folder name so the order never
// depends on how the OS happens to list a directory -- which also lets a
// patched index (patchLibraryIndex) come out in exactly the same order.
function compareVideoEntries(a, b) {
    return ((b.metadata.addedEpoch || 0) - (a.metadata.addedEpoch || 0))
        || (a.videoFolderName < b.videoFolderName ? -1 : a.videoFolderName > b.videoFolderName ? 1 : 0);
}

function compareChannelEntries(a, b) {
    return a.displayName.localeCompare(b.displayName)
        || (a.channelFolderName < b.channelFolderName ? -1 : a.channelFolderName > b.channelFolderName ? 1 : 0);
}

// A channel's index entry from its (already sorted) videos. channelKey is
// its folder relative to the sublibrary: "<channel>" for YouTube, or
// "NonYT/<platform>" for a platform group, which has no channel icon.
function buildChannelEntry(channelKey, channelPath, videos, iconEntryName) {
    const segments = channelKey.split(path.sep);
    if (segments.length === 2 && segments[0] === NONYT_DIR_NAME) {
        return {
            channelFolderName: channelKey,
            displayName: segments[1],
            channelIconPath: null,
            isPlatformGroup: true,
            platform: segments[1],
            videos,
        };
    }
    return {
        channelFolderName: channelKey,
        displayName: videos[0]?.metadata.channel || channelKey,
        channelIconPath: iconEntryName ? path.join(channelPath, iconEntryName) : null,
        videos,
    };
}

// Cached by ensureChannelIcon (main.mjs) the first time a video from a
// channel gets added.
function findChannelIconName(dirEntries) {
    return dirEntries.find((e) => e.isFile() && e.name.startsWith('channel-icon.'))?.name || null;
}

async function scanChannelLikeFolder(channelPath, yieldIfDue) {
    let videoEntries;
    try {
        videoEntries = fs.readdirSync(channelPath, { withFileTypes: true });
    } catch {
        return null;
    }

    const videos = [];
    for (const videoEntry of videoEntries) {
        if (!videoEntry.isDirectory()) continue;
        await yieldIfDue();
        const video = readVideoEntry(path.join(channelPath, videoEntry.name), videoEntry.name);
        if (video) videos.push(video);
    }

    if (videos.length === 0) return null;
    videos.sort(compareVideoEntries);
    // videoEntries already lists everything directly inside channelPath
    // (files included), so the icon is a free lookup rather than a second
    // readdir.
    return { videos, iconEntryName: findChannelIconName(videoEntries) };
}

// Bounded 3-level walk (channel/video/epoch), tolerant of partial or corrupt
// folders -- a missing or unparseable metadata.json is skipped rather than
// failing the whole scan, since an interrupted write is always conceivable.
// Collects every valid epoch into `epochs` (newest first) for the
// version-control UI; `latestEpoch`/`metadata` stay pointed at the newest
// valid one, which every other consumer reads.
//
// NONYT_DIR_NAME gets one extra level of recursion: instead of being a real
// channel folder, it's a container of per-platform folders, each flattened
// into this same top-level `channels` array as its own synthetic
// isPlatformGroup entry (see NONYT_DIR_NAME's own comment). channelFolderName
// for one of these is the full NonYT/<platform> relative path (via
// path.join), not a bare folder name -- every consumer (moveLibraryEntry,
// library:refreshChannelIcon in main.mjs) builds an absolute path via
// path.join(libraryTagDir(...), channelFolderName) directly, and only the
// full relative path resolves correctly through that.
export async function scanLibrary(libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME) {
    const index = { channels: [] };
    if (!libraryDir) {
        return index;
    }
    // Scans the given tag's own folder, not libraryDir itself -- see
    // libraryTagDir's own comment. Not fs.existsSync(libraryDir) either:
    // a freshly-configured libraryDir with nothing written into it yet is
    // exactly the same "empty index" case as one whose tag subfolder hasn't
    // been created (lazily, for DEFAULT_LIBRARY_DIR_NAME) yet.
    const scanRoot = libraryTagDir(libraryDir, libraryTag);
    if (!fs.existsSync(scanRoot)) {
        return index;
    }

    let channelEntries;
    try {
        channelEntries = fs.readdirSync(scanRoot, { withFileTypes: true });
    } catch {
        return index;
    }
    const yieldIfDue = createScanYielder();

    for (const channelEntry of channelEntries) {
        if (!channelEntry.isDirectory()) continue;
        if (channelEntry.name === PLAYLISTS_DIR_NAME) continue;

        if (channelEntry.name === NONYT_DIR_NAME) {
            const nonytRoot = path.join(scanRoot, channelEntry.name);
            let platformEntries;
            try {
                platformEntries = fs.readdirSync(nonytRoot, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const platformEntry of platformEntries) {
                if (!platformEntry.isDirectory()) continue;
                const platformPath = path.join(nonytRoot, platformEntry.name);
                const result = await scanChannelLikeFolder(platformPath, yieldIfDue);
                if (!result) continue;
                index.channels.push(buildChannelEntry(path.join(NONYT_DIR_NAME, platformEntry.name), platformPath, result.videos, null));
            }
            continue;
        }

        const channelPath = path.join(scanRoot, channelEntry.name);
        const result = await scanChannelLikeFolder(channelPath, yieldIfDue);
        if (!result) continue;
        index.channels.push(buildChannelEntry(channelEntry.name, channelPath, result.videos, result.iconEntryName));
    }

    index.channels.sort(compareChannelEntries);
    return index;
}

// PERF-002/008: brings an index up to date after writes to specific video
// folders by re-reading only those folders (plus each affected channel's
// own listing for its icon) instead of the whole sublibrary. Handles a
// video added, updated, or removed, a channel appearing or disappearing,
// and re-sorting -- the result is deep-equal to a fresh scanLibrary() as
// long as nothing *else* changed on disk (that's what the full
// refreshLibraryIndex is for). Returns a new index object; the one passed
// in is not modified, since it may already have been handed out. Returns
// null for a path it can't place (outside the sublibrary, or not shaped
// like a video folder), so the caller can fall back to a full scan.
export function patchLibraryIndex(index, libraryDir, libraryTag, videoDirs) {
    const scanRoot = libraryTagDir(libraryDir, libraryTag);
    const byChannel = new Map();
    for (const videoDir of videoDirs) {
        const relative = path.relative(scanRoot, videoDir);
        if (!relative || climbsOutOfBase(relative)) return null;
        const segments = relative.split(path.sep);
        const isNonYt = segments[0] === NONYT_DIR_NAME;
        if (segments.length !== (isNonYt ? 3 : 2) || segments[0] === PLAYLISTS_DIR_NAME) return null;
        const channelKey = path.join(...segments.slice(0, -1));
        if (!byChannel.has(channelKey)) byChannel.set(channelKey, new Set());
        byChannel.get(channelKey).add(path.join(scanRoot, relative));
    }

    const channels = [...index.channels];
    for (const [channelKey, changedDirs] of byChannel) {
        const channelPath = path.join(scanRoot, channelKey);
        const position = channels.findIndex((c) => c.channelFolderName === channelKey);
        const videos = (position >= 0 ? channels[position].videos : []).filter((v) => !changedDirs.has(v.videoDir));
        for (const videoDir of changedDirs) {
            const video = readVideoEntry(videoDir, path.basename(videoDir));
            if (video) videos.push(video);
        }
        if (videos.length === 0) {
            if (position >= 0) channels.splice(position, 1);
            continue;
        }
        videos.sort(compareVideoEntries);
        let iconEntryName = null;
        try {
            iconEntryName = findChannelIconName(fs.readdirSync(channelPath, { withFileTypes: true }));
        } catch {
            iconEntryName = null;
        }
        const entry = buildChannelEntry(channelKey, channelPath, videos, iconEntryName);
        if (position >= 0) channels[position] = entry;
        else channels.push(entry);
    }
    channels.sort(compareChannelEntries);
    return { ...index, channels };
}

// getLibraryIndex reuses whatever scan is already in flight (or already
// resolved) for the current (libraryDir, libraryTag) pair, rather than
// kicking off a redundant scan on every call -- so an app-start background
// scan and a Library-tab mount asking for the index at roughly the same time
// share one walk. Keyed on BOTH libraryDir and libraryTag, not libraryDir
// alone -- libraryDir stays constant while switching sublibraries, so a
// cache keyed only on it would keep serving the previously-active
// sublibrary's stale index after a switch.
let indexPromise = null;
let indexPromiseDir = null;
let indexPromiseTag = null;

export function getLibraryIndex(libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME) {
    if (!indexPromise || indexPromiseDir !== libraryDir || indexPromiseTag !== libraryTag) {
        indexPromise = scanLibrary(libraryDir, libraryTag);
        indexPromiseDir = libraryDir;
        indexPromiseTag = libraryTag;
    }
    return indexPromise;
}

// True when the in-memory index cache currently holds (or is building) this
// sublibrary's scan. The cache holds exactly one sublibrary at a time, so a
// write to a sublibrary that isn't cached has nothing stale to refresh --
// the next getLibraryIndex() for it scans fresh anyway.
export function isLibraryIndexCachedFor(libraryDir, libraryTag) {
    return !!indexPromise && indexPromiseDir === libraryDir && indexPromiseTag === libraryTag;
}

// The sublibrary (tag folder name) a path inside the library belongs to --
// its first path segment under libraryDir -- or null for a path outside it.
// Lets a write that only knows its videoDir refresh the sublibrary it
// actually changed instead of assuming the active one.
export function libraryTagForPath(libraryDir, targetPath) {
    if (!libraryDir || !targetPath) return null;
    const relative = path.relative(path.resolve(libraryDir), path.resolve(targetPath));
    if (!relative || climbsOutOfBase(relative)) return null;
    return relative.split(path.sep)[0];
}

export function refreshLibraryIndex(libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME) {
    indexPromise = scanLibrary(libraryDir, libraryTag);
    indexPromiseDir = libraryDir;
    indexPromiseTag = libraryTag;
    return indexPromise;
}

// The incremental counterpart to refreshLibraryIndex: after writes to the
// given video folders, patches the cached index (patchLibraryIndex) instead
// of rescanning the whole sublibrary. Chained onto the current cache entry,
// so it applies after any scan or patch already in flight, in call order.
// Returns the updated index promise, or null when this sublibrary isn't
// the one cached (nothing to update -- its next getLibraryIndex scans
// fresh anyway). Falls back to a full scan if the patch can't place a path
// or the cached scan had failed.
export function updateLibraryIndexForVideoDirs(libraryDir, libraryTag, videoDirs) {
    if (!isLibraryIndexCachedFor(libraryDir, libraryTag)) return null;
    const rescan = () => scanLibrary(libraryDir, libraryTag);
    indexPromise = indexPromise.then(
        (index) => patchLibraryIndex(index, libraryDir, libraryTag, videoDirs) ?? rescan(),
        rescan,
    );
    return indexPromise;
}

// Keyed by videoId specifically (not folder name/title) -- it's the one field
// guaranteed unique per video regardless of which channel folder it landed
// under, same reasoning already applied to the folder-collision fix.
//
// platform is optional and backward compatible: existing call sites that
// don't pass it are unaffected (matches on videoId alone, same as before).
// When given, it also disambiguates videos whose raw id happens to collide
// across two different extractors -- id uniqueness is only guaranteed
// *within* one extractor, not across all of them. A video's own
// metadata.platform being null/absent (an entry written before this field
// existed) is treated as 'youtube' for this comparison, same backward-compat
// default buildEpochMetadata uses.
export function findVideoInIndex(index, videoId, platform) {
    for (const channel of index.channels) {
        const video = channel.videos.find((v) => {
            if (v.metadata.videoId !== videoId) return false;
            if (!platform) return true;
            return (v.metadata.platform || 'youtube') === platform;
        });
        if (video) {
            return { channel, video };
        }
    }
    return null;
}

// findVideoInIndex walks every channel/video, which is fine for one lookup
// but not for one per playlist entry: a 50k-entry playlist against a 100k-
// video library spent ~141 s blocked in that loop (PERF-009,
// reports/PerformanceAnalysis.md). This builds a videoId map once and
// returns a lookup with exactly findVideoInIndex's semantics -- same
// first-match order (channels, then videos, as the index lists them), same
// optional platform filter -- for callers that look up many ids against the
// same index. Built per call rather than cached on the index object, so a
// lookup can never go stale.
export function createVideoLookup(index) {
    const byVideoId = new Map();
    for (const channel of index.channels) {
        for (const video of channel.videos) {
            const matches = byVideoId.get(video.metadata.videoId);
            if (matches) matches.push({ channel, video });
            else byVideoId.set(video.metadata.videoId, [{ channel, video }]);
        }
    }
    return function lookupVideo(videoId, platform) {
        const matches = byVideoId.get(videoId);
        if (!matches) return null;
        if (!platform) return matches[0];
        return matches.find(({ video }) => (video.metadata.platform || 'youtube') === platform) || null;
    };
}

// A title that's missing, or that's literally just the video's own id, means
// "we don't actually know this video's title" -- yt-dlp's flat-playlist
// listing sometimes has no title at all for an entry (most often an
// unavailable/deleted/private video), and this catches that case rather
// than letting a caller accidentally persist the id string as if it were
// real, meaningful title data.
function isDeadTitle(title, videoId) {
    return !title || title === videoId;
}

// One-time snapshot of a fetched playlist's contents, not a live-synced
// mirror -- uses the same epoch-folder shape as a video's own versioning
// (<libraryDir>/playlists/<playlistId>/<epoch>/metadata.json), but a
// playlist gets exactly one epoch ever: every bulk-add run against the same
// playlist link calls this again, and without that guard it would pile up a
// duplicate epoch folder per run.
//
// localFiles maps each entry's videoId to its current videoDir in the
// library (or null), computed once from the index as of this snapshot.
// Entries also carry their own title/thumbnailUrl/uploadDate rather than a
// bare videoId/url, since most won't have a localFiles match yet at
// save-time (nothing's downloaded) and this is the fallback display data
// for those.
export function writePlaylistSnapshot({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, playlistId, title, uploader, originalUrl, entries, index }) {
    ensureLibraryTagMetadata(libraryDir, libraryTag);
    const playlistDir = path.join(libraryTagDir(libraryDir, libraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));

    if (fs.existsSync(playlistDir) && fs.readdirSync(playlistDir, { withFileTypes: true }).some((e) => e.isDirectory())) {
        return { playlistDir, epochDir: null, epoch: null, metadata: null, skipped: true };
    }

    const addedEpoch = Date.now();
    const epochDir = path.join(playlistDir, String(addedEpoch));
    fs.mkdirSync(epochDir, { recursive: true });

    const localFiles = {};
    const lookupVideo = createVideoLookup(index);
    for (const entry of entries) {
        const match = lookupVideo(entry.videoId);
        localFiles[entry.videoId] = match ? match.video.videoDir : null;
    }

    const metadata = {
        schemaVersion: CURRENT_PLAYLIST_SCHEMA_VERSION,
        playlistId,
        title: title || null,
        uploader: uploader || null,
        originalUrl: originalUrl || null,
        addedEpoch,
        // Set only by reconcilePlaylistSnapshot, once a refresh actually
        // happens -- null here means "never refreshed since the initial
        // save," which the UI treats as addedEpoch itself being the most
        // recent update.
        lastRefreshedEpoch: null,
        entries: entries.map((e) => ({
            videoId: e.videoId,
            title: isDeadTitle(e.title, e.videoId) ? null : e.title,
            url: e.url,
            thumbnailUrl: e.thumbnailUrl || null,
            uploadDate: e.uploadDate || null,
            // Flagged explicitly (rather than the UI just inferring it from a
            // null title) so a future refresh has a reliable signal to clear
            // once the video is confirmed alive again, independent of
            // whatever ends up in title.
            unavailable: isDeadTitle(e.title, e.videoId),
        })),
        localFiles,
        // Set only via setPlaylistManualThumbnail below -- null means
        // "automatic" (follow the first available entry, see
        // resolvePlaylistThumbnailUrl).
        manualThumbnailVideoId: null,
    };
    fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    return { playlistDir, epochDir, epoch: String(addedEpoch), metadata };
}

// Patches a single already-saved playlist entry with real data once it's
// known -- called from the bulk-add loop right after a video belonging to a
// saved playlist gets its own info fetched (see useBulkAddQueue.tsx).
// Additive/non-destructive: a dead incoming title or missing
// uploadDate/thumbnailUrl never overwrites what's already stored, so a later
// playlist re-fetch that sees the video as unavailable can't regress data
// already captured. Silently no-ops if the playlist was never saved, or
// doesn't have this entry -- the common case for a video not part of any
// known playlist.
export function enrichPlaylistEntry({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, playlistId, videoId, title, uploadDate, thumbnailUrl }) {
    const playlistDir = path.join(libraryTagDir(libraryDir, libraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
    if (!fs.existsSync(playlistDir)) return null;

    // Only ever one epoch today (writePlaylistSnapshot), but read whichever
    // is newest rather than assuming a specific name, in case that changes.
    const epochNames = fs.readdirSync(playlistDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => Number(b) - Number(a));
    if (epochNames.length === 0) return null;

    const metadataPath = path.join(playlistDir, epochNames[0], 'metadata.json');
    let metadata;
    try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    } catch {
        return null;
    }

    const entry = metadata.entries.find((e) => e.videoId === videoId);
    if (!entry) return null;

    if (!isDeadTitle(title, videoId)) {
        entry.title = title;
        entry.unavailable = false;
    }
    if (uploadDate) entry.uploadDate = uploadDate;
    if (thumbnailUrl) entry.thumbnailUrl = thumbnailUrl;

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return metadata;
}

// Shared by every playlist-refresh/read function below -- a playlist only
// ever has the one epoch writePlaylistSnapshot created, but reads whichever
// is newest by name rather than assuming a specific one, same defensive
// stance enrichPlaylistEntry already takes above.
// Exported for libraryExport.mjs -- the newest epoch folder of a saved
// playlist, or null when there's no snapshot there.
export function findPlaylistEpochDir(playlistDir) {
    return resolvePlaylistEpochDir(playlistDir);
}

function resolvePlaylistEpochDir(playlistDir) {
    if (!fs.existsSync(playlistDir)) return null;
    const epochNames = fs.readdirSync(playlistDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => Number(b) - Number(a));
    if (epochNames.length === 0) return null;
    return path.join(playlistDir, epochNames[0]);
}

// Playlist-level (not per-epoch), a sibling of the epoch folders -- same
// pattern as channel-icon.*/video-thumbnail.*. Cached by
// ensurePlaylistThumbnail (main.mjs) as a fallback for when the live
// resolved thumbnail (see resolvePlaylistThumbnailUrl below) has no
// thumbnailUrl of its own (empty playlist, or every entry dead) -- the
// renderer always prefers the live thumbnailUrl when available. Exported so
// main.mjs can re-read it after calling ensurePlaylistThumbnail itself
// (that function lives there, not here -- it needs the thumbnails.mjs
// fetcher instance main.mjs already owns).
export function findPlaylistThumbnailPath(playlistDir) {
    if (!fs.existsSync(playlistDir)) return null;
    const entry = fs.readdirSync(playlistDir, { withFileTypes: true })
        .find((e) => e.isFile() && e.name.startsWith('playlist-thumbnail.'));
    return entry ? path.join(playlistDir, entry.name) : null;
}

// Skips unavailable/thumbnail-less entries rather than blindly trusting
// entries[0] -- a dead or thumbnail-less first entry used to leave the
// playlist showing a broken/missing image even though later entries had a
// perfectly good one. Falls back to entries[0]'s own thumbnailUrl (possibly
// null) only once every entry has been checked and none qualify, so this
// never returns worse than the old unconditional behavior.
export function firstAvailablePlaylistThumbnail(entries) {
    const available = (entries || []).find((e) => !e.unavailable && e.thumbnailUrl);
    if (available) return available.thumbnailUrl;
    return entries?.[0]?.thumbnailUrl || null;
}

// The single source of truth for "what should this playlist's thumbnail be
// right now" -- used by both listPlaylistSnapshots and getPlaylistSnapshot
// so list and detail views never disagree, and by main.mjs whenever it
// needs to refresh the cached fallback file. A manual override
// (setPlaylistManualThumbnail below) wins only while its entry still exists
// and isn't unavailable -- a picked entry that later goes dead or drops out
// of the playlist on refresh silently reverts to automatic, same as B's own
// "never show known-dead content" rule, rather than needing reconcile to
// special-case it.
export function resolvePlaylistThumbnailUrl(metadata) {
    if (metadata.manualThumbnailVideoId) {
        const manual = (metadata.entries || []).find((e) => e.videoId === metadata.manualThumbnailVideoId);
        if (manual && !manual.unavailable && manual.thumbnailUrl) return manual.thumbnailUrl;
    }
    return firstAvailablePlaylistThumbnail(metadata.entries);
}

// Summary list for the Library tab's new Playlists section -- nothing before
// this read a saved playlist snapshot back into the renderer at all.
export function listPlaylistSnapshots({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME }) {
    const playlistsRoot = path.join(libraryTagDir(libraryDir, libraryTag), PLAYLISTS_DIR_NAME);
    if (!fs.existsSync(playlistsRoot)) return [];

    const summaries = [];
    for (const dirEntry of fs.readdirSync(playlistsRoot, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const playlistDir = path.join(playlistsRoot, dirEntry.name);
        const epochDir = resolvePlaylistEpochDir(playlistDir);
        if (!epochDir) continue;
        let metadata;
        try {
            metadata = JSON.parse(fs.readFileSync(path.join(epochDir, 'metadata.json'), 'utf-8'));
        } catch {
            continue;
        }
        summaries.push({
            playlistId: metadata.playlistId,
            title: metadata.title,
            uploader: metadata.uploader,
            entryCount: metadata.entries.length,
            addedEpoch: metadata.addedEpoch,
            lastRefreshedEpoch: metadata.lastRefreshedEpoch || null,
            hasPreviousMetadata: fs.existsSync(path.join(epochDir, 'previousMetadata.json')),
            thumbnailUrl: resolvePlaylistThumbnailUrl(metadata),
            thumbnailPath: findPlaylistThumbnailPath(playlistDir),
        });
    }
    summaries.sort((a, b) => (b.addedEpoch || 0) - (a.addedEpoch || 0));
    return summaries;
}

// Full detail for one saved playlist -- backs the Playlists section's detail
// view (entries, localFiles) and tells the UI whether Undo has anything to
// act on.
//
// localFiles is recomputed fresh against the current library index on every
// read, rather than trusting what was last written to disk -- it's a cheap
// local lookup (findVideoInIndex), and stale disk data would leave a video
// bulk-added after this playlist was saved with no "go to library" link
// until an explicit "Refresh from YouTube".
//
// When no index is handed in, this forces a genuine refreshLibraryIndex()
// rescan rather than reusing getLibraryIndex()'s cache, which is only
// invalidated by mutations this process itself knows about -- an entry a
// playlist *refresh* just discovered, whose video already existed in the
// library, could otherwise still show no link. A playlist detail view is
// opened rarely enough that a full rescan here is cheap insurance.
export async function getPlaylistSnapshot({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, playlistId, index }) {
    const playlistDir = path.join(libraryTagDir(libraryDir, libraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
    const epochDir = resolvePlaylistEpochDir(playlistDir);
    if (!epochDir) return null;

    let metadata;
    try {
        metadata = JSON.parse(fs.readFileSync(path.join(epochDir, 'metadata.json'), 'utf-8'));
    } catch {
        return null;
    }

    // previousMetadataSavedEpoch tells the UI exactly what Undo would revert
    // to and when that version was itself last current -- read straight off
    // previousMetadata.json's own lastRefreshedEpoch (or addedEpoch, if that
    // backed-up version had itself never been refreshed before).
    let previousMetadataSavedEpoch = null;
    try {
        const previous = JSON.parse(fs.readFileSync(path.join(epochDir, 'previousMetadata.json'), 'utf-8'));
        previousMetadataSavedEpoch = previous.lastRefreshedEpoch || previous.addedEpoch || null;
    } catch {
        // No previousMetadata.json -- stays null.
    }

    const resolvedIndex = index || await refreshLibraryIndex(libraryDir, libraryTag);
    const localFiles = {};
    const lookupVideo = createVideoLookup(resolvedIndex);
    for (const entry of metadata.entries || []) {
        const match = lookupVideo(entry.videoId);
        localFiles[entry.videoId] = match ? match.video.videoDir : null;
    }

    return {
        ...metadata,
        localFiles,
        hasPreviousMetadata: previousMetadataSavedEpoch !== null,
        previousMetadataSavedEpoch,
        thumbnailUrl: resolvePlaylistThumbnailUrl(metadata),
        thumbnailPath: findPlaylistThumbnailPath(playlistDir),
    };
}

// Refresh, not a new version -- reconciles in place with a single undo step.
// Matched by videoId (stable even for a video YouTube has since killed):
//   - a *dead* fresh entry whose videoId already has a saved entry keeps the
//     saved entry's data untouched -- a placeholder must never clobber real
//     data.
//   - a fresh entry with real data always wins (missing fields fall back to
//     the saved value) -- the only protection is against dead data, not
//     against a legitimate retitle.
//   - a saved entry entirely absent from the fresh fetch (not even as a dead
//     placeholder) is dropped -- that's the signal the playlist owner
//     removed it themselves, not that YouTube killed the video.
// The current metadata.json is copied to previousMetadata.json first
// (overwriting any earlier one -- a single undo step, not a history) so
// undoPlaylistRefresh can revert it. The live metadata.json is only touched
// via the same temp-then-rename pattern swapLibraryDownload uses, so a crash
// mid-refresh never leaves it partially written.
export function reconcilePlaylistSnapshot({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, playlistId, freshEntries, freshTitle, freshUploader, index }) {
    const playlistDir = path.join(libraryTagDir(libraryDir, libraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
    const epochDir = resolvePlaylistEpochDir(playlistDir);
    if (!epochDir) {
        throw new Error('This playlist has no saved snapshot to refresh.');
    }

    const metadataPath = path.join(epochDir, 'metadata.json');
    const oldMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

    // Backed up first -- only proceeds to actually reconcile once this
    // succeeds, since a refresh that can't guarantee an undo path shouldn't
    // be allowed to mutate anything.
    fs.writeFileSync(path.join(epochDir, 'previousMetadata.json'), JSON.stringify(oldMetadata, null, 2), 'utf-8');

    const oldByVideoId = new Map(oldMetadata.entries.map((e) => [e.videoId, e]));
    let added = 0;
    let updated = 0;

    const reconciledEntries = freshEntries.map((fresh) => {
        const old = oldByVideoId.get(fresh.videoId);
        if (isDeadTitle(fresh.title, fresh.videoId)) {
            // Flag as unavailable even when the saved entry's own data is
            // kept untouched -- the preservation rule above only protects
            // title/thumbnail/uploadDate, not whether this refresh found it
            // dead.
            if (old) {
                if (!old.unavailable) updated++;
                return { ...old, unavailable: true };
            }
            added++;
            return { videoId: fresh.videoId, title: null, url: fresh.url, thumbnailUrl: fresh.thumbnailUrl || null, uploadDate: fresh.uploadDate || null, unavailable: true };
        }
        const reconciled = {
            videoId: fresh.videoId,
            title: fresh.title,
            url: fresh.url,
            thumbnailUrl: fresh.thumbnailUrl || old?.thumbnailUrl || null,
            uploadDate: fresh.uploadDate || old?.uploadDate || null,
            unavailable: false,
        };
        if (!old) {
            added++;
        } else if (old.title !== reconciled.title || old.thumbnailUrl !== reconciled.thumbnailUrl || old.uploadDate !== reconciled.uploadDate || old.unavailable) {
            updated++;
        }
        return reconciled;
    });

    const freshVideoIds = new Set(freshEntries.map((e) => e.videoId));
    const removed = oldMetadata.entries.filter((e) => !freshVideoIds.has(e.videoId)).length;

    const localFiles = {};
    const lookupVideo = createVideoLookup(index);
    for (const entry of reconciledEntries) {
        const match = lookupVideo(entry.videoId);
        localFiles[entry.videoId] = match ? match.video.videoDir : null;
    }

    // Every live entry with no library match right now -- not just ones
    // brand-new to this playlist. An entry can predate this feature, or have
    // been in the playlist for a while without ever actually getting added
    // (a failed/skipped bulk-add, or simply never triggered), and a refresh
    // should still notice and pull its full data in either case, not only
    // for entries the reconcile above happens to consider "new."
    const missingFromLibraryEntries = reconciledEntries.filter((e) => !e.unavailable && !localFiles[e.videoId]);

    const lastRefreshedEpoch = Date.now();
    const newMetadata = {
        ...oldMetadata,
        // A refresh brings the saved shape up to date with whatever
        // writePlaylistSnapshot would produce today -- without this, an
        // "Outdated data" playlist (schemaVersion behind current) stayed
        // flagged outdated forever, since oldMetadata's own stale
        // schemaVersion was just carried through unchanged by the spread
        // above, no matter how many times it was refreshed. Falls back the
        // same way writePlaylistSnapshot's own initial write does, for
        // fields (manualThumbnailVideoId) that predate this schema version.
        schemaVersion: CURRENT_PLAYLIST_SCHEMA_VERSION,
        manualThumbnailVideoId: oldMetadata.manualThumbnailVideoId ?? null,
        title: freshTitle || oldMetadata.title,
        uploader: freshUploader || oldMetadata.uploader,
        lastRefreshedEpoch,
        entries: reconciledEntries,
        localFiles,
    };

    const tempPath = `${metadataPath}.new`;
    fs.writeFileSync(tempPath, JSON.stringify(newMetadata, null, 2), 'utf-8');
    fs.renameSync(tempPath, metadataPath);

    return { success: true, added, removed, updated, lastRefreshedEpoch, entries: reconciledEntries, missingFromLibraryEntries, manualThumbnailVideoId: newMetadata.manualThumbnailVideoId ?? null };
}

// Sets (or, with videoId null, clears) which entry's thumbnail this
// playlist's own thumbnail should follow -- see resolvePlaylistThumbnailUrl
// for how this interacts with automatic (first-available-entry) selection.
// Refuses to point at an entry that doesn't exist or is already flagged
// unavailable, rather than silently accepting a pick that resolvePlaylistThumbnailUrl
// would just ignore anyway -- the caller (the UI's hover button) never
// offers this for an unavailable entry, but the backend shouldn't trust that.
// Doesn't itself touch the cached fallback file (ensurePlaylistThumbnail) --
// that lives in main.mjs, which calls it right after this succeeds.
export function setPlaylistManualThumbnail({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, playlistId, videoId }) {
    const playlistDir = path.join(libraryTagDir(libraryDir, libraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
    const epochDir = resolvePlaylistEpochDir(playlistDir);
    if (!epochDir) return { success: false, message: 'This playlist has no saved snapshot.' };

    const metadataPath = path.join(epochDir, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

    if (videoId) {
        const target = metadata.entries.find((e) => e.videoId === videoId);
        if (!target || target.unavailable) {
            return { success: false, message: 'That entry is not available to use as a thumbnail.' };
        }
    }

    metadata.manualThumbnailVideoId = videoId || null;
    const tempPath = `${metadataPath}.new`;
    fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2), 'utf-8');
    fs.renameSync(tempPath, metadataPath);

    return { success: true, manualThumbnailVideoId: metadata.manualThumbnailVideoId, thumbnailUrl: resolvePlaylistThumbnailUrl(metadata) };
}

// One-shot undo -- reverts to previousMetadata.json (written by the most
// recent reconcilePlaylistSnapshot call) and then deletes it, so a second
// Undo click has nothing left to act on rather than toggling back and forth.
export function undoPlaylistRefresh({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, playlistId }) {
    const playlistDir = path.join(libraryTagDir(libraryDir, libraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
    const epochDir = resolvePlaylistEpochDir(playlistDir);
    if (!epochDir) return { success: false, message: 'This playlist has no saved snapshot.' };

    const previousPath = path.join(epochDir, 'previousMetadata.json');
    if (!fs.existsSync(previousPath)) {
        return { success: false, message: 'Nothing to undo.' };
    }

    const metadataPath = path.join(epochDir, 'metadata.json');
    const tempPath = `${metadataPath}.new`;
    fs.copyFileSync(previousPath, tempPath);
    fs.renameSync(tempPath, metadataPath);
    fs.rmSync(previousPath, { force: true });

    return { success: true, metadata: JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) };
}

// Deletes just the playlist's own saved snapshot -- never touches the videos
// it references, which live in their own channel/video folders independent
// of any playlist pointing at them. Same containment check every other
// destructive library operation in this file uses.
export function deletePlaylistSnapshot({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, playlistId }) {
    const playlistDir = path.join(libraryTagDir(path.resolve(libraryDir || ''), libraryTag), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
    const resolvedPlaylistDir = resolveInsideLibrary(libraryDir, playlistDir);
    if (!resolvedPlaylistDir) {
        throw new Error('Refusing to delete a path outside the configured library folder.');
    }

    fs.rmSync(resolvedPlaylistDir, { recursive: true, force: true });
    return { success: true };
}
