import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createChannelScanner, createChannelScanSession, parseChannelEntryLine } from './channelScan.mjs';
import { ERROR_KINDS } from './downloadErrors.mjs';

const CHANNEL_ID = 'UCHnyfMqiRRG1u-2MsSQLbXA';
const VIDEOS_URL = 'https://www.youtube.com/@veritasium/videos';

// A stand-in for child_process.spawn: records every call and hands back an
// EventEmitter child the test drives by hand. kill() closes the child with a
// null exit code, the way a signalled process reports itself.
function fakeSpawn() {
    const calls = [];
    function spawn(command, args, options) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => {
            setImmediate(() => child.emit('close', null));
            return true;
        });
        calls.push({ command, args, options, child });
        return child;
    }
    return { spawn, calls };
}

function makeScanner(overrides = {}) {
    const { spawn, calls } = fakeSpawn();
    const onLog = vi.fn();
    const scanner = createChannelScanner({
        ytdlpPath: '/bin/yt-dlp',
        ffmpegDir: '/ffmpeg',
        cookiesArgs: () => ['--cookies', '/c.txt'],
        jsRuntimeArgs: () => ['--js-runtimes', 'deno:/deno'],
        ytdlpSpawnEnv: () => ({ PATH: '/usr/bin' }),
        onLog,
        spawn,
        ...overrides,
    });
    return { scanner, calls, onLog };
}

function line(id, extra = {}) {
    return `${JSON.stringify({ id, title: `Title ${id}`, duration: 60, timestamp: 1790899200, ...extra })}\n`;
}

const ID_A = 'aaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbb';
const ID_C = 'ccccccccccc';

describe('parseChannelEntryLine', () => {
    it('reads a full entry', () => {
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI", "title": "A title", "duration": 308, "timestamp": 1790899200}')).toEqual({
            videoId: 'ONAuUyml0yI', title: 'A title', durationSeconds: 308, approxTimestamp: 1790899200, membersOnly: false,
        });
    });

    it('turns absent or wrongly-typed keys into null', () => {
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI"}')).toEqual({
            videoId: 'ONAuUyml0yI', title: null, durationSeconds: null, approxTimestamp: null, membersOnly: false,
        });
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI", "title": 5, "duration": "308", "timestamp": null}')).toEqual({
            videoId: 'ONAuUyml0yI', title: null, durationSeconds: null, approxTimestamp: null, membersOnly: false,
        });
    });

    it('flags a members-only entry', () => {
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI", "availability": "subscriber_only"}').membersOnly).toBe(true);
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI", "availability": "public"}').membersOnly).toBe(false);
    });

    it('drops upcoming and live entries but keeps finished streams', () => {
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI", "live_status": "is_upcoming"}')).toBeNull();
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI", "live_status": "is_live"}')).toBeNull();
        expect(parseChannelEntryLine('{"id": "ONAuUyml0yI", "live_status": "was_live"}')).not.toBeNull();
    });

    it('drops entries whose id is not an 11-character YouTube id', () => {
        expect(parseChannelEntryLine('{"id": "short"}')).toBeNull();
        expect(parseChannelEntryLine('{"id": "../../../etc"}')).toBeNull();
        expect(parseChannelEntryLine('{"id": 12345678901}')).toBeNull();
        expect(parseChannelEntryLine('{"title": "no id"}')).toBeNull();
    });

    it('returns null for unparseable or non-object lines', () => {
        expect(parseChannelEntryLine('')).toBeNull();
        expect(parseChannelEntryLine('WARNING: something')).toBeNull();
        expect(parseChannelEntryLine('{"id": "ONAuUyml0')).toBeNull();
        expect(parseChannelEntryLine('null')).toBeNull();
        expect(parseChannelEntryLine('["ONAuUyml0yI"]')).toBeNull();
    });
});

describe('resolveChannel', () => {
    it('spawns yt-dlp with the shared dependency args and returns the channel id and name', async () => {
        const { scanner, calls } = makeScanner();
        const onChild = vi.fn();
        const promise = scanner.resolveChannel(VIDEOS_URL, { onChild });
        const { command, args, options, child } = calls[0];
        expect(command).toBe('/bin/yt-dlp');
        expect(args).toEqual([
            '-J', '--no-warnings', '--flat-playlist', '--playlist-end', '1',
            '--ffmpeg-location', '/ffmpeg', '--cookies', '/c.txt', '--js-runtimes', 'deno:/deno', '--', VIDEOS_URL,
        ]);
        expect(options).toEqual({ env: { PATH: '/usr/bin' } });
        expect(onChild).toHaveBeenCalledWith(child);

        child.stdout.emit('data', Buffer.from(JSON.stringify({ channel_id: CHANNEL_ID, channel: 'Veritasium', title: 'Veritasium - Videos' })));
        child.emit('close', 0);
        await expect(promise).resolves.toEqual({ channelId: CHANNEL_ID, title: 'Veritasium', avatarUrl: null });
    });

    it('falls back to uploader, then to the tab title without its " - Videos" suffix', async () => {
        const { scanner, calls } = makeScanner();
        const withUploader = scanner.resolveChannel(VIDEOS_URL);
        calls[0].child.stdout.emit('data', Buffer.from(JSON.stringify({ channel_id: CHANNEL_ID, uploader: 'Uploader Name', title: 'X - Videos' })));
        calls[0].child.emit('close', 0);
        await expect(withUploader).resolves.toEqual({ channelId: CHANNEL_ID, title: 'Uploader Name', avatarUrl: null });

        const titleOnly = scanner.resolveChannel(VIDEOS_URL);
        calls[1].child.stdout.emit('data', Buffer.from(JSON.stringify({ title: 'Some Channel - Videos' })));
        calls[1].child.emit('close', 0);
        await expect(titleOnly).resolves.toEqual({ channelId: null, title: 'Some Channel', avatarUrl: null });
    });

    it('returns the channel avatar, picked the same way the library\'s channel icon is', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.resolveChannel(VIDEOS_URL);
        calls[0].child.stdout.emit('data', Buffer.from(JSON.stringify({
            channel_id: CHANNEL_ID,
            channel: 'Veritasium',
            thumbnails: [
                { id: 'banner_uncropped', url: 'https://yt3.example/banner.jpg' },
                { id: 'avatar', url: 'https://yt3.example/avatar-small.jpg' },
                { id: 'avatar_uncropped', url: 'https://yt3.example/avatar.jpg' },
            ],
        })));
        calls[0].child.emit('close', 0);
        await expect(promise).resolves.toEqual({ channelId: CHANNEL_ID, title: 'Veritasium', avatarUrl: 'https://yt3.example/avatar.jpg' });
    });

    it('rejects with a classified kind on a non-zero exit', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.resolveChannel(VIDEOS_URL);
        calls[0].child.stderr.emit('data', Buffer.from('ERROR: [youtube:tab] Sign in to confirm you\'re not a bot\n'));
        calls[0].child.emit('close', 1);
        await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.BOT_BLOCK, message: expect.stringContaining('not a bot') });
    });

    it('rejects with missingDependency when yt-dlp cannot be started', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.resolveChannel(VIDEOS_URL);
        calls[0].child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.MISSING_DEPENDENCY });
    });

    it('rejects with unknown when the output is not JSON', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.resolveChannel(VIDEOS_URL);
        calls[0].child.stdout.emit('data', Buffer.from('not json'));
        calls[0].child.emit('close', 0);
        await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.UNKNOWN });
    });
});

describe('fetchPublicVideoCount', () => {
    it('asks for the UULF playlist of the channel and returns its playlist_count', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.fetchPublicVideoCount(CHANNEL_ID);
        expect(calls[0].args.at(-1)).toBe('https://www.youtube.com/playlist?list=UULFHnyfMqiRRG1u-2MsSQLbXA');
        expect(calls[0].args.at(-2)).toBe('--');
        expect(calls[0].args).toEqual(expect.arrayContaining(['--flat-playlist', '--playlist-end', '1']));
        calls[0].child.stdout.emit('data', Buffer.from(JSON.stringify({ playlist_count: 450 })));
        calls[0].child.emit('close', 0);
        await expect(promise).resolves.toBe(450);
    });

    it('returns null without spawning anything for a malformed channel id', async () => {
        const { scanner, calls } = makeScanner();
        await expect(scanner.fetchPublicVideoCount('UCshort')).resolves.toBeNull();
        await expect(scanner.fetchPublicVideoCount(`${CHANNEL_ID}&x=1`)).resolves.toBeNull();
        await expect(scanner.fetchPublicVideoCount(null)).resolves.toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('returns null on a non-zero exit, a spawn error, bad JSON, or a missing count', async () => {
        const { scanner, calls } = makeScanner();

        const nonZero = scanner.fetchPublicVideoCount(CHANNEL_ID);
        calls[0].child.stderr.emit('data', Buffer.from('ERROR: The playlist does not exist.\n'));
        calls[0].child.emit('close', 1);
        await expect(nonZero).resolves.toBeNull();

        const spawnError = scanner.fetchPublicVideoCount(CHANNEL_ID);
        calls[1].child.emit('error', new Error('boom'));
        await expect(spawnError).resolves.toBeNull();

        const badJson = scanner.fetchPublicVideoCount(CHANNEL_ID);
        calls[2].child.stdout.emit('data', Buffer.from('{'));
        calls[2].child.emit('close', 0);
        await expect(badJson).resolves.toBeNull();

        const noCount = scanner.fetchPublicVideoCount(CHANNEL_ID);
        calls[3].child.stdout.emit('data', Buffer.from(JSON.stringify({ playlist_count: null })));
        calls[3].child.emit('close', 0);
        await expect(noCount).resolves.toBeNull();
    });

    it('returns null when the call goes silent past its timeout', async () => {
        const { scanner, calls } = makeScanner({ countTimeoutMs: 10 });
        await expect(scanner.fetchPublicVideoCount(CHANNEL_ID)).resolves.toBeNull();
        expect(calls[0].child.kill).toHaveBeenCalled();
    });

    it('returns null when spawn itself throws', async () => {
        const { scanner } = makeScanner({ spawn: () => { throw new Error('EACCES'); } });
        await expect(scanner.fetchPublicVideoCount(CHANNEL_ID)).resolves.toBeNull();
    });
});

describe('scanVideos', () => {
    it('spawns the lazy flat-playlist listing with the print template', () => {
        const { scanner, calls } = makeScanner();
        scanner.scanVideos({ videosUrl: VIDEOS_URL }).catch(() => {});
        expect(calls[0].args).toEqual([
            '--no-warnings', '--flat-playlist', '--lazy-playlist',
            '--extractor-args', 'youtubetab:approximate_date',
            '--print', '%(.{id,title,duration,timestamp,availability,live_status})j',
            '--ffmpeg-location', '/ffmpeg', '--cookies', '/c.txt', '--js-runtimes', 'deno:/deno', '--', VIDEOS_URL,
        ]);
        expect(calls[0].options).toEqual({ env: { PATH: '/usr/bin' } });
        calls[0].child.emit('close', 0);
    });

    it('collects entries across several chunks and reports the running count', async () => {
        const { scanner, calls } = makeScanner();
        const onEntryCount = vi.fn();
        const onChild = vi.fn();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL, onEntryCount, onChild });
        const { child } = calls[0];
        expect(onChild).toHaveBeenCalledTimes(1);
        expect(onChild).toHaveBeenCalledWith(child);

        child.stdout.emit('data', Buffer.from(line(ID_A) + line(ID_B)));
        child.stdout.emit('data', Buffer.from(line(ID_C, { availability: 'subscriber_only' })));
        child.emit('close', 0);

        const { entries, truncated } = await promise;
        expect(entries.map((e) => e.videoId)).toEqual([ID_A, ID_B, ID_C]);
        expect(entries[2].membersOnly).toBe(true);
        expect(truncated).toBe(false);
        expect(onEntryCount.mock.calls).toEqual([[2], [3]]);
    });

    it('reassembles a line split across chunks, including inside a multi-byte character', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        const { child } = calls[0];
        const bytes = Buffer.from(line(ID_A, { title: 'Café 日本' }) + line(ID_B));
        const splitInsideMultiByte = bytes.indexOf(Buffer.from('é')) + 1;
        child.stdout.emit('data', bytes.subarray(0, splitInsideMultiByte));
        child.stdout.emit('data', bytes.subarray(splitInsideMultiByte, splitInsideMultiByte + 20));
        child.stdout.emit('data', bytes.subarray(splitInsideMultiByte + 20));
        child.emit('close', 0);

        const { entries } = await promise;
        expect(entries.map((e) => e.videoId)).toEqual([ID_A, ID_B]);
        expect(entries[0].title).toBe('Café 日本');
    });

    it('flushes a final line that has no trailing newline', async () => {
        const { scanner, calls } = makeScanner();
        const onEntryCount = vi.fn();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL, onEntryCount });
        calls[0].child.stdout.emit('data', Buffer.from(line(ID_A) + line(ID_B).trimEnd()));
        calls[0].child.emit('close', 0);
        const { entries } = await promise;
        expect(entries.map((e) => e.videoId)).toEqual([ID_A, ID_B]);
    });

    it('works when all output arrives in one chunk at the end', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        calls[0].child.stdout.emit('data', Buffer.from(line(ID_A) + line(ID_B) + line(ID_C)));
        calls[0].child.emit('close', 0);
        expect((await promise).entries).toHaveLength(3);
    });

    it('skips unparseable lines, dropped entries and repeated ids', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        calls[0].child.stdout.emit('data', Buffer.from(
            `garbage\n\r\n${line(ID_A)}${line(ID_B, { live_status: 'is_upcoming' })}${line(ID_A)}${line(ID_C)}`,
        ));
        calls[0].child.emit('close', 0);
        expect((await promise).entries.map((e) => e.videoId)).toEqual([ID_A, ID_C]);
    });

    it('rejects with the classified kind on a non-zero exit with no entries', async () => {
        const { scanner, calls, onLog } = makeScanner();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        calls[0].child.stderr.emit('data', Buffer.from('ERROR: [youtube:tab] @x: Sign in to confirm you\'re not a bot\n'));
        calls[0].child.emit('close', 1);
        await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.BOT_BLOCK });
        expect(onLog).toHaveBeenCalledWith(expect.stringContaining('kind=botBlock'));
    });

    it('still resolves the entries it got when yt-dlp exits non-zero after listing some', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        calls[0].child.stdout.emit('data', Buffer.from(line(ID_A)));
        calls[0].child.stderr.emit('data', Buffer.from('ERROR: one entry failed\n'));
        calls[0].child.emit('close', 1);
        expect((await promise).entries.map((e) => e.videoId)).toEqual([ID_A]);
    });

    it('only keeps the tail of a very long stderr', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        calls[0].child.stderr.emit('data', Buffer.from(`${'x'.repeat(200_000)}\n`));
        calls[0].child.stderr.emit('data', Buffer.from('ERROR: HTTP Error 429: Too Many Requests\n'));
        calls[0].child.emit('close', 1);
        const err = await promise.catch((e) => e);
        expect(err.kind).toBe(ERROR_KINDS.RATE_LIMIT);
        expect(err.message.length).toBeLessThan(200);
    });

    it('kills the child and rejects as stalled after no output for the stall timeout', async () => {
        const { scanner, calls } = makeScanner({ stallTimeoutMs: 20 });
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        calls[0].child.stdout.emit('data', Buffer.from(line(ID_A)));
        await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.STALLED });
        expect(calls[0].child.kill).toHaveBeenCalled();
    });

    it('rejects as cancelled when the child is killed mid-listing, even with entries already read', async () => {
        const { scanner, calls } = makeScanner();
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL, onChild: (child) => setImmediate(() => child.kill()) });
        calls[0].child.stdout.emit('data', Buffer.from(line(ID_A)));
        await expect(promise).rejects.toMatchObject({ kind: ERROR_KINDS.CANCELLED });
    });

    it('stops at the entry cap and reports the list as truncated', async () => {
        const { scanner, calls } = makeScanner({ maxEntries: 2 });
        const promise = scanner.scanVideos({ videosUrl: VIDEOS_URL });
        calls[0].child.stdout.emit('data', Buffer.from(line(ID_A) + line(ID_B) + line(ID_C)));
        const { entries, truncated } = await promise;
        expect(entries.map((e) => e.videoId)).toEqual([ID_A, ID_B]);
        expect(truncated).toBe(true);
        expect(calls[0].child.kill).toHaveBeenCalled();
    });
});

// A scanner whose three steps are plain controllable promises, plus a child
// per step so cancel has something to kill.
function fakeScanner() {
    const steps = {};
    const step = (name) => {
        const child = { kill: vi.fn() };
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        steps[name] = { child, resolve, reject };
        return { child, promise };
    };
    const scanner = {
        resolveChannel: vi.fn((url, { onChild }) => {
            const { child, promise } = step('resolve');
            onChild(child);
            return promise;
        }),
        fetchPublicVideoCount: vi.fn((channelId, { onChild }) => {
            const { child, promise } = step('count');
            onChild(child);
            return promise;
        }),
        scanVideos: vi.fn(({ onChild, onEntryCount }) => {
            const { child, promise } = step('list');
            steps.list.onEntryCount = onEntryCount;
            onChild(child);
            return promise;
        }),
    };
    return { scanner, steps };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ENTRY = { videoId: ID_A, title: 'A', durationSeconds: 1, approxTimestamp: null, membersOnly: false };

describe('createChannelScanSession', () => {
    it('runs resolve -> count -> list, reports each stage, and resolves the scan result', async () => {
        const { scanner, steps } = fakeScanner();
        const sendProgress = vi.fn();
        const session = createChannelScanSession({ scanner, sendProgress });
        const promise = session.scan('scan-1', VIDEOS_URL);
        expect(session.hasActiveScans()).toBe(true);
        expect(sendProgress).toHaveBeenLastCalledWith({ scanId: 'scan-1', stage: 'resolving', found: 0, total: null });

        steps.resolve.resolve({ channelId: CHANNEL_ID, title: 'Veritasium', avatarUrl: 'https://yt3.example/avatar.jpg' });
        await flush();
        expect(scanner.fetchPublicVideoCount).toHaveBeenCalledWith(CHANNEL_ID, expect.anything());
        expect(sendProgress).toHaveBeenLastCalledWith({ scanId: 'scan-1', stage: 'counting', found: 0, total: null });

        steps.count.resolve(450);
        await flush();
        expect(sendProgress).toHaveBeenLastCalledWith({ scanId: 'scan-1', stage: 'listing', found: 0, total: 450 });

        steps.list.resolve({ entries: [ENTRY], truncated: false });
        await expect(promise).resolves.toEqual({
            success: true,
            channel: { id: CHANNEL_ID, title: 'Veritasium', url: VIDEOS_URL, avatarUrl: 'https://yt3.example/avatar.jpg' },
            total: 450,
            entries: [ENTRY],
            truncated: false,
        });
        expect(sendProgress).toHaveBeenLastCalledWith({ scanId: 'scan-1', stage: 'listing', found: 1, total: 450 });
        expect(session.hasActiveScans()).toBe(false);
    });

    it('throttles listing progress and always sends a final update', async () => {
        const { scanner, steps } = fakeScanner();
        const sendProgress = vi.fn();
        let clock = 1000;
        const session = createChannelScanSession({ scanner, sendProgress, now: () => clock, progressIntervalMs: 250 });
        const promise = session.scan('scan-1', VIDEOS_URL);
        steps.resolve.resolve({ channelId: CHANNEL_ID, title: 'V' });
        await flush();
        steps.count.resolve(null);
        await flush();
        sendProgress.mockClear();

        steps.list.onEntryCount(10);
        clock += 100;
        steps.list.onEntryCount(20);
        clock += 200;
        steps.list.onEntryCount(30);
        clock += 10;
        steps.list.onEntryCount(40);
        expect(sendProgress.mock.calls.map(([p]) => p.found)).toEqual([30]);

        steps.list.resolve({ entries: Array.from({ length: 45 }, () => ENTRY), truncated: false });
        await promise;
        expect(sendProgress.mock.calls.map(([p]) => p.found)).toEqual([30, 45]);
    });

    it('resolves a failure with the error kind and message instead of rejecting', async () => {
        const { scanner, steps } = fakeScanner();
        const session = createChannelScanSession({ scanner, sendProgress: vi.fn() });
        const promise = session.scan('scan-1', VIDEOS_URL);
        steps.resolve.reject(Object.assign(new Error('Sign in to confirm you\'re not a bot'), { kind: ERROR_KINDS.BOT_BLOCK }));
        await expect(promise).resolves.toEqual({ success: false, kind: ERROR_KINDS.BOT_BLOCK, message: 'Sign in to confirm you\'re not a bot', cancelled: false });
        expect(session.hasActiveScans()).toBe(false);
    });

    it('falls back to kind unknown for an error with no kind', async () => {
        const { scanner, steps } = fakeScanner();
        const session = createChannelScanSession({ scanner, sendProgress: vi.fn() });
        const promise = session.scan('scan-1', VIDEOS_URL);
        steps.resolve.reject(new Error('boom'));
        await expect(promise).resolves.toMatchObject({ success: false, kind: ERROR_KINDS.UNKNOWN, cancelled: false });
    });

    it('cancel kills the running child and the scan resolves as cancelled', async () => {
        const { scanner, steps } = fakeScanner();
        const session = createChannelScanSession({ scanner, sendProgress: vi.fn() });
        const promise = session.scan('scan-1', VIDEOS_URL);
        steps.resolve.resolve({ channelId: CHANNEL_ID, title: 'V' });
        await flush();
        steps.count.resolve(3);
        await flush();

        expect(session.cancel('scan-1')).toEqual({ cancelled: true });
        expect(steps.list.child.kill).toHaveBeenCalled();
        steps.list.reject(Object.assign(new Error('stopped'), { kind: ERROR_KINDS.CANCELLED }));
        await expect(promise).resolves.toEqual({ success: false, kind: ERROR_KINDS.CANCELLED, message: 'Channel scan cancelled.', cancelled: true });
        expect(session.hasActiveScans()).toBe(false);
    });

    it('a cancel that lands while a step is finishing still stops before the next step', async () => {
        const { scanner, steps } = fakeScanner();
        const session = createChannelScanSession({ scanner, sendProgress: vi.fn() });
        const promise = session.scan('scan-1', VIDEOS_URL);
        session.cancel('scan-1');
        steps.resolve.resolve({ channelId: CHANNEL_ID, title: 'V' });
        await expect(promise).resolves.toMatchObject({ success: false, cancelled: true });
        expect(scanner.fetchPublicVideoCount).not.toHaveBeenCalled();
    });

    it('cancel of an unknown or finished scan does nothing', async () => {
        const { scanner, steps } = fakeScanner();
        const session = createChannelScanSession({ scanner, sendProgress: vi.fn() });
        expect(session.cancel('nope')).toEqual({ cancelled: false });
        const promise = session.scan('scan-1', VIDEOS_URL);
        steps.resolve.reject(new Error('boom'));
        await promise;
        expect(session.cancel('scan-1')).toEqual({ cancelled: false });
    });

    it('refuses a missing scan id or one that is already running', async () => {
        const { scanner } = fakeScanner();
        const session = createChannelScanSession({ scanner, sendProgress: vi.fn() });
        await expect(session.scan('', VIDEOS_URL)).resolves.toMatchObject({ success: false });
        await expect(session.scan(42, VIDEOS_URL)).resolves.toMatchObject({ success: false });
        session.scan('scan-1', VIDEOS_URL);
        await expect(session.scan('scan-1', VIDEOS_URL)).resolves.toMatchObject({ success: false });
        expect(scanner.resolveChannel).toHaveBeenCalledTimes(1);
    });

    it('killAll cancels every running scan', async () => {
        const { scanner, steps } = fakeScanner();
        const session = createChannelScanSession({ scanner, sendProgress: vi.fn() });
        const promise = session.scan('scan-1', VIDEOS_URL);
        session.killAll();
        expect(steps.resolve.child.kill).toHaveBeenCalled();
        steps.resolve.reject(new Error('killed'));
        await expect(promise).resolves.toMatchObject({ success: false, cancelled: true });
    });
});
