import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path'
import { spawn } from 'child_process';

import { getSupportedVideoFilters } from '../utils/constants.mjs';


process.env.NODE_ENV = 'development';

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

ipcMain.handle('getVideoInfoPython', async (event, url, args={}) => {
    return new Promise((resolve, reject) => {
        const script = spawn('python3', [path.join(pythonPath, "vidInfoFetch.py"), url, JSON.stringify(args) ]);
        let data = '';
        let error = '';
        let resultObject = {}

        script.stdout.on('data', (output) => {
            data += output.toString();
        });
        script.stderr.on('data', err => {
            error += err.toString();
        });

        script.on('close', (code) => {

            if (code !== 0 || error) {
                resultObject = {success: false, error: error || `Python script failed with code ${code}`};
                reject (resultObject);
            } else {
                console.log(data);
                try {
                    resultObject = {success: true, data: JSON.parse(data)}
                    resolve(resultObject);
                } catch (e) {
                    resultObject = {success: false, error: 'Failed to parse video data'}
                    reject(resultObject);
                }
            }
        });
    });
});

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

ipcMain.handle('downloadVideoWithProgressUpdates', (event, { videoUrl, outputPath, format }) => {
    console.log('PARAMS:',videoUrl, outputPath, format)

    const script = spawn('python3', [path.join(pythonPath, "vidDownloadWithProgressHook.py"), videoUrl, outputPath, format ]);

    let buffer = '';
    
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