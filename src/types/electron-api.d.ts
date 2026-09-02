import type { LibraryVideoMetadata, PlaylistEntry, PlaylistSummary, PlaylistSnapshot, LibraryClip } from '../types';

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

// Mirrors LibraryScreen.tsx's own SortField/SortDirection unions.
type LibrarySortField = 'title' | 'uploadDate' | 'dateAdded' | 'channel' | 'downloaded' | 'quality';
type LibrarySortDirection = 'asc' | 'desc';

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
            openDirectory: (path: string) => Promise<T>
            openFileInDirectory: (filePath: string) => Promise<T>
            openFileExternally: (filePath: string) => Promise<void>
            saveCookie: (cookieText: string) => Promise<{ success: boolean; cookieCount: number; skipped: number }>
            deleteCookie: () => Promise<{ success: boolean }>
            getCookieStatus: () => Promise<{ loaded: boolean; cookieCount: number; path?: string; savedAtEpoch?: number }>
            getCookiesConfig: () => Promise<{ cookiesMode: 'file' | 'browser'; cookiesBrowser: string; supportedBrowsers: string[] }>
            setCookiesConfig: (payload: { cookiesMode: 'file' | 'browser'; cookiesBrowser: string }) => Promise<{ success: boolean; cookiesMode: 'file' | 'browser'; cookiesBrowser: string }>
            getDownloadDir: () => Promise<{ downloadDir: string }>
            setDownloadDir: (dir: string) => Promise<{ success: boolean; downloadDir: string }>
            checkFileExists: (filePath: string) => Promise<boolean>
            checkForYtdlpUpdate: () => Promise<{ current: string; latest: string; updateAvailable: boolean }>
            startYtdlpUpdate: () => Promise<{ success: boolean; version: string }>
            onYtdlpUpdateProgress: (callback: (data: { stage: string }) => void) => void
            removeYtdlpUpdateProgressListener: () => void
            quitApp: () => Promise<void>
            getAppVersion: () => Promise<string>
            getFfmpegVersion: () => Promise<string | null>
            deleteVideoInfoCacheEntry: (url: string) => Promise<{ success: boolean; existed: boolean }>
            getLibraryDir: () => Promise<{ libraryDir: string }>
            setLibraryDir: (dir: string) => Promise<{ success: boolean; libraryDir: string }>
            getLibraryViewMode: () => Promise<{ libraryViewMode: 'channel' | 'video' }>
            setLibraryViewMode: (mode: 'channel' | 'video') => Promise<{ success: boolean; libraryViewMode: 'channel' | 'video' }>
            getLibrarySort: () => Promise<{ sortField: LibrarySortField; sortDirection: LibrarySortDirection }>
            setLibrarySort: (payload: { sortField: LibrarySortField; sortDirection: LibrarySortDirection }) => Promise<{ success: boolean; sortField: LibrarySortField; sortDirection: LibrarySortDirection }>
            getThemeMode: () => Promise<{ themeMode: 'light' | 'dark' }>
            setThemeMode: (mode: 'light' | 'dark') => Promise<{ success: boolean; themeMode: 'light' | 'dark' }>
            getCustomConvertFormats: () => Promise<{ customConvertFormats: string[] }>
            setCustomConvertFormats: (formats: string[]) => Promise<{ success: boolean; customConvertFormats: string[] }>
            getMaxSimultaneousDownloads: () => Promise<{ maxSimultaneousDownloads: number }>
            setMaxSimultaneousDownloads: (value: number) => Promise<{ success: boolean; maxSimultaneousDownloads: number }>
            getThumbnailSize: () => Promise<{ thumbnailSize: number }>
            setThumbnailSize: (value: number) => Promise<{ success: boolean; thumbnailSize: number }>
            getLibraryIndex: () => Promise<LibraryIndex>
            refreshLibraryIndex: () => Promise<LibraryIndex>
            refreshChannelIcon: (payload: { channelFolderName: string; channelId: string | null }) => Promise<LibraryIndex>
            addLibraryEntry: (videoMetaData: T) => Promise<{ success: boolean; videoDir: string; epoch: string }>
            overrideLibraryEntry: (videoMetaData: T, existingVideoDir: string) => Promise<{ success: boolean; videoDir: string }>
            addLibraryVersion: (videoMetaData: T, videoDir: string) => Promise<{ success: boolean; videoDir: string; epoch: string; metadata: LibraryVideoMetadata }>
            refreshLibraryEntry: (videoDir: string, epoch: string, videoMetaData: T) => Promise<{ success: boolean; metadata: LibraryVideoMetadata }>
            findLibraryVideo: (videoId: string) => Promise<{ found: boolean; channelDisplayName?: string; videoDir?: string }>
            fetchPlaylistEntries: (playlistUrl: string) => Promise<{ success: boolean; entries?: { id: string; title: string | null; url: string; thumbnailUrl: string; uploadDate: string | null }[]; playlistId?: string; message?: string }>
            enrichPlaylistEntry: (payload: { playlistId: string; videoId: string; title?: string | null; uploadDate?: string | null; thumbnailUrl?: string | null }) => Promise<{ success: boolean; message?: string }>
            listPlaylists: () => Promise<{ playlists: PlaylistSummary[] }>
            getPlaylist: (playlistId: string) => Promise<{ playlist: PlaylistSnapshot | null }>
            refreshPlaylist: (playlistId: string) => Promise<{ success: boolean; added?: number; removed?: number; updated?: number; lastRefreshedEpoch?: number; entries?: PlaylistEntry[]; message?: string }>
            undoPlaylistRefresh: (playlistId: string) => Promise<{ success: boolean; metadata?: PlaylistSnapshot; message?: string }>
            deletePlaylist: (playlistId: string) => Promise<{ success: boolean; message?: string }>
            recordLibraryDownload: (payload: { videoDir: string; epoch: string; filePath: string; resolution: string; format?: string; kind?: 'video' | 'audio' }) => Promise<{ success: boolean }>
            swapLibraryDownload: (payload: { videoDir: string; epoch: string; tempFilePath: string; oldFilePath: string | null; resolution: string; format?: string; kind?: 'video' | 'audio' }) => Promise<LibraryVideoMetadata>
            deleteLibraryEntry: (videoDir: string, epoch?: string) => Promise<{ success: boolean; videoDeleted: boolean }>
            deleteLibraryEntries: (videoDirs: string[]) => Promise<{ success: boolean; results: { videoDir: string; success: boolean; error?: string }[] }>
            deleteLocalFiles: (videoDirs: string[]) => Promise<{ success: boolean; results: { videoDir: string; success: boolean; error?: string }[] }>
            onLibraryBackgroundUpdate: (callback: () => void) => void
            removeLibraryBackgroundUpdateListener: () => void
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
