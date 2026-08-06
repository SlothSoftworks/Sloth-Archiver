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

type LibraryVideoMetadata = {
    schemaVersion: number;
    videoId: string;
    channelId: string | null;
    channel: string | null;
    title: string | null;
    fullTitle: string | null;
    description: string | null;
    thumbnail: string | null;
    originalUrl: string | null;
    duration: number | null;
    durationString: string | null;
    uploadDate: string | null;
    addedEpoch: number;
    resolutions: { resolution: string; filesizeMb: string }[];
    downloadedFilePath: string | null;
    downloadedResolution: string | null;
    downloadedFormat: string | null;
    downloadedAudioFilePath: string | null;
};

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
        }[];
    }[];
};

declare global {
    interface Window {
        electronAPI: {
            pickFolder: (options: T) => Promise <OpenFolderResult>;
            saveVideoFile: (defaultName?: string) => Promise <FolderPickerResult>;
            getVideoInfoPython: (url: string, options?: T) => Promise <T>
            openDirectory: (path: string) => Promise<T>
            openFileInDirectory: (filePath: string) => Promise<T>
            openFileExternally: (filePath: string) => Promise<void>
            saveCookie: (cookieText: string) => Promise<{ success: boolean; cookieCount: number; skipped: number }>
            deleteCookie: () => Promise<{ success: boolean }>
            getCookieStatus: () => Promise<{ loaded: boolean; cookieCount: number }>
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
            deleteVideoInfoCacheEntry: (url: string) => Promise<{ success: boolean; existed: boolean }>
            getLibraryDir: () => Promise<{ libraryDir: string }>
            setLibraryDir: (dir: string) => Promise<{ success: boolean; libraryDir: string }>
            getLibraryViewMode: () => Promise<{ libraryViewMode: 'channel' | 'video' }>
            setLibraryViewMode: (mode: 'channel' | 'video') => Promise<{ success: boolean; libraryViewMode: 'channel' | 'video' }>
            getThemeMode: () => Promise<{ themeMode: 'light' | 'dark' }>
            setThemeMode: (mode: 'light' | 'dark') => Promise<{ success: boolean; themeMode: 'light' | 'dark' }>
            getLibraryIndex: () => Promise<LibraryIndex>
            refreshLibraryIndex: () => Promise<LibraryIndex>
            refreshChannelIcon: (payload: { channelFolderName: string; channelId: string | null }) => Promise<LibraryIndex>
            addLibraryEntry: (videoMetaData: T) => Promise<{ success: boolean; videoDir: string; epoch: string }>
            overrideLibraryEntry: (videoMetaData: T, existingVideoDir: string) => Promise<{ success: boolean; videoDir: string }>
            addLibraryVersion: (videoMetaData: T, videoDir: string) => Promise<{ success: boolean; videoDir: string; epoch: string; metadata: LibraryVideoMetadata }>
            findLibraryVideo: (videoId: string) => Promise<{ found: boolean; channelDisplayName?: string; videoDir?: string }>
            fetchPlaylistEntries: (playlistUrl: string) => Promise<{ success: boolean; entries?: { id: string; title: string | null; url: string; thumbnailUrl: string; uploadDate: string | null }[]; playlistId?: string; message?: string }>
            enrichPlaylistEntry: (payload: { playlistId: string; videoId: string; title?: string | null; uploadDate?: string | null; thumbnailUrl?: string | null }) => Promise<{ success: boolean; message?: string }>
            recordLibraryDownload: (payload: { videoDir: string; epoch: string; filePath: string; resolution: string; format?: string; kind?: 'video' | 'audio' }) => Promise<{ success: boolean }>
            swapLibraryDownload: (payload: { videoDir: string; epoch: string; tempFilePath: string; oldFilePath: string | null; resolution: string; format?: string; kind?: 'video' | 'audio' }) => Promise<LibraryVideoMetadata>
            deleteLibraryEntry: (videoDir: string, epoch?: string) => Promise<{ success: boolean; videoDeleted: boolean }>
            onLibraryBackgroundUpdate: (callback: () => void) => void
            removeLibraryBackgroundUpdateListener: () => void
            reportRendererError: (payload: { message: string; stack?: string }) => Promise<void>
            getErrorLogInfo: () => Promise<{ exists: boolean; path: string }>
            openErrorLog: () => Promise<void>
        };
        electronAPIPythonDownload: {
            startDownloadPython: (options: T) => Promise<T>;
            onProgressUpdate: (option: T) => Promise<T>;
            removeProgressListener: () => void;
        }
    }
}
