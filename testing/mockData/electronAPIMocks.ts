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

}

export const electronAPIPythonDownloadMock = {
    startDownloadPython: noop,
    onProgressUpdate: noop,
    removeProgressListener: noop,
}