import type { SvgIconComponent } from '@mui/icons-material';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import MovieIcon from '@mui/icons-material/Movie';
import PublicIcon from '@mui/icons-material/Public';

// Keyed on the same lowercased, sanitized platform string library.mjs uses
// for the NonYT/<platform> folder name (derivePlatform() in videoInfo.mjs) --
// a small, hand-picked set rather than an exhaustive per-extractor mapping.
// A Map (not a plain object) so looking it up with an arbitrary string key
// needs no index-signature widening or unsafe cast.
const PLATFORM_ICONS = new Map<string, SvgIconComponent>([
  ['soundcloud', AudiotrackIcon],
  ['bandcamp', AudiotrackIcon],
  ['mixcloud', AudiotrackIcon],
  ['dailymotion', MovieIcon],
  ['vimeo', MovieIcon],
  ['archiveorg', MovieIcon],
  ['peertube', MovieIcon],
  ['twitch', MovieIcon],
]);

// The deliberate catch-all for any platform not listed above.
const FALLBACK_PLATFORM_ICON = PublicIcon;

export function getPlatformIcon(platform: string | null | undefined): SvgIconComponent {
  if (!platform) return FALLBACK_PLATFORM_ICON;
  return PLATFORM_ICONS.get(platform) ?? FALLBACK_PLATFORM_ICON;
}

// Real brand colors, not a generic categorical palette -- picked so the
// platform chip (VideoQualityDownload.tsx, LibraryScreen.tsx's VideoCard) is
// recognizable at a glance rather than just "some color." archive.org has no
// strong brand color of its own (its site leans on plain grey/blue), so it
// shares the same neutral grey as the fallback rather than inventing one.
const PLATFORM_COLORS = new Map<string, string>([
  ['soundcloud', '#FF5500'],
  ['bandcamp', '#408294'],
  ['mixcloud', '#5000FF'],
  ['dailymotion', '#00AAFF'],
  ['vimeo', '#1AB7EA'],
  ['peertube', '#F1680D'],
  ['twitch', '#9146FF'],
]);

const FALLBACK_PLATFORM_COLOR = '#78909C';

export function getPlatformColor(platform: string | null | undefined): string {
  if (!platform) return FALLBACK_PLATFORM_COLOR;
  return PLATFORM_COLORS.get(platform) ?? FALLBACK_PLATFORM_COLOR;
}
