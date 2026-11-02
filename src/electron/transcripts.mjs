import fs from 'fs';
import path from 'path';
import { ERROR_KINDS } from './downloadErrors.mjs';

export const TRANSCRIPT_FILE_NAME = 'transcript.json';
const TRANSCRIPT_FORMAT_VERSION = 1;

// A batch stops on these instead of burning through the rest of the list:
// every remaining fetch would fail the same way and dig the hole deeper.
const BATCH_STOPPING_KINDS = new Set([ERROR_KINDS.RATE_LIMIT, ERROR_KINDS.BOT_BLOCK]);

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

function baseLanguage(code) {
    return code.replace(/-orig$/, '').split('-')[0].toLowerCase();
}

function displayNameFor(code, name) {
    if (name) return name.replace(/\s*\(Original\)$/, '');
    try {
        return languageNames.of(code.replace(/-orig$/, '')) || code;
    } catch {
        return code;
    }
}

// Compact form of yt-dlp's subtitles/automatic_captions maps, small enough
// for the video-info cache. Auto-captions keep only the original-language
// recognition track (`<lang>-orig`, or `<lang>` matching the video's own
// language) -- the other ~160 are machine translations of it, never picked.
export function buildSubtitleTracks(info) {
    const manual = Object.entries(info.subtitles || {})
        .filter(([code]) => code !== 'live_chat')
        .map(([code, formats]) => ({ code, name: formats?.[0]?.name || null }));
    const auto = Object.entries(info.automatic_captions || {})
        .filter(([code]) => code.endsWith('-orig') || code === info.language)
        .map(([code, formats]) => ({ code, name: formats?.[0]?.name || null }));
    return { manual, auto };
}

export function originalTranscriptLanguage({ subtitleTracks, language }) {
    if (language) return language;
    const orig = subtitleTracks?.auto.find((t) => t.code.endsWith('-orig'));
    if (orig) return orig.code.replace(/-orig$/, '');
    return subtitleTracks?.manual[0]?.code || null;
}

function manualTrack(track) {
    return { key: track.code, flag: '--write-subs', source: 'manual', language: track.code, languageName: displayNameFor(track.code, track.name) };
}

function autoTrack(track) {
    const language = track.code.replace(/-orig$/, '');
    return { key: track.code, flag: '--write-auto-subs', source: 'auto', language, languageName: displayNameFor(language, track.name) };
}

function findTrackFor(subtitleTracks, target) {
    const targetBase = baseLanguage(target);
    const manual = subtitleTracks.manual.find((t) => t.code === target)
        || subtitleTracks.manual.find((t) => baseLanguage(t.code) === targetBase);
    if (manual) return manualTrack(manual);
    const auto = subtitleTracks.auto.find((t) => t.code === `${target}-orig`)
        || subtitleTracks.auto.find((t) => t.code === target)
        || subtitleTracks.auto.find((t) => baseLanguage(t.code) === targetBase);
    return auto ? autoTrack(auto) : null;
}

// The track behind one listTranscriptLanguages code, exactly -- no prefix
// match and no fallback, so a transcript never lands under another
// language's file name.
export function findTranscriptTrackByCode(subtitleTracks, code) {
    if (!subtitleTracks) return null;
    const manual = subtitleTracks.manual.find((t) => t.code === code);
    if (manual) return manualTrack(manual);
    const auto = subtitleTracks.auto.find((t) => t.code === `${code}-orig`) || subtitleTracks.auto.find((t) => t.code === code);
    return auto ? autoTrack(auto) : null;
}

// Uploader subtitles beat auto-captions for the same language. A preferred
// language with no native track falls back to the video's own language
// rather than a machine translation.
export function pickTranscriptTrack({ subtitleTracks, language, preferredLanguage }) {
    if (!subtitleTracks) return null;
    const original = originalTranscriptLanguage({ subtitleTracks, language });
    const targets = [...new Set([preferredLanguage, original].filter(Boolean))];
    for (const target of targets) {
        const track = findTrackFor(subtitleTracks, target);
        if (track) return track;
    }
    return null;
}

// Every language a user could switch to from the detail view.
export function listTranscriptLanguages(subtitleTracks) {
    if (!subtitleTracks) return [];
    const seen = new Set();
    const languages = [];
    for (const t of subtitleTracks.manual) {
        seen.add(t.code);
        languages.push({ code: t.code, name: displayNameFor(t.code, t.name), source: 'manual' });
    }
    for (const t of subtitleTracks.auto) {
        const code = t.code.replace(/-orig$/, '');
        if (seen.has(code)) continue;
        seen.add(code);
        languages.push({ code, name: displayNameFor(code, t.name), source: 'auto' });
    }
    return languages;
}

// --sub-langs takes regexes (yt-dlp anchors them), hence the escaping.
export function buildSubtitleDownloadArgs({ url, track, outputDir, ffmpegDir, extraArgs = [] }) {
    const langPattern = track.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
        '--skip-download', '--no-playlist', '--no-warnings', track.flag, '--sub-langs', langPattern, '--sub-format', 'vtt',
        '--ffmpeg-location', ffmpegDir, ...extraArgs, '-o', path.join(outputDir, 'sub.%(ext)s'), '--', url,
    ];
}

const TIMING_LINE = /^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})/;
const INLINE_TIMESTAMP = /<\d{2}:\d{2}:\d{2}\.\d{3}>/;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function parseTimestamp(value) {
    const parts = value.split(':').map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
}

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === '#') {
            const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function cleanLine(line) {
    return decodeEntities(line.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// YouTube auto-captions are "rolling": each cue repeats the previous line
// above the new one, and ~10 ms filler cues repeat it again. Those files are
// recognisable by their inline word timestamps; only there are lines already
// shown by the previous cue dropped, so a real repeated lyric in uploader
// subtitles survives.
export function parseVtt(text) {
    const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const rolling = INLINE_TIMESTAMP.test(text);
    const segments = [];
    let previousLines = [];

    for (const block of blocks) {
        const lines = block.split('\n');
        const timingIndex = lines.findIndex((line) => TIMING_LINE.test(line));
        if (timingIndex === -1) continue;
        const [, startText, endText] = lines[timingIndex].match(TIMING_LINE);
        const start = parseTimestamp(startText);
        const end = parseTimestamp(endText);
        const cueLines = lines.slice(timingIndex + 1).map(cleanLine).filter(Boolean);

        const newLines = rolling ? cueLines.filter((line) => !previousLines.includes(line)) : cueLines;
        previousLines = cueLines;
        if (newLines.length === 0) continue;

        const last = segments[segments.length - 1];
        if (last && last.end > start) last.end = start;
        segments.push({ start, end, text: newLines.join(' ') });
    }
    return segments;
}

const EXTRA_TRANSCRIPT_FILE = /^transcript\.([A-Za-z0-9-]+)\.json$/;

// transcript.json is the version's default transcript; any other language
// the user downloads sits next to it as transcript.<code>.json. Codes are
// validated by the caller (clampTranscriptSettings' pattern).
export function transcriptPath(epochDir, language = null) {
    return path.join(epochDir, language ? `transcript.${language}.json` : TRANSCRIPT_FILE_NAME);
}

export function readTranscript(epochDir, language = null) {
    try {
        return JSON.parse(fs.readFileSync(transcriptPath(epochDir, language), 'utf-8'));
    } catch {
        return null;
    }
}

export function listExtraTranscriptLanguages(epochDir) {
    try {
        return fs.readdirSync(epochDir).map((name) => name.match(EXTRA_TRANSCRIPT_FILE)?.[1]).filter(Boolean);
    } catch {
        return [];
    }
}

// The default answers for its own language, so a language is never stored twice.
export function readTranscriptForLanguage(epochDir, language) {
    const defaultTranscript = readTranscript(epochDir);
    if (!language || defaultTranscript?.language === language) return defaultTranscript;
    return readTranscript(epochDir, language);
}

// The languages dialog's rows: what the video offers, marked with what is
// saved. A saved language the video no longer lists still shows.
export function mergeTranscriptLanguages(available, defaultTranscript, extraTranscripts) {
    const saved = new Map();
    if (defaultTranscript) saved.set(defaultTranscript.language, defaultTranscript);
    for (const t of extraTranscripts) if (!saved.has(t.language)) saved.set(t.language, t);
    const isDefault = (code) => defaultTranscript?.language === code;
    const rows = available.map((l) => ({ ...l, saved: saved.has(l.code), isDefault: isDefault(l.code) }));
    for (const [code, t] of saved) {
        if (!rows.some((row) => row.code === code)) rows.push({ code, name: t.languageName, source: t.source, saved: true, isDefault: isDefault(code) });
    }
    return rows;
}

function writeJsonAtomic(filePath, value) {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value), 'utf-8');
    fs.renameSync(tempPath, filePath);
}

// The default transcript also keeps the video's language list, so the
// languages dialog doesn't have to ask YouTube again.
export function saveAvailableTranscriptLanguages(epochDir, availableLanguages) {
    const transcript = readTranscript(epochDir);
    if (transcript) writeJsonAtomic(transcriptPath(epochDir), { ...transcript, availableLanguages });
}

// The default (asDefault) also gets the small summary on metadata.json that
// the index carries -- the segments themselves never go into the index.
// An extra language only writes its own file.
export function writeTranscript(epochDir, { language, languageName, source, segments, availableLanguages, fetchedEpoch = Date.now() }, { asDefault = true } = {}) {
    const transcript = { version: TRANSCRIPT_FORMAT_VERSION, language, languageName, source, fetchedEpoch, segments };
    if (asDefault && availableLanguages) transcript.availableLanguages = availableLanguages;
    writeJsonAtomic(transcriptPath(epochDir, asDefault ? null : language), transcript);
    if (!asDefault) return transcript;

    const metadataPath = path.join(epochDir, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    metadata.transcript = { language, languageName, source, fetchedEpoch, segmentCount: segments.length };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return transcript;
}

function formatTimestamp(seconds) {
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function transcriptToText(transcript, { withTimestamps }) {
    return transcript.segments
        .map((segment) => (withTimestamps ? `[${formatTimestamp(segment.start)}] ${segment.text}` : segment.text))
        .join('\n');
}

// One fetch at a time, with a gap between them, so auto-fetch after a bulk
// download and "fetch missing transcripts" never hit YouTube in a burst.
// Single jobs and batch items share the one line.
export function createTranscriptQueue({ fetchOne, gapMs = 2000, onBatchProgress = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const pending = [];
    let running = false;
    let batch = null;

    function batchStatus() {
        if (!batch) return null;
        const { label, total, done, failed, current, stoppedReason, finished } = batch;
        return { label, total, done, failed, current, stoppedReason, finished };
    }

    async function drain() {
        if (running) return;
        running = true;
        let first = true;
        while (pending.length > 0) {
            const job = pending.shift();
            if (job.batch && job.batch.cancelled) {
                job.resolve({ success: false, cancelled: true });
                continue;
            }
            if (!first) await sleep(gapMs);
            first = false;
            if (job.batch) {
                job.batch.current = job.item.videoDir;
                onBatchProgress(batchStatus());
            }
            let result;
            try {
                result = await fetchOne(job.item);
            } catch (err) {
                result = { success: false, message: err instanceof Error ? err.message : String(err) };
            }
            job.resolve(result);
            if (job.batch) settleBatchItem(job.batch, result);
        }
        running = false;
    }

    function settleBatchItem(b, result) {
        b.done += 1;
        if (!result.success) b.failed += 1;
        if (!result.success && BATCH_STOPPING_KINDS.has(result.kind)) {
            b.stoppedReason = result.kind;
            b.cancelled = true;
        }
        if (b.done === b.total || b.cancelled) finishBatch(b);
        else onBatchProgress(batchStatus());
    }

    function finishBatch(b) {
        if (b.finished) return;
        b.finished = true;
        b.current = null;
        onBatchProgress(batchStatus());
    }

    function enqueue(item) {
        return new Promise((resolve) => {
            pending.push({ item, resolve });
            drain();
        });
    }

    // label says who started the batch (e.g. a channel), so only that view
    // shows its progress.
    function enqueueBatch(items, { label = null } = {}) {
        if (batch && !batch.finished) return { success: false, message: 'A transcript batch is already running.' };
        batch = { label, total: items.length, done: 0, failed: 0, current: null, stoppedReason: null, finished: false, cancelled: false };
        const b = batch;
        if (items.length === 0) finishBatch(b);
        for (const item of items) pending.push({ item, batch: b, resolve: () => {} });
        onBatchProgress(batchStatus());
        drain();
        return { success: true };
    }

    function cancelBatch() {
        if (!batch || batch.finished) return;
        batch.cancelled = true;
        batch.stoppedReason = 'cancelled';
        finishBatch(batch);
    }

    return { enqueue, enqueueBatch, cancelBatch, status: batchStatus };
}
