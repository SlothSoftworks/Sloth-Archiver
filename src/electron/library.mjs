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
// (<libraryDir>/playlists/<playlistId>/<epoch>/metadata.json) -- lives
// alongside channel folders in libraryDir, but isn't one itself.
// scanLibrary() explicitly skips it so it's never mistaken for a channel
// (playlists are their own concept, deliberately not surfaced in the
// channel/video view -- a playlist view is future work).
export const PLAYLISTS_DIR_NAME = 'playlists';

// One cross-platform sanitizer using Windows' illegal-character set as the
// superset (rather than branching per-OS) -- keeps folder names identical if
// the library is ever copied between a Mac and a Windows machine, which
// matters given archival/portability is the whole point of this feature.
export function sanitizeForFilesystem(input, maxLength = 100) {
    if (!input) return 'untitled';
    let cleaned = input
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
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

export function channelFolderName(channel) {
    return sanitizeForFilesystem(channel || 'Unknown Channel');
}

// Keyed purely on videoId, not title -- YouTube titles can (and often do)
// change after upload, and a folder name derived from title would go
// cosmetically stale relative to the video's current title over time.
// videoId is stable for the life of the video and already guarantees
// uniqueness on its own (two videos can never share one), stronger than the
// old title+suffix trick this used to need. Also shrinks the Windows
// MAX_PATH=260 worst case further (TD-005, reports/TechnicalDebt.md) --
// videoIds are far shorter than the 50-char title+suffix budget this
// replaced, though channel-folder length and libraryDir depth are still
// unbounded, so that entry isn't fully resolved by this alone.
export function videoFolderName(videoId) {
    return sanitizeForFilesystem(videoId);
}

// Shared by writeLibraryEntry (new video) and addLibraryVersion (new version
// of an existing video) so both ever build exactly one metadata shape --
// two independent inline copies would be free to drift apart over time.
function buildEpochMetadata(videoMetaData, addedEpoch) {
    const { id, title, fullTitle, description, thumbnail, originalUrl, duration, durationString, uploadDate, channelId, uploader, resolutions } = videoMetaData;
    return {
        schemaVersion: 3,
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
        // Captured at add-time rather than fetched live when the user wants to
        // download -- keeps "what can I download" simple and self-contained
        // per entry, at the cost of the list going stale if YouTube changes
        // available qualities later. Entries written before this field existed
        // (schemaVersion 1) just won't have it -- the download UI handles that
        // as "no quality info saved," not a silent live-fetch fallback.
        resolutions: resolutions || [],
        // Never set at write-time -- adding a video/version to the library and
        // downloading its file are separate actions. Filled in by
        // recordLibraryDownload() once an actual download completes.
        downloadedFilePath: null,
        downloadedResolution: null,
        downloadedFormat: null,
        // MP3 is a separate, coexisting artifact of the video -- its own
        // slot (audio.mp3, alongside video.<ext>), entirely independent of
        // the video fields above. Also filled in by recordLibraryDownload().
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
// new epoch directly under an already-known videoDir (from an earlier
// findVideoInIndex/findLibraryVideo lookup) rather than re-deriving
// channelDir/videoDir from videoMetaData the way writeLibraryEntry does --
// if the channel/title drifted since the video was first tracked,
// re-deriving could land the "new version" in a different folder entirely
// instead of alongside its own history.
export function addLibraryVersion({ libraryDir, videoDir, videoMetaData }) {
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedVideoDir = path.resolve(videoDir || '');
    const relative = path.relative(resolvedLibraryDir, resolvedVideoDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Refusing to add a version outside the configured library folder.');
    }

    const addedEpoch = Date.now();
    const epochDir = path.join(resolvedVideoDir, String(addedEpoch));
    fs.mkdirSync(epochDir, { recursive: true });

    const metadata = buildEpochMetadata(videoMetaData, addedEpoch);
    fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    return { videoDir: resolvedVideoDir, epochDir, epoch: String(addedEpoch), metadata };
}

// Called after a download into the library completes -- updates the specific
// epoch's metadata.json in place rather than writing a new epoch, since
// fulfilling an already-tracked entry isn't itself a new version (unlike the
// still-deferred "Download new version" flow).
//
// kind distinguishes the video slot from the separate, coexisting MP3 slot --
// 'audio' only ever touches downloadedAudioFilePath, leaving the video
// fields (and vice versa) completely untouched, so downloading one never
// disturbs the other.
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

// "Download different quality" -- the safety rule from the original spec is
// "don't replace on download, download with an alternative name and once the
// download is fine delete the old one and rename the new one." tempFilePath
// is wherever the just-completed download actually landed (a distinct
// "video.new.<ext>" path the caller downloads to, never the live file's own
// path), so a failed/interrupted download never touches the working file --
// this function is only ever called after startDownload's own isDone/isError
// signal confirms the new file is real and complete. Guard-railed against
// libraryDir with the same path.relative check deleteLibraryEntry uses.
export function swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath, resolution, format, kind = 'video' }) {
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedTempFilePath = path.resolve(tempFilePath || '');
    const relative = path.relative(resolvedLibraryDir, resolvedTempFilePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Refusing to swap in a file outside the configured library folder.');
    }

    const resolvedVideoDir = path.resolve(videoDir);
    // The deterministic "video.<ext>"/"audio.<ext>" slot this video's
    // downloads always live at (see LibraryVideoDetail.tsx's outputPath) --
    // re-derived from the temp file's own resolved extension rather than
    // reusing oldFilePath's name verbatim, since a quality swap can also
    // change format/extension.
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

// Guard-railed even though videoDir always originates from our own index in
// practice -- deleting is destructive enough to be worth defense in depth
// against ever operating outside the configured library folder.
//
// epoch, when given, deletes just that one version instead of the whole
// video -- the version-control UI always passes whichever epoch is
// currently displayed. Deliberately does NOT try to compute "the new latest
// remaining version" itself: scanLibrary()'s existing tolerant newest-valid-
// epoch logic already does exactly that on the next refresh, and
// re-implementing the same rule here a second time would risk the two
// drifting apart later. Callers just need to know whether the whole video
// is now gone (videoDeleted) so they can decide whether to navigate back to
// the library root or stay and let a refresh pick the video's new latest.
export function deleteLibraryEntry({ libraryDir, videoDir, epoch }) {
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedVideoDir = path.resolve(videoDir || '');
    const relative = path.relative(resolvedLibraryDir, resolvedVideoDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
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

// "Override" means replace the tracked entry, not add another version --
// "Add as new version" is the (not yet built) additive path. Deletes
// existingVideoDir exactly as given (the caller already knows it from an
// earlier findVideoInIndex lookup) rather than re-deriving it from
// videoMetaData -- if the title or channel display name drifted since the
// video was first tracked, writeLibraryEntry could land on a different path
// than the one being replaced, and re-deriving would silently miss cleaning
// up the real old folder.
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
// version-control UI, while `latestEpoch`/`metadata` stay pointed at the
// newest valid one exactly as before -- every existing consumer (grid
// cards, channel display name, channel-icon lookup) reads only those two
// fields and is completely unaffected by this.
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

            // Video-level, not per-epoch -- ensureVideoThumbnail (main.js)
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

        // Cached by ensureChannelIcon (main.js) the first time a video from
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

// One-time snapshot of a fetched playlist's contents -- not a live-synced
// mirror (see futureSpecsFeedback.md's "Playlist saving" assessment: whether
// to re-sync against upstream changes later is an open design question,
// deliberately deferred). Same epoch-folder shape as a video's own
// versioning (<libraryDir>/playlists/<playlistId>/<epoch>/metadata.json) so
// the versioning/playlist-view features planned on top of this later have a
// consistent structure to build against from day one, even though nothing
// reads these epochs back yet.
//
// Real epoch handling (deciding when a re-fetch is actually a new version
// worth keeping vs. just a refresh) is deferred to that future work -- for
// now, a playlist gets exactly one epoch ever. Every bulk-add run against
// the same playlist link calls this again, and without this guard that
// would silently pile up a fresh, functionally-identical epoch folder per
// run. If one already exists, this is a no-op.
//
// localFiles maps each entry's videoId to wherever that video's own
// videoDir currently is in the library (or null if it isn't tracked at
// all) -- computed once, from the index as of this snapshot, purely so
// future features (a playlist view, "download everything still missing")
// have something to key off immediately rather than needing to invent this
// mapping later.
//
// Each entry also carries its own title/thumbnailUrl/uploadDate (as of this
// snapshot) rather than just a bare videoId/url -- entries.length can run
// into the hundreds and localFiles will be null for most of them at
// save-time (nothing's downloaded yet), so this is the fallback display
// data a future playlist view needs to show something for those, without
// depending on the video ever actually getting added to the library.
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
        schemaVersion: 1,
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
// actually known -- called from the bulk-add loop right after a video
// belonging to a saved playlist gets its own real info fetched (see
// useBulkAddQueue.tsx). This is deliberately additive/non-destructive: a
// dead incoming title (isDeadTitle) or a missing uploadDate/thumbnailUrl
// never overwrites whatever was already stored, so a later re-fetch of the
// playlist that happens to see the video as unavailable can't regress data
// this already captured while it was still up. Silently no-ops if the
// playlist was never saved or doesn't have this entry -- bulk-adding an
// individual video that isn't part of any known playlist is the common
// case, not an error.
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

// Summary list for the Library tab's new Playlists section -- nothing before
// this read a saved playlist snapshot back into the renderer at all.
export function listPlaylistSnapshots({ libraryDir }) {
    const playlistsRoot = path.join(libraryDir, PLAYLISTS_DIR_NAME);
    if (!fs.existsSync(playlistsRoot)) return [];

    const summaries = [];
    for (const dirEntry of fs.readdirSync(playlistsRoot, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const epochDir = resolvePlaylistEpochDir(path.join(playlistsRoot, dirEntry.name));
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
        });
    }
    summaries.sort((a, b) => (b.addedEpoch || 0) - (a.addedEpoch || 0));
    return summaries;
}

// Full detail for one saved playlist -- backs the Playlists section's detail
// view (entries, localFiles) and tells the UI whether Undo has anything to
// act on.
export function getPlaylistSnapshot({ libraryDir, playlistId }) {
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
        // No previousMetadata.json (nothing to undo) -- stays null.
    }

    return {
        ...metadata,
        hasPreviousMetadata: previousMetadataSavedEpoch !== null,
        previousMetadataSavedEpoch,
    };
}

// Refresh, not a new version -- versioning was explicitly ruled out in favor
// of reconciling in place with a single undo step (see futureSpecsFeedback.md
// once updated, and the plan this landed under). Matched by videoId (stable
// even for a video YouTube has since killed):
//   - a *dead* fresh entry (isDeadTitle) whose videoId already has a saved
//     entry keeps the saved entry's data untouched -- a placeholder must
//     never clobber real data.
//   - a fresh entry with real data always wins (missing individual fields
//     fall back to the saved entry's own value) -- "keep it as updated as
//     possible" is the whole point, and the only protection asked for is
//     specifically against dead data, not against a legitimate retitle.
//   - a saved entry whose videoId is *entirely absent* from the fresh fetch
//     (not even as a dead placeholder) is dropped -- that absence, as
//     opposed to a dead-but-present slot, is the signal the playlist owner
//     removed it themselves on YouTube, not that YouTube killed the video.
// Before any of this, the current metadata.json is copied verbatim to a
// sibling previousMetadata.json (overwriting any earlier one -- this is a
// single undo step, not a history) so undoPlaylistRefresh can revert it. The
// live metadata.json is only ever touched via the same temp-then-rename
// pattern swapLibraryDownload already established, so a crash mid-refresh
// never leaves it partially written.
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
            // A fresh fetch turning up dead is exactly the "removed/private on
            // YouTube" signal the (not on YouTube) tag exists for -- flagged
            // here even when an already-saved entry's own (real) data is kept
            // untouched, since the placeholder-preservation rule above is only
            // about not clobbering title/thumbnail/uploadDate, not about
            // hiding the fact that this refresh just found it dead.
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
