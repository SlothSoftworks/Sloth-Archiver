// The on-demand half of omni-search: transcripts and descriptions are too
// big to keep in the catalog (searchCatalog.mjs), so a search that includes
// them reads them here, with the event loop yielded in between, and reports
// results in batches as it goes. What's read is kept in one size-capped
// cache for the session, so searching again doesn't re-read what fits.
import fsp from 'fs/promises';
import path from 'path';
import { fold, satisfiesGroups, mergeRanges, makeSnippet, matchesQuery, matchFields, toMatches, textField, videoSummary, RESULT_GROUP_LIMIT } from './searchCatalog.mjs';
import { transcriptPath } from './transcripts.mjs';

export const CONTENT_CACHE_BUDGET_BYTES = 128 * 1024 * 1024;
export const LINES_PER_TRANSCRIPT = 5;
const BATCH_INTERVAL_MS = 150;
const READ_CONCURRENCY = 8;

// Once full, it stops taking new entries rather than evicting old ones: a
// search reads files in the same order every time, and evicting the oldest
// would throw out exactly what the next search needs first, so nothing would
// ever hit. This way repeat searches always hit for whatever fits. An entry
// whose file changed since (mtime) is a miss and is replaced.
export function createContentCache({ budgetBytes = CONTENT_CACHE_BUDGET_BYTES } = {}) {
    const entries = new Map();
    let usedBytes = 0;
    return {
        get(filePath, mtimeMs) {
            const entry = entries.get(filePath);
            return entry && entry.mtimeMs === mtimeMs ? entry : null;
        },
        set(filePath, entry) {
            const previous = entries.get(filePath);
            const freed = previous ? previous.bytes : 0;
            if (usedBytes - freed + entry.bytes > budgetBytes) {
                if (previous) {
                    entries.delete(filePath);
                    usedBytes -= freed;
                }
                return;
            }
            entries.set(filePath, entry);
            usedBytes += entry.bytes - freed;
        },
        clear() {
            entries.clear();
            usedBytes = 0;
        },
        get size() {
            return entries.size;
        },
        get usedBytes() {
            return usedBytes;
        },
    };
}

// Every saved transcript of every version, newest version first within a
// video. The first language listed for a version is its default
// (transcript.json); the rest are extras (transcript.<code>.json).
export function listTranscriptTargets(catalog, { tags = null } = {}) {
    const targets = [];
    for (const entry of catalog.videos.values()) {
        if (tags && !tags.includes(entry.tag)) continue;
        const epochs = [...entry.transcripts].sort((a, b) => Number(b.epoch) - Number(a.epoch));
        for (const { epoch, languages } of epochs) {
            languages.forEach((language, i) => {
                targets.push({ entry, epoch, filePath: transcriptPath(path.join(entry.videoDir, epoch), i === 0 ? null : language) });
            });
        }
    }
    return targets;
}

// A transcript is kept as one text (its lines joined by newlines) plus its
// folded copy, so ruling it out takes one substring check per term; lines
// are only worked out for the transcripts that are shown.
async function loadTranscript(filePath, cache) {
    const { mtimeMs } = await fsp.stat(filePath);
    const cached = cache.get(filePath, mtimeMs);
    if (cached) return cached;
    const transcript = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    const segments = transcript.segments || [];
    const lineStarts = [];
    const starts = [];
    let offset = 0;
    const texts = segments.map((segment) => {
        const text = segment.text.replace(/\n/g, ' ');
        lineStarts.push(offset);
        starts.push(segment.start);
        offset += text.length + 1;
        return text;
    });
    const doc = texts.join('\n');
    const docFolded = fold(doc);
    const entry = {
        mtimeMs,
        language: transcript.language,
        languageName: transcript.languageName,
        doc,
        docFolded,
        lineStarts,
        starts,
        bytes: (doc.length + docFolded.length) * 2 + starts.length * 16,
    };
    cache.set(filePath, entry);
    return entry;
}

// Reads READ_CONCURRENCY items at a time and hands each to visit in order,
// with null for one that couldn't be read. Resolves false when cancelled.
async function forEachLoaded(items, load, visit, { isCancelled, yieldIfDue }) {
    for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
        if (isCancelled()) return false;
        await yieldIfDue();
        const chunk = items.slice(i, i + READ_CONCURRENCY);
        const loaded = await Promise.all(chunk.map((item) => load(item).catch(() => null)));
        chunk.forEach((item, j) => visit(item, loaded[j]));
    }
    return !isCancelled();
}

// Collects results and reports them through onBatch at most every
// BATCH_INTERVAL_MS, plus once at the end.
function createBatcher(onBatch, total, now) {
    let pending = [];
    let matched = 0;
    let scanned = 0;
    let lastFlush = now();
    const flush = (done) => {
        onBatch({ items: pending, matched, scanned, total, done });
        pending = [];
        lastFlush = now();
    };
    return {
        scanned() {
            scanned++;
            if (now() - lastFlush >= BATCH_INTERVAL_MS) flush(false);
        },
        // Every match is counted; build() only runs for the shown ones.
        matched(build) {
            matched++;
            if (matched <= RESULT_GROUP_LIMIT) pending.push(build());
        },
        finish: () => flush(true),
    };
}

function lineAt(lineStarts, position) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= position) low = mid;
        else high = mid - 1;
    }
    return low;
}

function matchesTranscript(query, entry) {
    const hitTerms = new Set();
    query.terms.forEach((term, i) => {
        if (term.test(entry.doc, entry.docFolded)) hitTerms.add(i);
    });
    return satisfiesGroups(query, hitTerms) ? hitTerms : null;
}

// The matching lines of a transcript that matched, with ranges relative to
// each line (a regex match running past a line's end is cut there).
function matchingLines(query, entry, hitTerms) {
    const byLine = new Map();
    const lineEnd = (line) => (line + 1 < entry.lineStarts.length ? entry.lineStarts[line + 1] - 1 : entry.doc.length);
    query.terms.forEach((term, i) => {
        if (!hitTerms.has(i)) return;
        for (const [start, end] of term.find(entry.doc, entry.docFolded)) {
            const line = lineAt(entry.lineStarts, start);
            const lineStart = entry.lineStarts[line];
            const clippedEnd = Math.min(end, lineEnd(line));
            if (clippedEnd <= start) continue;
            if (!byLine.has(line)) byLine.set(line, []);
            byLine.get(line).push([start - lineStart, clippedEnd - lineStart]);
        }
    });
    const lines = [...byLine.keys()].sort((a, b) => a - b);
    return {
        lineCount: lines.length,
        lines: lines.slice(0, LINES_PER_TRANSCRIPT).map((line) => ({
            start: entry.starts[line],
            ...makeSnippet(entry.doc.slice(entry.lineStarts[line], lineEnd(line)), mergeRanges(byLine.get(line))),
        })),
    };
}

// A transcript matches when its lines, taken together, satisfy the query
// (so "a AND b" can be on different lines); the result shows the first few
// matching lines, each with its timestamp. Unreadable files are skipped.
// onBatch({ items, matched, scanned, total, done }) gets only the new items;
// matched counts every matching transcript, past the result cap too.
export async function scanTranscripts({ catalog, targets, query, cache, isCancelled, onBatch, yieldIfDue = async () => {}, now = () => Date.now() }) {
    const batcher = createBatcher(onBatch, targets.length, now);
    const finished = await forEachLoaded(targets, (target) => loadTranscript(target.filePath, cache), (target, transcript) => {
        const hitTerms = transcript && matchesTranscript(query, transcript);
        if (hitTerms) {
            const { entry } = target;
            batcher.matched(() => ({
                kind: 'transcript',
                ...videoSummary(catalog, entry),
                epoch: target.epoch,
                isLatest: target.epoch === entry.latestEpoch,
                language: transcript.language,
                languageName: transcript.languageName,
                ...matchingLines(query, transcript, hitTerms),
            }));
        }
        batcher.scanned();
    }, { isCancelled, yieldIfDue });
    if (finished) batcher.finish();
}

// Each video's description, matched like a catalog field. descriptionFor
// answers from the in-memory library index when it has the video (the
// active sublibrary); anything else is read from the latest version's
// metadata.json. onBatch gets the same shape as scanTranscripts'.
export async function scanDescriptions({ catalog, tags = null, query, cache, descriptionFor = () => undefined, isCancelled, onBatch, yieldIfDue = async () => {}, now = () => Date.now() }) {
    const entries = [...catalog.videos.values()].filter((entry) => !tags || tags.includes(entry.tag));
    const batcher = createBatcher(onBatch, entries.length, now);
    const load = async (entry) => {
        const fromIndex = descriptionFor(entry.videoDir);
        if (fromIndex !== undefined) return textField('description', fromIndex);
        return loadDescription(path.join(entry.videoDir, entry.latestEpoch, 'metadata.json'), cache);
    };
    const finished = await forEachLoaded(entries, load, (entry, field) => {
        if (field?.text && matchesQuery(query, [field])) {
            batcher.matched(() => ({ kind: 'description', ...videoSummary(catalog, entry), matches: toMatches(matchFields(query, [field])) }));
        }
        batcher.scanned();
    }, { isCancelled, yieldIfDue });
    if (finished) batcher.finish();
}

async function loadDescription(filePath, cache) {
    const { mtimeMs } = await fsp.stat(filePath);
    const cached = cache.get(filePath, mtimeMs);
    if (cached) return cached.field;
    const metadata = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    const field = textField('description', typeof metadata.description === 'string' ? metadata.description : '');
    cache.set(filePath, { mtimeMs, field, bytes: (field.text.length + field.folded.length) * 2 + 64 });
    return field;
}
