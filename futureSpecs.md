# Future Specs

Running list of features and tasks planned for `yt-archiver`. Add items under
the relevant section below; Claude will pick these up as work requests when
you point it here.

## Ideas / Backlog

### Long shot ideas/Need planning

1. Video diff/comparator: a feture that lets users compare the difference between versions of videos (we can think of how to do this. For example we coun try to fetch the video transcript or maybe look up if there's any algorithmic way to search through video content to compare it.) the diff should show as a report with timestamps
2. Support for download from other video/media platforms: soundcloud/tiktok/instagram/twitter
3. Playlist refresh/versioning: Playlist saving itself is done (order-preserved snapshot in its own directory, videos map into the normal library locations, dedup against what's already there) -- what's left is the ability to re-fetch an already-saved playlist and either save it as a new version (for comparison against the old one) or refresh over the current version. Today re-adding the same playlist is a no-op.

### Big features

(none currently open -- Library view's ffmpeg utilities shipped 2026-08-05, see futureSpecsFeedback.md)

### QoL features

1. Theme support: the react app already supports a themprovider let's add a theme selector in the options, for a start just add dark and bright themes
2. Language support. Add support for language and set up the ability add more languages in the future via a "strings" style file that the app can reado n startup and load all the messages in the app in any language.
3. Improve options UX by grouping the options in "media options" which contain things like the download folder selections and the formats and the "general options" which include all the other ones

### Small features and corrections

1. Video merger (requires video versioning first): Sometimes videos get re-edited and reuploaded and this causes them to have a different link. This feature would add an option to add the new link in the video library view and the metadata will replace the main link to the video (to keep updating and downloading if he wants to) but keep the original video data in a version marked (legacy/deleted from youtube)
2. Small improvements to the embedded local player:
   - Add a "play" icon in the middle of the player to indicate the user they can begin playback
   - remove the "download" option from the list of options that appear n the 3 dot menu on the corner. It feels redundant
   - remove the buffer looking effect in the local player it could confuse users thinking they are watching the video online
