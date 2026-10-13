import fs from 'fs';
import path from 'path';
import {
    scanLibrary,
    listLibraryTags,
    listVideoTags,
    addTagToVideos,
    libraryTagDir,
    createVideoLookup,
    sanitizeForFilesystem,
    resolveInsideLibrary,
    ensureImportedLibraryTag,
    findPlaylistEpochDir,
    createScanYielder,
    NONYT_DIR_NAME,
    PLAYLISTS_DIR_NAME,
} from './library.mjs';

// Library export/import (futureSpecs.md "Export/Import JSON feature").
//
// An export is one JSON file describing every sublibrary: its videos (each
// version's metadata.json), its video labels, and its saved playlist
// snapshots. It's a *metadata* backup, not a file backup -- media files,
// clips and thumbnails aren't included, and every local file path is
// dropped, since a path from one machine means nothing (or something
// misleading) on another. Imported videos therefore show as "not
// downloaded", with a working download button.
//
// Import only ever adds. A sublibrary, video, version or playlist that
// already exists is left exactly as it is; for a video that already exists,
// only versions it doesn't have yet are added (matched by epoch). Same
// "reconcile, don't replace" stance playlist refresh takes. Local-file
// entries are skipped on import -- there's no source to download them from.

export const EXPORT_FORMAT = 'slotharchiver-library-export';
export const EXPORT_FORMAT_VERSION = 1;
// JSON.parse needs the whole file in memory; a 100k-video library exports
// to a few hundred MB, so this is generous while still refusing something
// absurd before reading it.
export const IMPORT_MAX_BYTES = 1024 * 1024 * 1024;

const EPOCH_NAME_PATTERN = /^\d{1,16}$/;

// Fields that describe this machine's copy of the media rather than the
// video itself -- cleared on export and again on import.
export function toPortableEpochMetadata(metadata) {
    return {
        ...metadata,
        downloadedFilePath: null,
        downloadedAudioFilePath: null,
        downloadedResolution: null,
        downloadedFormat: null,
        lastPlaybackPositionSeconds: null,
    };
}

function readLatestPlaylistMetadata(playlistDir) {
    const epochDir = findPlaylistEpochDir(playlistDir);
    if (!epochDir) return null;
    try {
        return { epoch: path.basename(epochDir), metadata: JSON.parse(fs.readFileSync(path.join(epochDir, 'metadata.json'), 'utf-8')) };
    } catch {
        return null;
    }
}

function exportPlaylists(libraryDir, folderName) {
    const playlistsRoot = path.join(libraryTagDir(libraryDir, folderName), PLAYLISTS_DIR_NAME);
    if (!fs.existsSync(playlistsRoot)) return [];
    const playlists = [];
    for (const entry of fs.readdirSync(playlistsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const latest = readLatestPlaylistMetadata(path.join(playlistsRoot, entry.name));
        if (!latest || !Array.isArray(latest.metadata.entries)) continue;
        // localFiles holds this machine's videoDirs -- recomputed whenever
        // the playlist is opened, so it's never worth carrying over.
        const metadata = { ...latest.metadata };
        delete metadata.localFiles;
        playlists.push({ folderName: entry.name, epoch: latest.epoch, metadata });
    }
    return playlists;
}

// Builds the export object for every sublibrary in libraryDir.
export async function buildLibraryExport(libraryDir, appVersion) {
    if (!libraryDir) throw new Error('No library folder is configured -- set one in Options first.');
    const sublibraries = [];
    for (const tag of listLibraryTags(libraryDir)) {
        const index = await scanLibrary(libraryDir, tag.folderName);
        const tagDir = libraryTagDir(libraryDir, tag.folderName);
        const videos = index.channels.flatMap((channel) => channel.videos).map((video) => ({
            path: path.relative(tagDir, video.videoDir).split(path.sep),
            epochs: video.epochs.map((e) => ({ epoch: e.epoch, metadata: toPortableEpochMetadata(e.metadata) })),
        }));
        sublibraries.push({
            folderName: tag.folderName,
            sublibraryName: tag.tagName,
            createdEpoch: tag.createdEpoch,
            videoTags: listVideoTags(libraryDir, tag.folderName),
            videos,
            playlists: exportPlaylists(libraryDir, tag.folderName),
        });
    }
    return {
        format: EXPORT_FORMAT,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion: appVersion || null,
        sublibraries,
    };
}

export function summarizeExport(data) {
    return {
        sublibraries: data.sublibraries.length,
        videos: data.sublibraries.reduce((n, s) => n + s.videos.length, 0),
        versions: data.sublibraries.reduce((n, s) => n + s.videos.reduce((m, v) => m + v.epochs.length, 0), 0),
        playlists: data.sublibraries.reduce((n, s) => n + s.playlists.length, 0),
    };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The import file is untrusted input (it may come from anywhere), so its
// shape is checked up front with a user-facing message, and every path it
// names is re-sanitized and re-checked against the library when applied.
export function parseLibraryExport(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('That file isn\'t valid JSON.');
    }
    if (!isPlainObject(data) || data.format !== EXPORT_FORMAT) {
        throw new Error('That file isn\'t a SlothArchiver library export.');
    }
    if (data.formatVersion !== EXPORT_FORMAT_VERSION) {
        throw new Error(`This export was made by a newer version of SlothArchiver (format ${data.formatVersion}) -- update the app to import it.`);
    }
    if (!Array.isArray(data.sublibraries)) {
        throw new Error('The export file is damaged (no sublibraries list).');
    }
    for (const sub of data.sublibraries) {
        if (!isPlainObject(sub) || typeof sub.folderName !== 'string' || !Array.isArray(sub.videos) || !Array.isArray(sub.playlists ?? [])) {
            throw new Error('The export file is damaged (a sublibrary entry is malformed).');
        }
    }
    return data;
}

// The folder a video goes in, relative to its sublibrary: either
// <channel>/<videoId> or NonYT/<platform>/<hash>, every segment re-run
// through the same sanitizer the app names folders with. Anything else is
// rejected rather than guessed at.
function safeRelativeVideoPath(segments) {
    if (!Array.isArray(segments) || !segments.every((s) => typeof s === 'string' && s !== '')) return null;
    const isNonYt = segments[0] === NONYT_DIR_NAME;
    if (isNonYt ? segments.length !== 3 : segments.length !== 2) return null;
    if (!isNonYt && segments[0] === PLAYLISTS_DIR_NAME) return null;
    return segments.map((s, i) => (isNonYt && i === 0 ? s : sanitizeForFilesystem(s)));
}

function emptySummary() {
    return {
        sublibrariesCreated: 0,
        videosAdded: 0,
        versionsAdded: 0,
        videosAlreadyPresent: 0,
        localFilesSkipped: 0,
        invalidSkipped: 0,
        playlistsAdded: 0,
        playlistsAlreadyPresent: 0,
        labelsApplied: 0,
    };
}

// Plans -- and unless dryRun, applies -- an import of `data` (already
// through parseLibraryExport) into libraryDir. The dry run walks exactly
// the same decisions without writing, so the preview the user confirms is
// what actually happens (barring the library changing in between).
//
// Returns the summary plus, for a real run, what was written that still
// needs a thumbnail/channel icon fetched (the caller does that in the
// background -- it's network work, not part of the import itself).
export async function importLibraryExport(libraryDir, data, { dryRun = false } = {}) {
    if (!libraryDir) throw new Error('No library folder is configured -- set one in Options first.');
    const summary = emptySummary();
    const followUps = { videos: [], playlists: [] };
    const touchedTags = new Set();
    const existingTags = new Map(listLibraryTags(libraryDir).map((t) => [t.folderName, t]));
    // The per-video work below is synchronous file I/O -- yield to the event
    // loop every few ms (same helper the library scan uses) so a large import
    // doesn't freeze the app for its whole duration.
    const yieldIfDue = createScanYielder();

    for (const sub of data.sublibraries) {
        let folderName = sanitizeForFilesystem(sub.folderName);
        // A plain folder (no library.json) already sitting at that name is
        // someone else's -- import beside it instead of adopting it.
        if (!existingTags.has(folderName) && fs.existsSync(libraryTagDir(libraryDir, folderName))) {
            folderName = sanitizeForFilesystem(`${sub.folderName} (imported)`);
        }
        const tagExists = existingTags.has(folderName);
        if (!tagExists) {
            summary.sublibrariesCreated++;
            if (!dryRun) {
                ensureImportedLibraryTag(libraryDir, folderName, typeof sub.sublibraryName === 'string' ? sub.sublibraryName : folderName, sub.createdEpoch);
                existingTags.set(folderName, { folderName });
            }
        }
        const tagDir = libraryTagDir(libraryDir, folderName);
        const index = tagExists ? await scanLibrary(libraryDir, folderName) : { channels: [] };
        const lookupVideo = createVideoLookup(index);
        const presentVideoIds = new Set();

        for (const video of sub.videos) {
            await yieldIfDue();
            const epochs = Array.isArray(video?.epochs)
                ? video.epochs.filter((e) => isPlainObject(e) && typeof e.epoch === 'string' && EPOCH_NAME_PATTERN.test(e.epoch) && isPlainObject(e.metadata) && typeof e.metadata.videoId === 'string')
                : [];
            const relativePath = safeRelativeVideoPath(video?.path);
            if (epochs.length === 0 || !relativePath) {
                summary.invalidSkipped++;
                continue;
            }
            const { videoId } = epochs[0].metadata;
            const platform = epochs[0].metadata.platform || 'youtube';
            if (platform === 'local') {
                summary.localFilesSkipped++;
                continue;
            }

            const existing = lookupVideo(videoId, platform);
            const videoDir = existing ? existing.video.videoDir : path.join(tagDir, ...relativePath);
            if (!resolveInsideLibrary(libraryDir, videoDir)) {
                summary.invalidSkipped++;
                continue;
            }
            const presentEpochs = new Set(existing ? existing.video.epochs.map((e) => e.epoch) : []);
            const newEpochs = epochs.filter((e) => !presentEpochs.has(e.epoch) && !fs.existsSync(path.join(videoDir, e.epoch)));
            presentVideoIds.add(videoId);
            if (existing && newEpochs.length === 0) {
                summary.videosAlreadyPresent++;
                continue;
            }
            if (!existing) summary.videosAdded++;
            summary.versionsAdded += newEpochs.length;
            if (dryRun) continue;

            for (const { epoch, metadata } of newEpochs) {
                const epochDir = path.join(videoDir, epoch);
                fs.mkdirSync(epochDir, { recursive: true });
                fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify(toPortableEpochMetadata(metadata), null, 2), 'utf-8');
            }
            touchedTags.add(folderName);
            if (!existing) {
                const latest = newEpochs.reduce((a, b) => (Number(b.epoch) > Number(a.epoch) ? b : a)).metadata;
                followUps.videos.push({
                    videoDir,
                    channelDir: path.dirname(videoDir),
                    thumbnailUrl: typeof latest.thumbnail === 'string' ? latest.thumbnail : null,
                    channelId: relativePath[0] === NONYT_DIR_NAME ? null : (typeof latest.channelId === 'string' ? latest.channelId : null),
                });
            }
        }

        // Labels: re-applied for every exported video that's now in this
        // sublibrary (added just now or already there) -- add-only, same as
        // "Tag selected".
        if (isPlainObject(sub.videoTags)) {
            for (const [labelName, ids] of Object.entries(sub.videoTags)) {
                if (!Array.isArray(ids)) continue;
                const videoIds = ids.filter((id) => typeof id === 'string' && presentVideoIds.has(id));
                if (videoIds.length === 0) continue;
                summary.labelsApplied++;
                if (!dryRun) addTagToVideos({ libraryDir, libraryTag: folderName, tagName: labelName, videoIds });
            }
        }

        for (const playlist of sub.playlists ?? []) {
            const metadata = playlist?.metadata;
            if (!isPlainObject(metadata) || typeof metadata.playlistId !== 'string' || !Array.isArray(metadata.entries) || typeof playlist.folderName !== 'string') {
                summary.invalidSkipped++;
                continue;
            }
            const playlistDir = path.join(tagDir, PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlist.folderName));
            if (!resolveInsideLibrary(libraryDir, playlistDir)) {
                summary.invalidSkipped++;
                continue;
            }
            if (findPlaylistEpochDir(playlistDir)) {
                summary.playlistsAlreadyPresent++;
                continue;
            }
            summary.playlistsAdded++;
            if (dryRun) continue;
            const epoch = typeof playlist.epoch === 'string' && EPOCH_NAME_PATTERN.test(playlist.epoch) ? playlist.epoch : String(Date.now());
            const epochDir = path.join(playlistDir, epoch);
            fs.mkdirSync(epochDir, { recursive: true });
            fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify({ ...metadata, localFiles: {} }, null, 2), 'utf-8');
            touchedTags.add(folderName);
            followUps.playlists.push({ playlistDir, metadata });
        }
    }

    return { summary, touchedTags: [...touchedTags], followUps: dryRun ? null : followUps };
}
