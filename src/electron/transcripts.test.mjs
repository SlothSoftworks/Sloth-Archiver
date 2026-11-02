import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    buildSubtitleTracks, pickTranscriptTrack, listTranscriptLanguages, originalTranscriptLanguage,
    buildSubtitleDownloadArgs, parseVtt, writeTranscript, readTranscript, transcriptToText, createTranscriptQueue,
} from './transcripts.mjs';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'subtitles');
const readFixture = (name) => fs.readFileSync(path.join(fixturesDir, name), 'utf-8');

describe('parseVtt', () => {
    it('collapses YouTube rolling auto-captions to one line per new phrase', () => {
        const segments = parseVtt(readFixture('youtube-auto.vtt'));

        expect(segments.map((s) => s.text)).toEqual([
            '[Music]',
            "We're no strangers to",
            'love. You know the rules and so do',
            "I. I feel commitments from what I'm",
            'thinking',
            "of. You wouldn't get this from any other",
            "guy. I just want to tell you how I'm",
        ]);
        expect(segments[1]).toEqual({ start: 18.8, end: 21.79, text: "We're no strangers to" });
    });

    it('ends each segment no later than the next one starts', () => {
        const segments = parseVtt(readFixture('youtube-auto.vtt'));
        for (let i = 0; i < segments.length - 1; i++) {
            expect(segments[i].end).toBeLessThanOrEqual(segments[i + 1].start);
        }
    });

    it('joins multi-line uploader cues and keeps their timing', () => {
        const segments = parseVtt(readFixture('youtube-manual.vtt'));
        expect(segments[0]).toEqual({ start: 1.36, end: 3.04, text: '[♪♪♪]' });
        expect(segments[2]).toEqual({ start: 22.64, end: 26.96, text: '♪ You know the rules and so do I ♪' });
    });

    it('keeps a genuinely repeated line in uploader subtitles', () => {
        const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nNever gonna give you up\n\n00:02.000 --> 00:03.000\nNever gonna give you up\n';
        expect(parseVtt(vtt).map((s) => s.text)).toEqual(['Never gonna give you up', 'Never gonna give you up']);
    });

    it('decodes entities, strips tags, and skips NOTE blocks and cue ids', () => {
        const vtt = 'WEBVTT\n\nNOTE a comment\n\ncue-1\n00:00:01.000 --> 00:00:02.000 align:start\n<v Bob>Tom &amp; Jerry&#39;s &lt;show&gt;</v>\n';
        expect(parseVtt(vtt)).toEqual([{ start: 1, end: 2, text: "Tom & Jerry's <show>" }]);
    });

    it('returns no segments for an empty file', () => {
        expect(parseVtt('WEBVTT\n')).toEqual([]);
    });
});

describe('buildSubtitleTracks', () => {
    it('keeps uploader tracks and only the original-language auto track', () => {
        const info = {
            language: 'en',
            subtitles: { en: [{ name: 'English' }], 'de-DE': [{ name: 'German (Germany)' }], live_chat: [{}] },
            automatic_captions: { en: [{}], 'en-orig': [{ name: 'English (Original)' }], es: [{ name: 'Spanish' }] },
        };
        expect(buildSubtitleTracks(info)).toEqual({
            manual: [{ code: 'en', name: 'English' }, { code: 'de-DE', name: 'German (Germany)' }],
            auto: [{ code: 'en', name: null }, { code: 'en-orig', name: 'English (Original)' }],
        });
    });

    it('copes with missing maps', () => {
        expect(buildSubtitleTracks({})).toEqual({ manual: [], auto: [] });
    });
});

describe('pickTranscriptTrack', () => {
    const tracks = {
        manual: [{ code: 'de-DE', name: 'German (Germany)' }],
        auto: [{ code: 'en-orig', name: 'English (Original)' }],
    };

    it('prefers the uploader track for the video language over auto-captions', () => {
        const both = { manual: [{ code: 'en', name: 'English' }], auto: [{ code: 'en-orig', name: 'English (Original)' }] };
        expect(pickTranscriptTrack({ subtitleTracks: both, language: 'en' }))
            .toEqual({ key: 'en', flag: '--write-subs', source: 'manual', language: 'en', languageName: 'English' });
    });

    it('falls back to the original-language auto track', () => {
        expect(pickTranscriptTrack({ subtitleTracks: tracks, language: 'en' }))
            .toEqual({ key: 'en-orig', flag: '--write-auto-subs', source: 'auto', language: 'en', languageName: 'English' });
    });

    it('matches a preferred language by prefix', () => {
        expect(pickTranscriptTrack({ subtitleTracks: tracks, language: 'en', preferredLanguage: 'de' }).key).toBe('de-DE');
    });

    it('falls back to the original when the preferred language has no native track', () => {
        expect(pickTranscriptTrack({ subtitleTracks: tracks, language: 'en', preferredLanguage: 'fr' }).key).toBe('en-orig');
    });

    it('infers the original language from the -orig track when yt-dlp gives none', () => {
        expect(originalTranscriptLanguage({ subtitleTracks: tracks, language: null })).toBe('en');
        expect(pickTranscriptTrack({ subtitleTracks: tracks, language: null }).key).toBe('en-orig');
    });

    it('names a track from its code when yt-dlp gives no name', () => {
        const unnamed = { manual: [], auto: [{ code: 'ja', name: null }] };
        expect(pickTranscriptTrack({ subtitleTracks: unnamed, language: 'ja' }).languageName).toBe('Japanese');
    });

    it('returns null with no usable tracks', () => {
        expect(pickTranscriptTrack({ subtitleTracks: { manual: [], auto: [] }, language: 'en' })).toBeNull();
        expect(pickTranscriptTrack({ subtitleTracks: undefined, language: 'en' })).toBeNull();
    });
});

describe('buildSubtitleDownloadArgs', () => {
    it('asks for exactly the picked track, escaped, into the given folder, with the URL last', () => {
        const args = buildSubtitleDownloadArgs({
            url: 'https://youtu.be/x', track: { key: 'zh.Hans', flag: '--write-auto-subs' }, outputDir: '/tmp/subs', ffmpegDir: '/ff', extraArgs: ['--cookies', 'c.txt'],
        });
        expect(args).toEqual([
            '--skip-download', '--no-playlist', '--no-warnings', '--write-auto-subs', '--sub-langs', 'zh\\.Hans', '--sub-format', 'vtt',
            '--ffmpeg-location', '/ff', '--cookies', 'c.txt', '-o', path.join('/tmp/subs', 'sub.%(ext)s'), '--', 'https://youtu.be/x',
        ]);
    });
});

describe('listTranscriptLanguages', () => {
    it('lists uploader tracks, then the auto track unless a manual one covers it', () => {
        expect(listTranscriptLanguages({
            manual: [{ code: 'en', name: 'English' }],
            auto: [{ code: 'en-orig', name: 'English (Original)' }, { code: 'ja-orig', name: null }],
        })).toEqual([
            { code: 'en', name: 'English', source: 'manual' },
            { code: 'ja', name: 'Japanese', source: 'auto' },
        ]);
    });
});

describe('writeTranscript / readTranscript / transcriptToText', () => {
    let epochDir;
    beforeEach(() => {
        epochDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-transcript-test-'));
        fs.writeFileSync(path.join(epochDir, 'metadata.json'), JSON.stringify({ videoId: 'abc', downloadedFilePath: '/x/video.mp4' }));
    });
    afterEach(() => fs.rmSync(epochDir, { recursive: true, force: true }));

    const segments = [{ start: 1, end: 2, text: 'Hello' }, { start: 65, end: 70, text: 'World' }];

    it('writes the file and a small summary onto metadata.json, keeping other fields', () => {
        writeTranscript(epochDir, { language: 'en', languageName: 'English', source: 'auto', segments, fetchedEpoch: 5 });

        expect(readTranscript(epochDir)).toEqual({ version: 1, language: 'en', languageName: 'English', source: 'auto', fetchedEpoch: 5, segments });
        const metadata = JSON.parse(fs.readFileSync(path.join(epochDir, 'metadata.json'), 'utf-8'));
        expect(metadata.downloadedFilePath).toBe('/x/video.mp4');
        expect(metadata.transcript).toEqual({ language: 'en', languageName: 'English', source: 'auto', fetchedEpoch: 5, segmentCount: 2 });
        expect(fs.readdirSync(epochDir).sort()).toEqual(['metadata.json', 'transcript.json']);
    });

    it('reads null when there is no transcript', () => {
        expect(readTranscript(epochDir)).toBeNull();
    });

    it('formats as text with or without timestamps', () => {
        const transcript = { segments };
        expect(transcriptToText(transcript, { withTimestamps: true })).toBe('[0:01] Hello\n[1:05] World');
        expect(transcriptToText(transcript, { withTimestamps: false })).toBe('Hello\nWorld');
    });
});

describe('createTranscriptQueue', () => {
    function deferred() {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        return { promise, resolve };
    }

    it('runs one fetch at a time with the gap between them', async () => {
        const events = [];
        const gates = [deferred(), deferred()];
        let call = 0;
        const fetchOne = vi.fn(async (item) => {
            events.push(`start ${item.videoDir}`);
            await gates[call++].promise;
            events.push(`end ${item.videoDir}`);
            return { success: true };
        });
        const sleep = vi.fn(async (ms) => { events.push(`sleep ${ms}`); });
        const queue = createTranscriptQueue({ fetchOne, gapMs: 50, sleep });

        const a = queue.enqueue({ videoDir: 'a' });
        const b = queue.enqueue({ videoDir: 'b' });
        await Promise.resolve();
        expect(fetchOne).toHaveBeenCalledTimes(1);

        gates[0].resolve();
        await a;
        await vi.waitFor(() => expect(fetchOne).toHaveBeenCalledTimes(2));
        gates[1].resolve();
        await b;
        expect(events).toEqual(['start a', 'end a', 'sleep 50', 'start b', 'end b']);
    });

    it('reports batch progress and a final summary', async () => {
        const progress = [];
        const fetchOne = vi.fn(async (item) => (item.videoDir === 'b' ? { success: false, kind: 'unavailable' } : { success: true }));
        const queue = createTranscriptQueue({ fetchOne, sleep: async () => {}, onBatchProgress: (s) => progress.push(s) });

        expect(queue.enqueueBatch([{ videoDir: 'a' }, { videoDir: 'b' }, { videoDir: 'c' }])).toEqual({ success: true });
        await vi.waitFor(() => expect(queue.status().finished).toBe(true));

        expect(queue.status()).toEqual({ total: 3, done: 3, failed: 1, current: null, stoppedReason: null, finished: true });
        expect(progress[0]).toMatchObject({ total: 3, done: 0 });
    });

    it('stops a batch early when YouTube rate-limits', async () => {
        const fetchOne = vi.fn(async (item) => (item.videoDir === 'b' ? { success: false, kind: 'rateLimit' } : { success: true }));
        const queue = createTranscriptQueue({ fetchOne, sleep: async () => {} });

        queue.enqueueBatch([{ videoDir: 'a' }, { videoDir: 'b' }, { videoDir: 'c' }]);
        await vi.waitFor(() => expect(queue.status().finished).toBe(true));

        expect(fetchOne).toHaveBeenCalledTimes(2);
        expect(queue.status()).toMatchObject({ done: 2, failed: 1, stoppedReason: 'rateLimit' });
    });

    it('cancel skips what is left, and a new batch can start afterwards', async () => {
        const gate = deferred();
        const fetchOne = vi.fn(async () => { await gate.promise; return { success: true }; });
        const queue = createTranscriptQueue({ fetchOne, sleep: async () => {} });

        queue.enqueueBatch([{ videoDir: 'a' }, { videoDir: 'b' }]);
        expect(queue.enqueueBatch([{ videoDir: 'x' }]).success).toBe(false);
        queue.cancelBatch();
        gate.resolve();
        await vi.waitFor(() => expect(queue.status()).toMatchObject({ finished: true, stoppedReason: 'cancelled' }));
        await new Promise((r) => setTimeout(r, 0));

        expect(fetchOne).toHaveBeenCalledTimes(1);
        expect(queue.enqueueBatch([]).success).toBe(true);
    });

    it('turns a thrown fetch into a failed result', async () => {
        const queue = createTranscriptQueue({ fetchOne: async () => { throw new Error('boom'); }, sleep: async () => {} });
        expect(await queue.enqueue({ videoDir: 'a' })).toEqual({ success: false, message: 'boom' });
    });
});
