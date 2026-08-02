const SUPPORTED_FORMATS = [
    'mp4',
    'mkv',
    '3gp',
]

const allVideoFilter = [{ name: 'All Files', extensions: ['*']}];

const getSupportedVideoFilters = () => {
    return [
        { name: 'Video Files', extensions: [...SUPPORTED_FORMATS] },
        ...allVideoFilter,
    ];
}


export { allVideoFilter, getSupportedVideoFilters };