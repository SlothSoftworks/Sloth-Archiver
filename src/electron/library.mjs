import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

// Windows reserves these as device names -- CON, PRN.txt, con, etc. all refer
// to the device, not an ordinary file/folder, regardless of case or extension.
// A folder named exactly one of these can't be created at all.
const WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// Top-level reserved folder name for playlist snapshots
// (<libraryDir>/playlists/<playlistId>/<epoch>/metadata.json) -- a sibling of
// channel folders in libraryDir, not one itself. scanLibrary() skips it so
// it's never mistaken for a channel.
export const PLAYLISTS_DIR_NAME = 'playlists';

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
// MAX_PATH=260 worst case (TD-005, reports/TechnicalDebt.md), though
// channel-folder length and libraryDir depth remain unbounded.
export function videoFolderName(videoId) {
    return sanitizeForFilesystem(videoId);
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

export function writeLibraryEntry({ libraryDir, videoMetaData }) {
    const { id, uploader } = videoMetaData;
    if (!id) {
        throw new Error('videoMetaData.id is required to add a library entry');
    }
    if (!libraryDir) {
        throw new Error('No library folder is configured -- set one in Options first.');
    }

    const channelDir = path.join(libraryDir, channelFolderName(uploader));
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

// "Override" means replace the tracked entry, not add another version.
// Deletes existingVideoDir exactly as given (from an earlier
// findVideoInIndex lookup) rather than re-deriving it from videoMetaData --
// if the title or channel display name drifted, writeLibraryEntry could land
// on a different path than the one being replaced, missing the real old
// folder.
export function overrideLibraryEntry({ libraryDir, videoMetaData, existingVideoDir }) {
    if (existingVideoDir && fs.existsSync(existingVideoDir)) {
        fs.rmSync(existingVideoDir, { recursive: true, force: true });
    }
    return writeLibraryEntry({ libraryDir, videoMetaData });
}

// Bounded 3-level walk (channel/video/epoch), tolerant of partial or corrupt
// folders -- a missing or unparseable metadata.json is skipped rather than
// failing the whole scan, since an interrupted write is always conceivable.
// Collects every valid epoch into `epochs` (newest first) for the
// version-control UI; `latestEpoch`/`metadata` stay pointed at the newest
// valid one, which every other consumer reads.
export async function scanLibrary(libraryDir) {
    const index = { channels: [] };
    if (!libraryDir || !fs.existsSync(libraryDir)) {
        return index;
    }

    let channelEntries;
    try {
        channelEntries = await fsp.readdir(libraryDir, { withFileTypes: true });
    } catch {
        return index;
    }

    for (const channelEntry of channelEntries) {
        if (!channelEntry.isDirectory()) continue;
        if (channelEntry.name === PLAYLISTS_DIR_NAME) continue;
        const channelPath = path.join(libraryDir, channelEntry.name);

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
            // sort puts the most recent attempt first.
            const epochNames = epochEntries
                .filter((e) => e.isDirectory())
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

            videos.push({
                videoFolderName: videoEntry.name,
                videoDir: videoPath,
                latestEpoch,
                metadata,
                epochs,
                thumbnailPath: thumbnailEntry ? path.join(videoPath, thumbnailEntry.name) : null,
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
// resolved) for the current libraryDir, rather than kicking off a redundant
// scan on every call -- so an app-start background scan and a Library-tab
// mount asking for the index at roughly the same time share one walk.
let indexPromise = null;
let indexPromiseDir = null;

export function getLibraryIndex(libraryDir) {
    if (!indexPromise || indexPromiseDir !== libraryDir) {
        indexPromise = scanLibrary(libraryDir);
        indexPromiseDir = libraryDir;
    }
    return indexPromise;
}

export function refreshLibraryIndex(libraryDir) {
    indexPromise = scanLibrary(libraryDir);
    indexPromiseDir = libraryDir;
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
export function writePlaylistSnapshot({ libraryDir, playlistId, title, uploader, originalUrl, entries, index }) {
    const playlistDir = path.join(libraryDir, PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));

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
export function enrichPlaylistEntry({ libraryDir, playlistId, videoId, title, uploadDate, thumbnailUrl }) {
    const playlistDir = path.join(libraryDir, PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
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
export function listPlaylistSnapshots({ libraryDir }) {
    const playlistsRoot = path.join(libraryDir, PLAYLISTS_DIR_NAME);
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
// local lookup (findVideoInIndex), and disk staleness was a real bug: a
// video bulk-added after this playlist was first saved had no "go to
// library" link until an explicit "Refresh from YouTube".
//
// When no index is handed in, this forces a genuine refreshLibraryIndex()
// rescan rather than reusing getLibraryIndex()'s cache, which is only
// invalidated by mutations this process itself knows about -- a second,
// similar bug surfaced entries a playlist *refresh* had just discovered,
// whose video already existed in the library, still showing no link. A
// playlist detail view is opened rarely enough that a full rescan here is
// cheap insurance against that failure mode.
export async function getPlaylistSnapshot({ libraryDir, playlistId, index }) {
    const playlistDir = path.join(libraryDir, PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
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

    const resolvedIndex = index || await refreshLibraryIndex(libraryDir);
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
export function reconcilePlaylistSnapshot({ libraryDir, playlistId, freshEntries, freshTitle, freshUploader, index }) {
    const playlistDir = path.join(libraryDir, PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
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
export function undoPlaylistRefresh({ libraryDir, playlistId }) {
    const playlistDir = path.join(libraryDir, PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
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
export function deletePlaylistSnapshot({ libraryDir, playlistId }) {
    const playlistDir = path.join(path.resolve(libraryDir || ''), PLAYLISTS_DIR_NAME, sanitizeForFilesystem(playlistId));
    const resolvedPlaylistDir = resolveInsideLibrary(libraryDir, playlistDir);
    if (!resolvedPlaylistDir) {
        throw new Error('Refusing to delete a path outside the configured library folder.');
    }

    fs.rmSync(resolvedPlaylistDir, { recursive: true, force: true });
    return { success: true };
}
