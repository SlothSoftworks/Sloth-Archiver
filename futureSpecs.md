# Future Specs

Running list of features and tasks planned for `yt-archiver`. Add items under
the relevant section below; Claude will pick these up as work requests when
you point it here.

## Ideas / Backlog

### Long shot ideas/Need planning

1. Video diff/comparator: a feture that lets users compare the difference between versions of videos (we can think of how to do this. For example we coun try to fetch the video transcript or maybe look up if there's any algorithmic way to search through video content to compare it.) the diff should show as a report with timestamps

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
5. Clip collection feature: Let's make it so the clips the user makes can be saved into the video as a separate /clips directory that will be located on the videoID level (not inside the epoch folder level) these clips will be collected in a "clips" tab where the user can see the list of clips and play them if they want to
6. Playlist mode: An internal quasi-playlist mode that allows the user to queue videos and they will play back to back in that order (this playlist function should have the option to enable/disable autoplay the next video after the last finishes downloading). This feature will also show small arrow indicators in the screen to allow the user to move next or previous video in the current playlist. Making this feature will enable to also add other smaller features such as:
   - "Play" playlist button that queues all of the playlist items to play back to back
   - Context based playlist in the video search view that will pick up all the viewos currently displayed in the search and let the user navigate on this search context as a playlist.

### QoL features

1. Language support. Add support for language and set up the ability add more languages in the future via a "strings" style file that the app can reado n startup and load all the messages in the app in any language.

### Small features and corrections

1. Video merger (requires video versioning first): Sometimes videos get re-edited and reuploaded and this causes them to have a different link. This feature would add an option to add the new link in the video library view and the metadata will replace the main link to the video (to keep updating and downloading if he wants to) but keep the original video data in a version marked (legacy/deleted from youtube)
2. Small improvements to the embedded local player:
   - remove the buffer looking effect in the local player it could confuse users thinking they are watching the video online
3. Customizable thumbnail sizes for video view. As part of this let's add a new element to the general view. a bottom page settings bar that will have a small slider type of menu similar to that zoom level indicator apps like Word have that will allow you to change the size of the thumbnails. Let's try with 4 sizes to start (Large, Medium, Small, Miniature) with Large being the current size we have as default and the others being smaller.


### Bugs found
