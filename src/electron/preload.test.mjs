import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

// preload.cjs's entire job is wiring: exposeInMainWorld(name, { key: (...) =>
// ipcRenderer.invoke/on('channel', ...) }). The only thing worth testing is
// that wiring itself -- every exposed key maps to the right IPC channel name
// with the right args forwarded -- since that's exactly the class of bug a
// typo'd/renamed channel string introduces (main.mjs and preload.cjs have to
// agree on these strings independently; nothing enforces it structurally).
const invoke = vi.fn();
const on = vi.fn();
const removeAllListeners = vi.fn();
const removeListener = vi.fn();
const exposeInMainWorld = vi.fn();

// vi.mock('electron', ...) -- the approach every other test file in this
// project uses -- doesn't reach this file's require('electron') call: that
// mock only intercepts Vite's own ESM import graph, and preload.cjs is
// CommonJS (see its own top-of-file comment for why). So the mock is
// injected the way Node itself would resolve it: directly into
// require.cache at 'electron''s real resolved path, before preload.cjs's
// own require('electron') call runs. require(), unlike a static import,
// re-reads that cache on every call, which is what makes this ordering
// (mock first, require second) safe without any hoisting.
const require = createRequire(import.meta.url);
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: require.resolve('electron'),
  loaded: true,
  exports: {
    contextBridge: { exposeInMainWorld },
    ipcRenderer: { invoke, on, removeAllListeners, removeListener },
  },
};

require('./preload.cjs');

const calls = Object.fromEntries(exposeInMainWorld.mock.calls);
const electronAPI = calls.electronAPI;
const electronAPIPythonDownload = calls.electronAPIPythonDownload;

it('exposes exactly electronAPI and electronAPIPythonDownload on the main world', () => {
  expect(exposeInMainWorld).toHaveBeenCalledTimes(2);
  expect(electronAPI).toBeTruthy();
  expect(electronAPIPythonDownload).toBeTruthy();
});

// [electronAPI key, args to call it with, expected ipcRenderer.invoke call]
const invokeTable = [
  ['pickFolder', [{ title: 't' }], ['dialog:openFolder', { title: 't' }]],
  ['saveVideoFile', ['name', 'fmt', { x: 1 }], ['dialog:saveVideoFile', 'name', 'fmt', { x: 1 }]],
  ['getVideoInfoPython', ['url', { o: 1 }], ['getVideoInfoPython', 'url', { o: 1 }]],
  ['openDirectory', ['/p'], ['system:openDirectory', '/p']],
  ['openFileInDirectory', ['/p/f'], ['system:openFileInDirectory', '/p/f']],
  ['openFileExternally', ['/p/f'], ['system:openFileExternally', '/p/f']],
  ['saveCookie', ['cookie-text'], ['cookies:save', 'cookie-text']],
  ['deleteCookie', [], ['cookies:delete']],
  ['getCookieStatus', [], ['cookies:status']],
  ['getCookiesConfig', [], ['cookies:getConfig']],
  ['setCookiesConfig', [{ cookiesMode: 'file' }], ['cookies:setConfig', { cookiesMode: 'file' }]],
  ['getDownloadDir', [], ['settings:getDownloadDir']],
  ['setDownloadDir', ['/d'], ['settings:setDownloadDir', '/d']],
  ['checkFileExists', ['/p'], ['system:pathExists', '/p']],
  ['checkForYtdlpUpdate', [], ['ytdlp:checkForUpdate']],
  ['startYtdlpUpdate', [], ['ytdlp:startUpdate']],
  ['quitApp', [], ['app:quit']],
  ['deleteVideoInfoCacheEntry', ['url'], ['videoInfoCache:deleteEntry', 'url']],
  ['getLibraryDir', [], ['settings:getLibraryDir']],
  ['setLibraryDir', ['/l'], ['settings:setLibraryDir', '/l']],
  ['getLibraryViewMode', [], ['settings:getLibraryViewMode']],
  ['setLibraryViewMode', ['video'], ['settings:setLibraryViewMode', 'video']],
  ['getThemeMode', [], ['settings:getThemeMode']],
  ['setThemeMode', ['dark'], ['settings:setThemeMode', 'dark']],
  ['getCustomConvertFormats', [], ['settings:getCustomConvertFormats']],
  ['setCustomConvertFormats', [['mkv']], ['settings:setCustomConvertFormats', ['mkv']]],
  ['getLibraryIndex', [], ['library:getIndex']],
  ['refreshLibraryIndex', [], ['library:refreshIndex']],
  ['refreshChannelIcon', [{ c: 1 }], ['library:refreshChannelIcon', { c: 1 }]],
  ['addLibraryEntry', [{ id: 1 }], ['library:addEntry', { id: 1 }]],
  ['overrideLibraryEntry', [{ id: 1 }, '/v'], ['library:overrideEntry', { videoMetaData: { id: 1 }, existingVideoDir: '/v' }]],
  ['addLibraryVersion', [{ id: 1 }, '/v'], ['library:addVersion', { videoMetaData: { id: 1 }, videoDir: '/v' }]],
  ['findLibraryVideo', ['vid'], ['library:findVideo', 'vid']],
  ['fetchPlaylistEntries', ['url'], ['library:fetchPlaylistEntries', 'url']],
  ['enrichPlaylistEntry', [{ e: 1 }], ['library:enrichPlaylistEntry', { e: 1 }]],
  ['recordLibraryDownload', [{ r: 1 }], ['library:recordDownload', { r: 1 }]],
  ['swapLibraryDownload', [{ s: 1 }], ['library:swapDownload', { s: 1 }]],
  ['deleteLibraryEntry', ['/v', 'epoch1'], ['library:deleteEntry', { videoDir: '/v', epoch: 'epoch1' }]],
  ['saveExportedFile', [{ f: 1 }], ['dialog:saveExportedFile', { f: 1 }]],
  ['extractMp3FromFile', [{ f: 1 }], ['library:extractMp3', { f: 1 }]],
  ['convertFileFormat', [{ f: 1 }], ['library:convertFormat', { f: 1 }]],
  ['ensurePlayablePreview', [{ f: 1 }], ['library:ensurePlayablePreview', { f: 1 }]],
  ['extractClipFromFile', [{ f: 1 }], ['library:extractClip', { f: 1 }]],
  ['embedFileMetadata', [{ f: 1 }], ['library:embedMetadata', { f: 1 }]],
  ['reportRendererError', [{ message: 'm' }], ['errorLog:report', { message: 'm' }]],
  ['getErrorLogInfo', [], ['errorLog:getInfo']],
  ['openErrorLog', [], ['errorLog:open']],
];

describe.each(invokeTable)('electronAPI.%s', (key, args, expectedInvokeArgs) => {
  it(`forwards to ipcRenderer.invoke(${JSON.stringify(expectedInvokeArgs[0])}, ...)`, () => {
    invoke.mockClear();
    invoke.mockResolvedValue('ok');
    electronAPI[key](...args);
    expect(invoke).toHaveBeenCalledWith(...expectedInvokeArgs);
  });
});

describe('electronAPI event subscriptions', () => {
  it('onYtdlpUpdateProgress/removeYtdlpUpdateProgressListener wire to the ytdlpUpdateProgress channel', () => {
    on.mockClear();
    const callback = vi.fn();
    electronAPI.onYtdlpUpdateProgress(callback);
    expect(on).toHaveBeenCalledWith('ytdlpUpdateProgress', expect.any(Function));
    on.mock.calls[0][1](/* _event */ {}, { stage: 'building' });
    expect(callback).toHaveBeenCalledWith({ stage: 'building' });

    removeAllListeners.mockClear();
    electronAPI.removeYtdlpUpdateProgressListener();
    expect(removeAllListeners).toHaveBeenCalledWith('ytdlpUpdateProgress');
  });

  it('onLibraryBackgroundUpdate/removeLibraryBackgroundUpdateListener wire to the library:backgroundUpdate channel', () => {
    on.mockClear();
    const callback = vi.fn();
    electronAPI.onLibraryBackgroundUpdate(callback);
    expect(on).toHaveBeenCalledWith('library:backgroundUpdate', expect.any(Function));
    on.mock.calls[0][1]();
    expect(callback).toHaveBeenCalledWith();

    removeAllListeners.mockClear();
    electronAPI.removeLibraryBackgroundUpdateListener();
    expect(removeAllListeners).toHaveBeenCalledWith('library:backgroundUpdate');
  });

  it('onFfmpegUtilityProgress/removeFfmpegUtilityProgressListener wire to the ffmpegUtilityProgress channel', () => {
    on.mockClear();
    const callback = vi.fn();
    electronAPI.onFfmpegUtilityProgress(callback);
    expect(on).toHaveBeenCalledWith('ffmpegUtilityProgress', expect.any(Function));
    on.mock.calls[0][1]({}, { type: 'progress', percent: 50 });
    expect(callback).toHaveBeenCalledWith({ type: 'progress', percent: 50 });

    removeAllListeners.mockClear();
    electronAPI.removeFfmpegUtilityProgressListener();
    expect(removeAllListeners).toHaveBeenCalledWith('ffmpegUtilityProgress');
  });

  it('onPreviewGenerationProgress/removePreviewGenerationProgressListener wire to the previewGenerationProgress channel', () => {
    on.mockClear();
    const callback = vi.fn();
    electronAPI.onPreviewGenerationProgress(callback);
    expect(on).toHaveBeenCalledWith('previewGenerationProgress', expect.any(Function));
    on.mock.calls[0][1]({}, { percent: 50 });
    expect(callback).toHaveBeenCalledWith({ percent: 50 });

    removeAllListeners.mockClear();
    electronAPI.removePreviewGenerationProgressListener();
    expect(removeAllListeners).toHaveBeenCalledWith('previewGenerationProgress');
  });
});

describe('electronAPIPythonDownload', () => {
  it('startDownloadPython forwards to downloadVideoWithProgressUpdates', () => {
    invoke.mockClear();
    electronAPIPythonDownload.startDownloadPython({ url: 'x' });
    expect(invoke).toHaveBeenCalledWith('downloadVideoWithProgressUpdates', { url: 'x' });
  });

  it('onProgressUpdate/removeProgressListener wire to the progressUpdate channel', () => {
    on.mockClear();
    const callback = vi.fn();
    const listener = electronAPIPythonDownload.onProgressUpdate(callback);
    expect(on).toHaveBeenCalledWith('progressUpdate', expect.any(Function));
    on.mock.calls[0][1]({}, { type: 'progress' });
    expect(callback).toHaveBeenCalledWith({ type: 'progress' });

    removeListener.mockClear();
    electronAPIPythonDownload.removeProgressListener(listener);
    expect(removeListener).toHaveBeenCalledWith('progressUpdate', listener);
  });
});
