import fs from 'fs';

// Browsers yt-dlp's own --cookies-from-browser supports reading a cookie
// database from directly (its documented keyring list) -- kept here as the
// single source of truth for both validating settings:setCookiesConfig and
// populating the Options screen's dropdown.
export const SUPPORTED_COOKIE_BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];

// A factory (not a bare function reading module-level state) so this stays a
// pure Node module with no Electron dependency -- readSettings/cookiesPath
// are resolved by main.mjs and injected here, same pattern as settings.mjs's
// createSettingsStore. 'browser' mode takes priority whenever a browser is
// actually configured -- switching modes in Options doesn't delete the saved
// cookies.txt file, so a leftover file from a previous 'file'-mode setup
// should never silently win again once the user has moved to 'browser' mode.
export function makeCookiesArgs(readSettings, cookiesPath) {
    return function cookiesArgs() {
        const { cookiesMode, cookiesBrowser } = readSettings();
        if (cookiesMode === 'browser' && SUPPORTED_COOKIE_BROWSERS.includes(cookiesBrowser)) {
            return ['--cookies-from-browser', cookiesBrowser];
        }
        return fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];
    };
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
    const farFutureExpiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5;
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
        // The header was captured from a request to youtube.com, but
        // yt-dlp's YouTube extractor also makes requests to Google's shared
        // account-auth infrastructure -- registering under both domains
        // (cookie jars key by domain+path+name, so this can't conflict)
        // maximizes the chance the cookie is sent where needed.
        for (const domain of ['.youtube.com', '.google.com']) {
            lines.push([domain, 'TRUE', '/', 'TRUE', String(farFutureExpiry), name, value].join('\t'));
        }
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
// a cookie may legitimately appear on more than one line (our own dual
// .youtube.com/.google.com registration, or a real export covering both
// youtube.com and www.youtube.com), and raw line counts would overstate how
// many cookies were loaded.
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
