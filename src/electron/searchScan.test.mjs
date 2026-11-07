import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCatalog, compileQuery } from './searchCatalog.mjs';
import { createTranscriptCache, listTranscriptTargets, scanTranscripts, LINES_PER_TRANSCRIPT } from './searchScan.mjs';

let root;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-search-scan-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeTranscript(videoDir, epoch, language, texts, { extra = false } = {}) {
    const epochDir = path.join(videoDir, epoch);
    fs.mkdirSync(epochDir, { recursive: true });
    const segments = texts.map((text, i) => ({ start: i * 10, end: i * 10 + 5, text }));
    const name = extra ? `transcript.${language}.json` : 'transcript.json';
    fs.writeFileSync(path.join(epochDir, name), JSON.stringify({ version: 1, language, languageName: language.toUpperCase(), source: 'auto', segments }));
}

// A catalog with one video whose transcripts sit on disk under root.
function setup(videos) {
    const catalog = createCatalog();
    catalog.setTagNames([{ folderName: 'Lib', tagName: 'Library' }]);
    const index = {
        channels: [{
            videos: videos.map(({ name, epochs, latestEpoch }) => ({
                videoDir: path.join(root, name),
                videoFolderName: name,
                latestEpoch,
                metadata: { videoId: name, title: `Title ${name}`, channel: 'Chan' },
                epochs: epochs.map(({ epoch, language }) => ({ epoch, metadata: language ? { transcript: { language } } : {} })),
                clipCount: 0,
            })),
        }],
    };
    const extrasByDir = new Map(videos.flatMap(({ name, epochs }) => epochs.map(({ epoch, extras = [] }) => [path.join(root, name, epoch), extras])));
    catalog.replaceTag('Lib', index, [], {
        readClips: () => [],
        listExtraLanguages: (videoDir, epoch) => extrasByDir.get(path.join(videoDir, epoch)) || [],
    });
    return catalog;
}

async function runScan(catalog, text, { cache = createTranscriptCache(), isCancelled = () => false } = {}) {
    const batches = [];
    await scanTranscripts({
        catalog,
        targets: listTranscriptTargets(catalog),
        query: compileQuery({ text }),
        cache,
        isCancelled,
        onBatch: (batch) => batches.push(batch),
    });
    return batches;
}

describe('listTranscriptTargets', () => {
    it('lists the default and extra files of every version, newest first', () => {
        const catalog = setup([{ name: 'v1', latestEpoch: '200', epochs: [{ epoch: '100', language: 'en' }, { epoch: '200', language: 'en', extras: ['ja'] }] }]);
        expect(listTranscriptTargets(catalog).map((t) => path.relative(root, t.filePath))).toEqual([
            path.join('v1', '200', 'transcript.json'),
            path.join('v1', '200', 'transcript.ja.json'),
            path.join('v1', '100', 'transcript.json'),
        ]);
    });

    it('filters by sublibrary', () => {
        const catalog = setup([{ name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] }]);
        expect(listTranscriptTargets(catalog, { tags: ['Other'] })).toEqual([]);
    });
});

describe('scanTranscripts', () => {
    it('reports each matching transcript with its matching lines and timestamps', async () => {
        writeTranscript(path.join(root, 'v1'), '200', 'en', ['hello there', 'nothing', 'Hello again']);
        writeTranscript(path.join(root, 'v2'), '200', 'en', ['no match']);
        const catalog = setup([
            { name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] },
            { name: 'v2', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] },
        ]);

        const batches = await runScan(catalog, 'hello');
        const last = batches[batches.length - 1];
        expect(last).toMatchObject({ scanned: 2, total: 2, matched: 1, done: true });
        const items = batches.flatMap((b) => b.items);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            kind: 'transcript', videoId: 'v1', tagName: 'Library', epoch: '200', isLatest: true, language: 'en', languageName: 'EN', lineCount: 2,
            lines: [{ start: 0, text: 'hello there', ranges: [[0, 5]] }, { start: 20, text: 'Hello again', ranges: [[0, 5]] }],
        });
    });

    it('matches AND terms on different lines, showing each line with its own highlight', async () => {
        writeTranscript(path.join(root, 'v1'), '200', 'en', ['the alpha part', 'filler', 'then BETA']);
        writeTranscript(path.join(root, 'v2'), '200', 'en', ['alpha alone']);
        const catalog = setup([
            { name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] },
            { name: 'v2', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] },
        ]);
        const batches = [];
        await scanTranscripts({
            catalog,
            targets: listTranscriptTargets(catalog),
            query: compileQuery({ mode: 'terms', terms: [{ text: 'alpha' }, { text: 'beta', op: 'and' }] }),
            cache: createTranscriptCache(),
            isCancelled: () => false,
            onBatch: (batch) => batches.push(batch),
        });
        const items = batches.flatMap((b) => b.items);
        expect(items.map((i) => i.videoId)).toEqual(['v1']);
        expect(items[0].lines).toEqual([
            { start: 0, text: 'the alpha part', ranges: [[4, 9]] },
            { start: 20, text: 'then BETA', ranges: [[5, 9]] },
        ]);
    });

    it('runs a regex against the transcript text', async () => {
        writeTranscript(path.join(root, 'v1'), '200', 'en', ['chapter 12 starts', 'no digits']);
        const catalog = setup([{ name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] }]);
        const batches = [];
        await scanTranscripts({
            catalog,
            targets: listTranscriptTargets(catalog),
            query: compileQuery({ mode: 'regex', text: 'chapter \\d+' }),
            cache: createTranscriptCache(),
            isCancelled: () => false,
            onBatch: (batch) => batches.push(batch),
        });
        expect(batches.flatMap((b) => b.items)[0].lines).toEqual([{ start: 0, text: 'chapter 12 starts', ranges: [[0, 10]] }]);
    });

    it('shows a few lines per transcript but counts them all', async () => {
        writeTranscript(path.join(root, 'v1'), '200', 'en', Array.from({ length: 9 }, (_, i) => `word ${i}`));
        const catalog = setup([{ name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] }]);
        const [item] = (await runScan(catalog, 'word')).flatMap((b) => b.items);
        expect(item.lineCount).toBe(9);
        expect(item.lines).toHaveLength(LINES_PER_TRANSCRIPT);
    });

    it('skips a transcript file that has gone missing', async () => {
        const catalog = setup([{ name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] }]);
        const batches = await runScan(catalog, 'x');
        expect(batches[batches.length - 1]).toMatchObject({ scanned: 1, matched: 0, done: true });
    });

    it('serves a second search from the cache, and re-reads a changed file', async () => {
        const videoDir = path.join(root, 'v1');
        writeTranscript(videoDir, '200', 'en', ['first words']);
        const catalog = setup([{ name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] }]);
        const cache = createTranscriptCache();
        await runScan(catalog, 'first', { cache });
        expect(cache.size).toBe(1);

        const filePath = path.join(videoDir, '200', 'transcript.json');
        const later = new Date(Date.now() + 5000);
        writeTranscript(videoDir, '200', 'en', ['second words']);
        fs.utimesSync(filePath, later, later);
        const items = (await runScan(catalog, 'second', { cache })).flatMap((b) => b.items);
        expect(items).toHaveLength(1);
    });

    it('stops without a final batch once cancelled', async () => {
        writeTranscript(path.join(root, 'v1'), '200', 'en', ['x']);
        const catalog = setup([{ name: 'v1', latestEpoch: '200', epochs: [{ epoch: '200', language: 'en' }] }]);
        expect(await runScan(catalog, 'x', { isCancelled: () => true })).toEqual([]);
    });
});

describe('createTranscriptCache', () => {
    it('evicts the least recently used entries past the budget', () => {
        const cache = createTranscriptCache({ budgetBytes: 250 });
        cache.set('a', { mtimeMs: 1, bytes: 100 });
        cache.set('b', { mtimeMs: 1, bytes: 100 });
        cache.get('a', 1);
        cache.set('c', { mtimeMs: 1, bytes: 100 });
        expect(cache.get('b', 1)).toBeNull();
        expect(cache.get('a', 1)).not.toBeNull();
        expect(cache.usedBytes).toBe(200);
    });

    it('treats a different mtime as a miss', () => {
        const cache = createTranscriptCache();
        cache.set('a', { mtimeMs: 1, bytes: 10 });
        expect(cache.get('a', 2)).toBeNull();
    });
});
