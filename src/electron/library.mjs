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
    const { id, title, fullTitle, description, thumbnail, originalUrl, duration, durationString, uploadDate, channelId, uploader } = videoMetaData;
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
        schemaVersion: 1,
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
        // Never set by this bare-bones trigger -- adding a video to the
        // library and downloading its file are separate actions. A later
        // pass fills these in once an actual download completes.
        downloadedFilePath: null,
        downloadedResolution: null,
        downloadedFormat: null,
    };

    fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    return { channelDir, videoDir, epochDir, metadata };
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
