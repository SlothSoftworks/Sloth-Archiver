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

// Lazily creates a tag folder + its library.json manifest the first time
// something is actually about to be written into it. For DEFAULT_LIBRARY_DIR_NAME
// specifically this is never eager (not at app start, not when libraryDir is
// first configured) and never a migration of anything that predates this
// layer -- callers rely on that. A no-op past the first call for a given
// (libraryDir, tagName) pair, which also makes it safe to call unconditionally
// from createLibraryTag()'s own eager creation path below.
function ensureLibraryTagMetadata(libraryDir, tagName = DEFAULT_LIBRARY_DIR_NAME) {
    const dir = libraryTagDir(libraryDir, tagName);
    const metadataPath = path.join(dir, LIBRARY_METADATA_FILE_NAME);
    if (fs.existsSync(metadataPath)) {
        try {
            return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        } catch {
            // Falls through to rewrite a fresh one below if the existing
            // file is somehow corrupt.
        }
    }
    fs.mkdirSync(dir, { recursive: true });
    const metadata = { tagName, createdEpoch: Date.now() };
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
            if (!metadata.tagName) continue;
            tags.push({ tagName: metadata.tagName, folderName: entry.name, createdEpoch: metadata.createdEpoch || null });
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
    return { tagName: metadata.tagName, folderName, createdEpoch: metadata.createdEpoch };
}

// Bumped whenever buildEpochMetadata's/writePlaylistSnapshot's own written
// shape gains a field a stale entry won't have. Exported so the renderer can
// compare an entry's stored `schemaVersion` against "what would get written
// today" and surface a "this entry predates newer features, refresh it"
// notice -- see LibraryVideoDetail.tsx/PlaylistsSection.tsx's own duplicated
// copy of these two numbers.
export const CURRENT_VIDEO_SCHEMA_VERSION = 3;
export const CURRENT_PLAYLIST_SCHEMA_VERSION = 1;

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
export function resolveInsideLibrary(libraryDir, targetPath) {
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedTarget = path.resolve(targetPath || '');
    const relative = path.relative(resolvedLibraryDir, resolvedTarget);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    return resolvedTarget;
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

// <videoDir>/clips/clips.json -- one JSON array of clip records per video.
// Kept minimal: title/extension are derivable from the clip's own filename;
// this only holds what scanLibrary/ClipCollectionView need cheaply without
// re-invoking ffprobe on every scan.
// Record shape: { id, fileName, title, createdAt, durationSeconds }
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
export function recordClip({ libraryDir, videoDir, fileName, title, durationSeconds }) {
    const resolvedVideoDir = resolveInsideLibrary(libraryDir, videoDir);
    if (!resolvedVideoDir) {
        throw new Error('Refusing to record a clip outside the configured library folder.');
    }
    const manifest = readClipsManifest(resolvedVideoDir);
    if (manifest.some((c) => c.fileName === fileName)) {
        throw new Error('A clip with this name already exists for this video.');
    }
    const clip = { id: crypto.randomUUID(), fileName, title, createdAt: Date.now(), durationSeconds };
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

// Shared by writeLibraryEntry (new video) and addLibraryVersion (new version
// of an existing video) so both ever build exactly one metadata shape --
// two independent inline copies would be free to drift apart over time.
function buildEpochMetadata(videoMetaData, addedEpoch) {
    const { id, title, fullTitle, description, thumbnail, originalUrl, duration, durationString, uploadDate, channelId, uploader, resolutions } = videoMetaData;
    return {
        schemaVersion: CURRENT_VIDEO_SCHEMA_VERSION,
        videoId: id,
        channelId: channelId || null,
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
        // stale if YouTube changes available qualities later. Entries written
        // before this field existed just won't have it.
        resolutions: resolutions || [],
        // Adding a video/version and downloading its file are separate
        // actions -- filled in by recordLibraryDownload() once a download
        // completes.
        downloadedFilePath: null,
        downloadedResolution: null,
        downloadedFormat: null,
        // MP3 is a separate, coexisting artifact -- its own slot (audio.mp3,
        // alongside video.<ext>), independent of the video fields above.
        downloadedAudioFilePath: null,
    };
}

export function writeLibraryEntry({ libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME, videoMetaData }) {
    const { id, uploader } = videoMetaData;
    if (!id) {
        throw new Error('videoMetaData.id is required to add a library entry');
    }
    if (!libraryDir) {
        throw new Error('No library folder is configured -- set one in Options first.');
    }

    ensureLibraryTagMetadata(libraryDir, libraryTag);
    const channelDir = path.join(libraryTagDir(libraryDir, libraryTag), channelFolderName(uploader));
    const videoDir = path.join(channelDir, videoFolderName(id));
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
        fs.rmSync(resolvedVideoDir, { recursive: true, force: true });
        return { videoDeleted: true };
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

// Bounded 3-level walk (channel/video/epoch), tolerant of partial or corrupt
// folders -- a missing or unparseable metadata.json is skipped rather than
// failing the whole scan, since an interrupted write is always conceivable.
// Collects every valid epoch into `epochs` (newest first) for the
// version-control UI; `latestEpoch`/`metadata` stay pointed at the newest
// valid one, which every other consumer reads.
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
        channelEntries = await fsp.readdir(scanRoot, { withFileTypes: true });
    } catch {
        return index;
    }

    for (const channelEntry of channelEntries) {
        if (!channelEntry.isDirectory()) continue;
        if (channelEntry.name === PLAYLISTS_DIR_NAME) continue;
        const channelPath = path.join(scanRoot, channelEntry.name);

        let videoEntries;
        try {
            videoEntries = await fsp.readdir(channelPath, { withFileTypes: true });
        } catch {
            continue;
        }

        const videos = [];
        for (const videoEntry of videoEntries) {
            if (!videoEntry.isDirectory()) continue;
            const videoPath = path.join(channelPath, videoEntry.name);

            let epochEntries;
            try {
                epochEntries = await fsp.readdir(videoPath, { withFileTypes: true });
            } catch {
                continue;
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
                    const raw = await fsp.readFile(path.join(videoPath, epochName, 'metadata.json'), 'utf-8');
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

            if (!metadata) continue;

            // Video-level, not per-epoch -- ensureVideoThumbnail (main.mjs)
            // saves exactly one video-thumbnail.* file directly in videoPath,
            // a sibling of the epoch folders, same pattern as channel-icon.*
            // one level up.
            const thumbnailEntry = epochEntries.find((e) => e.isFile() && e.name.startsWith('video-thumbnail.'));
            // Cheap (one JSON parse) -- only the count rides along in the main
            // index; the full per-clip list is fetched lazily via
            // library:getClips when the Clip Collection view actually opens.
            const clipCount = readClipsManifest(videoPath).length;

            videos.push({
                videoFolderName: videoEntry.name,
                videoDir: videoPath,
                latestEpoch,
                metadata,
                epochs,
                thumbnailPath: thumbnailEntry ? path.join(videoPath, thumbnailEntry.name) : null,
                clipCount,
            });
        }

        if (videos.length === 0) continue;
        videos.sort((a, b) => (b.metadata.addedEpoch || 0) - (a.metadata.addedEpoch || 0));

        // Cached by ensureChannelIcon (main.mjs) the first time a video from
        // this channel gets added -- videoEntries already lists everything
        // directly inside channelPath (files included), so this is a free
        // lookup rather than a second readdir.
        const iconEntry = videoEntries.find((e) => e.isFile() && e.name.startsWith('channel-icon.'));

        index.channels.push({
            channelFolderName: channelEntry.name,
            displayName: videos[0]?.metadata.channel || channelEntry.name,
            channelIconPath: iconEntry ? path.join(channelPath, iconEntry.name) : null,
            videos,
        });
    }

    index.channels.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return index;
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

export function refreshLibraryIndex(libraryDir, libraryTag = DEFAULT_LIBRARY_DIR_NAME) {
    indexPromise = scanLibrary(libraryDir, libraryTag);
    indexPromiseDir = libraryDir;
    indexPromiseTag = libraryTag;
    return indexPromise;
}

// Keyed by videoId specifically (not folder name/title) -- it's the one field
// guaranteed unique per video regardless of which channel folder it landed
// under, same reasoning already applied to the folder-collision fix.
export function findVideoInIndex(index, videoId) {
    for (const channel of index.channels) {
        const video = channel.videos.find((v) => v.metadata.videoId === videoId);
        if (video) {
            return { channel, video };
        }
    }
    return null;
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
    for (const entry of entries) {
        const match = findVideoInIndex(index, entry.videoId);
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
// ensurePlaylistThumbnail (main.mjs) as a fallback for when the live first
// entry has no thumbnailUrl of its own (empty playlist, or a dead first
// entry) -- the renderer always prefers the live entries[0].thumbnailUrl
// when available.
function findPlaylistThumbnailPath(playlistDir) {
    if (!fs.existsSync(playlistDir)) return null;
    const entry = fs.readdirSync(playlistDir, { withFileTypes: true })
        .find((e) => e.isFile() && e.name.startsWith('playlist-thumbnail.'));
    return entry ? path.join(playlistDir, entry.name) : null;
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
            thumbnailUrl: metadata.entries?.[0]?.thumbnailUrl || null,
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
    for (const entry of metadata.entries || []) {
        const match = findVideoInIndex(resolvedIndex, entry.videoId);
        localFiles[entry.videoId] = match ? match.video.videoDir : null;
    }

    return {
        ...metadata,
        localFiles,
        hasPreviousMetadata: previousMetadataSavedEpoch !== null,
        previousMetadataSavedEpoch,
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
    for (const entry of reconciledEntries) {
        const match = findVideoInIndex(index, entry.videoId);
        localFiles[entry.videoId] = match ? match.video.videoDir : null;
    }

    const lastRefreshedEpoch = Date.now();
    const newMetadata = {
        ...oldMetadata,
        title: freshTitle || oldMetadata.title,
        uploader: freshUploader || oldMetadata.uploader,
        lastRefreshedEpoch,
        entries: reconciledEntries,
        localFiles,
    };

    const tempPath = `${metadataPath}.new`;
    fs.writeFileSync(tempPath, JSON.stringify(newMetadata, null, 2), 'utf-8');
    fs.renameSync(tempPath, metadataPath);

    return { success: true, added, removed, updated, lastRefreshedEpoch, entries: reconciledEntries };
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
