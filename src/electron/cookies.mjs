import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Browsers yt-dlp's own --cookies-from-browser supports reading a cookie
// database from directly (its documented keyring list) -- kept here as the
// single source of truth for both validating settings:setCookiesConfig and
// populating the Options screen's dropdown.
export const SUPPORTED_COOKIE_BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];

// Every per-run cookie-jar copy (see makeCookiesArgs below) is named with
// this prefix so reapStaleCookieCopies can find them again without also
// touching unrelated files that happen to share the OS temp directory.
const COOKIE_COPY_PREFIX = 'sloth-archiver-cookies-';

// A factory (not a bare function reading module-level state) so this stays a
// pure Node module with no Electron dependency -- readSettings/cookiesPath
// are resolved by main.mjs and injected here, same pattern as settings.mjs's
// createSettingsStore. 'browser' mode takes priority whenever a browser is
// actually configured -- switching modes in Options doesn't delete the saved
// cookies.txt file, so a leftover file from a previous 'file'-mode setup
// should never silently win again once the user has moved to 'browser' mode.
//
// File mode never hands yt-dlp the canonical cookiesPath directly -- each
// call gets its own throwaway copy in the OS temp dir instead. Up to
// MAX_SIMULTANEOUS_DOWNLOADS_CEILING yt-dlp processes can hold a cookie jar
// open at once, and yt-dlp writes its jar back to disk at the end of a run;
// sharing one file across concurrent processes risks both corruption (a
// lost update from racing writes) and cookie-mixing (an unrelated site's
// cookies merging into what the user thinks of as "my YouTube cookie"). The
// canonical file is therefore read-only at runtime. The copy isn't deleted
// the instant its process exits -- that would mean threading cleanup
// through every spawn call site and every download retry -- it's a small
// text file that ages out via reapStaleCookieCopies (called at app startup
// and on an interval, see main.mjs) instead.
export function makeCookiesArgs(readSettings, cookiesPath, tmpDir = os.tmpdir()) {
    return function cookiesArgs() {
        const { cookiesMode, cookiesBrowser } = readSettings();
        if (cookiesMode === 'browser' && SUPPORTED_COOKIE_BROWSERS.includes(cookiesBrowser)) {
            return ['--cookies-from-browser', cookiesBrowser];
        }
        if (!fs.existsSync(cookiesPath)) return [];
        const copyPath = path.join(tmpDir, `${COOKIE_COPY_PREFIX}${crypto.randomUUID()}.txt`);
        fs.copyFileSync(cookiesPath, copyPath);
        return ['--cookies', copyPath];
    };
}

// Deletes per-run cookie copies (see makeCookiesArgs above) older than
// maxAgeMs -- called at app startup (cleaning up anything a previous run
// left behind if it was killed rather than exiting cleanly) and on an
// interval thereafter. Every real download/metadata fetch finishes well
// inside the default window, so this never touches a copy still in use.
export function reapStaleCookieCopies(maxAgeMs = 10 * 60 * 1000, tmpDir = os.tmpdir()) {
    let entries;
    try {
        entries = fs.readdirSync(tmpDir);
    } catch {
        return;
    }
    const now = Date.now();
    for (const entry of entries) {
        if (!entry.startsWith(COOKIE_COPY_PREFIX)) continue;
        const fullPath = path.join(tmpDir, entry);
        try {
            if (now - fs.statSync(fullPath).mtimeMs > maxAgeMs) {
                fs.rmSync(fullPath, { force: true });
            }
        } catch {
            // Already gone, or a permissions blip -- nothing to do.
        }
    }
}

// Accepts either a real Netscape cookies.txt export (produced by browser
// extensions like "Get cookies.txt") or a raw "name=value; name2=value2"
// cookie-header string copied from a browser's DevTools Network tab --
// normalizing the latter into Netscape format so yt-dlp's --cookies flag
// can consume it either way.
export function looksLikeNetscapeFormat(text) {
    return /^\s*#/.test(text) || /^[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]*$/m.test(text);
}

export function convertHeaderCookiesToNetscape(text) {
    // A header paste carries no expiry of its own -- the browser it came
    // from would have discarded these as session cookies when it closed.
    // Stamping them with a short, renewable horizon (rather than treating
    // "no expiry" as "forever") means a forgotten paste ages out on its own
    // instead of persisting as a live credential for years.
    const shortExpiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    // A real cookie-header string is a single logical line. Pasting one out
    // of a wrapped display (e.g. a chat code block) can pick up stray line
    // breaks at the wrap points, severing a value mid-token and corrupting
    // everything after it. Collapsing embedded newlines first prevents that.
    const normalized = text.replace(/[\r\n]+/g, '');
    const lines = ['# Netscape HTTP Cookie File'];
    for (const pair of normalized.split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const name = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!name) continue;
        // Scoped to youtube.com only -- the header was captured from a
        // request to youtube.com, and registering it for the whole of
        // .google.com (as this used to do) would attach it to every
        // Google-hosted subdomain yt-dlp is ever pointed at, far beyond
        // what the source request ever granted.
        lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', String(shortExpiry), name, value].join('\t'));
    }
    // Validity/skip counts are derived centrally in validateNetscapeLines,
    // so they're correct for both this converted output and a raw Netscape
    // passthrough alike.
    return lines.join('\n') + '\n';
}

// Verifies the final file is well-formed Netscape cookie format (every
// non-comment, non-blank line has exactly 7 tab-separated fields) -- a raw
// Netscape paste can suffer the same wrapped-copy corruption as the
// header-string path. "valid" counts *distinct cookie names*, not lines --
// a cookie may legitimately appear on more than one line (a real export
// covering both youtube.com and www.youtube.com, for instance), and raw
// line counts would overstate how many cookies were loaded.
export function validateNetscapeLines(content) {
    const validNames = new Set();
    let invalid = 0;
    for (const line of content.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const fields = line.split('\t');
        if (fields.length === 7) {
            validNames.add(fields[5]);
        } else {
            invalid++;
        }
    }
    return { valid: validNames.size, invalid };
}
