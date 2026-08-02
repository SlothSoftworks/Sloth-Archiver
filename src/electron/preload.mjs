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
});

contextBridge.exposeInMainWorld('electronAPIPythonDownload', {
    startDownloadPython: (options) => ipcRenderer.invoke('downloadVideoWithProgressUpdates', options),
    onProgressUpdate: (callback) => ipcRenderer.on('progressUpdate', (_event, data) => callback(data)),
    removeProgressListener: () => ipcRenderer.removeAllListeners('progressUpdate')
});

