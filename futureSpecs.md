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

1. Export/Import  JSON feature
   - A feature that let's you export the entire current scan of the library to a unified json that when imported in another instance of the app it will create the structures of the videos in the archive and load the metadata from the json into their corresponding files
2. Select bulk controllers and download/download all:
   - A dynamic UI feature that allows the user to click non downloaded videos in the video list of the library and click on a download all button that add all of the videos not downloaded to the bulk download list
   - Ths requires introducing an identifier between a download job in the side panel and a add to library job (that doesn't require a download)
   - The bulk controllers section is this:
     - A user can select one or more items and this will add a new option in the top menu where the other buttons of the video view are which will be a "delete all selected" feature that will delete the entries of the list of selected items and their files
     - The same way there will be a "download selected" which will apply only when all of the items selected aren't downloaded. If even one of the items in the selection list is downloaded this control will dissapear.
3. Customization of embedded player: have the user select the start and end point of a clip directly via buttons on the player itself (the "pick timestamp" buttons next to the clip fields, which just grab the player's current position, already shipped)
4. Implementation of a more resilient embedded player that supports more codecs like MKV

### QoL features

1. Language support. Add support for language and set up the ability add more languages in the future via a "strings" style file that the app can reado n startup and load all the messages in the app in any language.

### Small features and corrections

1. Video merger (requires video versioning first): Sometimes videos get re-edited and reuploaded and this causes them to have a different link. This feature would add an option to add the new link in the video library view and the metadata will replace the main link to the video (to keep updating and downloading if he wants to) but keep the original video data in a version marked (legacy/deleted from youtube)
2. Small improvements to the embedded local player:
   - remove the buffer looking effect in the local player it could confuse users thinking they are watching the video online

### Bugs found

* When a list is being added as bulk add and the user chooses to click on "stop after item" the downloads stop but the stop after item spinner never stops spinning and the resume buttons don't show up again
* On the first pass of bulk add the playlist data saved doesn't create or link to the library entry of the added videos. The user needs to move to the playlist view and hit refresh to be able to see the little go to video icon.
* Not exactly a bug but a gap in the features. In some scenarios a "refresh youtube" button is needed in the view view. This feature was around before basically a version of download new version but that explaces the version selected. Add it back to help the user refresh data easiert
