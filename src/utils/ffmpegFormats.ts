// Confirmed directly against this app's bundled ffmpeg binary (`ffmpeg
// -muxers`, then a real conversion test per format) -- every one of these
// writes a single regular file at a plain output path, none are inherently
// segmented/multi-file the way hls/dash are. Split into a small "popular"
// default set (shown directly in the Library view's convert-to picker) and
// a longer suggested list only surfaced in Options, for anyone who wants to
// add one of their own without typing a muxer name from memory.
export const POPULAR_CONVERT_FORMATS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'gif'];

// Known-good muxers not in the popular set above. GIF (in the popular set)
// has no audio track at all -- any audio silently drops. MPG/3GP/3G2 here
// have real codec constraints (fixed frame rates/audio sample rates) that a
// real conversion needs to transcode for, not just remux -- a concern for
// whenever this actually gets wired up, not this list itself.
export const SUGGESTED_EXTRA_CONVERT_FORMATS = ['flv', 'wmv', 'mpg', 'ts', '3gp', '3g2', 'ogv', 'vob'];
