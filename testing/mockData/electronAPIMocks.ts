import { videoResponseMock } from './pythonResponseMocks.ts';

export const noop = () => {};

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
    pickFolder: noop,
    downloadVideoPython: noop,
    saveVideoFile: noop,
    getVideoInfoPython: noop,
    openDirectory: noop,
    openFileInDirectory: noop,
    openFileExternally: noop,
    saveCookie: async () => ({ success: true, cookieCount: 0, skipped: 0 }),
    deleteCookie: async () => ({ success: true }),
    getCookieStatus: async () => ({ loaded: false, cookieCount: 0 }),
    getDownloadDir: async () => ({ downloadDir: '' }),
    setDownloadDir: async () => ({ success: true, downloadDir: '' }),
    checkFileExists: async () => false,
    checkForYtdlpUpdate: async () => ({ current: '', latest: '', updateAvailable: false }),
    startYtdlpUpdate: async () => ({ success: true, version: '' }),
    onYtdlpUpdateProgress: noop,
    removeYtdlpUpdateProgressListener: noop,
    quitApp: noop,
    getAppVersion: async () => '0.0.0',
    deleteVideoInfoCacheEntry: async () => ({ success: true, existed: false }),
    getLibraryDir: async () => ({ libraryDir: '' }),
    setLibraryDir: async () => ({ success: true, libraryDir: '' }),
    getThemeMode: async () => ({ themeMode: 'light' }),
    setThemeMode: async () => ({ success: true, themeMode: 'light' }),
    getCustomConvertFormats: async () => ({ customConvertFormats: [] }),
    setCustomConvertFormats: async () => ({ success: true, customConvertFormats: [] }),
    getMaxSimultaneousDownloads: async () => ({ maxSimultaneousDownloads: 1 }),
    setMaxSimultaneousDownloads: async () => ({ success: true, maxSimultaneousDownloads: 1 }),
    getLibraryIndex: async () => ({ channels: [] }),
    refreshLibraryIndex: async () => ({ channels: [] }),
    refreshChannelIcon: async () => ({ channels: [] }),
    addLibraryEntry: async () => ({ success: true, videoDir: '', epoch: '' }),
    overrideLibraryEntry: async () => ({ success: true, videoDir: '' }),
    addLibraryVersion: async () => ({ success: true, videoDir: '', epoch: '', metadata: {} }),
    refreshLibraryEntry: async () => ({ success: true, metadata: {} }),
    findLibraryVideo: async () => ({ found: false }),
    fetchPlaylistEntries: async () => ({ success: true, entries: [] }),
    enrichPlaylistEntry: async () => ({ success: true }),
    listPlaylists: async () => ({ playlists: [] }),
    getPlaylist: async () => ({ playlist: null }),
    refreshPlaylist: async () => ({ success: true, added: 0, removed: 0, updated: 0, entries: [] }),
    undoPlaylistRefresh: async () => ({ success: true }),
    deletePlaylist: async () => ({ success: true }),
    recordLibraryDownload: async () => ({ success: true }),
    swapLibraryDownload: async () => ({}),
    deleteLibraryEntry: async () => ({ success: true, videoDeleted: true }),
    onLibraryBackgroundUpdate: noop,
    removeLibraryBackgroundUpdateListener: noop,
    saveExportedFile: async () => ({ canceled: true }),
    extractMp3FromFile: async () => ({ success: true }),
    convertFileFormat: async () => ({ success: true }),
    extractClipFromFile: async () => ({ success: true }),
    embedFileMetadata: async () => ({ success: true }),
    onFfmpegUtilityProgress: noop,
    removeFfmpegUtilityProgressListener: noop,
    reportRendererError: noop,
    getErrorLogInfo: async () => ({ exists: false, path: '' }),
    openErrorLog: noop,

}

export const electronAPIPythonDownloadMock = {
    startDownloadPython: noop,
    onProgressUpdate: noop,
    removeProgressListener: noop,
    cancelDownload: noop,
}