const SUPPORTED_FORMATS = [
    'mp4',
    'mkv',
    '3gp',
]

const allVideoFilter = [{ name: 'All Files', extensions: ['*']}];

// 'Audio Files' is a separate filter (not folded into SUPPORTED_FORMATS,
// which is video-recode formats only) so the Save dialog actually offers an
// mp3 option -- main.js's withTargetExtension is what guarantees the final
// file really lands on .mp3 for an MP3 download regardless of what's picked
// here, but leaving mp3 out of every filter entirely (the previous
// behavior) meant the dialog itself never showed the user a matching option.
const getSupportedVideoFilters = () => {
    return [
        { name: 'Video Files', extensions: [...SUPPORTED_FORMATS] },
        { name: 'Audio Files', extensions: ['mp3'] },
        ...allVideoFilter,
    ];
}


export { allVideoFilter, getSupportedVideoFilters };