import { videoResponseMock } from './pythonResponseMocks.ts';
import type { LibraryVideoMetadata } from '../../src/types.ts';

export const noop = () => {};

const emptyLibraryVideoMetadata: LibraryVideoMetadata = {
  videoId: '',
  channelId: null,
  channel: null,
  title: null,
  fullTitle: null,
  description: null,
  thumbnail: null,
  originalUrl: null,
  duration: null,
  durationString: null,
  uploadDate: null,
  addedEpoch: 0,
  downloadedFilePath: null,
  downloadedResolution: null,
  downloadedFormat: null,
  downloadedAudioFilePath: null,
};

// DownloaderScreen seeds its initial videoInfo state from this in dev-mock
// mode (App.tsx's electronAPI fallback, see there) so previewing it in a
// plain browser shows something instead of an empty form. window.mockingElectron
// has no global type declaration (App.tsx sets it dynamically) -- same cast
// used in App.test.tsx.
export function getInitialDownloaderVideoInfo() {
  const mocking = (window as unknown as { mockingElectron?: unknown }).mockingElectron;
  return mocking === 'yes' ? videoResponseMock.data.response : null;
}

export const electronAPIMock = {
    pickFolder: async () => ({ filePaths: [], canceled: true }),
    saveVideoFile: async () => ({ filePath: '', canceled: true }),
    getVideoInfoPython: async () => ({}),
    openDirectory: async () => ({}),
    openFileInDirectory: async () => ({}),
    openFileExternally: async () => {},
    saveCookie: async () => ({ success: true, cookieCount: 0, skipped: 0 }),
    deleteCookie: async () => ({ success: true }),
    getCookieStatus: async () => ({ loaded: false, cookieCount: 0 }),
    getCookiesConfig: async () => ({ cookiesMode: 'file' as const, cookiesBrowser: '', supportedBrowsers: [] }),
    setCookiesConfig: async () => ({ success: true, cookiesMode: 'file' as const, cookiesBrowser: '' }),
    getDownloadDir: async () => ({ downloadDir: '' }),
    setDownloadDir: async () => ({ success: true, downloadDir: '' }),
    checkFileExists: async () => false,
    checkForYtdlpUpdate: async () => ({ current: '', latest: '', updateAvailable: false }),
    startYtdlpUpdate: async () => ({ success: true, version: '' }),
    onYtdlpUpdateProgress: noop,
    removeYtdlpUpdateProgressListener: noop,
    quitApp: async () => {},
    getAppVersion: async () => '0.0.0',
    deleteVideoInfoCacheEntry: async () => ({ success: true, existed: false }),
    getLibraryDir: async () => ({ libraryDir: '' }),
    setLibraryDir: async () => ({ success: true, libraryDir: '' }),
    getLibraryViewMode: async () => ({ libraryViewMode: 'channel' as const }),
    setLibraryViewMode: async () => ({ success: true, libraryViewMode: 'channel' as const }),
    getThemeMode: async () => ({ themeMode: 'light' as const }),
    setThemeMode: async () => ({ success: true, themeMode: 'light' as const }),
    getCustomConvertFormats: async () => ({ customConvertFormats: [] }),
    setCustomConvertFormats: async () => ({ success: true, customConvertFormats: [] }),
    getMaxSimultaneousDownloads: async () => ({ maxSimultaneousDownloads: 1 }),
    setMaxSimultaneousDownloads: async () => ({ success: true, maxSimultaneousDownloads: 1 }),
    getThumbnailSize: async () => ({ thumbnailSize: 0 }),
    setThumbnailSize: async () => ({ success: true, thumbnailSize: 0 }),
    getLibraryIndex: async () => ({ channels: [] }),
    refreshLibraryIndex: async () => ({ channels: [] }),
    refreshChannelIcon: async () => ({ channels: [] }),
    addLibraryEntry: async () => ({ success: true, videoDir: '', epoch: '' }),
    overrideLibraryEntry: async () => ({ success: true, videoDir: '' }),
    addLibraryVersion: async () => ({ success: true, videoDir: '', epoch: '', metadata: emptyLibraryVideoMetadata }),
    refreshLibraryEntry: async () => ({ success: true, metadata: emptyLibraryVideoMetadata }),
    findLibraryVideo: async () => ({ found: false }),
    fetchPlaylistEntries: async () => ({ success: true, entries: [] }),
    enrichPlaylistEntry: async () => ({ success: true }),
    listPlaylists: async () => ({ playlists: [] }),
    getPlaylist: async () => ({ playlist: null }),
    refreshPlaylist: async () => ({ success: true, added: 0, removed: 0, updated: 0, entries: [] }),
    undoPlaylistRefresh: async () => ({ success: true }),
    deletePlaylist: async () => ({ success: true }),
    recordLibraryDownload: async () => ({ success: true }),
    swapLibraryDownload: async () => (emptyLibraryVideoMetadata),
    deleteLibraryEntry: async () => ({ success: true, videoDeleted: true }),
    deleteLibraryEntries: async () => ({ success: true, results: [] }),
    deleteLocalFiles: async () => ({ success: true, results: [] }),
    onLibraryBackgroundUpdate: noop,
    removeLibraryBackgroundUpdateListener: noop,
    saveExportedFile: async () => ({ canceled: true }),
    extractMp3FromFile: async () => ({ success: true }),
    convertFileFormat: async () => ({ success: true }),
    extractClipFromFile: async () => ({ success: true }),
    createClip: async () => ({ success: true }),
    getClips: async () => ({ success: true, clips: [] }),
    deleteClip: async () => ({ success: true }),
    convertClip: async () => ({ success: true }),
    embedFileMetadata: async () => ({ success: true }),
    onFfmpegUtilityProgress: noop,
    removeFfmpegUtilityProgressListener: noop,
    ensurePlayablePreview: async () => ({ success: true, previewPath: '/mock/preview.mp4', generated: false }),
    onPreviewGenerationProgress: noop,
    removePreviewGenerationProgressListener: noop,
    reportRendererError: async () => {},
    getErrorLogInfo: async () => ({ exists: false, path: '' }),
    openErrorLog: async () => {},

}

export const electronAPIPythonDownloadMock = {
    startDownloadPython: async () => ({}),
    onProgressUpdate: noop,
    removeProgressListener: noop,
    cancelDownload: async () => ({ cancelled: true }),
}