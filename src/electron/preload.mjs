import { contextBridge, ipcRenderer } from 'electron';
//const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
    pickFolder: (options) => ipcRenderer.invoke('dialog:openFolder', options),
    saveVideoFile: (defaultName, format, options) => ipcRenderer.invoke('dialog:saveVideoFile', defaultName, format, options),
    getVideoInfoPython: (url, options) => ipcRenderer.invoke('getVideoInfoPython', url, options),
    openDirectory: (path) => ipcRenderer.invoke('system:openDirectory', path),
    openFileInDirectory: (filePath) => ipcRenderer.invoke('system:openFileInDirectory', filePath),
    openFileExternally: (filePath) => ipcRenderer.invoke('system:openFileExternally', filePath),
    saveCookie: (cookieText) => ipcRenderer.invoke('cookies:save', cookieText),
    deleteCookie: () => ipcRenderer.invoke('cookies:delete'),
    getCookieStatus: () => ipcRenderer.invoke('cookies:status'),
    getCookiesConfig: () => ipcRenderer.invoke('cookies:getConfig'),
    setCookiesConfig: (payload) => ipcRenderer.invoke('cookies:setConfig', payload),
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
    getLibraryViewMode: () => ipcRenderer.invoke('settings:getLibraryViewMode'),
    setLibraryViewMode: (mode) => ipcRenderer.invoke('settings:setLibraryViewMode', mode),
    getThemeMode: () => ipcRenderer.invoke('settings:getThemeMode'),
    setThemeMode: (mode) => ipcRenderer.invoke('settings:setThemeMode', mode),
    getCustomConvertFormats: () => ipcRenderer.invoke('settings:getCustomConvertFormats'),
    setCustomConvertFormats: (formats) => ipcRenderer.invoke('settings:setCustomConvertFormats', formats),
    getMaxSimultaneousDownloads: () => ipcRenderer.invoke('settings:getMaxSimultaneousDownloads'),
    setMaxSimultaneousDownloads: (value) => ipcRenderer.invoke('settings:setMaxSimultaneousDownloads', value),
    getLibraryIndex: () => ipcRenderer.invoke('library:getIndex'),
    refreshLibraryIndex: () => ipcRenderer.invoke('library:refreshIndex'),
    refreshChannelIcon: (payload) => ipcRenderer.invoke('library:refreshChannelIcon', payload),
    addLibraryEntry: (videoMetaData) => ipcRenderer.invoke('library:addEntry', videoMetaData),
    overrideLibraryEntry: (videoMetaData, existingVideoDir) => ipcRenderer.invoke('library:overrideEntry', { videoMetaData, existingVideoDir }),
    addLibraryVersion: (videoMetaData, videoDir) => ipcRenderer.invoke('library:addVersion', { videoMetaData, videoDir }),
    findLibraryVideo: (videoId) => ipcRenderer.invoke('library:findVideo', videoId),
    fetchPlaylistEntries: (playlistUrl) => ipcRenderer.invoke('library:fetchPlaylistEntries', playlistUrl),
    enrichPlaylistEntry: (payload) => ipcRenderer.invoke('library:enrichPlaylistEntry', payload),
    listPlaylists: () => ipcRenderer.invoke('library:listPlaylists'),
    getPlaylist: (playlistId) => ipcRenderer.invoke('library:getPlaylist', playlistId),
    refreshPlaylist: (playlistId) => ipcRenderer.invoke('library:refreshPlaylist', playlistId),
    undoPlaylistRefresh: (playlistId) => ipcRenderer.invoke('library:undoPlaylistRefresh', playlistId),
    recordLibraryDownload: (payload) => ipcRenderer.invoke('library:recordDownload', payload),
    swapLibraryDownload: (payload) => ipcRenderer.invoke('library:swapDownload', payload),
    deleteLibraryEntry: (videoDir, epoch) => ipcRenderer.invoke('library:deleteEntry', { videoDir, epoch }),
    onLibraryBackgroundUpdate: (callback) => ipcRenderer.on('library:backgroundUpdate', () => callback()),
    removeLibraryBackgroundUpdateListener: () => ipcRenderer.removeAllListeners('library:backgroundUpdate'),
    saveExportedFile: (payload) => ipcRenderer.invoke('dialog:saveExportedFile', payload),
    extractMp3FromFile: (payload) => ipcRenderer.invoke('library:extractMp3', payload),
    convertFileFormat: (payload) => ipcRenderer.invoke('library:convertFormat', payload),
    extractClipFromFile: (payload) => ipcRenderer.invoke('library:extractClip', payload),
    embedFileMetadata: (payload) => ipcRenderer.invoke('library:embedMetadata', payload),
    onFfmpegUtilityProgress: (callback) => ipcRenderer.on('ffmpegUtilityProgress', (_event, data) => callback(data)),
    removeFfmpegUtilityProgressListener: () => ipcRenderer.removeAllListeners('ffmpegUtilityProgress'),
    reportRendererError: (payload) => ipcRenderer.invoke('errorLog:report', payload),
    getErrorLogInfo: () => ipcRenderer.invoke('errorLog:getInfo'),
    openErrorLog: () => ipcRenderer.invoke('errorLog:open'),
});

contextBridge.exposeInMainWorld('electronAPIPythonDownload', {
    startDownloadPython: (options) => ipcRenderer.invoke('downloadVideoWithProgressUpdates', options),
    // Returns the actual listener function that got attached so
    // removeProgressListener can remove just this one -- multiple
    // useDownloadVideo() instances can be mounted at once (manual download,
    // Library-view download, the always-mounted bulk-add queue), all on this
    // same shared 'progressUpdate' channel, and removeAllListeners would
    // silently kill every other instance's listener too the moment any one
    // of them unmounts (the actual bug this fixes -- see TD-008).
    onProgressUpdate: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('progressUpdate', listener);
        return listener;
    },
    removeProgressListener: (listener) => ipcRenderer.removeListener('progressUpdate', listener),
});

