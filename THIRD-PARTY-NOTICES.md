# Third-Party Notices

SlothArchiver bundles the following third-party software as compiled binaries
rather than requiring the user to install them separately. This file credits
those projects and states the license terms under which their binaries are
redistributed here.

## yt-dlp

- **What it does:** the extraction/download engine SlothArchiver uses for
  every platform it supports.
- **License:** [The Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)
  — a public domain dedication. Use, modification, and redistribution are
  unrestricted; no attribution is legally required, and this notice is
  included as a courtesy.
- **Project:** <https://github.com/yt-dlp/yt-dlp>
- **How it's bundled:** built from source at release time (not the official
  prebuilt binary) via PyInstaller, from the exact version pinned in
  `src/python/requirements-build.txt`.

## FFmpeg / FFprobe

- **What they do:** media processing — remuxing, format conversion, MP3
  extraction, and clipping.
- **License:** GNU General Public License v3 (GPLv3). Confirmed directly from
  the bundled binary's own `-version` output, which reports
  `--enable-gpl --enable-version3` along with GPL-only encoders (`libx264`,
  `libx265`) compiled in — this build is GPL-licensed, not the more
  permissive LGPL some ffmpeg builds use. Compatible with SlothArchiver's own
  GPL-3.0-or-later license.
- **Project:** <https://ffmpeg.org>
- **How they're bundled:** the prebuilt static binaries distributed via the
  [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) and
  [`ffprobe-static`](https://www.npmjs.com/package/ffprobe-static) npm
  packages, both sourced from
  [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)'s
  unified release build (ffmpeg 6.1.1 across every platform SlothArchiver
  supports).

---

SlothArchiver's own source code is licensed separately — see
[`LICENSE`](LICENSE) (GPL-3.0-or-later).
