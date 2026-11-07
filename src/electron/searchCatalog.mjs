// Omni-search: a small in-memory catalog of every sublibrary's searchable
// text (titles, channels, notes, clips, saved playlists), so a search across
// all of them takes milliseconds instead of a disk walk per sublibrary.
// main.mjs builds it in the background at startup and keeps it current from
// the same write paths that patch the library index. Transcripts and
// descriptions are never held here -- searchScan.mjs reads them on demand.

export const QUERY_MODES = ['text', 'regex', 'terms'];
export const MAX_TERMS = 5;
export const RESULT_GROUP_LIMIT = 50;
const SNIPPET_CONTEXT = 60;

// Lowercase without accents, so "cafe" finds "Café". Folding can change a
// string's length (Hangul decomposes, some uppercase letters expand), so
// match ranges are mapped back to the original with foldWithMap.
export function fold(text) {
    return (text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function foldWithMap(text) {
    let folded = '';
    const map = [];
    let offset = 0;
    for (const char of text) {
        const piece = fold(char);
        for (let i = 0; i < piece.length; i++) map.push(offset);
        folded += piece;
        offset += char.length;
    }
    map.push(offset);
    return { folded, map };
}

// When folding kept the length, positions carry over as they are (true of
// nearly all text); otherwise they're mapped back character by character.
function findAllFolded(original, folded, needle) {
    if (!needle) return [];
    const starts = [];
    for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) starts.push(at);
    if (starts.length === 0) return [];
    if (folded.length === original.length) return starts.map((at) => [at, at + needle.length]);
    const { map } = foldWithMap(original);
    return starts.map((at) => [map[at], map[at + needle.length]]);
}

function findAllRegex(original, regex) {
    const ranges = [];
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(original)) !== null) {
        if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
        }
        ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
}

// A query becomes a list of terms plus OR-groups of AND-ed term indexes.
// Text and regex are a single term; "terms" mode joins up to MAX_TERMS with
// AND/OR, AND binding tighter (`a OR b AND c` is `a OR (b AND c)`). Each
// term has a cheap test(original, folded) and a find(original, folded) that
// returns match ranges in the original text -- only needed for results that
// are actually shown. Throws with a user-facing message for a query that
// can't run.
function textTerm(needle) {
    return { test: (original, folded) => folded.includes(needle), find: (original, folded) => findAllFolded(original, folded, needle) };
}

export function compileQuery({ mode = 'text', text = '', terms = [] } = {}) {
    if (!QUERY_MODES.includes(mode)) throw new Error('Unknown search type.');
    if (mode === 'regex') {
        if (!text) throw new Error('Type a pattern to search for.');
        let regex;
        let tester;
        try {
            regex = new RegExp(text, 'giu');
            tester = new RegExp(text, 'iu');
        } catch (err) {
            throw new Error(`Invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { terms: [{ test: (original) => tester.test(original), find: (original) => findAllRegex(original, regex) }], groups: [[0]] };
    }
    if (mode === 'text') {
        const needle = fold(text.trim());
        if (!needle) throw new Error('Type something to search for.');
        return { terms: [textTerm(needle)], groups: [[0]] };
    }
    const cleaned = terms.slice(0, MAX_TERMS)
        .map((term, i) => ({ needle: fold((term?.text || '').trim()), op: i === 0 ? null : term?.op === 'or' ? 'or' : 'and' }))
        .filter((term) => term.needle);
    if (cleaned.length === 0) throw new Error('Fill in at least one term.');
    const groups = [[]];
    cleaned.forEach((term, i) => {
        if (term.op === 'or') groups.push([]);
        groups[groups.length - 1].push(i);
    });
    return {
        terms: cleaned.map(({ needle }) => textTerm(needle)),
        groups,
    };
}

export function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
    }
    return merged;
}

// Long text (notes) is cut to a window around the first match, with the
// ranges shifted to the cut text.
export function makeSnippet(text, ranges) {
    if (text.length <= SNIPPET_CONTEXT * 2 + 20 || ranges.length === 0) return { text, ranges };
    const start = Math.max(0, ranges[0][0] - SNIPPET_CONTEXT);
    const end = Math.min(text.length, ranges[0][1] + SNIPPET_CONTEXT);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    const shift = prefix.length - start;
    return {
        text: `${prefix}${text.slice(start, end)}${suffix}`,
        ranges: ranges.filter(([s, e]) => s >= start && e <= end).map(([s, e]) => [s + shift, e + shift]),
    };
}

export function satisfiesGroups(query, hitTerms) {
    return query.groups.some((group) => group.every((i) => hitTerms.has(i)));
}

// Whether an item's fields ({ name, text, folded }), taken together,
// satisfy the query -- the cheap check every item gets.
export function matchesQuery(query, fields) {
    const hitTerms = new Set();
    query.terms.forEach((term, i) => {
        if (fields.some((field) => field.text && term.test(field.text, field.folded))) hitTerms.add(i);
    });
    return satisfiesGroups(query, hitTerms);
}

// The matched fields of an item with their ranges, or null when it doesn't
// satisfy any OR-group. Only run for results that are shown.
export function matchFields(query, fields) {
    const hitTerms = new Set();
    const perField = fields.map((field) => {
        if (!field.text) return null;
        const ranges = [];
        query.terms.forEach((term, i) => {
            const found = term.find(field.text, field.folded);
            if (found.length) {
                hitTerms.add(i);
                ranges.push(...found);
            }
        });
        return ranges.length ? { field, ranges: mergeRanges(ranges) } : null;
    });
    if (!satisfiesGroups(query, hitTerms)) return null;
    return perField.filter(Boolean);
}

export function textField(name, text) {
    return { name, text: text || '', folded: fold(text) };
}

// One video's catalog entry from its full index entry (scanLibrary /
// readLibraryVideoEntry shape). readClips and listExtraLanguages are only
// called when the video has clips / a version has a transcript.
export function buildVideoEntry(tag, video, { readClips, listExtraLanguages }) {
    const metadata = video.metadata || {};
    const clips = video.clipCount > 0
        ? readClips(video.videoDir).map((clip) => ({
            id: clip.id,
            title: textField('clipTitle', clip.title),
            notes: textField('clipNotes', clip.notes),
        }))
        : [];
    const transcripts = (video.epochs || [])
        .filter(({ metadata: epochMetadata }) => epochMetadata?.transcript)
        .map(({ epoch, metadata: epochMetadata }) => ({
            epoch,
            languages: [epochMetadata.transcript.language, ...listExtraLanguages(video.videoDir, epoch)],
        }));
    return {
        tag,
        videoDir: video.videoDir,
        videoId: metadata.videoId,
        platform: metadata.platform || 'youtube',
        latestEpoch: video.latestEpoch,
        thumbnailPath: video.thumbnailPath || null,
        title: textField('title', metadata.title || video.videoFolderName),
        channel: textField('channel', metadata.channel || metadata.uploader),
        notes: textField('notes', video.videoData?.notes),
        clips,
        transcripts,
    };
}

function buildPlaylistEntry(tag, playlist) {
    return {
        tag,
        playlistId: playlist.playlistId,
        title: textField('playlistTitle', playlist.title),
        uploader: textField('playlistUploader', playlist.uploader),
    };
}

// The catalog itself: videos keyed by videoDir, playlists and display names
// per sublibrary folder. Mutations replace whole entries, so a search
// running against it never sees a half-updated one.
export function createCatalog() {
    const videos = new Map();
    const playlistsByTag = new Map();
    const tagNames = new Map();

    function removeTag(tag) {
        for (const [videoDir, entry] of videos) if (entry.tag === tag) videos.delete(videoDir);
        playlistsByTag.delete(tag);
    }

    return {
        videos,
        playlistsByTag,
        tagNames,
        setTagNames(tags) {
            tagNames.clear();
            for (const { folderName, tagName } of tags) tagNames.set(folderName, tagName);
        },
        replaceTag(tag, index, playlists, deps) {
            removeTag(tag);
            for (const channel of index.channels) {
                for (const video of channel.videos) videos.set(video.videoDir, buildVideoEntry(tag, video, deps));
            }
            playlistsByTag.set(tag, playlists.map((playlist) => buildPlaylistEntry(tag, playlist)));
        },
        removeTag,
        replaceVideo(tag, video, deps) {
            videos.set(video.videoDir, buildVideoEntry(tag, video, deps));
        },
        removeVideoDir(videoDir) {
            videos.delete(videoDir);
        },
        replacePlaylists(tag, playlists) {
            playlistsByTag.set(tag, playlists.map((playlist) => buildPlaylistEntry(tag, playlist)));
        },
        clear() {
            videos.clear();
            playlistsByTag.clear();
            tagNames.clear();
        },
    };
}

export function toMatches(matched) {
    return matched.map(({ field, ranges }) => ({ field: field.name, ...makeSnippet(field.text, ranges) }));
}

export function videoSummary(catalog, entry) {
    return {
        tag: entry.tag,
        tagName: catalog.tagNames.get(entry.tag) || entry.tag,
        videoDir: entry.videoDir,
        videoId: entry.videoId,
        platform: entry.platform,
        title: entry.title.text,
        channel: entry.channel.text,
        thumbnailPath: entry.thumbnailPath,
    };
}

// Counts every match, but builds (ranges, snippets) only the shown ones.
function addIfMatches(group, query, fields, build) {
    if (!matchesQuery(query, fields)) return;
    group.total++;
    if (group.items.length < RESULT_GROUP_LIMIT) group.items.push(build(toMatches(matchFields(query, fields))));
}

// scope: { tags: string[] | null (null = every sublibrary), notes, clips,
// playlists } -- titles and channel names are always searched.
export function searchCatalog(catalog, query, scope = {}) {
    const { tags = null, notes = true, clips = true, playlists = true } = scope;
    const inScope = (tag) => !tags || tags.includes(tag);
    const results = {
        videos: { items: [], total: 0 },
        clips: { items: [], total: 0 },
        playlists: { items: [], total: 0 },
    };
    for (const entry of catalog.videos.values()) {
        if (!inScope(entry.tag)) continue;
        const fields = notes ? [entry.title, entry.channel, entry.notes] : [entry.title, entry.channel];
        addIfMatches(results.videos, query, fields, (matches) => ({ kind: 'video', ...videoSummary(catalog, entry), matches }));
        if (!clips) continue;
        for (const clip of entry.clips) {
            addIfMatches(results.clips, query, [clip.title, clip.notes], (matches) => ({
                kind: 'clip', ...videoSummary(catalog, entry), clipId: clip.id, clipTitle: clip.title.text, matches,
            }));
        }
    }
    if (playlists) {
        for (const [tag, list] of catalog.playlistsByTag) {
            if (!inScope(tag)) continue;
            for (const playlist of list) {
                addIfMatches(results.playlists, query, [playlist.title, playlist.uploader], (matches) => ({
                    kind: 'playlist',
                    tag,
                    tagName: catalog.tagNames.get(tag) || tag,
                    playlistId: playlist.playlistId,
                    title: playlist.title.text,
                    uploader: playlist.uploader.text,
                    matches,
                }));
            }
        }
    }
    return results;
}

const MAX_QUERY_LENGTH = 500;

// The renderer's search request, made safe: a known mode, bounded strings,
// at most MAX_TERMS terms, and a scope of plain booleans plus an optional
// list of sublibrary folder names.
export function normalizeSearchRequest({ query, scope } = {}) {
    const text = typeof query?.text === 'string' ? query.text.slice(0, MAX_QUERY_LENGTH) : '';
    const terms = Array.isArray(query?.terms)
        ? query.terms.slice(0, MAX_TERMS).map((term) => ({
            text: typeof term?.text === 'string' ? term.text.slice(0, MAX_QUERY_LENGTH) : '',
            op: term?.op === 'or' ? 'or' : 'and',
        }))
        : [];
    const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
    return {
        query: { mode: QUERY_MODES.includes(query?.mode) ? query.mode : 'text', text, terms },
        scope: {
            tags: Array.isArray(scope?.tags) ? scope.tags.filter((tag) => typeof tag === 'string') : null,
            notes: flag(scope?.notes, true),
            clips: flag(scope?.clips, true),
            playlists: flag(scope?.playlists, true),
            descriptions: flag(scope?.descriptions, false),
            transcripts: flag(scope?.transcripts, false),
        },
    };
}

// Keeps a catalog in step with the library. Every change runs on one
// promise chain, in call order, so a write landing mid-build is applied
// after it rather than interleaved. The file access comes in as functions
// (main.mjs passes the real library.mjs ones), which keeps this testable.
export function createCatalogService({ getLibraryDir, listTags, loadTagIndex, readVideoEntry, listPlaylists, tagOfVideoDir, deps, onError = () => {} }) {
    const catalog = createCatalog();
    let chain = Promise.resolve();
    let pendingRebuilds = 0;

    const enqueue = (operation) => {
        chain = chain.then(operation).catch(onError);
        return chain;
    };

    async function rebuildTagsNow(libraryDir, tags) {
        catalog.setTagNames(listTags(libraryDir));
        for (const tag of tags) {
            catalog.replaceTag(tag, await loadTagIndex(libraryDir, tag), listPlaylists(libraryDir, tag), deps);
        }
    }

    const trackRebuild = (operation) => {
        pendingRebuilds++;
        return enqueue(async () => {
            try {
                await operation();
            } finally {
                pendingRebuilds--;
            }
        });
    };

    return {
        catalog,
        rebuild() {
            return trackRebuild(async () => {
                catalog.clear();
                const libraryDir = getLibraryDir();
                if (!libraryDir) return;
                await rebuildTagsNow(libraryDir, listTags(libraryDir).map((tag) => tag.folderName));
            });
        },
        rebuildTags(tags) {
            return trackRebuild(async () => {
                const libraryDir = getLibraryDir();
                if (libraryDir) await rebuildTagsNow(libraryDir, [...new Set(tags.filter(Boolean))]);
            });
        },
        // Keyed by the path as given (the index's spelling), not the
        // resolved one. A folder that no longer reads as a video (deleted,
        // or moved away) drops out of the catalog.
        refreshVideoDirs(videoDirs) {
            return enqueue(() => {
                const libraryDir = getLibraryDir();
                for (const videoDir of videoDirs.filter(Boolean)) {
                    const entry = libraryDir ? readVideoEntry(libraryDir, videoDir) : null;
                    if (entry) catalog.replaceVideo(tagOfVideoDir(libraryDir, videoDir), { ...entry, videoDir }, deps);
                    else catalog.removeVideoDir(videoDir);
                }
            });
        },
        refreshPlaylists(tag) {
            return enqueue(() => {
                const libraryDir = getLibraryDir();
                if (libraryDir) catalog.replacePlaylists(tag, listPlaylists(libraryDir, tag));
            });
        },
        whenSettled() {
            return chain;
        },
        status() {
            return { building: pendingRebuilds > 0 };
        },
    };
}
