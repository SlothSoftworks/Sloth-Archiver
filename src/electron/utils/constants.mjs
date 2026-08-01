const SUPPORTED_FORMATS = [
    'mp4',
    'mkv',
    '3gp',
]

const allVideoFilter = [{ name: 'All Files', extensions: ['*']}];

const getSupportedVideoFilters = () => {
    const result = [{ name: 'Video Files', extensions: ['*']}];

    for(let format in SUPPORTED_FORMATS) {
        result[0].extensions.push(format);
    }
    return result;
}


export { allVideoFilter, getSupportedVideoFilters };