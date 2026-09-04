import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import type { LibraryVideoMetadata } from '../types';
// Shared with the main process (src/electron/utils/youtube.mjs) rather than
// a separate copy here -- see that file's own comment for why it lives
// there. Drives DownloaderScreen.tsx's choice between the full YouTube flow
// (VideoDetailCard) and the simplified multi-platform one
// (OtherPlatformDownloadCard); a plain hostname check, not a "supported
// platforms" allowlist, since yt-dlp itself decides what it can extract
// from -- this only decides which UI to show.
import { isYouTubeUrl } from '../electron/utils/youtube.mjs';

function isValidUrl(string: string) {
    try {
      new URL(string);
      return true;
    } catch {
      return false;
    }
  };

// Not a complete list (yt-dlp supports 1800+ sites) -- just the platforms
// worth a friendly name instead of a bare hostname. Falls back to a
// capitalized first hostname segment for anything else, e.g. "vimeo.com" ->
// "Vimeo".
const KNOWN_PLATFORM_LABELS: Record<string, string> = {
  'soundcloud.com': 'SoundCloud',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',
  'fb.watch': 'Facebook',
  'tiktok.com': 'TikTok',
  'twitter.com': 'Twitter/X',
  'x.com': 'Twitter/X',
};

// Backs OtherPlatformDownloadCard's small platform tag, and its SoundCloud-
// specific defaults (always-MP3 download, offering "embed metadata" after).
function getPlatformLabel(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (KNOWN_PLATFORM_LABELS[hostname]) return KNOWN_PLATFORM_LABELS[hostname];
    const base = hostname.split('.')[0] || hostname;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'Other';
  }
}

function convertYYYYMMDDStringToDate(stringDate: string, format = 'YYYY / MMM / DD') {
  if (stringDate?.length != 8) {
    return null;
  }
  dayjs.extend(customParseFormat);

  return dayjs(stringDate, 'YYYYMMDD').format(format);
}

// Epoch folder names/timestamps are Date.now() ms values, whether read
// straight off a folder name (string, e.g. LibraryVideoDetail.tsx's version
// selector) or off already-parsed JSON (number, e.g. PlaylistsSection.tsx's
// addedEpoch/lastRefreshedEpoch) -- one formatter for both shapes.
function formatEpochLabel(epoch: string | number): string {
  return new Date(Number(epoch)).toLocaleString();
}

// Builds a URL for a local file inside the configured library directory,
// served via the app-video:// protocol (main.mjs's handleAppVideoRequest).
// filePath must already be a trusted, server-resolved absolute path -- never
// arbitrary/user-typed input. cacheBustKey is appended as a query param
// (the protocol handler ignores it, only reading the pathname) purely to
// force a reload when a file is replaced in place at the same path, e.g. a
// "download different quality" swap.
function buildAppVideoUrl(filePath: string, cacheBustKey = 0): string {
  return `app-video://local/${encodeURIComponent(filePath)}?v=${cacheBustKey}`;
}

// Reflects the best quality captured across ALL versions, not just the
// video's latest one -- a newer version might not be downloaded yet while
// an older one already has a real file, and showing "Not downloaded" in
// that case would misrepresent what's actually archived. Shared between
// LibraryScreen.tsx (video grids) and PlaylistsSection.tsx (bulk-select
// gating for in-library playlist entries) rather than duplicated.
function getBestDownloadedQuality(epochs: { metadata: LibraryVideoMetadata }[]): { resolution: string; format: string | null } | null {
  const downloaded = epochs.filter((e) => e.metadata.downloadedFilePath);
  if (downloaded.length > 0) {
    // Prefer an actual video resolution over a legacy MP3-only capture (from
    // before MP3 got its own downloadedAudioFilePath slot) when both exist.
    const videoOnly = downloaded.filter((e) => e.metadata.downloadedResolution !== 'MP3');
    const pool = videoOnly.length > 0 ? videoOnly : downloaded;
    const best = pool.reduce((a, b) => (Number(b.metadata.downloadedResolution) > Number(a.metadata.downloadedResolution) ? b : a));
    return { resolution: best.metadata.downloadedResolution as string, format: best.metadata.downloadedFormat };
  }
  // No video download in any version -- a separately-downloaded MP3 still
  // counts as "something is archived" for the grid badge.
  if (epochs.some((e) => e.metadata.downloadedAudioFilePath)) {
    return { resolution: 'MP3', format: null };
  }
  return null;
}

// Backs the library's video-thumbnail and channel-icon grids
// (LibraryScreen.tsx). Both already use CSS `auto-fill`/`minmax()` so column
// count grows with available width, but a flat px floor still caps how big
// each column can get -- auto-fill only ever packs as many floor-sized
// columns as fit, then `1fr` distributes just the small leftover remainder
// among them, so cards converge on the floor value regardless of how wide
// the window actually is. `clamp()` against a `vw` term ties the floor to
// viewport width too, growing it on wider windows and capping it at `maxPx`
// so it doesn't run away on ultrawide/4K; `minPx` is a hard safety floor so
// columns never shrink to nothing on a tiny window.
function responsiveGridTemplateColumns(minPx: number, vwPreferred: string, maxPx: number): string {
  return `repeat(auto-fill, minmax(clamp(${minPx}px, ${vwPreferred}, ${maxPx}px), 1fr))`;
}

// The library's thumbnail-size slider (LibraryBottomBar.tsx) needs to stay
// meaningful at any window width, not just its default one. Passing the
// slider's raw px value as responsiveGridTemplateColumns' `minPx` doesn't
// work for that: `minPx` only wins while it's bigger than the vw term, so on
// a wide-enough window the vw term outgrows the slider's entire range and
// dragging the slider does nothing until it's dragged past that vw value --
// on a wide monitor that could be most or all of the slider's travel.
// Instead, express the slider's chosen px size AT THIS reference window
// width as an equivalent vw percentage, so the vw term itself scales with
// the slider (not just with the window): at REFERENCE_WIDTH_PX (this app's
// default `BrowserWindow` width, main.mjs) the result is exactly
// `thumbnailSize`px, matching the slider's own label; at any other width it
// scales proportionally, so the same slider position always maps to a
// different, visibly distinct size and the slider never goes inert. minPx/
// maxPx below are just safety bounds (tiny/huge windows), not meant to be
// hit across the slider's normal range.
const THUMBNAIL_GRID_REFERENCE_WIDTH_PX = 1280;

function thumbnailGridTemplateColumns(thumbnailSize: number): string {
  const vw = (thumbnailSize / THUMBNAIL_GRID_REFERENCE_WIDTH_PX) * 100;
  return responsiveGridTemplateColumns(120, `${vw.toFixed(3)}vw`, 720);
}

// yt-dlp's own postprocess progress-template only ever reports
// started/finished, never a real percentage (see useDownloadVideo.tsx) --
// for a merge/remux step that's normally fast, but on a very long recording
// can legitimately sit at "started" for a long time with the postprocessing
// bar showing no real movement. Arbitrary threshold picked to flag the
// videos where that's actually likely to be noticeable, not a measured
// cutoff.
const LONG_VIDEO_POSTPROCESS_THRESHOLD_SECONDS = 3 * 60 * 60;

function isLongVideoForPostprocess(durationSeconds: number | null | undefined): boolean {
  return typeof durationSeconds === 'number' && durationSeconds >= LONG_VIDEO_POSTPROCESS_THRESHOLD_SECONDS;
}

// Electron's ipcRenderer.invoke wraps any rejected IPC handler's error in a
// generic "Error invoking remote method '<channel>': Error: <message>"
// wrapper before it reaches the renderer -- an implementation detail of the
// IPC bridge itself, not something worth showing the user (e.g. every
// getVideoInfoPython failure was displaying that wrapper verbatim instead of
// the actual classified message underneath). Strips it down to just the
// real message; a no-op on any string that doesn't have that shape.
function cleanElectronErrorMessage(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

export { isValidUrl, isYouTubeUrl, getPlatformLabel, convertYYYYMMDDStringToDate, formatEpochLabel, buildAppVideoUrl, getBestDownloadedQuality, responsiveGridTemplateColumns, thumbnailGridTemplateColumns, cleanElectronErrorMessage, isLongVideoForPostprocess };

