# Security Policy

## Reporting a vulnerability

If you find a security issue in SlothArchiver, please report it privately
rather than opening a public GitHub issue — that gives time to look into it
and, if needed, ship a fix before the details are public.

**Email: sloth.software.dev@protonmail.com**

Please include, as far as you're able to:

- A description of the issue and why it's a security concern, not just a bug
- Steps to reproduce it, or a proof of concept if you have one
- The affected version (Options tab in the app, or the release you
  downloaded)
- Your OS, since some issues are platform-specific

You should get a response within a few days. This is a solo-maintained
project, so please bear with me if it takes a little longer than that —
you'll still hear back.

## Scope

This covers SlothArchiver's own code — the Electron app, its IPC surface,
and how it handles local files and bundled binaries. It does **not** cover
vulnerabilities in the third-party tools it bundles (`yt-dlp`, `ffmpeg`) —
those should be reported directly to their own projects, linked from
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Disclosure

Please give a reasonable amount of time to investigate and fix a reported
issue before disclosing it publicly. There's no bug bounty program — this is
a free, solo-maintained project — but credit is happily given in the fix's
release notes if you'd like it.
