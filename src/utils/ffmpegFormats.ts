// Verified against the bundled ffmpeg binary (`ffmpeg -muxers` + a real
// conversion per format): all single-file outputs, none segmented like
// hls/dash. Shown directly in the Library view's convert-to picker; the
// longer list below is only surfaced in Options.
export const POPULAR_CONVERT_FORMATS = ['mp4', 'mov', 'mkv', 'webm', 'avi'];

// Note for whoever wires these up: GIF (above) has no audio track, so audio
// silently drops. MPG/3GP/3G2 have fixed frame-rate/sample-rate constraints
// that require a real transcode, not just a remux.
export const SUGGESTED_EXTRA_CONVERT_FORMATS = ['flv', 'wmv', 'mpg', 'ts', '3gp', '3g2', 'ogv', 'vob'];
