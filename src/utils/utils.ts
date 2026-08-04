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

export { isValidUrl, convertYYYYMMDDStringToDate, buildAppVideoUrl };

