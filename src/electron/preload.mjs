import { contextBridge, ipcRenderer } from 'electron';
//const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
    pickFolder: (options) => ipcRenderer.invoke('dialog:openFolder', options),
    saveVideoFile: (defaultName, format, options) => ipcRenderer.invoke('dialog:saveVideoFile', defaultName, format, options),
    getVideoInfoPython: (url, options) => ipcRenderer.invoke('getVideoInfoPython', url, options),
    openDirectory: (path) => ipcRenderer.invoke('system:openDirectory', path),
    openFileInDirectory: (filePath) => ipcRenderer.invoke('system:openFileInDirectory', filePath),
    saveCookie: (cookieText) => ipcRenderer.invoke('cookies:save', cookieText),
    deleteCookie: () => ipcRenderer.invoke('cookies:delete'),
    getCookieStatus: () => ipcRenderer.invoke('cookies:status'),
    getDownloadDir: () => ipcRenderer.invoke('settings:getDownloadDir'),
    setDownloadDir: (dir) => ipcRenderer.invoke('settings:setDownloadDir', dir),
    checkFileExists: (filePath) => ipcRenderer.invoke('system:pathExists', filePath),
    checkForYtdlpUpdate: () => ipcRenderer.invoke('ytdlp:checkForUpdate'),
    startYtdlpUpdate: () => ipcRenderer.invoke('ytdlp:startUpdate'),
    onYtdlpUpdateProgress: (callback) => ipcRenderer.on('ytdlpUpdateProgress', (_event, data) => callback(data)),
    removeYtdlpUpdateProgressListener: () => ipcRenderer.removeAllListeners('ytdlpUpdateProgress'),
    quitApp: () => ipcRenderer.invoke('app:quit'),
    deleteVideoInfoCacheEntry: (url) => ipcRenderer.invoke('videoInfoCache:deleteEntry', url),
    getLibraryDir: () => ipcRenderer.invoke('settings:getLibraryDir'),
    setLibraryDir: (dir) => ipcRenderer.invoke('settings:setLibraryDir', dir),
    getLibraryIndex: () => ipcRenderer.invoke('library:getIndex'),
    refreshLibraryIndex: () => ipcRenderer.invoke('library:refreshIndex'),
    addLibraryEntry: (videoMetaData) => ipcRenderer.invoke('library:addEntry', videoMetaData),
    overrideLibraryEntry: (videoMetaData, existingVideoDir) => ipcRenderer.invoke('library:overrideEntry', { videoMetaData, existingVideoDir }),
    findLibraryVideo: (videoId) => ipcRenderer.invoke('library:findVideo', videoId),
    recordLibraryDownload: (payload) => ipcRenderer.invoke('library:recordDownload', payload),
    deleteLibraryEntry: (videoDir) => ipcRenderer.invoke('library:deleteEntry', videoDir),
    reportRendererError: (payload) => ipcRenderer.invoke('errorLog:report', payload),
    getErrorLogInfo: () => ipcRenderer.invoke('errorLog:getInfo'),
    openErrorLog: () => ipcRenderer.invoke('errorLog:open'),
});

contextBridge.exposeInMainWorld('electronAPIPythonDownload', {
    startDownloadPython: (options) => ipcRenderer.invoke('downloadVideoWithProgressUpdates', options),
    onProgressUpdate: (callback) => ipcRenderer.on('progressUpdate', (_event, data) => callback(data)),
    removeProgressListener: () => ipcRenderer.removeAllListeners('progressUpdate')
});

