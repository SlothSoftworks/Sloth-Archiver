import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path'


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, '../../yt-archiver-dist/index.html')

app.on("ready", () => {
    const mainWindow = new BrowserWindow({
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            contextIsolation: true, // TODO change to true on MVP
            nodeIntegration: true, // TODO change to false on MVP
        },
    });
    //mainWindow.loadFile(path.join(app.getAppPath(), 'yt-archiver-dist/index.html')); // OLD loadFile before chaning to __dirname
    mainWindow.loadFile(indexPath);
})

ipcMain.handle('dialog:openFolder', async () => dialog.showOpenDialog({
    properties: ['openDirectory'],
}))
