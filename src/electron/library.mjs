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
        schemaVersion: 2,
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
export function recordLibraryDownload({ videoDir, epoch, filePath, resolution, format }) {
    const metadataPath = path.join(videoDir, epoch, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    metadata.downloadedFilePath = filePath;
    metadata.downloadedResolution = resolution || null;
    metadata.downloadedFormat = format || null;
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
export function swapLibraryDownload({ libraryDir, videoDir, epoch, tempFilePath, oldFilePath, resolution, format }) {
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedTempFilePath = path.resolve(tempFilePath || '');
    const relative = path.relative(resolvedLibraryDir, resolvedTempFilePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Refusing to swap in a file outside the configured library folder.');
    }

    const resolvedVideoDir = path.resolve(videoDir);
    // The deterministic "video.<ext>" slot this video's downloads always live
    // at (see LibraryVideoDetail.tsx's outputPath) -- re-derived from the
    // temp file's own resolved extension rather than reusing oldFilePath's
    // name verbatim, since a quality swap can also change format/extension.
    const targetPath = path.join(resolvedVideoDir, epoch, `video${path.extname(resolvedTempFilePath)}`);

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
    metadata.downloadedFilePath = targetPath;
    metadata.downloadedResolution = resolution || null;
    metadata.downloadedFormat = format || null;
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

            videos.push({
                videoFolderName: videoEntry.name,
                videoDir: videoPath,
                latestEpoch,
                metadata,
                epochs,
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
