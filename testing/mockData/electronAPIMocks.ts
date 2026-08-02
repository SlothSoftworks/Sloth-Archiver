export const noop = () => {};

export const electronAPIMock = {
    pickFolder: noop,
    downloadVideoPython: noop,
    saveVideoFile: noop,
    getVideoInfoPython: noop,
    openDirectory: noop,
    openFileInDirectory: noop,
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
    deleteVideoInfoCacheEntry: async () => ({ success: true, existed: false }),
    getLibraryDir: async () => ({ libraryDir: '' }),
    setLibraryDir: async () => ({ success: true, libraryDir: '' }),
    getLibraryIndex: async () => ({ channels: [] }),
    refreshLibraryIndex: async () => ({ channels: [] }),
    addLibraryEntry: async () => ({ success: true, videoDir: '' }),
    overrideLibraryEntry: async () => ({ success: true, videoDir: '' }),
    findLibraryVideo: async () => ({ found: false }),
    recordLibraryDownload: async () => ({ success: true }),
    deleteLibraryEntry: async () => ({ success: true }),
    reportRendererError: noop,
    getErrorLogInfo: async () => ({ exists: false, path: '' }),
    openErrorLog: noop,

}

export const electronAPIPythonDownloadMock = {
    startDownloadPython: noop,
    onProgressUpdate: noop,
    removeProgressListener: noop,
}