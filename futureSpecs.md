# Future Specs

Running list of features and tasks planned for `yt-archiver`. Add items under
the relevant section below; Claude will pick these up as work requests when
you point it here.

## Ideas / Backlog

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
    - In the full card video view the usr will have a burger menu he can click on that will have more options:
        - "Download different quality video": Which will open a dialog with the download buttons and when selected and submited will download a new version of the video (inside the corresponding library folder), if the download is successful it will delete the older video (for this don't replace on download, for safety download with an alternative name and once the download is fine delete the old one and rename the new one with the old one's name)
        - "Download new version": Which will download all the videwo data all over again and present it in a dialog very similar to the video detail card but once the quality of downlaod is selected it will make a new entry with the current epoch the request and save the video in that folder. Once that is done  the user will be able to swap between the version and the app will hotswap the metadata.
        - "Delete video entry": Which deletes the video file if it exists, the metadata and the folder containing it
    - The add to library button in the first tab should add an entry of the video with the already loaded metadata into the library and open the view of the library on the newlt added video (this requires most of the logic for the library tab to be implemented so it has a dependency)
    - Future features to leave for the end: 
        - Rudimentary version control that lets user download a new version of the metadata and it will saved as a new version of the video entry, the user can swap between versions and the program will navigate the files based on the downloadEpoch directory structure
        - Switching view from channel based to video based for more flexible experience
        

    Notes: Regarding exactly how stuff like the metadata is saved I planned it with files for ease of transport and archival but if you have suggestions I will hear them out.

2. yt-dlp updater
    - A feature that detects that a new version of yt-dlp was detected in their repo and informs the user that an update is needed for the app to function in a pop up dialog when the app starts.
    - When the user clicks update the app will fetch the new data and do whatever is needed for yt-dlp to update itself (We will decide how to approach this but it's vital that the app can auto-update yt-dlp since it updates constantly)


### Small features and corrections
1. A field in the options menu that introduces a "base download directory" which will be taken as the suggested directory when opening the file selector system dialog when a video is about to be downloaded
2. Improvements of the file selector field so that it filters for video files on mac and windows instead of showing all files
3. Detection and dialogue asking for whether to replace the file or not and adjust the yt-dlp request accordingly
4. Improved download buttons/bar. Instead of separating the download buttons and bar once the download is confirmed have the download buttons dissapear and turn into a download indicator with the resolution selected and have the bar get filled in the same area. Include error detection that would make the original download buttons and postprcessing menu reappear in case of an error
5. Local cache for videos data fetched: To improve usage and even testing let's add a local cache that saves all of the video data that the app requires to begin a download. If the link matches the cached data avoid calling the actual app. This will help with load times and prevent the client from getting flagged as a bot. The cache should have a TTL of a week just in case anything about the video changes. For TTL just do a simple save epoch property on save cache compared to when it's trying to re-fetch it.


### Nice to haves depending on the features of our tech
1. Resume download detection and logic: When a big download fails for any reason and the user chooses to re-download the file detect the previous files and resume instead of redownloading everything (I think yt-dlp supports hits already)


## Planned

-

## In Progress

-

## Done

-
