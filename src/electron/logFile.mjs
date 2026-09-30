import fs from 'fs';
import os from 'os';

// SEC-016: main.log used to be appended to forever, and it's the file users
// are asked to attach to public bug reports. Two things keep it shareable:
// it's rotated once it passes a size cap (one previous file kept, as
// main.log.1), and the user's home directory -- which embeds their OS
// username in nearly every path the app logs -- is shown as "~" both in the
// log and in raw tool error text surfaced to the UI.
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replaces every occurrence of the home directory with "~". Case-insensitive
// and separator-agnostic on Windows, where the same path can show up as
// C:\Users\Name or c:/Users/Name depending on which tool printed it. A home
// directory that's just a root ("/", "C:\") is left alone -- replacing that
// would mangle every path.
export function redactHomeDir(text, homeDir = os.homedir(), platform = process.platform) {
    if (typeof text !== 'string' || !homeDir) return text;
    const trimmed = homeDir.replace(/[\\/]+$/, '');
    if (trimmed.length < 2 || /^[A-Za-z]:$/.test(trimmed)) return text;
    // The lookahead stops /home/alice from also matching /home/alice2.
    const boundary = '(?![A-Za-z0-9._-])';
    if (platform === 'win32') {
        const pattern = trimmed.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]');
        return text.replace(new RegExp(pattern + boundary, 'gi'), '~');
    }
    return text.replace(new RegExp(escapeRegExp(trimmed) + boundary, 'g'), '~');
}

// Returns a function that appends one line to filePath, first moving the
// current file aside to <filePath>.1 (replacing any older one) when this
// line would push it past maxBytes. Never throws: a log write failing (disk
// full, permissions) must not take the caller down with it.
export function createRotatingLogWriter(filePath, maxBytes = LOG_MAX_BYTES) {
    return function writeLine(line) {
        const entry = `${line}\n`;
        try {
            let size = 0;
            try {
                size = fs.statSync(filePath).size;
            } catch {
                size = 0;
            }
            if (size > 0 && size + Buffer.byteLength(entry) > maxBytes) {
                fs.renameSync(filePath, `${filePath}.1`);
            }
            fs.appendFileSync(filePath, entry);
        } catch {
            // Deliberately swallowed -- see above.
        }
    };
}
