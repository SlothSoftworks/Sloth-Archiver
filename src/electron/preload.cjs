// CommonJS, not ESM like the rest of this app's Electron code -- Electron's
// sandboxed preload environment (sandbox: true) loads the preload script
// through its own lightweight script loader, which only understands
// require()/module.exports, not import/export syntax. A '.mjs' preload
// throws "Cannot use import statement outside a module" the moment the
// window opens under a sandboxed BrowserWindow.
const { contextBridge, ipcRenderer } = require('electron');

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
    getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
    getFfmpegVersion: () => ipcRenderer.invoke('system:getFfmpegVersion'),
    deleteVideoInfoCacheEntry: (url) => ipcRenderer.invoke('videoInfoCache:deleteEntry', url),
    getLibraryDir: () => ipcRenderer.invoke('settings:getLibraryDir'),
    setLibraryDir: (dir) => ipcRenderer.invoke('settings:setLibraryDir', dir),
    listLibraryTags: () => ipcRenderer.invoke('library:listTags'),
    createLibraryTag: (name) => ipcRenderer.invoke('library:createTag', name),
    listVideoTags: () => ipcRenderer.invoke('library:listVideoTags'),
    setVideoTag: (tagName, videoId, applied) => ipcRenderer.invoke('library:setVideoTag', { tagName, videoId, applied }),
    tagVideos: (videoIds, tagName) => ipcRenderer.invoke('library:tagVideos', { videoIds, tagName }),
    getActiveLibraryTag: () => ipcRenderer.invoke('settings:getActiveLibraryTag'),
    setActiveLibraryTag: (tag) => ipcRenderer.invoke('settings:setActiveLibraryTag', tag),
    getLibraryViewMode: () => ipcRenderer.invoke('settings:getLibraryViewMode'),
    setLibraryViewMode: (mode) => ipcRenderer.invoke('settings:setLibraryViewMode', mode),
    getLibrarySort: () => ipcRenderer.invoke('settings:getLibrarySort'),
    setLibrarySort: (payload) => ipcRenderer.invoke('settings:setLibrarySort', payload),
    getThemeMode: () => ipcRenderer.invoke('settings:getThemeMode'),
    setThemeMode: (mode) => ipcRenderer.invoke('settings:setThemeMode', mode),
    getCustomConvertFormats: () => ipcRenderer.invoke('settings:getCustomConvertFormats'),
    setCustomConvertFormats: (formats) => ipcRenderer.invoke('settings:setCustomConvertFormats', formats),
    getMaxSimultaneousDownloads: () => ipcRenderer.invoke('settings:getMaxSimultaneousDownloads'),
    setMaxSimultaneousDownloads: (value) => ipcRenderer.invoke('settings:setMaxSimultaneousDownloads', value),
    getThumbnailSize: () => ipcRenderer.invoke('settings:getThumbnailSize'),
    setThumbnailSize: (value) => ipcRenderer.invoke('settings:setThumbnailSize', value),
    getLibraryIndex: () => ipcRenderer.invoke('library:getIndex'),
    refreshLibraryIndex: () => ipcRenderer.invoke('library:refreshIndex'),
    refreshChannelIcon: (payload) => ipcRenderer.invoke('library:refreshChannelIcon', payload),
    addLibraryEntry: (videoMetaData, targetTag) => ipcRenderer.invoke('library:addEntry', videoMetaData, targetTag),
    overrideLibraryEntry: (videoMetaData, existingVideoDir, targetTag) => ipcRenderer.invoke('library:overrideEntry', { videoMetaData, existingVideoDir }, targetTag),
    addLibraryVersion: (videoMetaData, videoDir) => ipcRenderer.invoke('library:addVersion', { videoMetaData, videoDir }),
    refreshLibraryEntry: (videoDir, epoch, videoMetaData) => ipcRenderer.invoke('library:refreshEntry', { videoDir, epoch, videoMetaData }),
    checkAndRepairEpochFiles: (videoDir, epoch) => ipcRenderer.invoke('library:checkAndRepairEpochFiles', { videoDir, epoch }),
    findLibraryVideo: (videoId, libraryTag) => ipcRenderer.invoke('library:findVideo', videoId, libraryTag),
    fetchPlaylistEntries: (playlistUrl) => ipcRenderer.invoke('library:fetchPlaylistEntries', playlistUrl),
    enrichPlaylistEntry: (payload) => ipcRenderer.invoke('library:enrichPlaylistEntry', payload),
    listPlaylists: () => ipcRenderer.invoke('library:listPlaylists'),
    getPlaylist: (playlistId) => ipcRenderer.invoke('library:getPlaylist', playlistId),
    refreshPlaylist: (playlistId) => ipcRenderer.invoke('library:refreshPlaylist', playlistId),
    undoPlaylistRefresh: (playlistId) => ipcRenderer.invoke('library:undoPlaylistRefresh', playlistId),
    deletePlaylist: (playlistId) => ipcRenderer.invoke('library:deletePlaylist', playlistId),
    recordLibraryDownload: (payload) => ipcRenderer.invoke('library:recordDownload', payload),
    swapLibraryDownload: (payload) => ipcRenderer.invoke('library:swapDownload', payload),
    deleteLibraryEntry: (videoDir, epoch) => ipcRenderer.invoke('library:deleteEntry', { videoDir, epoch }),
    deleteLibraryEntries: (videoDirs) => ipcRenderer.invoke('library:deleteEntries', { videoDirs }),
    moveLibraryEntries: (videoDirs, targetTag) => ipcRenderer.invoke('library:moveEntries', { videoDirs, targetTag }),
    deleteLocalFiles: (videoDirs) => ipcRenderer.invoke('library:deleteLocalFiles', { videoDirs }),
    onLibraryBackgroundUpdate: (callback) => ipcRenderer.on('library:backgroundUpdate', () => callback()),
    removeLibraryBackgroundUpdateListener: () => ipcRenderer.removeAllListeners('library:backgroundUpdate'),
    saveExportedFile: (payload) => ipcRenderer.invoke('dialog:saveExportedFile', payload),
    extractMp3FromFile: (payload) => ipcRenderer.invoke('library:extractMp3', payload),
    convertFileFormat: (payload) => ipcRenderer.invoke('library:convertFormat', payload),
    ensurePlayablePreview: (payload) => ipcRenderer.invoke('library:ensurePlayablePreview', payload),
    onPreviewGenerationProgress: (callback) => ipcRenderer.on('previewGenerationProgress', (_event, data) => callback(data)),
    removePreviewGenerationProgressListener: () => ipcRenderer.removeAllListeners('previewGenerationProgress'),
    extractClipFromFile: (payload) => ipcRenderer.invoke('library:extractClip', payload),
    createClip: (payload) => ipcRenderer.invoke('library:createClip', payload),
    getClips: (payload) => ipcRenderer.invoke('library:getClips', payload),
    deleteClip: (payload) => ipcRenderer.invoke('library:deleteClip', payload),
    convertClip: (payload) => ipcRenderer.invoke('library:convertClip', payload),
    embedFileMetadata: (payload) => ipcRenderer.invoke('library:embedMetadata', payload),
    onFfmpegUtilityProgress: (callback) => ipcRenderer.on('ffmpegUtilityProgress', (_event, data) => callback(data)),
    removeFfmpegUtilityProgressListener: () => ipcRenderer.removeAllListeners('ffmpegUtilityProgress'),
    reportRendererError: (payload) => ipcRenderer.invoke('errorLog:report', payload),
    getErrorLogInfo: () => ipcRenderer.invoke('errorLog:getInfo'),
    openErrorLog: () => ipcRenderer.invoke('errorLog:open'),
});

contextBridge.exposeInMainWorld('electronAPIPythonDownload', {
    startDownloadPython: (options) => ipcRenderer.invoke('downloadVideoWithProgressUpdates', options),
    cancelDownload: (requestId) => ipcRenderer.invoke('cancelDownload', requestId),
    // Returns the actual listener function that got attached so
    // removeProgressListener can remove just this one -- multiple
    // useDownloadVideo() instances can be mounted at once (manual download,
    // Library-view download, the always-mounted bulk-add queue), all on this
    // same shared 'progressUpdate' channel, and removeAllListeners would
    // silently kill every other instance's listener too the moment any one
    // of them unmounts.
    onProgressUpdate: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('progressUpdate', listener);
        return listener;
    },
    removeProgressListener: (listener) => ipcRenderer.removeListener('progressUpdate', listener),
});
