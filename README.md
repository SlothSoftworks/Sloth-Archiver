# SlothArchiver

[![Latest Release](https://img.shields.io/github/v/release/SlothSoftworks/Sloth-Archiver)](https://github.com/SlothSoftworks/Sloth-Archiver/releases/latest)
[![CI](https://github.com/SlothSoftworks/Sloth-Archiver/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/SlothSoftworks/Sloth-Archiver/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-informational)](#download)

**Your own personal, offline video archive — for people who like to keep their video archiving sweet and simple and not fight with
Docker, servers, or a complicated setup to get one.**

<p align="center">
  <img src="assets/icon.png" alt="SlothArchiver" width="200">
</p>
<p align="center">
  <sub>Logo by <a href="https://www.instagram.com/grek.jpg/" target="_blank" rel="noopener noreferrer">@grek.jpg</a></sub>
</p>


*Free and open source — no subscriptions, no accounts, no server to run.*

SlothArchiver is a free desktop app for downloading and organizing videos and audio
from YouTube and other platforms into a permanent library on your own computer.
Install it, point it at a folder, and it does the archiving for you — no
subscriptions, no re-uploading to yet another cloud service, no losing access
when a video gets taken down or a channel disappears. The name isn't ironic:
this app is built around doing as little work as possible, for you and for
itself.

## Download

<!-- Update the version in these 5 links on every release -- currently 1.0.0.
     Each filename must match exactly what GitHub actually named the asset on
     the release page -->

| Platform | Link |
|---|---|
| Windows (installer) | [Download](https://github.com/SlothSoftworks/Sloth-Archiver/releases/download/v1.0.0/SlothArchiver.Setup.1.0.0.exe) |
| Windows (portable, no install) | [Download](https://github.com/SlothSoftworks/Sloth-Archiver/releases/download/v1.0.0/SlothArchiver.1.0.0.exe) |
| macOS (Apple Silicon) | [Download](https://github.com/SlothSoftworks/Sloth-Archiver/releases/download/v1.0.0/SlothArchiver-1.0.0-arm64.dmg) |
| macOS (Intel) | [Download](https://github.com/SlothSoftworks/Sloth-Archiver/releases/download/v1.0.0/SlothArchiver-1.0.0.dmg) |
| Linux (AppImage) | [Download](https://github.com/SlothSoftworks/Sloth-Archiver/releases/download/v1.0.0/SlothArchiver-1.0.0.AppImage) |

All builds are unsigned, so your OS will show a first-run security warning —
see [Installing](#installing) below.

## What is SlothArchiver?

Videos on the internet aren't permanent — creators delete them, channels get taken
down, platforms change their terms, and links quietly rot. SlothArchiver exists to give
you a real, local copy of the videos and audio that matter to you, organized and
easy to find again, playable straight from the app whether or not you're online.

Paste a link, pick a quality, and it's yours — saved, catalogued, and searchable, on
your own machine.

## Why SlothArchiver?

Most tools in this space make you work for a real archive. Self-hosted servers give
you one, but only if you're willing to run Docker, manage a server, and keep a
machine on around the clock. Lightweight desktop downloaders skip all of that
setup, but most of them just drop files in a folder and call it done — no real
organization, nothing actually archived, just a pile of files you have to manage
yourself and the ones that do have some sort of paywall. So I got tired of waiting for the solution and started to develop it myself.

SlothArchiver is built to be the lazy option in the best sense: a normal app you
install like any other, with zero server to babysit and zero config to get right.
Point it at a folder once, and a real searchable library, playlist tracking, and
version history all happen automatically from there — the app does the tedious
bookkeeping so you don't have to, and it's free, in full, with no plan to change
that.

| | **SlothArchiver** | Arroxy | TubeArchiver | TubeArchivist / Pinchflat |
|---|:---:|:---:|:---:|:---:|
| Free, no paywall | ✅ | ✅ | ❌ (tiered plans) | ✅ |
| Open source | ✅ | ✅ | ❌ | ✅ |
| Runs locally — no Docker or server | ✅ | ✅ | ✅ | ❌ |
| Real searchable library (not just a folder) | ✅ | ❌ | ❌ (history list only) | ✅ |
| Playlist tracking that detects removed videos | ✅ | ❌ | ❌ (one-time fetch) | ✅ |
| Per-video version history | ✅ | ❌ | ❌ | ❌ |
| Library is plain files — no hidden database | ✅ | ✅ | N/A | ❌ (Elasticsearch) |
| Built-in playback in the app | ✅ | ❌ | ❌ | ✅ (web UI) |
| In-app clipping, MP3 extraction & format tools | ✅ | ❌ | ❌ | ❌ |
| macOS / Windows / Linux | ✅ | ✅ | Mac/Win only | ✅ (via Docker) |

No other tool in this space currently checks every one of those boxes at once —
that combination is the whole point of SlothArchiver — a simple catalogued library, organized in one place and fully local.

## Features

- **No paywall, ever** — every feature below is free today and will stay free in
  future updates. No tiers, no locked resolutions, no daily download caps.
- **Download video or audio** from YouTube and virtually any other site yt-dlp
  supports — 1800+ platforms, including SoundCloud, TikTok, Instagram, Facebook,
  Dailymotion, and more — in the quality you choose.
- **A real library, not just a downloads folder** — every video is organized by
  channel, searchable, and keeps a history of versions if you ever re-fetch it.
  Most downloaders stop at "file saved somewhere"; SlothArchiver actually keeps
  track of what you have.
- **Playlist archiving** — save an entire playlist at once, and refresh it later to
  pick up new additions without losing what you already have, with removed videos
  automatically flagged instead of silently disappearing.
- **Bulk downloading** — paste a whole list of links or a playlist and let the app
  work through them in the background, several at a time.
- **Built-in playback** — watch or listen to anything in your library right inside
  the app, no need to hunt for the file afterward.
- **Handy media tools** — extract audio as MP3, convert formats, trim clips, and
  embed metadata/cover art, all without leaving the app.
- **Stays current** — the app can update its own download engine on demand, so it
  keeps working as sites change.

## Demos

A quick look at some of the features that make SlothArchiver more than just a
download button.

### Playlist saving & bulk downloading

No more staring at a wall of "Video unavailable" placeholders. Save a playlist
once and SlothArchiver remembers exactly what was on it — title, thumbnail, and
order — even for videos that later get pulled, so you always know what you're
missing, and you can keep the whole thing downloaded locally so you never have
to find out at all. The same bulk engine also takes a plain list of links
pasted in at once, working through them several at a time in the background
with per-item progress, retry, and skip, so one bad link never holds up the
rest.

<img width="800" height="433" alt="playlist" src="https://github.com/user-attachments/assets/cb1308fa-e135-44d6-8350-f405ad774606" />

### Version history

Tired of a video getting edited, re-uploaded, or quietly censored after the
fact? Download the original before it changes, and if a newer version comes
along later, grab that too — SlothArchiver keeps both side by side instead of
overwriting what you already had. This is a level of history most archivers,
paid or free, don't track at all.

<img width="800" alt="demo_versions" src="https://github.com/user-attachments/assets/b80e7155-3e30-434a-ad19-8e291c43f77c" />

### Handles seriously long videos

Thanks to working directly with yt-dlp at a low level instead of a lightweight
wrapper, SlothArchiver can pull down videos that trip up other tools — tested
successfully on uploads up to 12 hours long.

<img width="800" height="440" alt="long-videos" src="https://github.com/user-attachments/assets/3fb866f9-4972-448c-a324-c2ab1e7ac937" />

### Up to 8K quality

SlothArchiver supports every quality YouTube (and whatever platform the
source video is on) actually offers — up to and including 8K, personally
tested at 4320p.

<img width="800" alt="demo_8k" src="https://github.com/user-attachments/assets/fd0e7d20-170c-4ec7-b479-375050922165" />

### Fast library search & sorting

Find anything in your archive in seconds. Search across your whole library,
sort by date, channel, title, or quality, and browse by channel or by
playlist — whichever fits how you think about your collection.

<img width="800" height="433" alt="library-org" src="https://github.com/user-attachments/assets/cba4b7c2-7acb-40dc-a754-21e26e577c2e" />

### Light footprint, no lock-in

Your library lives as plain files and folders — nothing hidden in a database
you can't get to, and no Elasticsearch or Redis instance to maintain in the
background. Want it gone? Delete the folder and it's gone, completely, with
nothing left behind.

<img width="800" height="438" alt="library-files" src="https://github.com/user-attachments/assets/92018182-c136-4c57-9293-605fd13f7dbe" />

### Built-in media utilities

Extract the audio as an MP3, embed metadata and cover art, cut out just the
clip you want at full quality, or convert to any format ffmpeg supports —
all straight from the library view, no other software required.

<img width="800" height="433" alt="clipping" src="https://github.com/user-attachments/assets/ab42cf7e-fde4-46b4-abd1-dc6f58e80d87" />

### Download from virtually any site yt-dlp supports

Not just YouTube — SlothArchiver works with virtually any of the
[1800+ sites yt-dlp itself supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md),
including SoundCloud, TikTok, Instagram, Facebook, Dailymotion, Archive.org and more.
Paste a link from any of them and SlothArchiver figures out the platform
automatically and gets you a download, no separate tool needed for each site.

<img width="800" height="433" alt="more-platforms" src="https://github.com/user-attachments/assets/5e361fba-d0a6-4547-8716-24076ca6e936" />

## How it works

SlothArchiver runs everything locally on your computer — there's no server, no
account, and nothing about your library ever leaves your machine unless you move it
yourself. For a deeper, more technical look at how the app is put together, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## FAQ

#### How is this different from other YouTube downloaders?
Most tools fall into one of two camps: self-hosted servers (like TubeArchivist or
Pinchflat) that need Docker and a machine running around the clock, or desktop
downloaders are built to save files but don't keep an actual
library — and some of those eventually put real features behind a subscription.
SlothArchiver is a normal desktop app with a real searchable library, playlist
tracking, and version history, and it's free without any tier to upgrade to. See the
[Why SlothArchiver?](#why-slotharchiver) section above for a fuller comparison.

#### Is SlothArchiver free?
Yes, it's free and open source.

#### Is it legal to download videos with this app?
The app uses yt-dlp to download the video and metadata, which acts as a browser under the hood — for the most part, it works the same way a real viewer's browser would: it requests a public page and reads back whatever that page already serves. For a few platforms, yt-dlp also has to mimic a real browser more closely (matching the kind of request a browser sends) to get past automated bot-detection checks — this doesn't unlock anything private or bypass any actual access control, it's just what's needed to be treated the same as a normal visitor rather than getting blocked as a script. Either way, nothing here involves hacking, cracking DRM, or accessing content that wasn't already publicly available to anyone with a browser. YouTube, however, doesn't approve the use of these tools or any means of downloading videos even if they are public.

This software is designed to work with yt-dlp and its functionalities without adding anything other than a layer of user interface and QoL features on top. This app is not designed or tested to be used to violate copyright, bypass DRM, or platform restrictions, and I don't condone the use of this app for that or any illegal purpose.

SlothArchiver is a personal-use, local tool — everything it downloads stays in your own library on your own machine. It doesn't upload, host, re-share, or otherwise distribute anything you download with anyone else. What you do with the files afterward, and whether that complies with a given platform's Terms of Service or the copyright law in your jurisdiction, is your responsibility as the user, not something this app enforces or takes a position on for you.

>TL;DR: It's a gray area as far as YouTube is concerned but not illegal. This is a personal, local-only archiving tool — staying within your platform's ToS and your local copyright law is on you.

#### What platforms does SlothArchiver support downloading from?
At time of writing we support YouTube for downloads, library, and playlists. For pure downloads, we support virtually any site [yt-dlp itself supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) — 1800+ platforms — including TikTok, Instagram, Twitter, Facebook, SoundCloud, and Dailymotion, to name a few with dedicated recognition in the app's UI.

#### What operating systems does SlothArchiver run on?
Currently we support Mac, Linux, and Windows. This is a solo dev operation and I manually create the executables per system, so I expect there could be OS issues as more people try out the software on their systems. If you experience any issues, let me know by raising an issue and detailing it there.

#### Where are my downloaded videos stored?
For library entries: on your first installation you need to set up a library folder in your system. This will be taken as the base path from which all your downloads will be added. After setting this up, I suggest not moving or changing the files unless you know what you're doing, since the app is designed to work with the filesystem and expects it to be consistent.

For downloads: the system will let you pick where to download the file when you click on any of the download buttons. You can also choose to add a base download path that will be set as the default starting path whenever you make future downloads.

#### Do I need a YouTube account or to sign in?
No, it can work without a YouTube account, however keep in mind you might be locked out of downloading certain videos (i.e. age-restricted ones) when downloading, or you could get locked out by YouTube if it detects you're downloading too many videos.

#### Why would I need to load cookies / sign in?
For most scenarios you won't need to add cookies, it would only be mandatory for scenarios like age restricted videos or members-only content. [According to yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies) exporting cookies to download at a high rate can result in suspension or bans to your account and they encourage using the feature in moderation or make use of throwaway accounts. 
From our side at SlothArchiver we try offer the best resilience for download retries and recovery to make the user experience better and you don't need to use Cookies for most scenarios.


#### What video quality can I download?
For YouTube and Dailymotion, all of the video qualities that yt-dlp supports will be displayed for download, personally tested up to 4320p aka 8k resolution. Of course it depends on the source video.

#### Can I download an entire playlist?
For YouTube, yes. As of now this is only supported as part of a bulk add feature which saves both the playlist and the video data in your library. For other platforms it's not supported.

#### Does SlothArchiver collect any of my data?
No, I designed the app precisely not to collect or require data anywhere whenever possible. That is also the reason the library management is done via pure filesystem instead of depending on a local database.

#### Why does the app set up extra components on first run?
yt-dlp and ffmpeg (the low-level tools that handle actual downloading and media processing) are bundled directly inside the installer itself, not fetched over the network afterward. The one thing that does happen on first run is copying yt-dlp into a per-user writable folder, since the app needs to be able to replace it later (see the next question) and the installer's own resources folder generally isn't writable without elevated permissions.

#### How do I update SlothArchiver?
Come back to this page and click on the download button for your platform. It's also worth noting that the "update yt-dlp" feature inside the app doesn't update the archiver app itself, only the low-level download library, and you might need to make sure you have both of them properly updated before using the app.

#### A download is failing or I'm getting a "bot check" error — what do I do?
Hopefully this doesn't happen often, but in these scenarios you can either add your cookie to the app and try again, or wait until your IP stops getting locked by YouTube. You may also use something like a VPN to try to change your IP and try again. Keep in mind YouTube's bot detection is unpredictable, so sometimes just clicking try again is enough — it's all a matter of trying it out and seeing what works.

#### How do I report a bug or request a feature?
Raise an issue, but only if you have the proper evidence and description on how to reproduce it for bugs, or a good description of the feature you'd like to see — otherwise I can't work on it. As I mentioned this is a solo project, so keep in mind I can only work on this in my free time.

#### What features are still in development?
Check the [Roadmap](ROADMAP.md) for a running list of what's currently being worked on or explored.

#### Do you accept contributions?
At this moment in time I don't but once I prepare a proper contribution guide and a pipeline and if an actual community forms for this app I might.

## Installing

SlothArchiver's builds aren't code-signed (that requires a paid yearly certificate
this solo project doesn't have) — so the first time you open one, your OS
will warn you it's from an unidentified/unrecognized developer. This is
expected for any unsigned app, not a sign anything's actually wrong.
Here's how to get past each OS's warning:

**Windows** — you'll see "Windows protected your PC" (SmartScreen). Click
**More info**, then **Run anyway**.

Step 1 — click **More info**:

<img width="532" height="498" alt="Windows SmartScreen: click More info" src="https://github.com/user-attachments/assets/3b11a6f1-c797-4262-a851-99842ec3f7e4" />

Step 2 — click **Run anyway**:

<img width="532" height="498" alt="Windows SmartScreen: click Run anyway" src="https://github.com/user-attachments/assets/f746e0e6-d41f-4abf-9814-45a3e9cbe66c" />

**macOS** — you'll see a message that the app "cannot be opened because it is
from an unidentified developer," and just double-clicking won't offer a way
past it. Instead: right-click (or Control-click) the app → **Open** → confirm
**Open** in the dialog that appears. You only need to do this once — after
that, it opens normally.

Step 1 — the Gatekeeper block you'll see on first launch:

<img width="260" alt="macOS: cannot be opened, unidentified developer" src="https://github.com/user-attachments/assets/d06a069a-381b-42ea-ac71-a1a2461e2542" />

If macOS still blocks it, go to **System Settings → Privacy & Security**,
scroll down to the security section, and click **Open Anyway** next to the
message about SlothArchiver.

Step 2 — find the security section in **Privacy & Security**:

<img width="652" alt="macOS: Privacy & Security section" src="https://github.com/user-attachments/assets/65999064-803b-4cd3-9b11-08fb45778469" />

Step 3 — click **Open Anyway**:

<img width="700" alt="macOS: click Open Anyway" src="https://github.com/user-attachments/assets/131abfdb-eb96-445e-b1d4-fdb836b9b9a4" />

**Linux (AppImage)** — make it executable first, then run it directly:
```
chmod +x SlothArchiver-<version>.AppImage
./SlothArchiver-<version>.AppImage
```
If it fails to launch at all with a FUSE-related error, your distro likely
needs `libfuse2` installed (common on newer distros that dropped FUSE2 by
default, e.g. recent Ubuntu/Fedora releases) — install it via your package
manager and try again.

## Support the author

SlothArchiver is free and will stay that way, no strings attached. If you'd
like to support the person building and maintaining it, see
[DONATION.md](DONATION.md) for ways to donate — entirely optional, and never
required to use any part of the app.