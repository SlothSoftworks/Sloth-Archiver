import type { LibraryVideo, LibraryVideoMetadata, PlaylistEntry, PlaylistSummary, PlaylistSnapshot, LibraryClip } from '../types';

export {}

type FolderPickerResult = {
    filePath: string;
    canceled: boolean;
};

// dialog.showOpenDialog (used by pickFolder) resolves with filePaths (plural, an
// array), unlike showSaveDialog's singular filePath -- these are genuinely
// different shapes, not the same result reused.
type OpenFolderResult = {
    filePaths: string[];
    canceled: boolean;
};

// Library export/import (libraryExport.mjs). counts describes the export
// file; plan/summary is what the import did (or, for a preview, would do).
export type LibraryExportCounts = { sublibraries: number; videos: number; versions: number; playlists: number };
export type LibraryImportSummary = {
    sublibrariesCreated: number;
    videosAdded: number;
    versionsAdded: number;
    videosAlreadyPresent: number;
    localFilesSkipped: number;
    invalidSkipped: number;
    playlistsAdded: number;
    playlistsAlreadyPresent: number;
    labelsApplied: number;
};

// Mirrors LibraryScreen.tsx's own SortField/SortDirection unions.
type LibrarySortField = 'title' | 'uploadDate' | 'dateAdded' | 'channel' | 'downloaded' | 'quality';
type LibrarySortDirection = 'asc' | 'desc';

// Mirrors listLibraryTags' return shape (library.mjs) -- folderName is what
// every IPC call actually keys on; tagName is presentational (today always
// equal to folderName, since sublibrary names aren't renamable separately
// from their folder). Exported so useLibraryTags.tsx and its consumers share
// this one declaration instead of each keeping their own local copy.
export type LibraryTag = {
    tagName: string;
    folderName: string;
    createdEpoch: number | null;
};

// A per-sublibrary map of user-defined video tags to the videoIds carrying
// them (see listVideoTags, library.mjs) -- unrelated to LibraryTag above
// (that's sublibrary switching); named videoTag(s) everywhere to keep the
// two concepts unambiguous.
type VideoTagsMap = Record<string, string[]>;

type LibraryIndex = {
    channels: {
        channelFolderName: string;
        displayName: string;
        channelIconPath: string | null;
        videos: {
            videoFolderName: string;
            videoDir: string;
            latestEpoch: string | null;
            metadata: LibraryVideoMetadata;
            epochs: { epoch: string; metadata: LibraryVideoMetadata }[];
            thumbnailPath: string | null;
            clipCount: number;
        }[];
    }[];
};

// Channel archiving (channelScan.mjs, archiveBacklog.mjs). `kind` values are
// downloadErrors.mjs's ERROR_KINDS, typed as string like every other error
// kind that crosses IPC.
export type ChannelScanEntry = {
    videoId: string;
    title: string | null;
    durationSeconds: number | null;
    // Seconds since the epoch, and only approximate: day precision for
    // recent uploads, month within a year, year beyond that.
    approxTimestamp: number | null;
    membersOnly: boolean;
};
// avatarUrl is a remote image URL straight from YouTube's metadata: pass it
// through safeRemoteImageUrl before rendering.
export type ChannelScanChannel = { id: string | null; title: string | null; url: string; avatarUrl: string | null };
export type ChannelScanProgress = {
    scanId: string;
    stage: 'resolving' | 'counting' | 'listing';
    found: number;
    // The channel's public video count; excludes members-only videos, so
    // `found` can end up above it.
    total: number | null;
};
export type ChannelScanResult =
    | { success: true; channel: ChannelScanChannel; total: number | null; entries: ChannelScanEntry[]; truncated: boolean }
    | { success: false; kind: string; message: string; cancelled: boolean };

export type ArchiveBacklogQuality = '2160' | '1440' | '1080' | '720' | '480' | '360' | '240' | '144' | 'MP3';
export type ArchiveBacklogJobOptions = {
    download: boolean;
    targetResolution: ArchiveBacklogQuality;
    targetLibraryTag: string;
    batchSize: number;
};
export type ArchiveBacklogItem = {
    videoId: string;
    title: string;
    approxTimestamp: number | null;
    status: 'pending' | 'error';
    attempts: number;
    errorKind?: string;
    errorMessage?: string;
};
export type ArchiveBacklogJob = {
    id: string;
    channelId: string | null;
    channelTitle: string;
    channelUrl: string | null;
    createdAt: number;
    options: ArchiveBacklogJobOptions;
    // totalCount is always doneCount plus the items still listed.
    totalCount: number;
    doneCount: number;
    items: ArchiveBacklogItem[];
};
// completedJobs carries the counts of jobs that finished and left `jobs`
// while others were still going.
export type ArchiveBacklog = { version: 1; libraryDir: string | null; completedJobs: { totalCount: number; doneCount: number }; jobs: ArchiveBacklogJob[] };
// total/done cover the whole backlog since it was last empty.
export type ArchiveBacklogCounts = { jobs: number; pending: number; errors: number; total: number; done: number };
// What every backlog call resolves with. libraryDirMatches is false when the
// backlog was queued for a different library folder than the current one.
export type ArchiveBacklogState = {
    backlog: ArchiveBacklog;
    counts: ArchiveBacklogCounts;
    libraryDir: string;
    libraryDirMatches: boolean;
};
export type ArchiveBacklogNewJob = {
    channelId: string | null;
    channelTitle: string | null;
    channelUrl: string;
    options: ArchiveBacklogJobOptions;
    items: { videoId: string; title: string | null; approxTimestamp: number | null }[];
};
export type ArchiveBacklogAddJobReason = 'invalidMode' | 'noLibraryDir' | 'invalidJob' | 'invalidOptions' | 'invalidTag' | 'tooManyItems' | 'noValidItems' | 'libraryDirMismatch' | 'ioError';
export type ArchiveBacklogAddJobResult = ArchiveBacklogState & (
    | { success: true; jobId: string | null; added: number; duplicatesSkipped: number; invalidSkipped: number }
    | { success: false; reason: ArchiveBacklogAddJobReason; message?: string }
);
// `success: false` only ever means the backlog file could not be written.
export type ArchiveBacklogMutationResult<Extra> = ArchiveBacklogState & (
    | ({ success: true } & Extra)
    | { success: false; reason: 'ioError'; message: string }
);
export type BacklogBatchResult = {
    videoId: string;
    outcome: 'done' | 'pending' | 'error';
    errorKind?: string;
    errorMessage?: string;
};

// Opaque handle: the wrapper function preload.cjs registered on ipcRenderer.
export type ChannelScanProgressListener = (...args: unknown[]) => void;

export type LibraryVideoLookupEntry = { videoDir: string; latestEpoch: string | null; hasVideoFile: boolean; hasAudioFile: boolean };
// Keyed by video id; an id that is not in the sublibrary has no key. Check
// for an own key (Object.keys, or hasOwnProperty.call) rather than reading
// lookup[id] directly: "constructor" is a syntactically valid video id.
export type LibraryVideoLookup = Record<string, LibraryVideoLookupEntry>;

export type VideoInfoResult =
    | { success: true; videoInfo: T; fromCache: boolean }
    | { success: false; kind: string; message: string };

declare global {
    interface Window {
        // Set by App.tsx only in the dev-mock fallback path (no real preload
        // attached) -- read back by testing/mockData/electronAPIMocks.ts to
        // decide whether DownloaderScreen should seed itself with mock video
        // info.
        mockingElectron?: string;
        electronAPI: {
            pickFolder: (options: T) => Promise <OpenFolderResult>;
            saveVideoFile: (defaultName?: string) => Promise <FolderPickerResult>;
            getVideoInfoPython: (url: string, options?: T) => Promise <T>
            getVideoInfoResult: (url: string) => Promise<VideoInfoResult>
            openDirectory: (path: string) => Promise<T>
            openFileInDirectory: (filePath: string) => Promise<T>
            openFileExternally: (filePath: string) => Promise<void>
            saveCookie: (cookieText: string) => Promise<{ success: boolean; cookieCount: number; skipped: number }>
            deleteCookie: () => Promise<{ success: boolean }>
            getCookieStatus: () => Promise<{ loaded: boolean; cookieCount: number; path?: string; savedAtEpoch?: number }>
            getCookiesConfig: () => Promise<{ cookiesMode: 'file' | 'browser'; cookiesBrowser: string; supportedBrowsers: string[]; cookiesPersistAcrossSessions: boolean }>
            setCookiesConfig: (payload: { cookiesMode: 'file' | 'browser'; cookiesBrowser: string }) => Promise<{ success: boolean; cookiesMode: 'file' | 'browser'; cookiesBrowser: string }>
            setCookiesPersistAcrossSessions: (persist: boolean) => Promise<{ success: boolean; cookiesPersistAcrossSessions: boolean }>
            getDownloadDir: () => Promise<{ downloadDir: string }>
            setDownloadDir: (dir: string) => Promise<{ success: boolean; downloadDir?: string; message?: string }>
            checkFileExists: (filePath: string) => Promise<boolean>
            checkForYtdlpUpdate: () => Promise<{ current: string; latest: string | null; updateAvailable: boolean }>
            startYtdlpUpdate: () => Promise<{ success: boolean; version: string }>
            onYtdlpUpdateProgress: (callback: (data: { stage: string }) => void) => void
            removeYtdlpUpdateProgressListener: () => void
            quitApp: () => Promise<void>
            getAppVersion: () => Promise<string>
            getFfmpegVersion: () => Promise<string | null>
            deleteVideoInfoCacheEntry: (url: string) => Promise<{ success: boolean; existed: boolean }>
            getLibraryDir: () => Promise<{ libraryDir: string }>
            setLibraryDir: (dir: string) => Promise<{ success: boolean; libraryDir?: string; message?: string }>
            listLibraryTags: () => Promise<{ tags: LibraryTag[] }>
            createLibraryTag: (name: string) => Promise<{ success: boolean; tag?: LibraryTag; message?: string }>
            listVideoTags: () => Promise<{ tags: VideoTagsMap }>
            setVideoTag: (tagName: string, videoId: string, applied: boolean) => Promise<{ success: boolean; tags: VideoTagsMap }>
            tagVideos: (videoIds: string[], tagName: string) => Promise<{ success: boolean; tags: VideoTagsMap }>
            getActiveLibraryTag: () => Promise<{ activeLibraryTag: string; activeLibraryTagDir: string }>
            setActiveLibraryTag: (tag: string) => Promise<{ success: boolean; activeLibraryTag: string }>
            getLibraryViewMode: () => Promise<{ libraryViewMode: 'channel' | 'video' }>
            setLibraryViewMode: (mode: 'channel' | 'video') => Promise<{ success: boolean; libraryViewMode: 'channel' | 'video' }>
            getLibrarySort: () => Promise<{ sortField: LibrarySortField; sortDirection: LibrarySortDirection }>
            setLibrarySort: (payload: { sortField: LibrarySortField; sortDirection: LibrarySortDirection }) => Promise<{ success: boolean; sortField: LibrarySortField; sortDirection: LibrarySortDirection }>
            getLibraryDisplayMode: () => Promise<{ libraryDisplayMode: 'grid' | 'list' }>
            setLibraryDisplayMode: (mode: 'grid' | 'list') => Promise<{ success: boolean; libraryDisplayMode: 'grid' | 'list' }>
            getLibraryListColumns: () => Promise<{ libraryListColumns: number }>
            setLibraryListColumns: (columns: number) => Promise<{ success: boolean; libraryListColumns: number }>
            getThemeMode: () => Promise<{ themeMode: 'light' | 'dark' }>
            setThemeMode: (mode: 'light' | 'dark') => Promise<{ success: boolean; themeMode: 'light' | 'dark' }>
            getThemeName: () => Promise<{ themeName: 'default' | 'slothui' }>
            setThemeName: (name: 'default' | 'slothui') => Promise<{ success: boolean; themeName: 'default' | 'slothui' }>
            getCustomConvertFormats: () => Promise<{ customConvertFormats: string[] }>
            setCustomConvertFormats: (formats: string[]) => Promise<{ success: boolean; customConvertFormats: string[] }>
            getMaxSimultaneousDownloads: () => Promise<{ maxSimultaneousDownloads: number }>
            setMaxSimultaneousDownloads: (value: number) => Promise<{ success: boolean; maxSimultaneousDownloads: number }>
            getThumbnailSize: () => Promise<{ thumbnailSize: number }>
            setThumbnailSize: (value: number) => Promise<{ success: boolean; thumbnailSize: number }>
            getResumeTrackingMode: () => Promise<{ resumeTrackingMode: 'never' | 'always' | 'custom' }>
            setResumeTrackingMode: (value: 'never' | 'always' | 'custom') => Promise<{ success: boolean; resumeTrackingMode: 'never' | 'always' | 'custom' }>
            getResumeMinDurationSeconds: () => Promise<{ resumeMinDurationSeconds: number }>
            setResumeMinDurationSeconds: (value: number) => Promise<{ success: boolean; resumeMinDurationSeconds: number }>
            getEmbedMetadataByDefault: () => Promise<{ embedMetadataByDefault: boolean }>
            setEmbedMetadataByDefault: (value: boolean) => Promise<{ success: boolean; embedMetadataByDefault: boolean }>
            getLibraryIndex: () => Promise<LibraryIndex>
            getLibraryVideo: (videoDir: string) => Promise<{ success: boolean; video?: LibraryVideo; message?: string }>
            refreshLibraryIndex: () => Promise<LibraryIndex>
            refreshChannelIcon: (payload: { channelFolderName: string; channelId: string | null }) => Promise<LibraryIndex>
            addLibraryEntry: (videoMetaData: T, targetTag?: string) => Promise<{ success: boolean; videoDir: string; epoch: string }>
            overrideLibraryEntry: (videoMetaData: T, existingVideoDir: string, targetTag?: string) => Promise<{ success: boolean; videoDir: string }>
            addLibraryVersion: (videoMetaData: T, videoDir: string) => Promise<{ success: boolean; videoDir: string; epoch: string; metadata: LibraryVideoMetadata }>
            refreshLibraryEntry: (videoDir: string, epoch: string, videoMetaData: T) => Promise<{ success: boolean; metadata: LibraryVideoMetadata }>
            checkAndRepairEpochFiles: (videoDir: string, epoch: string) => Promise<{ success: boolean; metadata?: LibraryVideoMetadata; videoRepaired?: boolean; audioRepaired?: boolean; videoMissing?: boolean; audioMissing?: boolean; message?: string }>
            findLibraryVideo: (videoId: string, libraryTag?: string) => Promise<{ found: boolean; channelDisplayName?: string; videoDir?: string }>
            lookupLibraryVideos: (videoIds: string[], libraryTag?: string) => Promise<LibraryVideoLookup>
            openLocalVideoFile: () => Promise<OpenFolderResult>
            openImageFile: () => Promise<OpenFolderResult>
            probeLocalFile: (filePath: string) => Promise<{ id: string; width: number | null; height: number | null; duration: number | null; tags: { title: string | null; artist: string | null; date: string | null; genre: string | null; comment: string | null } }>
            addLocalFile: (payload: { sourceFilePath: string; formFields: T; mode?: 'add' | 'override' | 'addVersion'; videoDir?: string }, targetTag?: string) => Promise<{ success: boolean; videoDir: string; epoch: string }>
            changeThumbnail: (payload: { videoDir: string; mode: 'timestamp' | 'file'; timestampSeconds?: number; imageFilePath?: string; downloadedFilePath?: string }) => Promise<{ success: boolean; thumbnailPath?: string; message?: string }>
            fetchPlaylistEntries: (playlistUrl: string) => Promise<{ success: boolean; entries?: { id: string; title: string | null; url: string; thumbnailUrl: string; uploadDate: string | null }[]; playlistId?: string; message?: string }>
            enrichPlaylistEntry: (payload: { playlistId: string; videoId: string; title?: string | null; uploadDate?: string | null; thumbnailUrl?: string | null }) => Promise<{ success: boolean; message?: string }>
            listPlaylists: () => Promise<{ playlists: PlaylistSummary[] }>
            getPlaylist: (playlistId: string) => Promise<{ playlist: PlaylistSnapshot | null }>
            refreshPlaylist: (playlistId: string) => Promise<{ success: boolean; added?: number; removed?: number; updated?: number; lastRefreshedEpoch?: number; entries?: PlaylistEntry[]; missingFromLibraryEntries?: PlaylistEntry[]; manualThumbnailVideoId?: string | null; message?: string }>
            setPlaylistManualThumbnail: (playlistId: string, videoId: string | null) => Promise<{ success: boolean; manualThumbnailVideoId?: string | null; thumbnailUrl?: string | null; thumbnailPath?: string | null; message?: string }>
            undoPlaylistRefresh: (playlistId: string) => Promise<{ success: boolean; metadata?: PlaylistSnapshot; message?: string }>
            deletePlaylist: (playlistId: string) => Promise<{ success: boolean; message?: string }>
            recordLibraryDownload: (payload: { videoDir: string; epoch: string; filePath: string; resolution: string; format?: string; kind?: 'video' | 'audio' }) => Promise<{ success: boolean }>
            savePlaybackPosition: (payload: { videoDir: string; epoch: string; positionSeconds: number }) => Promise<{ success: boolean }>
            swapLibraryDownload: (payload: { videoDir: string; epoch: string; tempFilePath: string; oldFilePath: string | null; resolution: string; format?: string; kind?: 'video' | 'audio' }) => Promise<LibraryVideoMetadata>
            deleteLibraryEntry: (videoDir: string, epoch?: string) => Promise<{ success: boolean; videoDeleted: boolean }>
            deleteLibraryEntries: (videoDirs: string[]) => Promise<{ success: boolean; results: { videoDir: string; success: boolean; error?: string }[] }>
            moveLibraryEntries: (videoDirs: string[], targetTag: string) => Promise<{ success: boolean; results: { videoDir: string; success: boolean; error?: string }[] }>
            deleteLocalFiles: (videoDirs: string[]) => Promise<{ success: boolean; results: { videoDir: string; success: boolean; error?: string }[] }>
            onLibraryBackgroundUpdate: (callback: () => void) => void
            removeLibraryBackgroundUpdateListener: () => void
            exportLibrary: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string; counts?: LibraryExportCounts; message?: string }>
            previewLibraryImport: () => Promise<{ success: boolean; canceled?: boolean; token?: string; fileName?: string; exportedAt?: string | null; counts?: LibraryExportCounts; plan?: LibraryImportSummary; message?: string }>
            applyLibraryImport: (token: string) => Promise<{ success: boolean; summary?: LibraryImportSummary; message?: string }>
            saveExportedFile: (payload: { defaultName: string; extensions: string[]; inputPath?: string }) => Promise<{ filePath?: string; canceled: boolean }>
            extractMp3FromFile: (payload: { inputPath: string; outputPath: string }) => Promise<{ success: boolean; outputPath?: string; message?: string }>
            convertFileFormat: (payload: { inputPath: string; outputPath: string; format: string; forceReencode?: boolean }) => Promise<{ success: boolean; outputPath?: string; message?: string }>
            ensurePlayablePreview: (payload: { filePath: string }) => Promise<{ success: boolean; previewPath?: string; generated?: boolean; message?: string }>
            onPreviewGenerationProgress: (callback: (data: { percent: number }) => void) => void
            removePreviewGenerationProgressListener: () => void
            extractClipFromFile: (payload: { inputPath: string; outputPath: string; start: string; end: string; format?: string; forceReencode?: boolean }) => Promise<{ success: boolean; outputPath?: string; message?: string }>
            createClip: (payload: { videoDir: string; inputPath: string; start: string; end: string; format: string; clipName: string; forceReencode?: boolean }) => Promise<{ success: boolean; clip?: LibraryClip; message?: string }>
            getClips: (payload: { videoDir: string }) => Promise<{ success: boolean; clips: LibraryClip[]; message?: string }>
            deleteClip: (payload: { videoDir: string; clipId: string }) => Promise<{ success: boolean; message?: string }>
            convertClip: (payload: { videoDir: string; clipId: string; format: string; forceReencode?: boolean }) => Promise<{ success: boolean; clip?: LibraryClip; message?: string }>
            embedFileMetadata: (payload: { inputPath: string; metadataTags: Record<string, string | null | undefined>; thumbnailPath?: string | null; kind: 'video' | 'audio' }) => Promise<{ success: boolean; message?: string }>
            onFfmpegUtilityProgress: (callback: (data: { type: string; percent?: number }) => void) => void
            removeFfmpegUtilityProgressListener: () => void
            scanChannel: (scanId: string, url: string) => Promise<ChannelScanResult>
            cancelChannelScan: (scanId: string) => Promise<{ cancelled: boolean }>
            // Returns the listener it attached -- pass it back into
            // removeChannelScanProgressListener to remove just this one.
            onChannelScanProgress: (callback: (data: ChannelScanProgress) => void) => ChannelScanProgressListener
            removeChannelScanProgressListener: (listener: ChannelScanProgressListener) => void
            getBacklog: () => Promise<ArchiveBacklogMutationResult<unknown>>
            addBacklogJob: (payload: { job: ArchiveBacklogNewJob; mode: 'append' | 'replace' }) => Promise<ArchiveBacklogAddJobResult>
            applyBacklogResults: (jobId: string, results: BacklogBatchResult[]) => Promise<ArchiveBacklogMutationResult<{ applied: number }>>
            retryBacklogErrors: () => Promise<ArchiveBacklogMutationResult<{ retried: number }>>
            dismissBacklogErrors: () => Promise<ArchiveBacklogMutationResult<{ dismissed: number }>>
            clearBacklog: () => Promise<ArchiveBacklogMutationResult<unknown>>
            reportRendererError: (payload: { message: string; stack?: string }) => Promise<void>
            getErrorLogInfo: () => Promise<{ exists: boolean; path: string }>
            openErrorLog: () => Promise<void>
        };
        electronAPIPythonDownload: {
            startDownloadPython: (options: T) => Promise<T>;
            // Returns the listener it attached -- pass it back into
            // removeProgressListener to remove just this one (see preload.cjs).
            onProgressUpdate: (callback: (data: T) => void) => T;
            removeProgressListener: (listener: T) => void;
            cancelDownload: (requestId: string) => Promise<{ cancelled: boolean }>;
        }
    }
}
