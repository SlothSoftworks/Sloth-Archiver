export const noop = () => {};

export const electronAPIMock = {
    pickFolder: noop,
    downloadVideoPython: noop,
    saveVideoFile: noop,
    getVideoInfoPython: noop,
    openDirectory: noop,
    openFileInDirectory: noop,

}

export const electronAPIPythonDownloadMock = {
    startDownloadPython: noop,
    onProgressUpdate: noop,
    removeProgressListener: noop,
}