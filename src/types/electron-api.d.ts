export {}

type FolderPickerResult = {
    filePath: string;
    canceled: boolean;
};

declare global {
    interface Window {
        electronAPI: {
            pickFolder: (options: T) => Promise <FolderPickerResult>;
            saveVideoFile: (defaultName?: string) => Promise <FolderPickerResult>;
            downloadVideoPython: (args: T) => Promise <string | null>; 
            getVideoInfoPython: (url: string, options?: T) => Promise <T>
            openDirectory: (path: string) => Promise<T>
            openFileInDirectory: (filePath: string) => Promise<T>
        };
        electronAPIPythonDownload: {
            startDownloadPython: (options: T) => Promise<T>;
            onProgressUpdate: (option: T) => Promise<T>;
            removeProgressListener: () => void;
        }
    }
}
