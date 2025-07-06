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
            downloadVideoPython: (args: T) => Promise <strin | null>; 
        };
    }
}