// Dev-only synthetic library generator for the performance benchmarks
// (scripts/perf/bench-library.mjs) -- never shipped with the app.
//
// Writes through library.mjs's own real writers (writeLibraryEntry,
// addLibraryVersion, recordLibraryDownload, recordClip,
// writePlaylistSnapshot) rather than hand-building metadata.json files, so
// the fixture can't drift from the shape the app actually produces. Only
// the inputs are synthetic: deterministic pseudo-random titles/descriptions
// of realistic length, tiny placeholder media/thumbnail files, and an
// incrementing fake clock (library.mjs keys epoch folders on Date.now(),
// which isn't fine-grained enough to keep thousands of writes distinct).
import fs from 'fs';
import path from 'path';
import {
    writeLibraryEntry,
    addLibraryVersion,
    recordLibraryDownload,
    recordClip,
    writePlaylistSnapshot,
    DEFAULT_LIBRARY_DIR_NAME,
} from '../../src/electron/library.mjs';

// Two channel-size distributions, since they stress different parts of the
// walk: a "real archive" (a handful of big channels) vs many tiny channels.
export const DISTRIBUTIONS = {
    archive: 200,
    scattered: 2,
};

const NON_YOUTUBE_PLATFORMS = [
    ['soundcloud', 'Soundcloud'],
    ['dailymotion', 'Dailymotion'],
    ['vimeo', 'Vimeo'],
    ['archive.org', 'ArchiveOrg'],
    ['bandcamp', 'Bandcamp'],
];

const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt labore dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat proident sunt culpa officia deserunt mollit anim laborum review tutorial live stream highlights episode'.split(' ');

// mulberry32 -- small, fast, deterministic; the same seed always produces
// the same fixture, so benchmark runs are comparable across machines.
function createRandom(seed) {
    let state = seed >>> 0;
    return function random() {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function sentence(random, wordCount) {
    const words = [];
    for (let i = 0; i < wordCount; i++) words.push(WORDS[Math.floor(random() * WORDS.length)]);
    return words.join(' ');
}

// An 11-char YouTube-shaped id, unique per index.
export function fixtureVideoId(n) {
    return `v${String(n).padStart(10, '0')}`;
}

function buildVideoMetaData(random, n, channelIndex, platform) {
    const id = fixtureVideoId(n);
    const title = `${sentence(random, 4 + Math.floor(random() * 8))} #${n}`;
    const base = {
        id,
        title,
        fullTitle: title,
        // Real descriptions vary a lot; 60-260 words is a typical spread.
        description: sentence(random, 60 + Math.floor(random() * 200)),
        thumbnail: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
        duration: 60 + Math.floor(random() * 3600),
        durationString: '12:34',
        uploadDate: `20${10 + Math.floor(random() * 16)}0${1 + Math.floor(random() * 9)}1${Math.floor(random() * 9)}`,
        resolutions: ['144', '240', '360', '480', '720', '1080', '1440', '2160'].map((resolution) => ({ resolution, filesizeMb: String(Math.floor(random() * 900)) })),
        timestamp: 1_600_000_000 + Math.floor(random() * 150_000_000),
        license: null,
        categories: ['Entertainment'],
        tags: Array.from({ length: 8 }, () => WORDS[Math.floor(random() * WORDS.length)]),
        music: null,
    };
    if (platform) {
        return { ...base, platform: platform[0], extractorKey: platform[1], uploader: `${platform[0]} uploader ${channelIndex}`, originalUrl: `https://${platform[0]}.example/${id}` };
    }
    return { ...base, uploader: `Channel ${channelIndex} ${WORDS[channelIndex % WORDS.length]}`, uploaderId: `@channel${channelIndex}`, channelId: `UC${String(channelIndex).padStart(22, '0')}`, originalUrl: `https://www.youtube.com/watch?v=${id}` };
}

function withFakeClock(start, fn) {
    const realNow = Date.now;
    let now = start;
    Date.now = () => now++;
    try {
        return fn();
    } finally {
        Date.now = realNow;
    }
}

// Generates a library of `videos` entries under libraryDir. Returns a
// summary of what was written (counts the benchmarks need, plus the ids).
export function generateLibraryFixture({
    libraryDir,
    videos,
    videosPerChannel = DISTRIBUTIONS.archive,
    seed = 1,
    nonYoutubeFraction = 0.1,
    multiEpochFraction = 0.1,
    downloadedFraction = 0.6,
    clipsFraction = 0.05,
}) {
    const random = createRandom(seed);
    fs.mkdirSync(libraryDir, { recursive: true });
    const placeholderMedia = Buffer.alloc(4096, 1);
    const placeholderImage = Buffer.alloc(2048, 2);
    const summary = { videos: 0, epochs: 0, downloaded: 0, clips: 0, youtubeChannels: new Set(), videoIds: [] };

    withFakeClock(1_700_000_000_000, () => {
        for (let n = 0; n < videos; n++) {
            const isNonYoutube = random() < nonYoutubeFraction;
            const channelIndex = Math.floor(n / videosPerChannel);
            const platform = isNonYoutube ? NON_YOUTUBE_PLATFORMS[n % NON_YOUTUBE_PLATFORMS.length] : null;
            const videoMetaData = buildVideoMetaData(random, n, channelIndex, platform);
            const { channelDir, videoDir, metadata } = writeLibraryEntry({ libraryDir, videoMetaData });
            summary.videos++;
            summary.epochs++;
            summary.videoIds.push(videoMetaData.id);
            if (!platform) summary.youtubeChannels.add(channelDir);

            fs.writeFileSync(path.join(videoDir, 'video-thumbnail.jpg'), placeholderImage);
            if (!platform && !fs.existsSync(path.join(channelDir, 'channel-icon.jpg'))) {
                fs.writeFileSync(path.join(channelDir, 'channel-icon.jpg'), placeholderImage);
            }

            let latestEpoch = String(metadata.addedEpoch);
            if (random() < multiEpochFraction) {
                const extra = 1 + Math.floor(random() * 2);
                for (let e = 0; e < extra; e++) {
                    latestEpoch = addLibraryVersion({ libraryDir, videoDir, videoMetaData }).epoch;
                    summary.epochs++;
                }
            }
            if (random() < downloadedFraction) {
                const filePath = path.join(videoDir, latestEpoch, 'video.mp4');
                fs.writeFileSync(filePath, placeholderMedia);
                recordLibraryDownload({ videoDir, epoch: latestEpoch, filePath, resolution: '1080', format: 'mp4' });
                summary.downloaded++;
            }
            if (random() < clipsFraction) {
                fs.mkdirSync(path.join(videoDir, 'clips'), { recursive: true });
                const fileName = 'Clip 1.mp4';
                fs.writeFileSync(path.join(videoDir, 'clips', fileName), placeholderMedia);
                recordClip({ libraryDir, videoDir, fileName, title: 'Clip 1', durationSeconds: 12, clipTimestamps: { start: 1, end: 13 } });
                summary.clips++;
            }
        }
    });

    return {
        videos: summary.videos,
        epochs: summary.epochs,
        downloaded: summary.downloaded,
        clips: summary.clips,
        youtubeChannels: summary.youtubeChannels.size,
        videoIds: summary.videoIds,
    };
}

// Playlist entries in the shape reconcile/writePlaylistSnapshot take.
// `libraryVideoIds` (optional) are mixed in so a fraction of entries match
// real library videos; the rest are ids that aren't in the library.
export function buildPlaylistEntries({ count, libraryVideoIds = [], matchFraction = 0.5, seed = 7 }) {
    const random = createRandom(seed);
    const entries = [];
    for (let i = 0; i < count; i++) {
        const useLibraryId = libraryVideoIds.length > 0 && random() < matchFraction;
        const videoId = useLibraryId ? libraryVideoIds[Math.floor(random() * libraryVideoIds.length)] : `p${String(i).padStart(10, '0')}`;
        entries.push({
            videoId,
            title: `${sentence(random, 6)} #${i}`,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            uploadDate: '20240101',
        });
    }
    return entries;
}

// Writes one saved playlist snapshot with `entries`. Passes an empty index
// on purpose: writePlaylistSnapshot's localFiles pass is itself a
// findVideoInIndex call per entry (see PERF-009), which would make fixture
// generation as slow as the thing being measured -- the benchmark times
// that pass separately instead.
export function generatePlaylistFixture({ libraryDir, playlistId, entries }) {
    return withFakeClock(1_800_000_000_000, () => writePlaylistSnapshot({
        libraryDir,
        libraryTag: DEFAULT_LIBRARY_DIR_NAME,
        playlistId,
        title: `Fixture playlist ${playlistId}`,
        uploader: 'Fixture',
        originalUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
        entries,
        index: { channels: [] },
    }));
}
