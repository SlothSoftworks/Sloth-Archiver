import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path'
import { spawn } from 'child_process';

import { getSupportedVideoFilters } from '../utils/constants.mjs';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, '../../yt-archiver-dist/index.html');
const pythonPath = path.resolve(__dirname, '../python');

app.on("ready", () => {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            contextIsolation: true, // TODO change to true on MVP
            nodeIntegration: true, // TODO change to false on MVP
        },
    });
    mainWindow.loadFile(indexPath);
    mainWindow.webContents.openDevTools(); // For startup with devtools
})

ipcMain.handle('dialog:openFolder', async (e, options) => dialog.showOpenDialog({
    properties: ['openDirectory'],
    ...options
}));

ipcMain.handle('dialog:saveVideoFile', async (e, defaultName = 'ytVid', format = 'mp4', options) => dialog.showSaveDialog({
    title: 'Save Video',
    buttonLabel: 'Save',
    defaultPath: `${app.getPath('downloads')}/${defaultName}.${format}`,
    filters: getSupportedVideoFilters(),
    ...options
}))


ipcMain.handle('downloadVideoPython', async (event, args) => {
    return new Promise((resolve, reject) => {
        const script = spawn('python3', [path.join(pythonPath, "vidDownloader.py"), JSON.stringify(args) ]);

        let result = "";
        script.stdout.on('data', (data) => {
            result += data.toString();
        });
        script.stderr.on('data', err => {
            console.error('Python Error:', err.toString());
        });

        script.on('close', () => {
            resolve(result);
        });
    });
});