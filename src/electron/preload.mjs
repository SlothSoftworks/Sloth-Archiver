import { contextBridge, ipcRenderer } from 'electron';
//const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
    pickFolder: (options) => ipcRenderer.invoke('dialog:openFolder', options),
    saveVideoFile: (defaultName, format, options) => ipcRenderer.invoke('dialog:saveVideoFile', defaultName, format, options),
    downloadVideoPython: (args) => ipcRenderer.invoke('downloadVideoPython', args),
});
