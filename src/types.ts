interface Resolution {
    resolution: string;
    filesizeMb: string;
}

export type VideoDataProps = {
    videoMetaData: {
        fullTitle: string;
        description: string;
        thumbnail: string;
        resolutions: Resolution[];
        originalUrl: string;
        durationString: string;
        uploadDate: string;
    }
  }

export type DownloadProgressMessage = {
    type: string;
    // Echoed back from the DownloadVideoParams that started this download
    // (TD-008) -- 'progressUpdate' is one shared broadcast channel, not
    // scoped per-download, so every listener filters to its own request.
    requestId: string;
    payload: {
      filename: string;
      downloadedBytes: string;
      totalBytes: string;
      percent: string;
      speed: string;
      // postprocessing-only fields (TD-004) -- postprocessPercent is a real,
      // continuous number, not named `percent` to avoid confusion with the
      // download phase's string-typed percent above.
      stage?: string;
      processor?: string;
      postprocessPercent?: number;
    }
  }

  export type DownloadVideoParams = {
    videoUrl: string;
    outputPath: string;
    format?: string;
    resolution: string;
    overwriteMode?: 'overwrite' | 'resume';
    additionalOptions?: object;
    // Generated fresh by useDownloadVideo.tsx's startDownload() on every
    // call, not caller-supplied -- optional here so callers building this
    // object don't need to invent one.
    requestId?: string;
  }
