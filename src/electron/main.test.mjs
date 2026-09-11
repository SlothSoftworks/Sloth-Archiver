import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// main.mjs is the real Electron entry point -- it imports 'electron' directly
// and, at module-evaluation time, computes paths off app.getPath('userData')
// and registers ipcMain handlers/process listeners. All of that is made safe
// to import here by mocking 'electron' entirely (same technique as
// preload.test.mjs) and pointing app.getPath at a real temp directory, so
// any incidental fs reads/writes (readSettings, cookiesArgs) land somewhere
// real and harmless instead of the actual OS userData folder.
//
// This file only covers main.mjs's exported pure/near-pure helpers -- the
// ~50 ipcMain.handle(...) bodies (download orchestration, library IPC,
// cookie dialogs, etc.) are still inline, unexported callbacks and are out
// of scope for this pass; see the commit this landed in for the reasoning.
// vi.mock (and everything it needs from vi.hoisted) is hoisted above every
// other statement in this file, including plain top-level `const`s and even
// the static `import './main.mjs'` below -- so the mock's return value has to
// be a value computable without any fs/os calls (a plain string is enough at
// import time, since main.mjs's own top-level code only builds path strings
// from it, it doesn't read/write anything there yet). The real directory is
// created for real just below, before any test runs.
const electronMocks = vi.hoisted(() => {
  const mockUserDataDir = `${process.env.TMPDIR || '/tmp'}/sloth-archiver-test-userdata-${process.pid}-${Date.now()}`;
  return {
    mockUserDataDir,
    app: {
      getPath: () => mockUserDataDir,
      isPackaged: false,
      on: () => {},
      quit: () => {},
    },
    BrowserWindow: Object.assign(() => {}, { getAllWindows: () => [] }),
    ipcMain: { handle: () => {} },
    dialog: { showOpenDialog: () => {}, showSaveDialog: () => {} },
    shell: { openPath: () => {}, showItemInFolder: () => {} },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    net: { fetch: () => {} },
  };
});

vi.mock('electron', () => electronMocks);

import {
  cookiesArgs,
  mimeTypeForPath,
  pickBestThumbnail,
  looksLikeNetscapeFormat,
  convertHeaderCookiesToNetscape,
  validateNetscapeLines,
  buildResolutions,
  reshapeVideoInfo,
  isDeadVideoInfo,
  needsDirectFfmpegPass,
  ffmpegTargetExtension,
  withTargetExtension,
  buildDownloadArgs,
  findFinalFile,
  findRawDownloadedFile,
  assertValidHttpUrl,
  isValidClipTimestamp,
  resolveAppOrLibraryPath,
  rememberAppPath,
  makeCookiesArgs,
  reapStaleCookieCopies,
  getCookiesPersistAcrossSessions,
  jsRuntimeArgs,
  ytdlpSpawnEnv,
} from './main.mjs';

fs.mkdirSync(electronMocks.mockUserDataDir, { recursive: true });
const settingsPath = path.join(electronMocks.mockUserDataDir, 'settings.json');
const cookiesPath = path.join(electronMocks.mockUserDataDir, 'cookies.txt');

function resetSettingsAndCookies() {
  fs.rmSync(settingsPath, { force: true });
  fs.rmSync(cookiesPath, { force: true });
}

describe('mimeTypeForPath', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(mimeTypeForPath('/x/index.html')).toBe('text/html');
    expect(mimeTypeForPath('/x/app.js')).toBe('text/javascript');
    expect(mimeTypeForPath('/x/style.css')).toBe('text/css');
    expect(mimeTypeForPath('/x/photo.png')).toBe('application/octet-stream');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeTypeForPath('/x/INDEX.HTML')).toBe('text/html');
  });
});

describe('pickBestThumbnail', () => {
  it('picks the widest thumbnail when several are given', () => {
    const thumbnails = [{ url: 'small', width: 120 }, { url: 'big', width: 1280 }, { url: 'medium', width: 480 }];
    expect(pickBestThumbnail('vid1', thumbnails)).toBe('big');
  });

  it('falls back to the predictable CDN URL when no thumbnails are given', () => {
    expect(pickBestThumbnail('vid1', [])).toBe('https://i.ytimg.com/vi/vid1/mqdefault.jpg');
    expect(pickBestThumbnail('vid1', undefined)).toBe('https://i.ytimg.com/vi/vid1/mqdefault.jpg');
  });
});

describe('looksLikeNetscapeFormat', () => {
  it('recognizes a Netscape-format comment header', () => {
    expect(looksLikeNetscapeFormat('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t123\tname\tvalue')).toBe(true);
  });

  it('recognizes a bare well-formed 7-field tab-separated line', () => {
    expect(looksLikeNetscapeFormat('.youtube.com\tTRUE\t/\tTRUE\t123\tname\tvalue')).toBe(true);
  });

  it('rejects a raw cookie-header string', () => {
    expect(looksLikeNetscapeFormat('CONSENT=YES+42; VISITOR_INFO1_LIVE=abc')).toBe(false);
  });
});

describe('convertHeaderCookiesToNetscape', () => {
  it('converts a raw cookie-header string into Netscape lines scoped to youtube.com only', () => {
    const result = convertHeaderCookiesToNetscape('a=1; b=2');
    const { valid } = validateNetscapeLines(result);
    expect(valid).toBe(2); // distinct cookie names: a, b
    expect(result).toContain('.youtube.com\tTRUE\t/\tTRUE\t');
    expect(result).not.toContain('google.com');
    expect(result).toContain('\ta\t1');
    expect(result).toContain('\tb\t2');
  });

  it('stamps a short (~30 day), not multi-year, expiry', () => {
    const result = convertHeaderCookiesToNetscape('a=1');
    const expiry = Number(result.split('\t')[4]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const thirtyOneDays = 60 * 60 * 24 * 31;
    const oneYear = 60 * 60 * 24 * 365;
    expect(expiry - nowSeconds).toBeGreaterThan(0);
    expect(expiry - nowSeconds).toBeLessThan(thirtyOneDays);
    expect(expiry - nowSeconds).toBeLessThan(oneYear);
  });

  it('collapses embedded line breaks before parsing (wrapped-copy paste damage)', () => {
    const result = convertHeaderCookiesToNetscape('a=1;\nb=2');
    expect(validateNetscapeLines(result).valid).toBe(2);
  });

  it('skips malformed pairs with no "=" and empty segments', () => {
    const result = convertHeaderCookiesToNetscape('a=1; ; novalue; b=2');
    expect(validateNetscapeLines(result).valid).toBe(2);
  });
});

describe('validateNetscapeLines', () => {
  it('counts distinct cookie names, ignoring comments/blank lines', () => {
    const content = [
      '# Netscape HTTP Cookie File',
      '',
      '.youtube.com\tTRUE\t/\tTRUE\t123\tname\tvalue1',
      '.google.com\tTRUE\t/\tTRUE\t123\tname\tvalue1', // same name, different domain -- still one distinct name
      '.youtube.com\tTRUE\t/\tTRUE\t123\tother\tvalue2',
    ].join('\n');
    expect(validateNetscapeLines(content)).toEqual({ valid: 2, invalid: 0 });
  });

  it('counts malformed lines as invalid', () => {
    const content = 'not\tenough\tfields';
    expect(validateNetscapeLines(content)).toEqual({ valid: 0, invalid: 1 });
  });
});

describe('buildResolutions', () => {
  it('builds one entry per distinct video height plus an MP3 entry, with size estimates including best audio', () => {
    const info = {
      duration: 100,
      formats: [
        { height: 720, vcodec: 'avc1', ext: 'mp4', tbr: 2000 },
        { height: 720, vcodec: 'avc1', ext: 'mp4', tbr: 2500 }, // duplicate height, ignored
        { height: 1080, vcodec: 'avc1', ext: 'mp4', filesize: 50_000_000 },
        { height: null, vcodec: 'avc1', ext: 'mp4', tbr: 100 }, // no height, ignored
        { vcodec: 'none', acodec: 'opus', abr: 128 }, // audio-only, used for the size bump + MP3 estimate
      ],
    };
    const resolutions = buildResolutions(info);
    const heights = resolutions.map((r) => r.resolution);
    expect(heights).toEqual(['720', '1080', 'MP3']);

    const mp3 = resolutions.find((r) => r.resolution === 'MP3');
    expect(mp3.ext).toBe('mp3');
    expect(mp3.filesizeMb).toBeGreaterThan(0);

    const r1080 = resolutions.find((r) => r.resolution === '1080');
    // filesize (50MB) + best audio's estimated size, in MB
    expect(r1080.filesizeMb).toBeGreaterThan(50_000_000 / (1024 * 1024));
  });

  it('returns an empty array (no MP3 entry either) when there are no usable video formats', () => {
    expect(buildResolutions({ duration: 100, formats: [] })).toEqual([]);
    expect(buildResolutions({ duration: 100 })).toEqual([]);
  });

  it('leaves filesizeMb null when neither filesize/filesize_approx nor tbr+duration are available', () => {
    const resolutions = buildResolutions({ formats: [{ height: 480, vcodec: 'avc1', ext: 'mp4' }] });
    expect(resolutions.find((r) => r.resolution === '480').filesizeMb).toBeNull();
  });
});

describe('reshapeVideoInfo', () => {
  it('maps yt-dlp field names to the app\'s own response shape', () => {
    const info = {
      id: 'abc', title: 't', thumbnail: 'th', thumbnails: [], description: 'd',
      channel_id: 'UC1', duration: 42, duration_string: '0:42', original_url: 'u',
      categories: ['c'], tags: ['tag'], release_timestamp: 123,
      uploader: 'up', uploader_id: 'upid', uploader_url: 'upurl',
      upload_date: '20260101', playlist: null, playlist_index: null,
      fulltitle: 'full t', ext: 'mp4', language: 'en', formats: [],
    };
    const result = reshapeVideoInfo(info);
    expect(result).toMatchObject({
      id: 'abc', channelId: 'UC1', durationString: '0:42', originalUrl: 'u',
      uploaderId: 'upid', uploaderUrl: 'upurl', uploadDate: '20260101',
      fullTitle: 'full t', sourceFormat: 'mp4',
    });
  });
});

describe('isDeadVideoInfo', () => {
  it('is alive with no resolutions as long as channelId/uploader is set (e.g. an audio-only SoundCloud source)', () => {
    expect(isDeadVideoInfo({ resolutions: [], channelId: 'UC1' })).toBe(false);
  });

  it('is dead when there is no channelId and no uploader', () => {
    expect(isDeadVideoInfo({ resolutions: [{ resolution: '720' }], channelId: null, uploader: null })).toBe(true);
  });

  it('is alive when resolutions exist and at least one of channelId/uploader is set', () => {
    expect(isDeadVideoInfo({ resolutions: [{ resolution: '720' }], channelId: null, uploader: 'Someone' })).toBe(false);
  });
});

describe('needsDirectFfmpegPass', () => {
  it('is true for mp3 resolution, case-insensitively', () => {
    expect(needsDirectFfmpegPass({ resolution: 'MP3' })).toBe(true);
    expect(needsDirectFfmpegPass({ resolution: 'mp3' })).toBe(true);
  });

  it('is true for a real explicit format', () => {
    expect(needsDirectFfmpegPass({ format: 'webm' })).toBe(true);
  });

  it('is false for the sentinel "undefined"/"dflt" format values or nothing at all', () => {
    expect(needsDirectFfmpegPass({ format: 'undefined' })).toBe(false);
    expect(needsDirectFfmpegPass({ format: 'dflt' })).toBe(false);
    expect(needsDirectFfmpegPass({ resolution: '720' })).toBe(false);
  });
});

describe('ffmpegTargetExtension', () => {
  it('returns "mp3" when resolution is mp3, taking priority over format', () => {
    expect(ffmpegTargetExtension({ resolution: 'mp3', format: 'webm' })).toBe('mp3');
  });

  it('returns the lowercased format when set', () => {
    expect(ffmpegTargetExtension({ format: 'WEBM' })).toBe('webm');
  });

  it('returns null when neither applies', () => {
    expect(ffmpegTargetExtension({ format: 'dflt' })).toBeNull();
    expect(ffmpegTargetExtension({})).toBeNull();
  });
});

describe('withTargetExtension', () => {
  it('replaces an existing extension', () => {
    expect(withTargetExtension('/a/b/video.mp4', 'mp3')).toBe(path.join('/a/b', 'video.mp3'));
  });

  it('adds an extension to an extension-less path', () => {
    expect(withTargetExtension('/a/b/video', 'mp3')).toBe(path.join('/a/b', 'video.mp3'));
  });
});

describe('buildDownloadArgs', () => {
  it('uses an audio-only selector for mp3, and a merged mp4 selector otherwise', () => {
    resetSettingsAndCookies();
    const mp3Args = buildDownloadArgs({ videoUrl: 'u', outputPath: 'o', resolution: 'mp3' });
    expect(mp3Args).toContain('bestaudio/best');
    expect(mp3Args).not.toContain('--merge-output-format');

    const videoArgs = buildDownloadArgs({ videoUrl: 'u', outputPath: 'o', resolution: '720' });
    expect(videoArgs).toContain('bestvideo[height<=720]+bestaudio/best');
    expect(videoArgs).toContain('--merge-output-format');
    expect(videoArgs).toContain('mp4');
  });

  it('only adds --force-overwrites when overwriteMode is "overwrite"', () => {
    resetSettingsAndCookies();
    expect(buildDownloadArgs({ videoUrl: 'u', outputPath: 'o', resolution: '720' })).not.toContain('--force-overwrites');
    expect(buildDownloadArgs({ videoUrl: 'u', outputPath: 'o', resolution: '720', overwriteMode: 'overwrite' })).toContain('--force-overwrites');
  });

  it('appends the video URL as the final argument', () => {
    resetSettingsAndCookies();
    const args = buildDownloadArgs({ videoUrl: 'https://youtube.com/watch?v=x', outputPath: 'o', resolution: '720' });
    expect(args[args.length - 1]).toBe('https://youtube.com/watch?v=x');
  });

  // Without a '--' separator, a videoUrl starting with '-' (e.g. '--exec=...')
  // would be parsed by yt-dlp as an option instead of a URL.
  it('inserts a "--" separator immediately before the video URL', () => {
    resetSettingsAndCookies();
    const args = buildDownloadArgs({ videoUrl: 'https://youtube.com/watch?v=x', outputPath: 'o', resolution: '720' });
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('https://youtube.com/watch?v=x');
  });
});

describe('assertValidHttpUrl', () => {
  it('accepts http(s) URLs and returns the parsed URL', () => {
    expect(assertValidHttpUrl('https://youtube.com/watch?v=x').href).toBe('https://youtube.com/watch?v=x');
    expect(() => assertValidHttpUrl('http://example.com')).not.toThrow();
  });

  it('rejects a value that would be parsed by yt-dlp as an option', () => {
    expect(() => assertValidHttpUrl('--exec=touch pwned')).toThrow(/Invalid/);
  });

  it('rejects non-http(s) schemes such as file: and data:', () => {
    expect(() => assertValidHttpUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => assertValidHttpUrl('data:text/plain,hi')).toThrow(/http/);
  });

  it('rejects unparseable input', () => {
    expect(() => assertValidHttpUrl('not a url')).toThrow(/Invalid/);
    expect(() => assertValidHttpUrl('')).toThrow(/Invalid/);
  });

  it('includes the caller-supplied label in the error message', () => {
    expect(() => assertValidHttpUrl('not a url', 'playlist URL')).toThrow(/playlist URL/);
  });
});

describe('jsRuntimeArgs', () => {
  it('points yt-dlp at the bundled Deno binary via the deno provider', () => {
    const [flag, value] = jsRuntimeArgs();
    expect(flag).toBe('--js-runtimes');
    expect(value.startsWith('deno:')).toBe(true);
    expect(value.endsWith(process.platform === 'win32' ? 'deno.exe' : 'deno')).toBe(true);
  });
});

describe('ytdlpSpawnEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not set ELECTRON_RUN_AS_NODE -- that was only ever needed for the Electron-as-node runtime, not Deno', () => {
    expect(ytdlpSpawnEnv().ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('does not leak arbitrary secrets from process.env through to the spawned env', () => {
    vi.stubEnv('SOME_API_TOKEN', 'super-secret-value');
    expect(ytdlpSpawnEnv().SOME_API_TOKEN).toBeUndefined();
  });

  it('passes through HOME -- cookies-from-browser resolves a browser profile dir via it', () => {
    vi.stubEnv('HOME', '/Users/someone');
    expect(ytdlpSpawnEnv().HOME).toBe('/Users/someone');
  });

  it('passes through the Windows profile-dir variables cookies-from-browser also relies on', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\someone');
    vi.stubEnv('APPDATA', 'C:\\Users\\someone\\AppData\\Roaming');
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\someone\\AppData\\Local');
    const env = ytdlpSpawnEnv();
    expect(env.USERPROFILE).toBe('C:\\Users\\someone');
    expect(env.APPDATA).toBe('C:\\Users\\someone\\AppData\\Roaming');
    expect(env.LOCALAPPDATA).toBe('C:\\Users\\someone\\AppData\\Local');
  });

  it('passes through PATH and the temp-dir variables', () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('TEMP', '/tmp/a');
    vi.stubEnv('TMP', '/tmp/b');
    vi.stubEnv('TMPDIR', '/tmp/c');
    const env = ytdlpSpawnEnv();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.TEMP).toBe('/tmp/a');
    expect(env.TMP).toBe('/tmp/b');
    expect(env.TMPDIR).toBe('/tmp/c');
  });

  it('omits an allowlisted key entirely when unset, rather than passing through an undefined value', () => {
    vi.stubEnv('HOME', undefined);
    expect('HOME' in ytdlpSpawnEnv()).toBe(false);
  });
});

describe('isValidClipTimestamp', () => {
  it('accepts every shape the renderer\'s own timestamp formatters can produce', () => {
    expect(isValidClipTimestamp('5')).toBe(true);
    expect(isValidClipTimestamp('45')).toBe(true);
    expect(isValidClipTimestamp('5:30')).toBe(true);
    expect(isValidClipTimestamp('12:34')).toBe(true);
    expect(isValidClipTimestamp('12:34:56')).toBe(true);
    expect(isValidClipTimestamp('100000:00:00')).toBe(true); // very long video, unbounded hours
    expect(isValidClipTimestamp('12.5')).toBe(true); // drag-derived sub-second boundary
    expect(isValidClipTimestamp('12:34:56.789')).toBe(true);
  });

  it('rejects malformed groups and non-string/empty input', () => {
    expect(isValidClipTimestamp('')).toBe(false);
    expect(isValidClipTimestamp('1:2')).toBe(false); // groups after the first must be 2 digits
    expect(isValidClipTimestamp('12:345')).toBe(false);
    expect(isValidClipTimestamp('1:2:3:4')).toBe(false); // too many groups
    expect(isValidClipTimestamp(null)).toBe(false);
    expect(isValidClipTimestamp(undefined)).toBe(false);
    expect(isValidClipTimestamp('12.5678')).toBe(false); // more than 3 fractional digits
    expect(isValidClipTimestamp('12.5:34')).toBe(false); // '.' only allowed on the trailing (seconds) group
  });

  it('rejects a value shaped to reach ffmpeg as an injected option', () => {
    expect(isValidClipTimestamp('-1')).toBe(false);
    expect(isValidClipTimestamp('--exec=touch pwned')).toBe(false);
  });
});

describe('resolveAppOrLibraryPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-library-'));
  const libraryFile = path.join(dir, 'video.mp4');
  fs.writeFileSync(libraryFile, 'data');

  it('resolves a path inside the configured library', () => {
    expect(resolveAppOrLibraryPath(dir, libraryFile)).toBe(path.resolve(libraryFile));
  });

  it('rejects a path outside the library that was never handed to the renderer', () => {
    expect(resolveAppOrLibraryPath(dir, '/etc/passwd')).toBeNull();
  });

  it('accepts a path outside the library once rememberAppPath has recorded it', () => {
    const outside = path.join(os.tmpdir(), `sloth-archiver-test-download-${Date.now()}.mp4`);
    expect(resolveAppOrLibraryPath(dir, outside)).toBeNull();
    rememberAppPath(outside);
    expect(resolveAppOrLibraryPath(dir, outside)).toBe(path.resolve(outside));
  });

  it('ignores a falsy path rather than remembering it', () => {
    rememberAppPath('');
    rememberAppPath(null);
    expect(resolveAppOrLibraryPath(dir, '')).toBeNull();
  });
});

describe('findFinalFile', () => {
  it('returns the most recently modified file matching the output path prefix', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-final-'));
    try {
      const outputPath = path.join(dir, 'video');
      fs.writeFileSync(`${outputPath}.mp4`, 'first');
      await new Promise((r) => setTimeout(r, 5));
      fs.writeFileSync(`${outputPath}.mp4.mp3`, 'second, newer');
      expect(findFinalFile(outputPath)).toBe(`${outputPath}.mp4.mp3`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the given outputPath when the directory does not exist', () => {
    const outputPath = path.join(os.tmpdir(), 'sloth-archiver-test-missing-dir', 'video.mp4');
    expect(findFinalFile(outputPath)).toBe(outputPath);
  });
});

describe('findRawDownloadedFile', () => {
  it('finds the single raw.* file in the given directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-raw-'));
    try {
      fs.writeFileSync(path.join(dir, 'raw.webm'), 'data');
      expect(findRawDownloadedFile(dir)).toBe(path.join(dir, 'raw.webm'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when no raw.* file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-raw-empty-'));
    try {
      expect(() => findRawDownloadedFile(dir)).toThrow(/no raw downloaded file was found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cookiesArgs', () => {
  it('returns [] when no cookies file exists and no browser mode is configured', () => {
    resetSettingsAndCookies();
    expect(cookiesArgs()).toEqual([]);
  });

  it('returns --cookies pointing at a fresh per-call copy, never the canonical file directly', () => {
    resetSettingsAndCookies();
    fs.writeFileSync(cookiesPath, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tname\tvalue\n');
    const [flag, copyPath] = cookiesArgs();
    try {
      expect(flag).toBe('--cookies');
      expect(copyPath).not.toBe(cookiesPath);
      expect(fs.readFileSync(copyPath, 'utf-8')).toBe(fs.readFileSync(cookiesPath, 'utf-8'));
    } finally {
      fs.rmSync(copyPath, { force: true });
    }
  });

  it('gives each call its own copy, so concurrent runs cannot corrupt or race one another', () => {
    resetSettingsAndCookies();
    fs.writeFileSync(cookiesPath, '# Netscape HTTP Cookie File\n');
    const [, copyPathA] = cookiesArgs();
    const [, copyPathB] = cookiesArgs();
    try {
      expect(copyPathA).not.toBe(copyPathB);
    } finally {
      fs.rmSync(copyPathA, { force: true });
      fs.rmSync(copyPathB, { force: true });
    }
  });

  it('returns --cookies-from-browser when browser mode is configured with a supported browser', () => {
    resetSettingsAndCookies();
    fs.writeFileSync(settingsPath, JSON.stringify({ cookiesMode: 'browser', cookiesBrowser: 'firefox' }));
    expect(cookiesArgs()).toEqual(['--cookies-from-browser', 'firefox']);
  });

  it('falls back to file mode when browser mode is set but the browser is unsupported', () => {
    resetSettingsAndCookies();
    fs.writeFileSync(settingsPath, JSON.stringify({ cookiesMode: 'browser', cookiesBrowser: 'not-a-real-browser' }));
    expect(cookiesArgs()).toEqual([]);
  });
});

describe('getCookiesPersistAcrossSessions', () => {
  it('respects an explicit true/false setting regardless of whether a cookie file exists', () => {
    resetSettingsAndCookies();
    fs.writeFileSync(settingsPath, JSON.stringify({ cookiesPersistAcrossSessions: true }));
    expect(getCookiesPersistAcrossSessions()).toBe(true);

    fs.writeFileSync(cookiesPath, '# Netscape HTTP Cookie File\n');
    fs.writeFileSync(settingsPath, JSON.stringify({ cookiesPersistAcrossSessions: false }));
    expect(getCookiesPersistAcrossSessions()).toBe(false);
  });

  it('defaults to true (grandfathered in) when no setting exists yet but a cookie file is already saved', () => {
    resetSettingsAndCookies();
    fs.writeFileSync(cookiesPath, '# Netscape HTTP Cookie File\n');
    expect(getCookiesPersistAcrossSessions()).toBe(true);
  });

  it('defaults to false (the safer default) when no setting exists yet and no cookie file is saved', () => {
    resetSettingsAndCookies();
    expect(getCookiesPersistAcrossSessions()).toBe(false);
  });
});

describe('makeCookiesArgs (with an injected tmpDir)', () => {
  it('never touches the canonical cookiesPath, only reads it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-cookies-'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-cookiescopy-'));
    try {
      const cookiesFile = path.join(dir, 'cookies.txt');
      fs.writeFileSync(cookiesFile, 'original content');
      const originalMtime = fs.statSync(cookiesFile).mtimeMs;
      const args = makeCookiesArgs(() => ({ cookiesMode: 'file' }), cookiesFile, tmpDir);
      const [, copyPath] = args();
      expect(path.dirname(copyPath)).toBe(tmpDir);
      expect(fs.readFileSync(cookiesFile, 'utf-8')).toBe('original content');
      expect(fs.statSync(cookiesFile).mtimeMs).toBe(originalMtime);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('reapStaleCookieCopies', () => {
  it('deletes only its own old copies, leaving recent copies and unrelated files alone', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-reap-'));
    try {
      const oldCopy = path.join(tmpDir, 'sloth-archiver-cookies-old.txt');
      const recentCopy = path.join(tmpDir, 'sloth-archiver-cookies-recent.txt');
      const unrelated = path.join(tmpDir, 'some-other-file.txt');
      fs.writeFileSync(oldCopy, 'x');
      fs.writeFileSync(recentCopy, 'x');
      fs.writeFileSync(unrelated, 'x');
      const oldTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      fs.utimesSync(oldCopy, oldTime, oldTime);

      reapStaleCookieCopies(10 * 60 * 1000, tmpDir); // 10 minute max age

      expect(fs.existsSync(oldCopy)).toBe(false);
      expect(fs.existsSync(recentCopy)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not throw when the temp directory is missing', () => {
    expect(() => reapStaleCookieCopies(1000, '/no/such/directory')).not.toThrow();
  });
});
