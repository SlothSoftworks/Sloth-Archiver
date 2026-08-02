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
    downloadedFilePath: string | null;
    downloadedResolution: string | null;
    downloadedFormat: string | null;
};

type LibraryIndex = {
    channels: {
        channelFolderName: string;
        displayName: string;
        videos: {
            videoFolderName: string;
            videoDir: string;
            latestEpoch: string | null;
            metadata: LibraryVideoMetadata;
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
            saveCookie: (cookieText: string) => Promise<{ success: boolean; cookieCount: number; skipped: number }>
            deleteCookie: () => Promise<{ success: boolean }>
            getCookieStatus: () => Promise<{ loaded: boolean; cookieCount: number }>
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
            getLibraryIndex: () => Promise<LibraryIndex>
            refreshLibraryIndex: () => Promise<LibraryIndex>
            addLibraryEntry: (videoMetaData: T) => Promise<{ success: boolean; videoDir: string }>
            overrideLibraryEntry: (videoMetaData: T, existingVideoDir: string) => Promise<{ success: boolean; videoDir: string }>
            findLibraryVideo: (videoId: string) => Promise<{ found: boolean; channelDisplayName?: string; videoDir?: string }>
        };
        electronAPIPythonDownload: {
            startDownloadPython: (options: T) => Promise<T>;
            onProgressUpdate: (option: T) => Promise<T>;
            removeProgressListener: () => void;
        }
    }
}
