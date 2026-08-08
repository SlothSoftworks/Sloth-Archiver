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
    // Echoed straight back from the DownloadVideoParams that started this
    // download (TD-008, reports/TechnicalDebt.md) -- 'progressUpdate' is one
    // shared broadcast channel, not scoped per-download, so every
    // useDownloadVideo() instance listening has to filter to just the
    // request it itself started rather than reacting to every message.
    requestId: string;
    payload: {
      filename: string;
      downloadedBytes: string;
      totalBytes: string;
      percent: string;
      speed: string;
      // postprocessing-only fields (MP3 extraction/format recode's direct ffmpeg
      // pass, see TD-004) -- postprocessPercent is a real, continuous number,
      // deliberately not named `percent` to avoid confusion with the download
      // phase's string-typed percent above.
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
    // Generated fresh by useDownloadVideo.tsx's startDownload() on every call
    // -- not caller-supplied -- so it's optional here (present at runtime,
    // but callers building a DownloadVideoParams themselves shouldn't need
    // to invent one).
    requestId?: string;
  }
