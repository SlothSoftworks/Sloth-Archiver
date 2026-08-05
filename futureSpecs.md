# Future Specs

Running list of features and tasks planned for `yt-archiver`. Add items under
the relevant section below; Claude will pick these up as work requests when
you point it here.

## Ideas / Backlog

### Long shot ideas/Need planning
1. Video diff/comparator: a feture that lets users compare the difference between versions of videos (we can think of how to do this. For example we coun try to fetch the video transcript or maybe look up if there's any algorithmic way to search through video content to compare it.) the diff should show as a report with timestamps
2. Support for download from other video/media platforms: soundcloud/tiktok/instagram/twitter
3. Playlist saving: A special playlist adding and saving feature. It would work something like it would scan and save all the data for the playlist and keep it in a special directory for playlists. The video themselves cna se saved on the normal locations but the playlist links and whatever order they come in should be saved in the exact order they came from youtube. 
    - This playlist fetching should attempt to map into videos that are already in the local library to avoid attempting to download duplicates
    - Playlists can be versioned or refreshed in case the user wants to save a new version for comparison or just refresh over the current version.

### Big features
1. Library view
    - The library view in the second tab of the main menu of the archiver. This will contain a deeper download and tracking of the videos. When a video es added to the library it will be added to a local storage that will keep track of all the videos tracked by this library feature. 
    - The UI of the library tab should be a pseudo folder structure that displays the channel names of the videos that are saved when clicking on it it displays a mini card version of the video, these mini card can be clicked and this open a full video card that has all of the options the video will have (described below)
    - Videos added here will have their metadata saved (title, description, date, channel who uploaded it link to it as well as the download relevant information like estimated filesize, qualities, etc) this data will be saved based on a base directory that is condigured in the options tab from there the data of the saves video will be saved in the order "<base_library>/<channel>/<videoTitle>/<downloadEpoch>"
    - Library mapping function for library: A mapping function that will systematically analyze the folder structure of the library folder when the user starts the app. This will do an internal mapping of which videos are saved in the folder structure expected by the mapping and it could also save metadata to help the app search through the library (evaluate how heavy this process can get)
        - This would also allow for an easy way to "refresh" and filter any data we read for other features since the mapping function will be ready to be used from here.
    - Videos added here have the option to download the video they're tracking into a local file and it will be saved in the library drectory where the metadata already lives
    - The library view should be able to call a local player and open the local file when it's downloaded and if it's not downloaded it should embed a youtube player so that the user can view in the same window
    - If the video is not downloaded the download video buttons should be displayed; If the video is already downloaded an indicator of the quality that the video is downloaded in should be displayed in the card
    - The add to library button in the first tab should add an entry of the video with the already loaded metadata into the library and open the view of the library on the newlt added video (this requires most of the logic for the library tab to be implemented so it has a dependency)
    - Future features to leave for the end: 
        - Rudimentary version control that lets user download a new version of the metadata and it will saved as a new version of the video entry, the user can swap between versions and the program will navigate the files based on the downloadEpoch directory structure
        - Switching view from channel based to video based for more flexible experience
    - Now that FFMPEG is implemented separately (as of August 2nd 2026) add also small ffmpeg funcionalities that are useful for the user some examples are:
        - Extract mp3 audio
        - Convert to different format
        - Embed the thumbnail to the mp3 file
        - Embed metadata to the video/audio file
        - "Extract clip" option that lets you extract a shorter version of the video recieving a start and stop point in time
        - We'll come up with more later.
        

    Notes: Regarding exactly how stuff like the metadata is saved I planned it with files for ease of transport and archival but if you have suggestions I will hear them out.

2. yt-dlp updater
    - A feature that detects that a new version of yt-dlp was detected in their repo and informs the user that an update is needed for the app to function in a pop up dialog when the app starts.
    - When the user clicks update the app will fetch the new data and do whatever is needed for yt-dlp to update itself (We will decide how to approach this but it's vital that the app can auto-update yt-dlp since it updates constantly)

3. (Dependent on full library sub-system being implemented) Robust library detection
    - A feature in the library view that allows the user to add full playlists the function will recieve a youtube playlist link and it will attempt to fetch all the videos inside it.
    - This feature will be heavier and might find frequent blocking by the youtube API while fetching the video data so we'll have to add some kind of background job functionality to do the data fetching while the user works. This could be a side panel in the library view with the list of videos pending to download
    - This feature will  work like this. The user clicks on the add playlist button -> a dialog appears asking for the link -> apart from the link the user will have some options like "download videos on load"
        - When the user click ons download videos on load another obligatory element will appear asking the preferred quality. This will be a hardcoded list of all the available quaities on youtube and the automated process will attempt to download in the closes to that quality while working
    - Oncce the user fills the playlost form and clicks on the submit button (labeled Add to Library) the scan and yt-dlp fetches will begin and this worker will act accordingly in the background
    - The sidepanel will indicate with loading bars which video the working is downloading right now and it will have a button on top to stop the entire worker process
    - If the user stops the worker it should keep track of what folder he was working with and the program will ask if the user wants to delete all files related to the process. The program will delete all the directories it created if the user selects yes
    - Once the worker completes the job it should send a system notification to the user to le them know the background process is done
4. Bulk add and playlist detection (without background worker)
    - A feature that let's users add entries to the library in bulk, be it with a playlist link or with a comma separated or breakline separated list of youtube links
    - Investigate if the normal youtube public api let's us access a public playlist's items to avoid overusing yt-dlp
    - Includes a collapsable sidepanel where all the videos that are added will be listed. This sidepanel wil be separate even from the main menu panels we've been working with until now it whould be interactable always in case there are elements in the queue.
    - In that sidepanel more features will be added for now each one trackes the recently added entries in the order they were found and processed by the collector function that fetched the information
    - This sidepanel will indicate if any of the entires in it failed when doing the fetch.
        - During the session the user can choose to send an individual retry signal to try and re-fetch the video info or they can choose to delete the entry from the sidepanel list if they choose not to download it anymore
    - Add an option to download data + video on the dialog for adding the playlist
        - the videos and data being download it should be sequential and based on the order they came from youtube (if playlist) or the comma separated text
        

### QoL features
1. Theme support: the react app already supports a themprovider let's add a theme selector in the options, for a start just add dark and bright themes
2. Language support. Add support for language and set up the ability add more languages in the future via a "strings" style file that the app can reado n startup and load all the messages in the app in any language.


### Small features and corrections
1. A field in the options menu that introduces a "base download directory" which will be taken as the suggested directory when opening the file selector system dialog when a video is about to be downloaded
2. Improvements of the file selector field so that it filters for video files on mac and windows instead of showing all files
3. Detection and dialogue asking for whether to replace the file or not and adjust the yt-dlp request accordingly
4. Improved download buttons/bar. Instead of separating the download buttons and bar once the download is confirmed have the download buttons dissapear and turn into a download indicator with the resolution selected and have the bar get filled in the same area. Include error detection that would make the original download buttons and postprcessing menu reappear in case of an error
5. Local cache for videos data fetched: To improve usage and even testing let's add a local cache that saves all of the video data that the app requires to begin a download. If the link matches the cached data avoid calling the actual app. This will help with load times and prevent the client from getting flagged as a bot. The cache should have a TTL of a week just in case anything about the video changes. For TTL just do a simple save epoch property on save cache compared to when it's trying to re-fetch it.
6. Feature that dumps any error log into a file that the user can read in case of an uncaught error happens.
7. After the add to library button effectievely adds a new item ot the library a notification number should be added on the library tab. This should increase for every new video that the user adds and once the user clicks into the library tab the notification will reset to 0 and dissapear
8. Change the icon in the channel level of the library view into the actual channel icon
9. Video merger (requires video versioning first): Sometimes videos get re-edited and reuploaded and this causes them to have a different link. This feature would add an option to add the new link in the video library view and the metadata will replace the main link to the video (to keep updating and downloading if he wants to) but keep the original video data in a version marked (legacy/deleted from youtube)
10. Local file video thumbnail replaced with the youtube video thumbnail to keep a consistent and more presentable UX (if we'ren ot savign the thubmnail yet start saving it to keep it working on offline mode)
11. Small improvements to the embedded local player:
    - Add a "play" icon in the middle of the player to indicate the user they can begin playback
    - remove the "download" option from the list of options that appear n the 3 dot menu on the corner. It feels redundant
12. Special case for audio/mp3 download. Instead of replacing the video section if an MP3 is download it embed a smaller container labeled "Audio" with a small audio player embedded that plays the MP3 (the audio player logic is exactly the same) The mp3 download logic should also allow the mp3 and video file to coexist in the same version since they will have separate players. Since this pretty much makes the mp3 download logic separate visually an in many ways functionally this change also should make it so the library view download. buttons always have the mp3 download available in the same little Audio container in the instruments panel.


### Bugs found by testers:
- In the video view you can't downlaod MP3. The download process fails and doesn't seem like it writes the file there is an error log with the text:  "[33239:0803/202656.407984:ERROR:components/services/storage/service_worker/service_worker_storage.cc:1814] Failed to delete the database: Database IO error" in the electron log
- The format of the videos sometimes saves wrong for example mp3 saves as video.mp4 (seen on windows)
- The filesizes are not right (this was done by an estimation but let's see if we can improve it to be a bit more precise)



### Nice to haves depending on the features of our tech
1. Resume download detection and logic: When a big download fails for any reason and the user chooses to re-download the file detect the previous files and resume instead of redownloading everything (I think yt-dlp supports hits already)



