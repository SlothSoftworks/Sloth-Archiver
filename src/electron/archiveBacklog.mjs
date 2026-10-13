import fs from 'fs';
import crypto from 'node:crypto';
import { parseYouTubeChannelUrl } from './utils/youtube.mjs';

export const BACKLOG_VERSION = 1;
export const BACKLOG_MAX_ITEMS = 50_000;
export const BACKLOG_BATCH_SIZE_MIN = 1;
export const BACKLOG_BATCH_SIZE_MAX = 500;
export const BACKLOG_BATCH_SIZE_DEFAULT = 10;
// Mirrors QUALITY_TIERS in src/ui/components/BulkAddDialog.tsx; kept as its
// own copy because the main process cannot import renderer code.
export const BACKLOG_QUALITY_TIERS = ['2160', '1440', '1080', '720', '480', '360', '240', '144', 'MP3'];

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const MAX_TITLE_CHARS = 500;
const MAX_ERROR_KIND_CHARS = 40;
const MAX_ERROR_MESSAGE_CHARS = 1000;

function emptyBacklog() {
    return { version: BACKLOG_VERSION, libraryDir: null, completedJobs: { totalCount: 0, doneCount: 0 }, jobs: [] };
}

function countOrZero(value) {
    return Number.isInteger(value) && value > 0 ? value : 0;
}

// A job leaves the list once it has no items left, but what it got done
// still belongs in the run's "X of Y done", so its counts are kept here.
function dropFinishedJobs(backlog) {
    for (const job of backlog.jobs) {
        if (job.items.length > 0) continue;
        backlog.completedJobs.totalCount += job.totalCount;
        backlog.completedJobs.doneCount += job.doneCount;
    }
    backlog.jobs = backlog.jobs.filter((job) => job.items.length > 0);
}

function toText(value, maxChars) {
    if (value === null || value === undefined) return '';
    return String(value).slice(0, maxChars);
}

export function clampBacklogBatchSize(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return BACKLOG_BATCH_SIZE_DEFAULT;
    return Math.min(BACKLOG_BATCH_SIZE_MAX, Math.max(BACKLOG_BATCH_SIZE_MIN, Math.round(number)));
}

function sanitizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.videoId !== 'string' || !VIDEO_ID_PATTERN.test(raw.videoId)) return null;
    const item = {
        videoId: raw.videoId,
        title: toText(raw.title, MAX_TITLE_CHARS),
        approxTimestamp: typeof raw.approxTimestamp === 'number' && Number.isFinite(raw.approxTimestamp) ? raw.approxTimestamp : null,
        status: raw.status === 'error' ? 'error' : 'pending',
        attempts: Number.isInteger(raw.attempts) && raw.attempts > 0 ? raw.attempts : 0,
    };
    if (item.status === 'error') {
        item.errorKind = toText(raw.errorKind, MAX_ERROR_KIND_CHARS) || 'unknown';
        item.errorMessage = toText(raw.errorMessage, MAX_ERROR_MESSAGE_CHARS);
    }
    return item;
}

// validTags is only known when a job is being added; a job read back from
// disk keeps whatever tag it was stored with (the sublibrary may have been
// removed since, which is the caller's business to detect).
function sanitizeOptions(raw, validTags) {
    if (!raw || typeof raw !== 'object') return { reason: 'invalidOptions' };
    if (!BACKLOG_QUALITY_TIERS.includes(raw.targetResolution)) return { reason: 'invalidOptions' };
    if (typeof raw.targetLibraryTag !== 'string' || !raw.targetLibraryTag) return { reason: 'invalidTag' };
    if (validTags && !validTags.includes(raw.targetLibraryTag)) return { reason: 'invalidTag' };
    return {
        options: {
            download: raw.download === true,
            targetResolution: raw.targetResolution,
            targetLibraryTag: raw.targetLibraryTag,
            batchSize: clampBacklogBatchSize(raw.batchSize),
        },
    };
}

function sanitizeChannelFields(raw) {
    return {
        channelId: typeof raw.channelId === 'string' && CHANNEL_ID_PATTERN.test(raw.channelId) ? raw.channelId : null,
        channelTitle: toText(raw.channelTitle, MAX_TITLE_CHARS),
        channelUrl: (typeof raw.channelUrl === 'string' && parseYouTubeChannelUrl(raw.channelUrl)) || null,
    };
}

function sanitizeStoredJob(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.items)) return null;
    const { options } = sanitizeOptions(raw.options, null);
    if (!options) return null;
    const seen = new Set();
    const items = [];
    for (const rawItem of raw.items) {
        const item = sanitizeItem(rawItem);
        if (!item || seen.has(item.videoId)) continue;
        seen.add(item.videoId);
        items.push(item);
    }
    if (items.length === 0) return null;
    // totalCount is always doneCount plus what is still listed; a file from
    // before these counts existed reads as "nothing done yet".
    const doneCount = countOrZero(raw.doneCount);
    return {
        id: raw.id.slice(0, 100),
        ...sanitizeChannelFields(raw),
        createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
        options,
        totalCount: doneCount + items.length,
        doneCount,
        items,
    };
}

export function summarizeBacklog(backlog) {
    let pending = 0;
    let errors = 0;
    let total = backlog.completedJobs.totalCount;
    let done = backlog.completedJobs.doneCount;
    for (const job of backlog.jobs) {
        total += job.totalCount;
        done += job.doneCount;
        for (const item of job.items) {
            if (item.status === 'error') errors++;
            else pending++;
        }
    }
    return { jobs: backlog.jobs.length, pending, errors, total, done };
}

// Run state for channel archiving: the videos still to be added, per channel
// job. Lives in userData (not in the library) because the library may be on
// a drive that is not plugged in when the app starts. The file is read back
// as untrusted input: anything that does not fit the shape is dropped.
export function createArchiveBacklogStore(filePath) {
    function read() {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return emptyBacklog();
        }
        if (!raw || typeof raw !== 'object' || raw.version !== BACKLOG_VERSION || !Array.isArray(raw.jobs)) return emptyBacklog();
        const jobs = [];
        let itemCount = 0;
        for (const rawJob of raw.jobs) {
            const job = sanitizeStoredJob(rawJob);
            if (!job || jobs.some((j) => j.id === job.id)) continue;
            if (itemCount + job.items.length > BACKLOG_MAX_ITEMS) break;
            itemCount += job.items.length;
            jobs.push(job);
        }
        if (jobs.length === 0) return emptyBacklog();
        const completedDone = countOrZero(raw.completedJobs?.doneCount);
        return {
            version: BACKLOG_VERSION,
            libraryDir: typeof raw.libraryDir === 'string' && raw.libraryDir ? raw.libraryDir : null,
            completedJobs: { totalCount: Math.max(completedDone, countOrZero(raw.completedJobs?.totalCount)), doneCount: completedDone },
            jobs,
        };
    }

    function write(backlog) {
        if (backlog.jobs.length === 0) {
            fs.rmSync(filePath, { force: true });
            return;
        }
        const tempPath = `${filePath}.new`;
        fs.writeFileSync(tempPath, JSON.stringify(backlog), 'utf-8');
        fs.renameSync(tempPath, filePath);
    }

    function result(backlog, extra = {}) {
        return { success: true, ...extra, backlog, counts: summarizeBacklog(backlog) };
    }

    function refusal(reason) {
        const backlog = read();
        return { success: false, reason, backlog, counts: summarizeBacklog(backlog) };
    }

    function addJob({ job, mode, currentLibraryDir, validTags }) {
        if (mode !== 'append' && mode !== 'replace') return refusal('invalidMode');
        if (typeof currentLibraryDir !== 'string' || !currentLibraryDir) return refusal('noLibraryDir');
        if (!job || typeof job !== 'object' || !Array.isArray(job.items)) return refusal('invalidJob');
        const { options, reason } = sanitizeOptions(job.options, Array.isArray(validTags) ? validTags : []);
        if (!options) return refusal(reason);
        if (job.items.length > BACKLOG_MAX_ITEMS) return refusal('tooManyItems');

        const backlog = mode === 'replace' ? emptyBacklog() : read();
        if (backlog.jobs.length > 0 && backlog.libraryDir !== currentLibraryDir) return refusal('libraryDirMismatch');

        const taken = new Set();
        for (const existing of backlog.jobs) {
            if (existing.options.targetLibraryTag !== options.targetLibraryTag) continue;
            for (const item of existing.items) taken.add(item.videoId);
        }
        const existingCount = backlog.jobs.reduce((sum, j) => sum + j.items.length, 0);

        const items = [];
        let invalidSkipped = 0;
        let duplicatesSkipped = 0;
        for (const rawItem of job.items) {
            // Only the descriptive fields are taken from the caller: a new
            // item always starts pending with no attempts.
            const item = sanitizeItem(rawItem ? { videoId: rawItem.videoId, title: rawItem.title, approxTimestamp: rawItem.approxTimestamp } : null);
            if (!item) {
                invalidSkipped++;
            } else if (taken.has(item.videoId)) {
                duplicatesSkipped++;
            } else {
                taken.add(item.videoId);
                items.push(item);
            }
        }
        if (items.length === 0 && duplicatesSkipped === 0) return refusal('noValidItems');
        if (existingCount + items.length > BACKLOG_MAX_ITEMS) return refusal('tooManyItems');

        let jobId = null;
        if (items.length > 0) {
            jobId = crypto.randomUUID();
            backlog.jobs.push({ id: jobId, ...sanitizeChannelFields(job), createdAt: Date.now(), options, totalCount: items.length, doneCount: 0, items });
        }
        backlog.libraryDir = currentLibraryDir;
        write(backlog);
        return result(backlog.jobs.length === 0 ? emptyBacklog() : backlog, { jobId, added: items.length, duplicatesSkipped, invalidSkipped });
    }

    function applyResults(jobId, results) {
        const backlog = read();
        const job = backlog.jobs.find((j) => j.id === jobId);
        if (!job || !Array.isArray(results)) return result(backlog, { applied: 0 });

        const byVideoId = new Map(job.items.map((item) => [item.videoId, item]));
        const removed = new Set();
        let applied = 0;
        for (const entry of results) {
            const item = entry && typeof entry === 'object' ? byVideoId.get(entry.videoId) : undefined;
            if (!item || removed.has(item.videoId)) continue;
            if (entry.outcome === 'done') {
                removed.add(item.videoId);
            } else if (entry.outcome === 'pending') {
                item.status = 'pending';
                item.attempts += 1;
                delete item.errorKind;
                delete item.errorMessage;
            } else if (entry.outcome === 'error') {
                item.status = 'error';
                item.errorKind = toText(entry.errorKind, MAX_ERROR_KIND_CHARS) || 'unknown';
                item.errorMessage = toText(entry.errorMessage, MAX_ERROR_MESSAGE_CHARS);
            } else {
                continue;
            }
            applied++;
        }
        if (applied === 0) return result(backlog, { applied });

        job.items = job.items.filter((item) => !removed.has(item.videoId));
        job.doneCount += removed.size;
        dropFinishedJobs(backlog);
        write(backlog);
        return result(backlog.jobs.length === 0 ? emptyBacklog() : backlog, { applied });
    }

    function retryErrors() {
        const backlog = read();
        let retried = 0;
        for (const job of backlog.jobs) {
            for (const item of job.items) {
                if (item.status !== 'error') continue;
                item.status = 'pending';
                item.attempts = 0;
                delete item.errorKind;
                delete item.errorMessage;
                retried++;
            }
        }
        if (retried > 0) write(backlog);
        return result(backlog, { retried });
    }

    function dismissErrors() {
        const backlog = read();
        let dismissed = 0;
        for (const job of backlog.jobs) {
            const kept = job.items.filter((item) => item.status !== 'error');
            dismissed += job.items.length - kept.length;
            // A dismissed video is no longer part of the work, so it leaves
            // the total too; what was done stays done.
            job.totalCount -= job.items.length - kept.length;
            job.items = kept;
        }
        if (dismissed === 0) return result(backlog, { dismissed });
        dropFinishedJobs(backlog);
        write(backlog);
        return result(backlog.jobs.length === 0 ? emptyBacklog() : backlog, { dismissed });
    }

    function clear() {
        fs.rmSync(filePath, { force: true });
        return result(emptyBacklog());
    }

    return { read, addJob, applyResults, retryErrors, dismissErrors, clear };
}
