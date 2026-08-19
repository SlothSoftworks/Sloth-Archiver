# YTArchiver

**Your own personal, offline video archive.**

YTArchiver is a free desktop app for downloading and organizing videos and audio
from YouTube and other platforms into a permanent library on your own computer —
no subscriptions, no re-uploading to yet another cloud service, no losing access
when a video gets taken down or a channel disappears.

## Download

> 🚧 Downloads coming soon.

| Platform | Link |
|---|---|
| macOS | [Download](#) |
| Windows | [Download](#) |
| Linux | [Download](#) |

## What is YTArchiver?

Videos on the internet aren't permanent — creators delete them, channels get taken
down, platforms change their terms, and links quietly rot. YTArchiver exists to give
you a real, local copy of the videos and audio that matter to you, organized and
easy to find again, playable straight from the app whether or not you're online.

Paste a link, pick a quality, and it's yours — saved, catalogued, and searchable, on
your own machine.

## Features

- **Download video or audio** from YouTube and a growing list of other platforms
  (SoundCloud, TikTok, Instagram, Facebook, Dailymotion, and more), in the quality
  you choose.
- **A real library, not just a downloads folder** — every video is organized by
  channel, searchable, and keeps a history of versions if you ever re-fetch it.
- **Playlist archiving** — save an entire playlist at once, and refresh it later to
  pick up new additions without losing what you already have.
- **Bulk downloading** — paste a whole list of links or a playlist and let the app
  work through them in the background, several at a time.
- **Built-in playback** — watch or listen to anything in your library right inside
  the app, no need to hunt for the file afterward.
- **Handy media tools** — extract audio as MP3, convert formats, trim clips, and
  embed metadata/cover art, all without leaving the app.
- **Stays current** — the app can update its own download engine on demand, so it
  keeps working as sites change.

## Demos

A quick look at some of the features that make YTArchiver more than just a
download button. *(Drop a gif or short clip in each spot below — `docs/media/`
is a good place to keep them, referenced here as `docs/media/<name>.gif`.)*

### Playlist saving

No more staring at a wall of "Video unavailable" placeholders. Save a playlist
once and YTArchiver remembers exactly what was on it — title, thumbnail, and
order — even for videos that later get pulled, so you always know what you're
missing, and you can keep the whole thing downloaded locally so you never have
to find out at all.

![Demo: playlist saving](docs/media/playlist-saving.gif)

### Version history

Tired of a video getting edited, re-uploaded, or quietly censored after the
fact? Download the original before it changes, and if a newer version comes
along later, grab that too — YTArchiver keeps both side by side instead of
overwriting what you already had.

![Demo: version history](docs/media/version-history.gif)

### Handles seriously long videos

Thanks to working directly with yt-dlp at a low level instead of a lightweight
wrapper, YTArchiver can pull down videos that trip up other tools — tested
successfully on uploads over 9 hours long.

![Demo: large video download](docs/media/large-video-download.gif)

### Fast library search & sorting

Find anything in your archive in seconds. Search across your whole library,
sort by date, channel, title, or quality, and browse by channel or by
playlist — whichever fits how you think about your collection.

![Demo: library search and sorting](docs/media/library-search-sorting.gif)

### Light footprint, no lock-in

Your library lives as plain files and folders — nothing hidden in a database
you can't get to. Want it gone? Delete the folder and it's gone, completely,
with nothing left behind.

![Demo: library filesystem layout](docs/media/library-filesystem.gif)

### Built-in media utilities

Extract the audio as an MP3, embed metadata and cover art, cut out just the
clip you want at full quality, or convert to any format ffmpeg supports —
all straight from the library view, no other software required.

![Demo: media utilities](docs/media/media-utilities.gif)

### Download from more than just YouTube

SoundCloud, TikTok, Instagram, Facebook, Dailymotion, and more — paste a link
from any of them and YTArchiver figures out the platform automatically and
gets you a download, no separate tool needed for each site.

![Demo: multi-platform downloads](docs/media/multi-platform-downloads.gif)

### Bulk downloading with live progress

Paste a whole playlist or a big list of links at once and walk away —
YTArchiver works through them several at a time in the background, with
per-item progress, retry, and skip, so one bad link never holds up the rest.

![Demo: bulk downloading](docs/media/bulk-downloading.gif)

## How it works

YTArchiver runs everything locally on your computer — there's no server, no
account, and nothing about your library ever leaves your machine unless you move it
yourself. For a deeper, more technical look at how the app is put together, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## FAQ

#### Is YTArchiver free?
Yes, it's free and open source.

#### Is it legal to download videos with this app?
The app uses yt-dlp to download the video and metadata, which acts as a browser under the hood — for the most part, it works the same way a real viewer's browser would: it requests a public page and reads back whatever that page already serves. For a few platforms, yt-dlp also has to mimic a real browser more closely (matching the kind of request a browser sends) to get past automated bot-detection checks — this doesn't unlock anything private or bypass any actual access control, it's just what's needed to be treated the same as a normal visitor rather than getting blocked as a script. Either way, nothing here involves hacking, cracking DRM, or accessing content that wasn't already publicly available to anyone with a browser. YouTube, however, doesn't approve the use of these tools or any means of downloading videos even if they are public.

This software is designed to work with yt-dlp and its functionalities without adding anything other than a layer of user interface and QoL features on top. This app is not designed or tested to be used to violate copyright, bypass DRM, or platform restrictions, and I don't condone the use of this app for that or any illegal purpose.

>TL;DR: It's a gray area as far as YouTube is concerned but not illegal.

#### What platforms does YTArchiver support downloading from?
At time of writing we support YouTube for downloads, library, and playlists. We support TikTok, Instagram, Twitter, Facebook, SoundCloud, and Dailymotion for pure downloads.

#### What operating systems does YTArchiver run on?
Currently we support Mac, Linux, and Windows. This is a solo dev operation and I manually create the executables per system, so I expect there could be OS issues as more people try out the software on their systems. If you experience any issues, let me know by raising an issue and detailing it there.

#### Where are my downloaded videos stored?
For library entries: on your first installation you need to set up a library folder in your system. This will be taken as the base path from which all your downloads will be added. After setting this up, I suggest not moving or changing the files unless you know what you're doing, since the app is designed to work with the filesystem and expects it to be consistent.

For downloads: the system will let you pick where to download the file when you click on any of the download buttons. You can also choose to add a base download path that will be set as the default starting path whenever you make future downloads.

#### Do I need a YouTube account or to sign in?
No, it can work without a YouTube account, however keep in mind you might be locked out of downloading certain videos (i.e. age-restricted ones) when downloading, or you could get locked out by YouTube if it detects you're downloading too many videos.

#### Why would I need to load cookies / sign in?
Cookies might be needed so your downloads can be done in case YouTube were to flag you for downloading. How it works is that it would usually flag your IP and lock you out of accessing their data — if this happens, only having a cookie will let you continue fetching data from them. In that scenario is when you might need to load the cookies, and that's why the feature exists on this app and yt-dlp.

#### What video quality can I download?
For YouTube and Dailymotion, all of the video qualities that yt-dlp supports will be displayed for download, personally tested up to 4320p aka 8k resolution. Of course it depends on the source video.

#### Can I download an entire playlist?
For YouTube, yes. As of now this is only supported as part of a bulk add feature which saves both the playlist and the video data in your library. For other platforms it's not supported.

#### Does YTArchiver collect any of my data?
No, I designed the app precisely not to collect or require data anywhere whenever possible. That is also the reason the library management is done via pure filesystem instead of depending on a local database.

#### Why does the app need to download extra components on first run?
These components are required for the low-level features of the app, which include yt-dlp and Deno, which support the download for videos and metadata. And ffmpeg, which supports the extra features like converting your download to MP3 or making clips inside the library view.

#### How do I update YTArchiver?
Come back to this page and click on the download button for your platform. It's also worth noting that the "update yt-dlp" feature inside the app doesn't update the archiver app itself, only the low-level download library, and you might need to make sure you have both of them properly updated before using the app.

#### A download is failing or I'm getting a "bot check" error — what do I do?
Hopefully this doesn't happen often, but in these scenarios you can either add your cookie to the app and try again, or wait until your IP stops getting locked by YouTube. You may also use something like a VPN to try to change your IP and try again. Keep in mind YouTube's bot detection is unpredictable, so sometimes just clicking try again is enough — it's all a matter of trying it out and seeing what works.

#### How do I report a bug or request a feature?
Raise an issue, but only if you have the proper evidence and description on how to reproduce it for bugs, or a good description of the feature you'd like to see — otherwise I can't work on it. As I mentioned this is a solo project, so keep in mind I can only work on this in my free time.

### Do you accept contributions?
At this moment in time I don't but once I prepare a proper contribution guide and a pipeline and if an actual community forms for this app I might.