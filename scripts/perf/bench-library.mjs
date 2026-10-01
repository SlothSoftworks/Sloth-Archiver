// Dev-only benchmark harness for reports/PerformanceAnalysis.md (dossier)
// test-plan steps 1-3: generates synthetic libraries (libraryFixture.mjs)
// at several sizes and times the real library.mjs functions against them.
// Not part of the app or the test suite.
//
//   node scripts/perf/bench-library.mjs --dir <scratch dir> \
//     [--sizes 100,1000,5000,20000,100000] [--distributions archive,scattered]
//     [--out results.json] [--no-cold]
//
// Fixtures are reused across runs when a matching one already exists in
// --dir. Cold-cache scans need permission to write /proc/sys/vm/drop_caches
// (Linux, root); without it they're skipped and reported as such.
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import v8 from 'v8';
import { execSync } from 'child_process';
import { performance, monitorEventLoopDelay } from 'perf_hooks';
import {
    scanLibrary,
    refreshLibraryIndex,
    findVideoInIndex,
    createVideoLookup,
    writeLibraryEntry,
    recordLibraryDownload,
    reconcilePlaylistSnapshot,
    libraryTagDir,
} from '../../src/electron/library.mjs';
import { generateLibraryFixture, generatePlaylistFixture, buildPlaylistEntries, fixtureVideoId, DISTRIBUTIONS } from './libraryFixture.mjs';

function parseArgs(argv) {
    const args = { sizes: [100, 1000, 5000, 20000, 100000], distributions: ['archive', 'scattered'], cold: true, out: null, dir: null, playlistSizes: [10000, 50000] };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--dir') args.dir = argv[++i];
        else if (flag === '--sizes') args.sizes = argv[++i].split(',').map(Number);
        else if (flag === '--distributions') args.distributions = argv[++i].split(',');
        else if (flag === '--playlist-sizes') args.playlistSizes = argv[++i].split(',').map(Number);
        else if (flag === '--out') args.out = argv[++i];
        else if (flag === '--no-cold') args.cold = false;
        else throw new Error(`Unknown flag ${flag}`);
    }
    if (!args.dir) throw new Error('--dir <scratch directory> is required');
    return args;
}

const median = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};
const round = (x, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;

async function timeAsync(fn) {
    const start = performance.now();
    const result = await fn();
    return { ms: performance.now() - start, result };
}

function timeSync(fn) {
    const start = performance.now();
    const result = fn();
    return { ms: performance.now() - start, result };
}

function dropCaches() {
    try {
        execSync('sync');
        fs.writeFileSync('/proc/sys/vm/drop_caches', '3');
        return true;
    } catch {
        return false;
    }
}

// Every filesystem round trip scanLibrary makes, each awaited (or sync) one
// after another: existsSync + readdir of the tag folder, a readdir per
// channel (plus NonYT/), a readdir per video, a readFile per epoch, and a
// sync readFileSync attempt for clips.json per video. Serial, so on storage
// with per-call latency L the scan costs at least roundTrips x L.
function countScanRoundTrips(index) {
    const videos = index.channels.flatMap((c) => c.videos);
    const epochs = videos.reduce((n, v) => n + v.epochs.length, 0);
    const hasNonYt = index.channels.some((c) => c.isPlatformGroup);
    return 2 + (hasNonYt ? 1 : 0) + index.channels.length + videos.length * 2 + epochs;
}

async function ensureFixture(baseDir, size, distribution) {
    const libraryDir = path.join(baseDir, `${distribution}-${size}`);
    const markerPath = path.join(libraryDir, '.fixture.json');
    if (fs.existsSync(markerPath)) {
        return { libraryDir, summary: JSON.parse(fs.readFileSync(markerPath, 'utf-8')), generatedMs: null };
    }
    fs.rmSync(libraryDir, { recursive: true, force: true });
    const { ms, result } = timeSync(() => generateLibraryFixture({ libraryDir, videos: size, videosPerChannel: DISTRIBUTIONS[distribution] }));
    const { videoIds, ...counts } = result;
    const summary = { ...counts, videoIdsCount: videoIds.length };
    fs.writeFileSync(markerPath, JSON.stringify(summary));
    return { libraryDir, summary, generatedMs: ms };
}

function diskUsageMb(dir) {
    try {
        return Number(execSync(`du -sm "${dir}"`).toString().split('\t')[0]);
    } catch {
        return null;
    }
}

// PERF-001 / PERF-003 / PERF-004 / PERF-007: one full scan, cold and warm,
// plus event-loop delay while it runs and the size of what it returns.
async function benchScan(libraryDir, { cold }) {
    const out = {};
    if (cold) {
        out.coldCacheDropped = dropCaches();
        if (out.coldCacheDropped) {
            out.coldScanMs = round((await timeAsync(() => scanLibrary(libraryDir))).ms);
        }
    }
    const warm = [];
    for (let i = 0; i < 5; i++) warm.push((await timeAsync(() => scanLibrary(libraryDir))).ms);
    out.warmScanMsMedian = round(median(warm));
    out.warmScanMsMin = round(Math.min(...warm));

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const index = await scanLibrary(libraryDir);
    histogram.disable();
    out.scanEventLoopDelayMaxMs = round(histogram.max / 1e6);
    out.scanEventLoopDelayP99Ms = round(histogram.percentile(99) / 1e6);

    out.channels = index.channels.length;
    out.scanRoundTrips = countScanRoundTrips(index);
    out.projectedSerialScanMsAt1msLatency = out.scanRoundTrips * 1;
    out.projectedSerialScanMsAt5msLatency = out.scanRoundTrips * 5;

    // Electron IPC uses structured clone, which is v8's serializer -- the
    // closest stand-in for what library:getIndex actually ships.
    const { ms: serializeMs, result: serialized } = timeSync(() => v8.serialize(index));
    const { ms: deserializeMs } = timeSync(() => v8.deserialize(serialized));
    out.ipcPayloadMb = round(serialized.length / 1024 / 1024, 2);
    out.ipcSerializeMs = round(serializeMs);
    out.ipcDeserializeMs = round(deserializeMs);
    return { out, index };
}

// Where PERF-001's scan time actually goes: the same set of metadata.json
// reads done the way scanLibrary does them (one awaited fs.promises.readFile
// after another), with bounded concurrency, and synchronously. Sizes the
// available fix without changing library.mjs.
async function benchReadStrategies(index) {
    const files = index.channels.flatMap((c) => c.videos).flatMap((v) => v.epochs.map((e) => path.join(v.videoDir, e.epoch, 'metadata.json')));
    const serial = await timeAsync(async () => { for (const f of files) JSON.parse(await fsp.readFile(f, 'utf-8')); });
    const concurrency = 32;
    const parallel = await timeAsync(async () => {
        let next = 0;
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (next < files.length) {
                const f = files[next++];
                JSON.parse(await fsp.readFile(f, 'utf-8'));
            }
        }));
    });
    const sync = timeSync(() => { for (const f of files) JSON.parse(fs.readFileSync(f, 'utf-8')); });
    return {
        metadataFiles: files.length,
        readSerialAsyncMs: round(serial.ms),
        readParallel32AsyncMs: round(parallel.ms),
        readSyncMs: round(sync.ms),
    };
}

// PERF-002: "one download finished" -- the metadata write itself vs the
// full refreshLibraryIndex() that follows it in library:recordDownload.
async function benchSingleMutation(libraryDir, index) {
    const videos = index.channels.flatMap((c) => c.videos);
    const video = videos[Math.floor(videos.length / 2)];
    const writes = [];
    const rescans = [];
    for (let i = 0; i < 3; i++) {
        writes.push(timeSync(() => recordLibraryDownload({ videoDir: video.videoDir, epoch: video.latestEpoch, filePath: path.join(video.videoDir, video.latestEpoch, 'video.mp4'), resolution: '1080', format: 'mp4' })).ms);
        rescans.push((await timeAsync(() => refreshLibraryIndex(libraryDir))).ms);
    }
    return { metadataWriteMs: round(median(writes), 2), rescanAfterWriteMs: round(median(rescans)) };
}

// PERF-009 (second half): one lookup, hit and miss (a miss walks everything).
function benchFindVideo(index, videoIdsCount) {
    const lookups = 500;
    const hits = [];
    for (let i = 0; i < lookups; i++) hits.push(fixtureVideoId(Math.floor((i * 7919) % videoIdsCount)));
    const hit = timeSync(() => { for (const id of hits) findVideoInIndex(index, id); });
    const miss = timeSync(() => { for (let i = 0; i < lookups; i++) findVideoInIndex(index, `missing${i}`); });
    return { findVideoHitUs: round((hit.ms * 1000) / lookups), findVideoMissUs: round((miss.ms * 1000) / lookups) };
}

// PERF-005: the Library tab's flat-list search, exactly as
// useLibrarySearch runs it (lowercase every title on every query), for a
// query matching almost everything and one matching nothing -- plus the
// "precompute lowercase once" variant the report suggests as a first fix.
function benchSearch(index) {
    const items = index.channels.flatMap((c) => c.videos);
    const getSearchText = (video) => video.metadata.title || video.videoFolderName;
    const run = (query) => {
        const runs = [];
        for (let i = 0; i < 15; i++) runs.push(timeSync(() => items.filter((item) => getSearchText(item).toLowerCase().includes(query))).ms);
        return round(median(runs), 2);
    };
    const lowered = items.map((item) => getSearchText(item).toLowerCase());
    const runPre = (query) => {
        const runs = [];
        for (let i = 0; i < 15; i++) runs.push(timeSync(() => items.filter((_, idx) => lowered[idx].includes(query))).ms);
        return round(median(runs), 2);
    };
    return { searchBroadMs: run('e'), searchNoMatchMs: run('zzqx'), searchNoMatchPrecomputedMs: runPre('zzqx') };
}

// PERF-008: a bulk add into an existing library. Replays the main-process
// side of each item exactly as useBulkAddQueue drives it: library:addEntry
// (write + awaited rescan, then a second rescan once the thumbnail/icon
// fetch settles) and library:recordDownload (write + awaited rescan). The
// Library screen's own onLibraryBackgroundUpdate refresh (a 4th rescan when
// that screen is open) is not included. Added entries are removed after.
async function benchBulkAdd(libraryDir, items) {
    const perItem = [];
    const added = [];
    const realNow = Date.now;
    let fakeNow = 1_900_000_000_000;
    Date.now = () => fakeNow++;
    try {
        for (let i = 0; i < items; i++) {
            const id = `b${String(i).padStart(10, '0')}`;
            const { ms } = await timeAsync(async () => {
                const { videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData: { id, title: `Bulk item ${i}`, uploader: 'Bulk Channel', channelId: 'UCbulk', originalUrl: `https://www.youtube.com/watch?v=${id}`, description: 'bulk', resolutions: [] } });
                added.push(videoDir);
                await refreshLibraryIndex(libraryDir);
                await refreshLibraryIndex(libraryDir);
                recordLibraryDownload({ videoDir, epoch: String(metadata.addedEpoch), filePath: path.join(videoDir, String(metadata.addedEpoch), 'video.mp4'), resolution: '720', format: 'mp4' });
                await refreshLibraryIndex(libraryDir);
            });
            perItem.push(ms);
        }
    } finally {
        Date.now = realNow;
        for (const dir of added) fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(path.join(libraryTagDir(libraryDir), 'Bulk Channel'), { recursive: true, force: true });
    }
    const window = Math.max(1, Math.min(10, Math.floor(items / 3)));
    return {
        bulkItems: items,
        bulkMsPerItemFirst: round(median(perItem.slice(0, window))),
        bulkMsPerItemLast: round(median(perItem.slice(-window))),
    };
}

// PERF-009: reconcile a large saved playlist against this library. All
// synchronous -- its duration is exactly how long the main process is
// blocked. The localFiles pass (one videoId lookup per entry) is also timed
// alone, since writePlaylistSnapshot runs the same pass on first save.
function benchReconcile(libraryDir, index, videoIds, playlistSize) {
    const playlistId = `PLbench${playlistSize}`;
    const entries = buildPlaylistEntries({ count: playlistSize, libraryVideoIds: videoIds, matchFraction: 0.5 });
    generatePlaylistFixture({ libraryDir, playlistId, entries });
    const fresh = entries.map((e, i) => (i % 10 === 0 ? { ...e, title: `${e.title} (edited)` } : e));
    const { ms } = timeSync(() => reconcilePlaylistSnapshot({ libraryDir, playlistId, freshEntries: fresh, index }));
    // The localFiles pass the way the library code does it today (one
    // createVideoLookup map, then a lookup per entry).
    const { ms: lookupMs } = timeSync(() => { const lookupVideo = createVideoLookup(index); for (const e of fresh) lookupVideo(e.videoId); });
    fs.rmSync(path.join(libraryTagDir(libraryDir), 'playlists', playlistId), { recursive: true, force: true });
    return { playlistEntries: playlistSize, reconcileMs: round(ms), reconcileLookupPassMs: round(lookupMs) };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    fs.mkdirSync(args.dir, { recursive: true });
    const environment = {
        date: new Date().toISOString(),
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
        cpu: `${os.cpus()[0]?.model} x${os.cpus().length}`,
        memoryGb: round(os.totalmem() / 1024 ** 3),
    };
    console.error('environment', environment);
    const rows = [];
    const reconcileRows = [];
    for (const distribution of args.distributions) {
        for (const size of args.sizes) {
            console.error(`\n== ${distribution} ${size}`);
            const { libraryDir, summary, generatedMs } = await ensureFixture(args.dir, size, distribution);
            const row = { distribution, size, ...summary, generatedMs: generatedMs == null ? null : round(generatedMs), diskMb: diskUsageMb(libraryDir) };
            const { out, index } = await benchScan(libraryDir, { cold: args.cold });
            Object.assign(row, out);
            Object.assign(row, await benchReadStrategies(index));
            Object.assign(row, await benchSingleMutation(libraryDir, index));
            Object.assign(row, benchFindVideo(index, summary.videoIdsCount));
            Object.assign(row, benchSearch(index));
            if (distribution === 'archive') {
                Object.assign(row, await benchBulkAdd(libraryDir, size >= 100000 ? 5 : size >= 20000 ? 15 : 50));
                const videoIds = Array.from({ length: summary.videoIdsCount }, (_, i) => fixtureVideoId(i));
                for (const playlistSize of args.playlistSizes) {
                    if (size !== Math.min(...args.sizes) && size !== Math.max(...args.sizes)) continue;
                    const r = benchReconcile(libraryDir, index, videoIds, playlistSize);
                    reconcileRows.push({ librarySize: size, ...r });
                    console.error('reconcile', { librarySize: size, ...r });
                }
            }
            console.error(row);
            rows.push(row);
        }
    }
    const results = { environment, rows, reconcileRows };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
