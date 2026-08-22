const SUPPORTED_FORMATS = [
    'mp4',
    'mkv',
    '3gp',
]

const allVideoFilter = [{ name: 'All Files', extensions: ['*']}];

// 'Audio Files' is a separate filter (SUPPORTED_FORMATS is video-recode
// formats only) so the Save dialog actually offers an mp3 option --
// main.mjs's withTargetExtension guarantees the final file lands on .mp3
// regardless of what's picked here.
const getSupportedVideoFilters = () => {
    return [
        { name: 'Video Files', extensions: [...SUPPORTED_FORMATS] },
        { name: 'Audio Files', extensions: ['mp3'] },
        ...allVideoFilter,
    ];
}


export { allVideoFilter, getSupportedVideoFilters };