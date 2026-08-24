import { describe, it, expect, vi } from 'vitest';

// preload.mjs's entire job is wiring: exposeInMainWorld(name, { key: (...) =>
// ipcRenderer.invoke/on('channel', ...) }). The only thing worth testing is
// that wiring itself -- every exposed key maps to the right IPC channel name
// with the right args forwarded -- since that's exactly the class of bug a
// typo'd/renamed channel string introduces (main.mjs and preload.mjs have to
// agree on these strings independently; nothing enforces it structurally).
// vi.mock's factory is hoisted above all top-level code in this file,
// including plain `const` declarations -- vi.hoisted() is what lets these
// mock fns exist early enough for the factory below to close over them
// without hitting a temporal-dead-zone ReferenceError.
const { invoke, on, removeAllListeners, removeListener, exposeInMainWorld } = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  removeListener: vi.fn(),
  exposeInMainWorld: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeAllListeners, removeListener },
}));

// vi.mock calls are hoisted above imports, so this static import runs against
// the mocked 'electron' module -- same reason plain top-level `import` (not a
// dynamic one inside a hook) is the idiomatic Vitest pattern here.
import './preload.mjs';

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
