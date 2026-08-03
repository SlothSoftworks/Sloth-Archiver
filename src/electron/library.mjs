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

// Title alone isn't a safe folder key -- two different videos can share an
// identical title (a re-upload, or coincidence), which would otherwise merge
// their download histories into one folder. Appending the video ID matches a
// de-facto yt-dlp convention (%(title)s [%(id)s]) used for the same reason.
//
// Total folder name (title + " [videoId]") is capped at 50 chars, not just the
// title -- narrows the Windows MAX_PATH=260 edge case logged as TD-005
// (reports/TechnicalDebt.md); doesn't eliminate it (an extreme libraryDir
// depth could still overflow), deliberately not solved further than this for now.
export function videoFolderName(title, videoId) {
    const MAX_TOTAL_LENGTH = 50;
    const suffix = ` [${videoId}]`;
    const maxTitleLength = Math.max(1, MAX_TOTAL_LENGTH - suffix.length);
    const safeTitle = sanitizeForFilesystem(title || 'Untitled', maxTitleLength);
    return `${safeTitle}${suffix}`;
}

export function writeLibraryEntry({ libraryDir, videoMetaData }) {
    const { id, title, fullTitle, description, thumbnail, originalUrl, duration, durationString, uploadDate, channelId, uploader, resolutions } = videoMetaData;
    if (!id) {
        throw new Error('videoMetaData.id is required to add a library entry');
    }
    if (!libraryDir) {
        throw new Error('No library folder is configured -- set one in Options first.');
    }

    const channelDir = path.join(libraryDir, channelFolderName(uploader));
    const videoDir = path.join(channelDir, videoFolderName(title, id));
    const addedEpoch = Date.now();
    const epochDir = path.join(videoDir, String(addedEpoch));
    fs.mkdirSync(epochDir, { recursive: true });

    const metadata = {
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
        // Never set by this bare-bones trigger -- adding a video to the
        // library and downloading its file are separate actions. Filled in by
        // recordLibraryDownload() once an actual download completes.
        downloadedFilePath: null,
        downloadedResolution: null,
        downloadedFormat: null,
    };

    fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    return { channelDir, videoDir, epochDir, metadata };
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
export function deleteLibraryEntry({ libraryDir, videoDir }) {
    const resolvedLibraryDir = path.resolve(libraryDir || '');
    const resolvedVideoDir = path.resolve(videoDir || '');
    const relative = path.relative(resolvedLibraryDir, resolvedVideoDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Refusing to delete a path outside the configured library folder.');
    }
    fs.rmSync(resolvedVideoDir, { recursive: true, force: true });
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
// Single-version only for this pass: if a video folder has multiple epoch
// subfolders, the most recent one with a valid metadata.json wins; full
// version history is an explicitly later, deferred step.
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
            for (const epochName of epochNames) {
                try {
                    const raw = await fsp.readFile(path.join(videoPath, epochName, 'metadata.json'), 'utf-8');
                    metadata = JSON.parse(raw);
                    latestEpoch = epochName;
                    break;
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
            });
        }

        if (videos.length === 0) continue;
        videos.sort((a, b) => (b.metadata.addedEpoch || 0) - (a.metadata.addedEpoch || 0));

        index.channels.push({
            channelFolderName: channelEntry.name,
            displayName: videos[0]?.metadata.channel || channelEntry.name,
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
