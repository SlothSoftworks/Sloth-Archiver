// The on-demand half of omni-search: transcripts are too big to keep in
// the catalog (searchCatalog.mjs), so a search that includes them reads the
// files here, a few at a time with the event loop yielded in between, and
// reports results in batches as it goes. Parsed transcripts are kept in a
// size-capped cache for the session, so searching again doesn't re-read
// what fits.
import fsp from 'fs/promises';
import path from 'path';
import { fold, satisfiesGroups, mergeRanges, makeSnippet, RESULT_GROUP_LIMIT } from './searchCatalog.mjs';
import { transcriptPath } from './transcripts.mjs';

export const TRANSCRIPT_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
export const LINES_PER_TRANSCRIPT = 5;
const BATCH_INTERVAL_MS = 150;

// Least recently used first out (a Map keeps insertion order; a hit
// re-inserts). An entry whose file changed since (mtime) is a miss.
export function createTranscriptCache({ budgetBytes = TRANSCRIPT_CACHE_BUDGET_BYTES } = {}) {
    const entries = new Map();
    let usedBytes = 0;
    return {
        get(filePath, mtimeMs) {
            const entry = entries.get(filePath);
            if (!entry || entry.mtimeMs !== mtimeMs) return null;
            entries.delete(filePath);
            entries.set(filePath, entry);
            return entry;
        },
        set(filePath, entry) {
            const previous = entries.get(filePath);
            if (previous) {
                usedBytes -= previous.bytes;
                entries.delete(filePath);
            }
            entries.set(filePath, entry);
            usedBytes += entry.bytes;
            for (const [oldestPath, oldest] of entries) {
                if (usedBytes <= budgetBytes || entries.size <= 1) break;
                entries.delete(oldestPath);
                usedBytes -= oldest.bytes;
            }
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
    let pending = [];
    let matchedCount = 0;
    let scanned = 0;
    let lastFlush = now();
    const flush = (done) => {
        onBatch({ items: pending, matched: matchedCount, scanned, total: targets.length, done });
        pending = [];
        lastFlush = now();
    };
    for (const target of targets) {
        if (isCancelled()) return;
        await yieldIfDue();
        let transcript;
        try {
            transcript = await loadTranscript(target.filePath, cache);
        } catch {
            scanned++;
            continue;
        }
        scanned++;
        const hitTerms = matchesTranscript(query, transcript);
        if (hitTerms) matchedCount++;
        if (hitTerms && matchedCount <= RESULT_GROUP_LIMIT) {
            const { entry } = target;
            pending.push({
                kind: 'transcript',
                tag: entry.tag,
                tagName: catalog.tagNames.get(entry.tag) || entry.tag,
                videoDir: entry.videoDir,
                videoId: entry.videoId,
                platform: entry.platform,
                title: entry.title.text,
                channel: entry.channel.text,
                thumbnailPath: entry.thumbnailPath,
                epoch: target.epoch,
                isLatest: target.epoch === entry.latestEpoch,
                language: transcript.language,
                languageName: transcript.languageName,
                ...matchingLines(query, transcript, hitTerms),
            });
        }
        if (now() - lastFlush >= BATCH_INTERVAL_MS) flush(false);
    }
    if (!isCancelled()) flush(true);
}
