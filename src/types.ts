export interface Resolution {
    resolution: string;
    // videoInfo.mjs's buildResolutions computes this as a rounded number (or
    // null when neither filesize/filesize_approx nor tbr+duration are
    // available) -- never a string.
    filesizeMb: number | null;
}

// Mirrors the shape returned by window.electronAPI.getLibraryIndex() et al.
// (see library.mjs's buildEpochMetadata) -- the one canonical declaration,
// imported by both src/types/electron-api.d.ts's ambient Window type and
// every renderer file that reads library metadata, rather than each
// redeclaring its own (that drifted once already: schemaVersion was
// required in one copy and optional in another).
export type LibraryVideoMetadata = {
    // Only absent on entries written before schemaVersion existed.
    schemaVersion?: number;
    videoId: string;
    channelId: string | null;
    channel: string | null;
    title: string | null;
    fullTitle: string | null;
    description: string | null;
    thumbnail: string | null;
    originalUrl: string | null;
    duration: number | null;
    durationString: string | null;
    uploadDate: string | null;
    addedEpoch: number;
    // Captured at add-time -- entries written before this field existed
    // won't have it (library.mjs's buildEpochMetadata).
    resolutions?: Resolution[];
    downloadedFilePath: string | null;
    downloadedResolution: string | null;
    downloadedFormat: string | null;
    downloadedAudioFilePath: string | null;
    lastPlaybackPositionSeconds: number | null;
}

// Video-level (not epoch-level) -- a clip is derived from whichever version
// was selected at creation time, but lives independently afterward.
// fileName/title/durationSeconds/createdAt mirror clips.json (library.mjs),
// which is the single source of truth for these on disk.
export type LibraryClip = {
    id: string;
    fileName: string;
    title: string;
    createdAt: number;
    durationSeconds: number;
}

export type PlaylistEntry = {
    videoId: string;
    title: string | null;
    url: string;
    thumbnailUrl: string | null;
    uploadDate: string | null;
    unavailable?: boolean;
}

export type PlaylistSummary = {
    playlistId: string;
    title: string | null;
    uploader: string | null;
    entryCount: number;
    addedEpoch: number;
    lastRefreshedEpoch: number | null;
    hasPreviousMetadata: boolean;
    // The current first entry's own thumbnailUrl (preferred display source)
    // and a locally-cached fallback file path for when that's unavailable
    // (an empty playlist, or a dead first entry) -- see ensurePlaylistThumbnail
    // (main.mjs).
    thumbnailUrl: string | null;
    thumbnailPath: string | null;
}

export type PlaylistSnapshot = {
    // Only absent on entries written before schemaVersion existed.
    schemaVersion?: number;
    playlistId: string;
    title: string | null;
    uploader: string | null;
    originalUrl: string | null;
    addedEpoch: number;
    lastRefreshedEpoch: number | null;
    entries: PlaylistEntry[];
    localFiles: Record<string, string | null>;
    hasPreviousMetadata: boolean;
    // What Undo would revert to, and when that version was itself last
    // current -- null when there's nothing to undo.
    previousMetadataSavedEpoch: number | null;
    thumbnailPath: string | null;
}

export type DownloadProgressMessage = {
    type: string;
    // Echoed back from the DownloadVideoParams that started this download --
    // 'progressUpdate' is one shared broadcast channel, not scoped
    // per-download, so every listener filters to its own request.
    requestId: string;
    payload: {
      filename: string;
      downloadedBytes: string;
      totalBytes: string;
      percent: string;
      speed: string;
      // postprocessing-only fields -- postprocessPercent is a real,
      // continuous number, not named `percent` to avoid confusion with the
      // download phase's string-typed percent above.
      stage?: string;
      processor?: string;
      postprocessPercent?: number;
      // 'error'/'retrying' fields (see src/electron/downloadErrors.mjs) --
      // message/kind are the classified failure; retryable is false once an
      // 'error' is actually sent (a retryable failure sends 'retrying'
      // instead and never reaches 'error' until retries are exhausted).
      // attempt/nextAttemptInMs are 'retrying'-only.
      message?: string;
      kind?: string;
      retryable?: boolean;
      attempt?: number;
      nextAttemptInMs?: number;
    }
  }

// A download's error state after useDownloadVideo.tsx's 'error' case -- the
// raw progress message on a first failure, or a { previous, current }
// wrapper once a second failure arrives while an earlier one was still
// being displayed (see useDownloadVideo.tsx's accumErr). Consumers that
// only care about the latest failure should read through to `.current`
// when this is the wrapped shape.
export type DownloadFailure =
    | DownloadProgressMessage
    | { previous: DownloadFailure; current: DownloadProgressMessage };

  export type DownloadVideoParams = {
    videoUrl: string;
    outputPath: string;
    format?: string;
    resolution: string;
    overwriteMode?: 'overwrite' | 'resume';
    additionalOptions?: object;
    // Opt-in auto-embed for downloads outside the library (main.mjs's
    // downloadVideoWithProgressUpdates only attempts an embed when a caller
    // actually supplies these) -- library-flow downloads embed separately
    // via library:recordDownload/swapDownload instead.
    metadataTags?: Record<string, string | null | undefined>;
    thumbnailPath?: string | null;
    // Generated fresh by useDownloadVideo.tsx's startDownload() on every
    // call, not caller-supplied -- optional here so callers building this
    // object don't need to invent one.
    requestId?: string;
  }
