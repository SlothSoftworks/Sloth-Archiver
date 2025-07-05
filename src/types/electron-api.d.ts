export {}

declare global {
    interface Window {
        electronAPI: {
            pickFolder: (options: T) => Promise <string | null>;
            saveVideoFile: (defaultName?: string) => Promise <string | null>;
            downloadVideoPython: (args: T) => Promise <strin | null>; 
        };
    }
}