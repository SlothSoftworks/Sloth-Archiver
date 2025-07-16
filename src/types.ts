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
    }
  }

  export type DownloadVideoParams = {
    videoUrl: string;
    outputPath: string;
    format: string;
  }
