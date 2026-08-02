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
  }
