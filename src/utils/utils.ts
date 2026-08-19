import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

function isValidUrl(string: string) {
    try {
      new URL(string);
      return true;
    } catch (err) {
      return false;
    }
  };

// Drives DownloaderScreen.tsx's choice between the full YouTube flow
// (VideoDetailCard) and the simplified multi-platform one
// (OtherPlatformDownloadCard). A plain hostname check, not a "supported
// platforms" allowlist -- yt-dlp itself decides what it can extract from,
// this only decides which UI to show.
function isYouTubeUrl(string: string): boolean {
  try {
    const hostname = new URL(string).hostname.replace(/^www\./, '');
    return hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'music.youtube.com' || hostname === 'youtu.be';
  } catch {
    return false;
  }
}

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

// Builds a URL for a local file inside the configured library directory,
// served via the app-video:// protocol (main.js's handleAppVideoRequest).
// filePath must already be a trusted, server-resolved absolute path -- never
// arbitrary/user-typed input. cacheBustKey is appended as a query param
// (the protocol handler ignores it, only reading the pathname) purely to
// force a reload when a file is replaced in place at the same path, e.g. a
// "download different quality" swap.
function buildAppVideoUrl(filePath: string, cacheBustKey = 0): string {
  return `app-video://local/${encodeURIComponent(filePath)}?v=${cacheBustKey}`;
}

export { isValidUrl, isYouTubeUrl, getPlatformLabel, convertYYYYMMDDStringToDate, buildAppVideoUrl };

