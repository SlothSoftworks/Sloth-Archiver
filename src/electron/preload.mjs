import { contextBridge, ipcRenderer } from 'electron';
//const { contextBridge, ipcRenderer } = require('electron');

console.log("ONEGAISHIMASU")

contextBridge.exposeInMainWorld('electronAPI', {
    pickFolder: () => ipcRenderer.invoke('dialog:openFolder'),
})