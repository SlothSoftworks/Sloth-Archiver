import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveInsideLibrary } from './library.mjs';

// A broad real-world video-extension list, not getSupportedVideoFilters()'s
// re-encode-target list (that one deliberately excludes .avi/.mov/.webm/.flv,
// which are all valid things to pick up as a local file to add).
export const LOCAL_VIDEO_FILE_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg'];

// Mirrors LibraryVideoPlayer.tsx's PLAYABLE_VIDEO_EXTENSIONS.
const NATIVE_PLAYABLE_EXTENSIONS = new Set(['mp4', 'webm']);

const OPENED_FILES_LIMIT = 200;

function extensionOf(filePath) {
    return path.extname(filePath).slice(1).toLowerCase();
}

export function isNativePlayableExtension(filePath) {
    return NATIVE_PLAYABLE_EXTENSIONS.has(extensionOf(filePath));
}

// VidTools opens files from anywhere on disk, picked in a dialog or dropped
// onto the window. A dropped path comes from the renderer, so this is the
// whole gate: an absolute path to an existing regular file with a video
// extension. Opened files only ever become readable (see
// createLocalFileAccess), never a valid output target.
export function validateOpenablePath(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        return { success: false, message: 'Not a valid file path.' };
    }
    if (!LOCAL_VIDEO_FILE_EXTENSIONS.includes(extensionOf(filePath))) {
        return { success: false, message: 'Not a supported video file.' };
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return { success: false, message: 'File not found.' };
    }
    if (!stat.isFile()) return { success: false, message: 'Not a file.' };
    return { success: true, filePath: path.resolve(filePath), sizeBytes: stat.size };
}

// ffmpeg's own same-file check compares path strings, so it misses the same
// file reached through a symlink, a hard link, or different letter case on
// a case-insensitive disk. Comparing device + inode catches all three.
export function isSameFile(pathA, pathB) {
    try {
        const a = fs.statSync(pathA, { bigint: true });
        const b = fs.statSync(pathB, { bigint: true });
        return a.dev === b.dev && a.ino === b.ino;
    } catch {
        return false;
    }
}

// Read-only access to files opened in VidTools, plus where their playable
// previews go. Kept apart from main.mjs's recentAppPaths on purpose: that
// set also gates *output* paths, and an opened original must never become
// one.
export function createLocalFileAccess({ previewDir }) {
    const readablePaths = new Set();

    function rememberReadable(filePath) {
        const resolved = path.resolve(filePath);
        readablePaths.delete(resolved);
        readablePaths.add(resolved);
        if (readablePaths.size > OPENED_FILES_LIMIT) {
            readablePaths.delete(readablePaths.values().next().value);
        }
    }

    function isOpened(filePath) {
        return !!filePath && readablePaths.has(path.resolve(filePath));
    }

    function resolveReadableInput(libraryDir, candidatePath) {
        return resolveInsideLibrary(libraryDir, candidatePath)
            || (isOpened(candidatePath) ? path.resolve(candidatePath) : null);
    }

    // Outside the user's own folders, unlike a library file's .preview/.
    function previewPathFor(filePath) {
        const hash = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex');
        return path.join(previewDir, `${hash}.mp4`);
    }

    function clearPreviews({ keep } = {}) {
        let entries;
        try {
            entries = fs.readdirSync(previewDir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const entryPath = path.join(previewDir, entry);
            if (entryPath !== keep) fs.rmSync(entryPath, { force: true, recursive: true });
        }
    }

    return { rememberReadable, isOpened, resolveReadableInput, previewPathFor, clearPreviews };
}
