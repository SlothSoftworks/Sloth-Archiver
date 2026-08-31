# Future Specs

Running list of features and tasks planned for `sloth-archiver`. Add items under
the relevant section below; Claude will pick these up as work requests when
you point it here.

## Ideas / Backlog

### Long shot ideas/Need planning

1. Video diff/comparator: a feture that lets users compare the difference between versions of videos (we can think of how to do this. For example we coun try to fetch the video transcript or maybe look up if there's any algorithmic way to search through video content to compare it.) the diff should show as a report with timestamps

### Big features

1. Export/Import  JSON feature
   - A feature that let's you export the entire current scan of the library to a unified json that when imported in another instance of the app it will create the structures of the videos in the archive and load the metadata from the json into their corresponding files
2. Customization of embedded player: have the user select the start and end point of a clip directly via buttons on the player itself (the "pick timestamp" buttons next to the clip fields, which just grab the player's current position, already shipped). The player itself is now a custom-built shell (see the grouped Player section in futureSpecsFeedback.md) — still open: dragging/clicking directly on the scrub bar itself to set the clip start/end, rather than only the existing "pick timestamp" buttons.
3. Playlist mode: An internal quasi-playlist mode that allows the user to queue videos and they will play back to back in that order (this playlist function should have the option to enable/disable autoplay the next video after the last finishes downloading). This feature will also show small arrow indicators in the screen to allow the user to move next or previous video in the current playlist. Making this feature will enable to also add other smaller features such as:
   - "Play" playlist button that queues all of the playlist items to play back to back
   - Context based playlist in the video search view that will pick up all the viewos currently displayed in the search and let the user navigate on this search context as a playlist.
4. Local files library support.
   - A feature that let's the user add local files to the library and make use of some of the features like clipping, converting and extracting mp3 inside the app. These videos should not have the quality selectors and any of the other options pertaining to obtaining data form youtube. Local files should be able to be loaded into the library through a new "add local file option" in the video view and there should be a new "Local" option in the Video/Playlist selector to filter for only the local files

### QoL features

1. Language support. Add support for language and set up the ability add more languages in the future via a "strings" style file that the app can reado n startup and load all the messages in the app in any language.
2. Embed the clipping controls into the custom player (the player shell itself already shipped, see futureSpecsFeedback.md's grouped Player section — this item is now specifically about the clip Start/End selection and a "Clip" button living inside the player's own chrome, not building the shell)
   - This will allow the user to pick the start and end part of the clip with controls that appear inside the player itself and a "clip" button also embedded that will give it a cleaner look and feel

### Small features and corrections

1. Video merger (requires video versioning first): Sometimes videos get re-edited and reuploaded and this causes them to have a different link. This feature would add an option to add the new link in the video library view and the metadata will replace the main link to the video (to keep updating and downloading if he wants to) but keep the original video data in a version marked (legacy/deleted from youtube)
