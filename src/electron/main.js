import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path'
import { spawn } from 'child_process';
import fs from "fs";

import { getSupportedVideoFilters } from './utils/constants.mjs';

const logFile = path.join(app.getPath("userData"), "main.log");
function log(...args) {
    const msg = args.map(String).join(" ");
    fs.appendFileSync(logFile, msg + "\n");
    console.log(msg);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

const indexPath = path.join(__dirname, '../renderer/index.html');
const devPythonDir = path.resolve(__dirname, '../../src/python');
const pyBinPath = isDev ? null : path.join(process.resourcesPath, 'python-bin', 'ytarchiver-py');
const ffmpegDir = isDev ? path.resolve(__dirname, '../ffmpeg') : path.join(process.resourcesPath, 'ffmpeg');

function spawnPython(subcommand, args) {
    if (isDev) {
        const scriptName = subcommand === 'info' ? 'vidInfoFetch.py' : 'vidDownloadWithProgressHook.py';
        return spawn('python3', [path.join(devPythonDir, scriptName), ...args]);
    }
    return spawn(pyBinPath, [subcommand, ...args]);
}

app.on("ready", () => {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    mainWindow.loadFile(indexPath);
    if (isDev) mainWindow.webContents.openDevTools();
})

ipcMain.handle('dialog:openFolder', async (e, options) => dialog.showOpenDialog({
    properties: ['openDirectory'],
    ...options
}));

ipcMain.handle('dialog:saveVideoFile', async (e, defaultName = 'ytVid', options) => dialog.showSaveDialog({
    title: 'Save Video',
    buttonLabel: 'Save',
    defaultPath: `${app.getPath('downloads')}/${defaultName}`,
    filters: getSupportedVideoFilters(),
    ...options
}))

ipcMain.handle('getVideoInfoPython', async (event, url, args={}) => {
    return new Promise((resolve, reject) => {
        const mergedArgs = { ...args, ffmpeg_location: ffmpegDir };
        const script = spawnPython('info', [url, JSON.stringify(mergedArgs)]);
        let data = '';
        let error = '';

        script.on('error', (err) => {
            reject(new Error(`Failed to start python process: ${err.message}`));
        });

        script.stdout.on('data', (output) => {
            data += output.toString();
        });
        script.stderr.on('data', err => {
            error += err.toString();
        });

        script.on('close', (code) => {

            if (code !== 0) {
                reject(new Error(error || `Python script failed with code ${code}`));
            } else {
                try {
                    resolve({success: true, data: JSON.parse(data)});
                } catch (e) {
                    reject(new Error('Failed to parse video data'));
                }
            }
        });
    });
});

ipcMain.handle('downloadVideoWithProgressUpdates', (event, options) => {
    const mergedOptions = {
        ...options,
        additionalOptions: { ...(options.additionalOptions || {}), ffmpeg_location: ffmpegDir },
    };

    const script = spawnPython('download', [JSON.stringify(mergedOptions)]);

    let buffer = '';

    script.on('error', (err) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', {
            type: 'error',
            payload: { message: `Failed to start python process: ${err.message}` },
        });
    });

    script.stdout.on('data', (data) => {
        buffer += data.toString();

        let lines = buffer.split('\n');
        buffer = lines.pop();

        lines.forEach(line => {
            try {
                const msg = JSON.parse(line);
                BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', msg);
            } catch (e) {
                console.warn('Invalid JSON found:', line);
            }
        })
    });

    script.stderr.on('data', (err) => {
        console.error('Python stderr:', err.toString());
    });

    script.on('close', (code) => {
        if (code !== 0) {
            BrowserWindow.getAllWindows()[0]?.webContents.send('progressUpdate', {
                type: 'error',
                payload: { message: `Download failed with code ${code}` },
            })
        }
    })

});

// openDirectory

ipcMain.handle('system:openFileInDirectory', async (e, filepath) => {
    shell.showItemInFolder(filepath);
});
ipcMain.handle('system:openDirectory', async (e, path) => {
    shell.showItemInFolder(path);
});