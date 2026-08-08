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
// (VideoDetailCard -- resolution picker, add-to-library) and the simplified
// multi-platform one (OtherPlatformDownloadCard -- basic info + a single
// Download button). Deliberately a plain hostname check, not an allowlist of
// "supported" other platforms -- yt-dlp itself already decides what it can
// actually extract from (1800+ sites), this only decides which *UI* to show.
function isYouTubeUrl(string: string): boolean {
  try {
    const hostname = new URL(string).hostname.replace(/^www\./, '');
    return hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'music.youtube.com' || hostname === 'youtu.be';
  } catch {
    return false;
  }
}

// Covers the platforms the multi-platform downloads feature has actually
// been tested against so far -- not meant to be a complete list (yt-dlp
// itself supports 1800+ sites), just the ones worth a friendly name instead
// of a bare hostname. Falls back to a capitalized first hostname segment for
// anything else, e.g. "vimeo.com" -> "Vimeo".
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

// Builds a URL for any trusted local file inside the configured library
// directory, served via the app-video:// protocol (main.js's
// handleAppVideoRequest) -- used for local video/audio playback and for
// cached channel-icon images alike, since the protocol is a generic
// guard-railed file server, not actually video-specific despite the name.
// filePath must already be a trusted, server-resolved absolute path, never
// arbitrary/user-typed input. cacheBustKey is appended as a query param
// (ignored by the protocol handler, which only reads the pathname) so a
// file that gets replaced in place (e.g. a "download different quality"
// swap landing on the same path+extension) still forces a real reload
// instead of the browser silently continuing to show old cached bytes
// under an unchanged src string.
function buildAppVideoUrl(filePath: string, cacheBustKey = 0): string {
  return `app-video://local/${encodeURIComponent(filePath)}?v=${cacheBustKey}`;
}

export { isValidUrl, isYouTubeUrl, getPlatformLabel, convertYYYYMMDDStringToDate, buildAppVideoUrl };

