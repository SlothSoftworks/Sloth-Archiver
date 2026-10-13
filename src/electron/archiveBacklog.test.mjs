import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    createArchiveBacklogStore,
    summarizeBacklog,
    clampBacklogBatchSize,
    BACKLOG_MAX_ITEMS,
    BACKLOG_QUALITY_TIERS,
} from './archiveBacklog.mjs';

const LIBRARY_DIR = '/library';
const CHANNEL_ID = 'UCHnyfMqiRRG1u-2MsSQLbXA';
const VALID_TAGS = ['DefaultLibrary', 'Music'];
const EMPTY_BACKLOG = { version: 1, libraryDir: null, completedJobs: { totalCount: 0, doneCount: 0 }, jobs: [] };

let tempDir;
let filePath;
let store;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-backlog-'));
    filePath = path.join(tempDir, 'backlog.json');
    store = createArchiveBacklogStore(filePath);
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function videoId(n) {
    return `vid${String(n).padStart(8, '0')}`;
}

function makeItems(count, start = 0) {
    return Array.from({ length: count }, (_, i) => ({ videoId: videoId(start + i), title: `Video ${start + i}`, approxTimestamp: 1790000000 + i }));
}

function makeJob(overrides = {}) {
    return {
        channelId: CHANNEL_ID,
        channelTitle: 'Veritasium',
        channelUrl: 'https://www.youtube.com/@veritasium/videos',
        options: { download: true, targetResolution: '1080', targetLibraryTag: 'DefaultLibrary', batchSize: 20 },
        items: makeItems(3),
        ...overrides,
    };
}

function add(job = makeJob(), extra = {}) {
    return store.addJob({ job, mode: 'append', currentLibraryDir: LIBRARY_DIR, validTags: VALID_TAGS, ...extra });
}

describe('read', () => {
    it('returns an empty backlog when there is no file', () => {
        expect(store.read()).toEqual(EMPTY_BACKLOG);
    });

    it.each([
        ['garbage', 'not json at all {'],
        ['a non-object', '42'],
        ['null', 'null'],
        ['an array', '[]'],
        ['an unknown version', JSON.stringify({ version: 2, libraryDir: LIBRARY_DIR, jobs: [] })],
        ['jobs that are not an array', JSON.stringify({ version: 1, libraryDir: LIBRARY_DIR, jobs: {} })],
    ])('treats %s as an empty backlog', (_label, content) => {
        fs.writeFileSync(filePath, content);
        expect(store.read()).toEqual(EMPTY_BACKLOG);
    });

    it('drops the parts of a hand-edited file that do not fit the shape and keeps the rest', () => {
        const goodOptions = { download: false, targetResolution: '720', targetLibraryTag: 'Music', batchSize: 9999 };
        fs.writeFileSync(filePath, JSON.stringify({
            version: 1,
            libraryDir: LIBRARY_DIR,
            jobs: [
                'not a job',
                { id: 'no-items', options: goodOptions },
                { id: 'bad-quality', options: { ...goodOptions, targetResolution: '999' }, items: makeItems(1) },
                { id: 'only-bad-items', options: goodOptions, items: [{ videoId: '../../etc' }] },
                {
                    id: 'good',
                    channelId: 'not-a-channel-id',
                    channelTitle: 12345,
                    channelUrl: 'https://evil.example/@x',
                    createdAt: 'yesterday',
                    options: goodOptions,
                    items: [
                        { videoId: videoId(1), title: 7, approxTimestamp: 'soon', status: 'error', attempts: -3, errorKind: 'unavailable', errorMessage: 'gone' },
                        { videoId: videoId(1), title: 'duplicate' },
                        { videoId: 'bad id' },
                        null,
                        { videoId: videoId(2), title: 'Fine', status: 'weird', attempts: 2, errorKind: 'stale' },
                    ],
                },
                { id: 'good', options: goodOptions, items: makeItems(1) },
            ],
        }));
        expect(store.read()).toEqual({
            version: 1,
            libraryDir: LIBRARY_DIR,
            completedJobs: { totalCount: 0, doneCount: 0 },
            jobs: [{
                id: 'good',
                channelId: null,
                channelTitle: '12345',
                channelUrl: null,
                createdAt: 0,
                options: { download: false, targetResolution: '720', targetLibraryTag: 'Music', batchSize: 500 },
                totalCount: 2,
                doneCount: 0,
                items: [
                    { videoId: videoId(1), title: '7', approxTimestamp: null, status: 'error', attempts: 0, errorKind: 'unavailable', errorMessage: 'gone' },
                    { videoId: videoId(2), title: 'Fine', approxTimestamp: null, status: 'pending', attempts: 2 },
                ],
            }],
        });
    });
});

describe('addJob', () => {
    it('round-trips a job through the file', () => {
        const result = add();
        expect(result).toMatchObject({ success: true, added: 3, duplicatesSkipped: 0, invalidSkipped: 0, counts: { jobs: 1, pending: 3, errors: 0 } });
        expect(typeof result.jobId).toBe('string');

        const backlog = createArchiveBacklogStore(filePath).read();
        expect(backlog).toEqual(result.backlog);
        expect(backlog.libraryDir).toBe(LIBRARY_DIR);
        expect(backlog.jobs).toHaveLength(1);
        expect(backlog.jobs[0]).toMatchObject({
            id: result.jobId,
            channelId: CHANNEL_ID,
            channelTitle: 'Veritasium',
            channelUrl: 'https://www.youtube.com/@veritasium/videos',
            options: { download: true, targetResolution: '1080', targetLibraryTag: 'DefaultLibrary', batchSize: 20 },
        });
        expect(backlog.jobs[0].items[0]).toEqual({ videoId: videoId(0), title: 'Video 0', approxTimestamp: 1790000000, status: 'pending', attempts: 0 });
        expect(typeof backlog.jobs[0].createdAt).toBe('number');
    });

    it('writes atomically and leaves no temp file behind', () => {
        add();
        expect(fs.readdirSync(tempDir)).toEqual(['backlog.json']);
    });

    it('never stores watch URLs', () => {
        add();
        expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('watch?v=');
    });

    it('assigns its own job id and ignores status fields supplied by the caller', () => {
        const result = add(makeJob({ id: 'caller-chosen', items: [{ videoId: videoId(1), title: 'T', status: 'error', attempts: 9, errorKind: 'x' }] }));
        expect(result.jobId).not.toBe('caller-chosen');
        expect(result.backlog.jobs[0].items[0]).toEqual({ videoId: videoId(1), title: 'T', approxTimestamp: null, status: 'pending', attempts: 0 });
    });

    it('coerces titles to strings and normalises the channel fields', () => {
        const result = add(makeJob({
            channelId: 'nope',
            channelTitle: null,
            channelUrl: 'https://www.youtube.com/@veritasium/shorts?x=1',
            items: [{ videoId: videoId(1), title: null }, { videoId: videoId(2), title: 42 }, { videoId: videoId(3) }],
        }));
        expect(result.backlog.jobs[0]).toMatchObject({ channelId: null, channelTitle: '', channelUrl: 'https://www.youtube.com/@veritasium/videos' });
        expect(result.backlog.jobs[0].items.map((i) => i.title)).toEqual(['', '42', '']);
    });

    it('skips invalid video ids and counts them', () => {
        const result = add(makeJob({ items: [{ videoId: videoId(1) }, { videoId: 'short' }, { videoId: '../../../etc' }, { videoId: 12345678901 }, null, 'x'] }));
        expect(result).toMatchObject({ success: true, added: 1, invalidSkipped: 5 });
    });

    it('refuses a job with no valid items and writes nothing', () => {
        expect(add(makeJob({ items: [{ videoId: 'bad' }] }))).toMatchObject({ success: false, reason: 'noValidItems' });
        expect(add(makeJob({ items: [] }))).toMatchObject({ success: false, reason: 'noValidItems' });
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('refuses a target sublibrary that is not in validTags', () => {
        const job = makeJob({ options: { download: true, targetResolution: '1080', targetLibraryTag: '../Elsewhere', batchSize: 10 } });
        expect(add(job)).toMatchObject({ success: false, reason: 'invalidTag' });
        expect(add(makeJob(), { validTags: [] })).toMatchObject({ success: false, reason: 'invalidTag' });
        expect(add(makeJob(), { validTags: undefined })).toMatchObject({ success: false, reason: 'invalidTag' });
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('refuses a quality that is not one of the tiers', () => {
        for (const targetResolution of ['999', 1080, undefined, 'mp3']) {
            const job = makeJob({ options: { download: true, targetResolution, targetLibraryTag: 'DefaultLibrary', batchSize: 10 } });
            expect(add(job)).toMatchObject({ success: false, reason: 'invalidOptions' });
        }
        expect(add(makeJob({ options: null }))).toMatchObject({ success: false, reason: 'invalidOptions' });
    });

    it('accepts every quality tier', () => {
        for (const targetResolution of BACKLOG_QUALITY_TIERS) {
            const job = makeJob({ options: { download: true, targetResolution, targetLibraryTag: 'DefaultLibrary', batchSize: 10 } });
            expect(store.addJob({ job, mode: 'replace', currentLibraryDir: LIBRARY_DIR, validTags: VALID_TAGS }).success).toBe(true);
        }
    });

    it('clamps batchSize to 1..500', () => {
        const withBatchSize = (batchSize) => store.addJob({
            job: makeJob({ options: { download: true, targetResolution: '1080', targetLibraryTag: 'DefaultLibrary', batchSize } }),
            mode: 'replace', currentLibraryDir: LIBRARY_DIR, validTags: VALID_TAGS,
        }).backlog.jobs[0].options.batchSize;
        expect(withBatchSize(0)).toBe(1);
        expect(withBatchSize(-5)).toBe(1);
        expect(withBatchSize(501)).toBe(500);
        expect(withBatchSize(25.4)).toBe(25);
        expect(withBatchSize('30')).toBe(30);
        expect(withBatchSize('lots')).toBe(10);
        expect(withBatchSize(undefined)).toBe(10);
    });

    it('refuses an unknown mode, a missing library folder, or a malformed job', () => {
        expect(add(makeJob(), { mode: 'merge' })).toMatchObject({ success: false, reason: 'invalidMode' });
        expect(add(makeJob(), { currentLibraryDir: '' })).toMatchObject({ success: false, reason: 'noLibraryDir' });
        expect(add(null)).toMatchObject({ success: false, reason: 'invalidJob' });
        expect(add({ options: makeJob().options, items: 'x' })).toMatchObject({ success: false, reason: 'invalidJob' });
    });

    it('refuses more items than the cap', () => {
        const result = add(makeJob({ items: makeItems(BACKLOG_MAX_ITEMS + 1) }));
        expect(result).toMatchObject({ success: false, reason: 'tooManyItems' });
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('refuses an append that would take the whole backlog over the cap', () => {
        expect(add(makeJob({ items: makeItems(BACKLOG_MAX_ITEMS - 1) })).success).toBe(true);
        const result = add(makeJob({ items: makeItems(2, BACKLOG_MAX_ITEMS) }));
        expect(result).toMatchObject({ success: false, reason: 'tooManyItems', counts: { jobs: 1, pending: BACKLOG_MAX_ITEMS - 1 } });
    });

    it('append adds a second job and skips items already pending or errored for the same sublibrary', () => {
        const first = add(makeJob({ items: makeItems(3) }));
        store.applyResults(first.jobId, [{ videoId: videoId(1), outcome: 'error', errorKind: 'unavailable', errorMessage: 'gone' }]);

        const second = add(makeJob({ items: [...makeItems(4, 1), { videoId: videoId(4), title: 'again' }] }));
        expect(second).toMatchObject({ success: true, added: 2, duplicatesSkipped: 3, counts: { jobs: 2, pending: 4, errors: 1 } });
        expect(second.backlog.jobs[1].items.map((i) => i.videoId)).toEqual([videoId(3), videoId(4)]);
        expect(second.backlog.jobs[0].id).toBe(first.jobId);
    });

    it('append does not treat the same video in a different sublibrary as a duplicate', () => {
        add();
        const result = add(makeJob({ options: { download: true, targetResolution: '1080', targetLibraryTag: 'Music', batchSize: 10 } }));
        expect(result).toMatchObject({ success: true, added: 3, duplicatesSkipped: 0, counts: { jobs: 2, pending: 6 } });
    });

    it('an append made only of duplicates succeeds without adding a job', () => {
        const first = add();
        const result = add();
        expect(result).toMatchObject({ success: true, jobId: null, added: 0, duplicatesSkipped: 3, counts: { jobs: 1, pending: 3 } });
        expect(result.backlog.jobs[0].id).toBe(first.jobId);
    });

    it('replace discards everything that was there', () => {
        const first = add(makeJob({ items: makeItems(5) }));
        const result = store.addJob({ job: makeJob({ items: makeItems(2) }), mode: 'replace', currentLibraryDir: '/other-library', validTags: VALID_TAGS });
        expect(result).toMatchObject({ success: true, added: 2, duplicatesSkipped: 0, counts: { jobs: 1, pending: 2 } });
        expect(result.backlog.libraryDir).toBe('/other-library');
        expect(result.backlog.jobs[0].id).not.toBe(first.jobId);
        expect(store.read()).toEqual(result.backlog);
    });

    it('a refused replace leaves the existing backlog untouched', () => {
        const first = add();
        const result = store.addJob({ job: makeJob({ items: [] }), mode: 'replace', currentLibraryDir: LIBRARY_DIR, validTags: VALID_TAGS });
        expect(result).toMatchObject({ success: false, reason: 'noValidItems', counts: { jobs: 1, pending: 3 } });
        expect(store.read()).toEqual(first.backlog);
    });

    it('refuses an append when the stored backlog belongs to a different library folder', () => {
        const first = add();
        const result = add(makeJob({ items: makeItems(2, 10) }), { currentLibraryDir: '/other-library' });
        expect(result).toMatchObject({ success: false, reason: 'libraryDirMismatch', counts: { jobs: 1, pending: 3 } });
        expect(store.read()).toEqual(first.backlog);
    });
});

describe('applyResults', () => {
    it('removes done items, bumps attempts on pending, and marks errors', () => {
        const { jobId } = add(makeJob({ items: makeItems(4) }));
        const result = store.applyResults(jobId, [
            { videoId: videoId(0), outcome: 'done' },
            { videoId: videoId(1), outcome: 'pending' },
            { videoId: videoId(2), outcome: 'error', errorKind: 'ageRestricted', errorMessage: 'Sign in to confirm your age' },
        ]);
        expect(result).toMatchObject({ success: true, applied: 3, counts: { jobs: 1, pending: 2, errors: 1 } });
        expect(result.backlog.jobs[0].items).toEqual([
            { videoId: videoId(1), title: 'Video 1', approxTimestamp: 1790000001, status: 'pending', attempts: 1 },
            { videoId: videoId(2), title: 'Video 2', approxTimestamp: 1790000002, status: 'error', attempts: 0, errorKind: 'ageRestricted', errorMessage: 'Sign in to confirm your age' },
            { videoId: videoId(3), title: 'Video 3', approxTimestamp: 1790000003, status: 'pending', attempts: 0 },
        ]);
        expect(store.read()).toEqual(result.backlog);
    });

    it('increments attempts on every pending result', () => {
        const { jobId } = add();
        store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'pending' }]);
        store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'pending' }]);
        const { backlog } = store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'pending' }]);
        expect(backlog.jobs[0].items[0].attempts).toBe(3);
    });

    it('a pending result clears an earlier error', () => {
        const { jobId } = add();
        store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'error', errorKind: 'unknown', errorMessage: 'x' }]);
        const { backlog } = store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'pending' }]);
        expect(backlog.jobs[0].items[0]).toEqual({ videoId: videoId(0), title: 'Video 0', approxTimestamp: 1790000000, status: 'pending', attempts: 1 });
    });

    it('defaults a missing error kind to unknown and coerces the message', () => {
        const { jobId } = add();
        const { backlog } = store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'error', errorMessage: { not: 'a string' } }]);
        expect(backlog.jobs[0].items[0]).toMatchObject({ status: 'error', errorKind: 'unknown', errorMessage: '[object Object]' });
    });

    it('ignores an unknown job id, unknown video ids, unknown outcomes and malformed results', () => {
        const { jobId, backlog: before } = add();
        expect(store.applyResults('no-such-job', [{ videoId: videoId(0), outcome: 'done' }])).toMatchObject({ success: true, applied: 0, backlog: before });
        expect(store.applyResults(jobId, [
            { videoId: 'zzzzzzzzzzz', outcome: 'done' },
            { videoId: videoId(0), outcome: 'exploded' },
            null,
            'done',
        ])).toMatchObject({ success: true, applied: 0, backlog: before });
        expect(store.applyResults(jobId, 'not an array')).toMatchObject({ success: true, applied: 0, backlog: before });
        expect(store.read()).toEqual(before);
    });

    it('removes a job once it has no items left and keeps the others', () => {
        const first = add(makeJob({ items: makeItems(1) }));
        const second = add(makeJob({ items: makeItems(1, 5) }));
        const result = store.applyResults(first.jobId, [{ videoId: videoId(0), outcome: 'done' }]);
        expect(result.backlog.jobs.map((j) => j.id)).toEqual([second.jobId]);
    });

    it('deletes the file when the last item is done', () => {
        const { jobId } = add(makeJob({ items: makeItems(2) }));
        const result = store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'done' }, { videoId: videoId(1), outcome: 'done' }]);
        expect(result).toMatchObject({ success: true, applied: 2, backlog: EMPTY_BACKLOG, counts: { jobs: 0, pending: 0, errors: 0 } });
        expect(fs.readdirSync(tempDir)).toEqual([]);
    });
});

describe('retryErrors', () => {
    it('puts every error item back to pending with attempts reset', () => {
        const { jobId } = add();
        store.applyResults(jobId, [
            { videoId: videoId(0), outcome: 'pending' },
            { videoId: videoId(1), outcome: 'pending' },
        ]);
        store.applyResults(jobId, [
            { videoId: videoId(0), outcome: 'error', errorKind: 'unavailable', errorMessage: 'gone' },
        ]);
        const result = store.retryErrors();
        expect(result).toMatchObject({ success: true, retried: 1, counts: { jobs: 1, pending: 3, errors: 0 } });
        expect(result.backlog.jobs[0].items[0]).toEqual({ videoId: videoId(0), title: 'Video 0', approxTimestamp: 1790000000, status: 'pending', attempts: 0 });
        expect(result.backlog.jobs[0].items[1].attempts).toBe(1);
        expect(store.read()).toEqual(result.backlog);
    });

    it('does nothing when there are no errors', () => {
        add();
        expect(store.retryErrors()).toMatchObject({ success: true, retried: 0, counts: { pending: 3, errors: 0 } });
        expect(createArchiveBacklogStore(path.join(tempDir, 'missing.json')).retryErrors()).toMatchObject({ success: true, retried: 0 });
    });
});

describe('dismissErrors', () => {
    it('removes error items and keeps pending ones', () => {
        const { jobId } = add();
        store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'error', errorKind: 'unavailable', errorMessage: 'gone' }]);
        const result = store.dismissErrors();
        expect(result).toMatchObject({ success: true, dismissed: 1, counts: { jobs: 1, pending: 2, errors: 0 } });
        expect(result.backlog.jobs[0].items.map((i) => i.videoId)).toEqual([videoId(1), videoId(2)]);
        expect(store.read()).toEqual(result.backlog);
    });

    it('deletes the file when only errors were left', () => {
        const { jobId } = add(makeJob({ items: makeItems(1) }));
        store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'error', errorKind: 'unavailable', errorMessage: 'gone' }]);
        expect(store.dismissErrors()).toMatchObject({ success: true, dismissed: 1, counts: { jobs: 0, pending: 0, errors: 0 } });
        expect(fs.existsSync(filePath)).toBe(false);
    });
});

describe('clear', () => {
    it('deletes the file and returns an empty backlog', () => {
        add();
        expect(store.clear()).toEqual({ success: true, backlog: EMPTY_BACKLOG, counts: { jobs: 0, pending: 0, errors: 0, total: 0, done: 0 } });
        expect(fs.existsSync(filePath)).toBe(false);
        expect(store.clear().success).toBe(true);
    });
});

describe('summarizeBacklog / clampBacklogBatchSize', () => {
    it('counts jobs, pending items and errors', () => {
        expect(summarizeBacklog(EMPTY_BACKLOG)).toEqual({ jobs: 0, pending: 0, errors: 0, total: 0, done: 0 });
        expect(summarizeBacklog({ completedJobs: { totalCount: 10, doneCount: 9 }, jobs: [
            { totalCount: 5, doneCount: 3, items: [{ status: 'pending' }, { status: 'error' }] },
            { totalCount: 1, doneCount: 0, items: [{ status: 'pending' }] },
        ] })).toEqual({ jobs: 2, pending: 2, errors: 1, total: 16, done: 12 });
    });

    it('clamps and rounds', () => {
        expect(clampBacklogBatchSize(50)).toBe(50);
        expect(clampBacklogBatchSize(0)).toBe(1);
        expect(clampBacklogBatchSize(100000)).toBe(500);
        expect(clampBacklogBatchSize(NaN)).toBe(10);
    });
});

describe('done and total counts', () => {
    it('start at "nothing done" for a new job', () => {
        const result = add(makeJob({ items: makeItems(4) }));
        expect(result.backlog.jobs[0]).toMatchObject({ totalCount: 4, doneCount: 0 });
        expect(result.counts).toMatchObject({ total: 4, done: 0 });
    });

    it('count only what an append actually added, on the job it was added to', () => {
        const first = add(makeJob({ items: makeItems(3) }));
        const second = add(makeJob({ items: makeItems(4, 1) }));
        expect(second).toMatchObject({ added: 2, duplicatesSkipped: 2 });
        expect(second.backlog.jobs.map((j) => [j.id === first.jobId, j.totalCount, j.doneCount])).toEqual([[true, 3, 0], [false, 2, 0]]);
        expect(second.counts).toMatchObject({ total: 5, done: 0 });
    });

    it('go up by one for every done result, whether it was fetched or found already in the library', () => {
        const { jobId } = add(makeJob({ items: makeItems(5) }));
        const result = store.applyResults(jobId, [
            { videoId: videoId(0), outcome: 'done' },
            { videoId: videoId(1), outcome: 'done' },
            { videoId: videoId(1), outcome: 'done' },
            { videoId: videoId(2), outcome: 'pending' },
            { videoId: videoId(3), outcome: 'error', errorKind: 'unavailable', errorMessage: 'gone' },
            { videoId: 'zzzzzzzzzzz', outcome: 'done' },
        ]);
        expect(result.backlog.jobs[0]).toMatchObject({ totalCount: 5, doneCount: 2 });
        expect(result.counts).toEqual({ jobs: 1, pending: 2, errors: 1, total: 5, done: 2 });
        expect(store.read().jobs[0]).toMatchObject({ totalCount: 5, doneCount: 2 });
    });

    it('keep a finished job\'s counts while another job is still going', () => {
        const first = add(makeJob({ items: makeItems(2) }));
        add(makeJob({ items: makeItems(3, 10) }));
        const result = store.applyResults(first.jobId, [{ videoId: videoId(0), outcome: 'done' }, { videoId: videoId(1), outcome: 'done' }]);
        expect(result.backlog.jobs).toHaveLength(1);
        expect(result.backlog.completedJobs).toEqual({ totalCount: 2, doneCount: 2 });
        expect(result.counts).toEqual({ jobs: 1, pending: 3, errors: 0, total: 5, done: 2 });
        expect(summarizeBacklog(store.read())).toEqual(result.counts);
    });

    it('are gone, with the file, once nothing is left', () => {
        const { jobId } = add(makeJob({ items: makeItems(1) }));
        expect(store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'done' }]).counts).toEqual({ jobs: 0, pending: 0, errors: 0, total: 0, done: 0 });
        expect(add(makeJob({ items: makeItems(2) })).counts).toMatchObject({ total: 2, done: 0 });
    });

    it('dismissing errors takes them out of the total and leaves done alone', () => {
        const { jobId } = add(makeJob({ items: makeItems(4) }));
        store.applyResults(jobId, [
            { videoId: videoId(0), outcome: 'done' },
            { videoId: videoId(1), outcome: 'error', errorKind: 'unavailable', errorMessage: 'gone' },
        ]);
        const result = store.dismissErrors();
        expect(result.backlog.jobs[0]).toMatchObject({ totalCount: 3, doneCount: 1 });
        expect(result.counts).toEqual({ jobs: 1, pending: 2, errors: 0, total: 3, done: 1 });
    });

    it('retrying errors changes neither count', () => {
        const { jobId } = add(makeJob({ items: makeItems(3) }));
        store.applyResults(jobId, [
            { videoId: videoId(0), outcome: 'done' },
            { videoId: videoId(1), outcome: 'error', errorKind: 'unknown', errorMessage: 'x' },
        ]);
        expect(store.retryErrors().counts).toEqual({ jobs: 1, pending: 2, errors: 0, total: 3, done: 1 });
    });

    it('a replace starts the counts over', () => {
        const { jobId } = add(makeJob({ items: makeItems(3) }));
        store.applyResults(jobId, [{ videoId: videoId(0), outcome: 'done' }]);
        const result = store.addJob({ job: makeJob({ items: makeItems(2, 20) }), mode: 'replace', currentLibraryDir: LIBRARY_DIR, validTags: VALID_TAGS });
        expect(result.counts).toEqual({ jobs: 1, pending: 2, errors: 0, total: 2, done: 0 });
    });

    it('default for a file written before they existed, and repair counts that do not add up', () => {
        const options = { download: false, targetResolution: '720', targetLibraryTag: 'Music', batchSize: 10 };
        fs.writeFileSync(filePath, JSON.stringify({
            version: 1,
            libraryDir: LIBRARY_DIR,
            jobs: [
                { id: 'old', options, items: makeItems(3) },
                { id: 'odd', options, totalCount: 1, doneCount: 'many', items: makeItems(2, 10) },
                { id: 'kept', options, totalCount: 999, doneCount: 4, items: makeItems(1, 20) },
            ],
        }));
        const backlog = store.read();
        expect(backlog.completedJobs).toEqual({ totalCount: 0, doneCount: 0 });
        expect(backlog.jobs.map((j) => [j.id, j.totalCount, j.doneCount])).toEqual([['old', 3, 0], ['odd', 2, 0], ['kept', 5, 4]]);
        expect(summarizeBacklog(backlog)).toEqual({ jobs: 3, pending: 6, errors: 0, total: 10, done: 4 });
    });
});
