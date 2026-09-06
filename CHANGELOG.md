# Changelog

This is the first documented entry — a snapshot of what SlothArchiver could
do as of this release, not a history of every change that got it here.
Future releases will log what actually changed from the previous one.

## [1.0.0] — 2026-09-05
- **First public release** 🎉🎉🥳🎉🎉
- **Added a theme selector.** Options now has a "Theme" dropdown alongside
  the existing Light/Dark toggle: the original plain look ("Default MUI")
  or a new "SlothUI" theme matching the color scheme from SlothArchiver's
  own website. SlothUI (dark) is now the default look for a fresh install;
  existing installs keep whatever they already had.
- **Cookie handling is clearer and safer.** The warning explains what
  cookies are actually for (age-restricted or members-only content, not
  something to leave on for every download) and links to yt-dlp's own
  cookie usage guide. A new "Save across sessions" checkbox, off by
  default, controls whether a saved cookie (or cookies-from-browser choice)
  is kept the next time the app opens or cleared as soon as it closes --
  so an authenticated session can't accidentally outlive the run that
  created it. Existing saved cookies are unaffected by this change.
- **Fixed a bug in the bulk-add queue where a retried download could show
  a generic "Download failed" message** instead of the actual reason,
  once an earlier failure on the same item was still being displayed.

## [0.27.1] — 2026-09-04
- **Fixed a bug where downloading a very long video could get stuck looping
  forever.** The step that joins the downloaded video and audio together
  doesn't report progress while it runs, and on a long enough recording that
  silence was being mistaken for a stalled connection — killing the merge
  partway through and restarting the whole download from scratch, repeatedly,
  with no way out short of force-quitting the app.
- **The postprocessing step now shows a proper loading animation instead of a
  progress bar stuck at 50%**, since that stage genuinely has no percentage
  to report — the old fixed value looked broken on anything that took more
  than a few seconds.
- **Downloading a video over 3 hours long now shows a heads-up** that the
  postprocessing step may take a while with no visible progress, so it's
  clear that's expected rather than a sign something's wrong.

## [0.27.0] — 2026-09-03
- **Split your library into separate sublibraries.** Create as many as you
  want from the Library tab, switch between them, and pick which one a new
  download or bulk add lands in. Move any video — every saved version, its
  clips, and its channel's icon if needed — to a different sublibrary at any
  time, individually or several at once from the bulk-selection bar. This is
  the feature the `DefaultLibrary` groundwork from 0.26.2 was preparing for.
- **Tag your videos, and filter the library by tag.** Add one or more tags to
  a video from its detail view (next to its quality badge), or tag several
  videos at once from the bulk-selection bar. A filter icon next to the sort
  control lets you narrow the library down to videos carrying every tag you
  select, layered on top of your current search and sort.
- **A video whose downloaded file goes missing — moved, renamed, or deleted
  outside the app — now recovers automatically where possible.** Opening it
  triggers a quick check that repairs the stored file link if a matching
  file is found nearby; if nothing's found, a clear warning tells you to
  re-download it or locate it yourself instead of the player just failing
  silently.

## [0.26.2] — 2026-09-02
- **Library thumbnails and channel icons now scale with your window, not
  just a fixed size.** Both grids used to cap out at a flat pixel size no
  matter how wide the window got, so a large monitor didn't actually show
  bigger thumbnails. They now grow with the window instead, and the
  thumbnail-size slider stays meaningful at any window width instead of
  losing effect once the window gets wide.
- **Prep work for upcoming SubLibrary/tag support.** New videos and
  playlists are now saved one level deeper on disk, inside a `DefaultLibrary`
  folder — internal groundwork for a future feature that lets you split your
  library into separate tagged sections. If you're upgrading from an earlier
  version, your existing library won't show up in the Library tab until you
  add something new to it — nothing is deleted, your files are exactly where
  they were, just outside where the app currently looks. A real migration
  path will ship before this becomes the default experience for everyone.

## [0.26.1] — 2026-09-02
- Add pre push validation for version updates

## [0.26.0] — 2026-09-02

- **yt-dlp updates are faster and more trustworthy.** Instead of rebuilding
  yt-dlp from source on your machine, the app now fetches yt-dlp's own
  official signed release and verifies it before installing. Checking for
  updates while offline now correctly shows your current version instead of
  an error.
- **Cookie-based login is safer to use.** A clear warning now explains the
  real-account risk before you use it. Pasted cookies expire and prompt for
  a renewal instead of being trusted indefinitely, and concurrent downloads
  no longer share the same cookie file, avoiding rare corruption when
  several downloads run at once.
- **Tightened several internal security boundaries** — sandboxed the app
  window against malicious pop-ups/navigation, and locked down the file
  paths and external process arguments the media-tools and library features
  use to only what they should actually be able to touch.
- New app icon.


## [0.25.3] — 2026-08-31

First documented release. Feature set at this point:

- Download video or audio from YouTube and a growing list of other platforms
  (SoundCloud, TikTok, Instagram, Facebook, Dailymotion, and more), in the
  quality you choose.
- A real library, not just a downloads folder — every video organized by
  channel, searchable, with version history kept if you ever re-fetch it.
- Playlist archiving — save an entire playlist at once, and refresh it later
  to pick up new additions, with removed videos flagged instead of silently
  disappearing.
- Bulk downloading — paste a list of links or a playlist and let the app
  work through them in the background, several at a time.
- Built-in playback — watch or listen to anything in your library directly
  inside the app.
- Media tools — extract audio as MP3, convert formats, trim clips, and embed
  metadata/cover art without leaving the app.
- Self-updating download engine, so the app keeps working as sites change.
- No paywall — every feature above is free, with no tiers or locked
  resolutions.
