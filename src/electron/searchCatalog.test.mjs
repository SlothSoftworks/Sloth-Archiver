import { describe, it, expect, vi } from 'vitest';
import { fold, compileQuery, matchFields, makeSnippet, createCatalog, searchCatalog, normalizeSearchRequest, createCatalogService, RESULT_GROUP_LIMIT } from './searchCatalog.mjs';

function video(videoDir, metadata = {}, extra = {}) {
    return {
        videoDir,
        videoFolderName: videoDir.split('/').pop(),
        latestEpoch: '200',
        metadata: { videoId: videoDir.split('/').pop(), title: 'Untitled', channel: 'Some Channel', ...metadata },
        epochs: [{ epoch: '200', metadata: { ...metadata } }],
        thumbnailPath: null,
        clipCount: 0,
        videoData: {},
        ...extra,
    };
}

const noDeps = { readClips: () => [], listExtraLanguages: () => [] };

function catalogWith(tag, videos, playlists = [], deps = noDeps) {
    const catalog = createCatalog();
    catalog.setTagNames([{ folderName: tag, tagName: `${tag} name` }]);
    catalog.replaceTag(tag, { channels: [{ videos }] }, playlists, deps);
    return catalog;
}

const field = (name, text) => ({ name, text, folded: fold(text) });

describe('fold', () => {
    it('ignores case and accents', () => {
        expect(fold('Café ÁRBOL')).toBe('cafe arbol');
    });
});

describe('compileQuery / matchFields', () => {
    it('finds plain text regardless of case and accents, with ranges in the original text', () => {
        const query = compileQuery({ mode: 'text', text: 'cafe' });
        expect(matchFields(query, [field('title', 'Le Café et le CAFE')])).toEqual([
            { field: expect.objectContaining({ name: 'title' }), ranges: [[3, 7], [14, 18]] },
        ]);
    });

    it('keeps ranges right when folding changes the length', () => {
        const query = compileQuery({ mode: 'text', text: 'x' });
        const [{ ranges }] = matchFields(query, [field('title', '한국 x')]);
        expect(ranges).toEqual([[3, 4]]);
    });

    it('runs a regex on the original text, case-insensitively', () => {
        const query = compileQuery({ mode: 'regex', text: 'ep(isode)?\\s*\\d+' });
        expect(matchFields(query, [field('title', 'Episode 12 and ep3')])[0].ranges).toEqual([[0, 10], [15, 18]]);
    });

    it('rejects an invalid regex with a readable message', () => {
        expect(() => compileQuery({ mode: 'regex', text: '(' })).toThrow(/Invalid pattern/);
    });

    it('binds AND tighter than OR, across all of an item\'s fields', () => {
        const query = compileQuery({ mode: 'terms', terms: [{ text: 'alpha' }, { text: 'beta', op: 'or' }, { text: 'gamma', op: 'and' }] });
        expect(matchFields(query, [field('title', 'alpha only')])).not.toBeNull();
        expect(matchFields(query, [field('title', 'beta only')])).toBeNull();
        expect(matchFields(query, [field('title', 'beta'), field('notes', 'and gamma')])).toHaveLength(2);
    });

    it('needs something to search for', () => {
        expect(() => compileQuery({ mode: 'text', text: '  ' })).toThrow();
        expect(() => compileQuery({ mode: 'terms', terms: [{ text: '' }] })).toThrow();
    });
});

describe('makeSnippet', () => {
    it('cuts long text around the first match and shifts its range', () => {
        const text = `${'a'.repeat(200)}needle${'b'.repeat(200)}`;
        const snippet = makeSnippet(text, [[200, 206]]);
        expect(snippet.text.startsWith('…')).toBe(true);
        expect(snippet.text.endsWith('…')).toBe(true);
        const [[start, end]] = snippet.ranges;
        expect(snippet.text.slice(start, end)).toBe('needle');
    });

    it('leaves short text alone', () => {
        expect(makeSnippet('short title', [[0, 5]])).toEqual({ text: 'short title', ranges: [[0, 5]] });
    });
});

describe('searchCatalog', () => {
    it('matches titles, channels and notes, and names the sublibrary', () => {
        const catalog = catalogWith('Lib', [
            video('/lib/c/v1', { title: 'Rust in production' }),
            video('/lib/c/v2', { title: 'Other', channel: 'Rustacean Station' }),
            video('/lib/c/v3', { title: 'Third' }, { videoData: { notes: 'rewatch the rust section' } }),
            video('/lib/c/v4', { title: 'Nothing here' }),
        ]);
        const { videos } = searchCatalog(catalog, compileQuery({ text: 'rust' }));
        expect(videos.total).toBe(3);
        expect(videos.items.map((v) => v.videoDir)).toEqual(['/lib/c/v1', '/lib/c/v2', '/lib/c/v3']);
        expect(videos.items[0]).toMatchObject({ kind: 'video', tag: 'Lib', tagName: 'Lib name', title: 'Rust in production' });
        expect(videos.items[2].matches).toEqual([{ field: 'notes', text: 'rewatch the rust section', ranges: [[12, 16]] }]);
    });

    it('leaves notes, clips and playlists out when the scope says so', () => {
        const readClips = vi.fn(() => [{ id: 'c1', title: 'rust clip', notes: '' }]);
        const catalog = catalogWith('Lib', [
            video('/lib/c/v1', { title: 'One' }, { videoData: { notes: 'rust' }, clipCount: 1 }),
        ], [{ playlistId: 'PL1', title: 'Rust talks', uploader: 'x' }], { ...noDeps, readClips });
        const all = searchCatalog(catalog, compileQuery({ text: 'rust' }));
        expect([all.videos.total, all.clips.total, all.playlists.total]).toEqual([1, 1, 1]);
        expect(all.clips.items[0]).toMatchObject({ kind: 'clip', clipId: 'c1', clipTitle: 'rust clip', videoDir: '/lib/c/v1' });
        expect(all.playlists.items[0]).toMatchObject({ kind: 'playlist', playlistId: 'PL1', tag: 'Lib' });

        const narrow = searchCatalog(catalog, compileQuery({ text: 'rust' }), { notes: false, clips: false, playlists: false });
        expect([narrow.videos.total, narrow.clips.total, narrow.playlists.total]).toEqual([0, 0, 0]);
    });

    it('only reads clips for videos that have some', () => {
        const readClips = vi.fn(() => []);
        catalogWith('Lib', [video('/lib/c/v1'), video('/lib/c/v2', {}, { clipCount: 2 })], [], { ...noDeps, readClips });
        expect(readClips).toHaveBeenCalledTimes(1);
        expect(readClips).toHaveBeenCalledWith('/lib/c/v2');
    });

    it('records which versions have transcripts, default language first', () => {
        const listExtraLanguages = vi.fn(() => ['ja']);
        const withTranscript = video('/lib/c/v1', {}, {
            epochs: [
                { epoch: '200', metadata: { transcript: { language: 'en' } } },
                { epoch: '100', metadata: {} },
            ],
        });
        const catalog = catalogWith('Lib', [withTranscript], [], { ...noDeps, listExtraLanguages });
        expect(catalog.videos.get('/lib/c/v1').transcripts).toEqual([{ epoch: '200', languages: ['en', 'ja'] }]);
        expect(listExtraLanguages).toHaveBeenCalledTimes(1);
    });

    it('filters by sublibrary', () => {
        const catalog = createCatalog();
        catalog.replaceTag('A', { channels: [{ videos: [video('/lib/A/c/v1', { title: 'match' })] }] }, [], noDeps);
        catalog.replaceTag('B', { channels: [{ videos: [video('/lib/B/c/v2', { title: 'match' })] }] }, [], noDeps);
        expect(searchCatalog(catalog, compileQuery({ text: 'match' })).videos.total).toBe(2);
        expect(searchCatalog(catalog, compileQuery({ text: 'match' }), { tags: ['B'] }).videos.items.map((v) => v.tag)).toEqual(['B']);
    });

    it('caps each group but keeps counting', () => {
        const videos = Array.from({ length: RESULT_GROUP_LIMIT + 5 }, (_, i) => video(`/lib/c/v${i}`, { title: 'same' }));
        const result = searchCatalog(catalogWith('Lib', videos), compileQuery({ text: 'same' }));
        expect(result.videos.items).toHaveLength(RESULT_GROUP_LIMIT);
        expect(result.videos.total).toBe(RESULT_GROUP_LIMIT + 5);
    });

    it('replaces and removes single videos, and rebuilding a sublibrary drops what is gone', () => {
        const catalog = catalogWith('Lib', [video('/lib/c/v1', { title: 'old title' })]);
        catalog.replaceVideo('Lib', video('/lib/c/v1', { title: 'new title' }), noDeps);
        expect(searchCatalog(catalog, compileQuery({ text: 'old' })).videos.total).toBe(0);
        expect(searchCatalog(catalog, compileQuery({ text: 'new' })).videos.total).toBe(1);

        catalog.removeVideoDir('/lib/c/v1');
        expect(catalog.videos.size).toBe(0);

        catalog.replaceVideo('Lib', video('/lib/c/v9'), noDeps);
        catalog.replaceTag('Lib', { channels: [] }, [], noDeps);
        expect(catalog.videos.size).toBe(0);
    });
});

describe('normalizeSearchRequest', () => {
    it('fills in defaults and drops anything malformed', () => {
        expect(normalizeSearchRequest({ query: { mode: 'weird', text: 5, terms: 'x' }, scope: { notes: 'yes', tags: ['A', 3] } })).toEqual({
            query: { mode: 'text', text: '', terms: [] },
            scope: { tags: ['A'], notes: true, clips: true, playlists: true, descriptions: false, transcripts: false },
        });
    });

    it('keeps at most five terms', () => {
        const terms = Array.from({ length: 8 }, (_, i) => ({ text: `t${i}`, op: 'or' }));
        expect(normalizeSearchRequest({ query: { mode: 'terms', terms } }).query.terms).toHaveLength(5);
    });
});

describe('createCatalogService', () => {
    function makeService(overrides = {}) {
        const indexes = {
            A: { channels: [{ videos: [video('/lib/A/c/v1', { title: 'alpha' })] }] },
            B: { channels: [{ videos: [video('/lib/B/c/v2', { title: 'beta' })] }] },
        };
        const entries = new Map([['/lib/A/c/v1', video('/lib/A/c/v1', { title: 'alpha edited' })]]);
        return createCatalogService({
            getLibraryDir: () => '/lib',
            listTags: () => [{ folderName: 'A', tagName: 'Alpha lib' }, { folderName: 'B', tagName: 'Beta lib' }],
            loadTagIndex: async (libraryDir, tag) => indexes[tag],
            readVideoEntry: (libraryDir, videoDir) => entries.get(videoDir) || null,
            listPlaylists: (libraryDir, tag) => (tag === 'B' ? [{ playlistId: 'PL', title: 'beta mix', uploader: '' }] : []),
            tagOfVideoDir: (libraryDir, videoDir) => videoDir.split('/')[2],
            deps: noDeps,
            ...overrides,
        });
    }

    const titles = (service, text) => searchCatalog(service.catalog, compileQuery({ text })).videos.items.map((v) => v.title);

    it('builds every sublibrary, with display names and playlists', async () => {
        const service = makeService();
        await service.rebuild();
        expect(titles(service, 'a')).toEqual(['alpha', 'beta']);
        expect(searchCatalog(service.catalog, compileQuery({ text: 'mix' })).playlists.items[0]).toMatchObject({ tag: 'B', tagName: 'Beta lib' });
        expect(service.status()).toEqual({ building: false });
    });

    it('refreshes changed video folders and drops ones that are gone', async () => {
        const service = makeService();
        service.rebuild();
        service.refreshVideoDirs(['/lib/A/c/v1', '/lib/B/c/v2']);
        await service.whenSettled();
        expect(titles(service, 'a')).toEqual(['alpha edited']);
    });

    it('reports building until queued rebuilds finish, and survives a failing step', async () => {
        const onError = vi.fn();
        const service = makeService({ loadTagIndex: async () => { throw new Error('disk gone'); }, onError });
        const built = service.rebuild();
        expect(service.status()).toEqual({ building: true });
        await built;
        expect(onError).toHaveBeenCalled();
        expect(service.status()).toEqual({ building: false });
    });
});
