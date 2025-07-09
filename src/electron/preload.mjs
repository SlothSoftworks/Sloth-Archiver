import { contextBridge, ipcRenderer } from 'electron';
//const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
    pickFolder: (options) => ipcRenderer.invoke('dialog:openFolder', options),
    saveVideoFile: (defaultName, format, options) => ipcRenderer.invoke('dialog:saveVideoFile', defaultName, format, options),
    getVideoInfoPython: (url, options) => ipcRenderer.invoke('getVideoInfoPython', url, options),
    downloadVideoPython: (args) => ipcRenderer.invoke('downloadVideoPython', args),
});
