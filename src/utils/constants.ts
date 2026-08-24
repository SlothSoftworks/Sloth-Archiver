// Renderer-side constants shared across more than one file -- mirrors
// main.mjs's own MAX_SIMULTANEOUS_DOWNLOADS_CEILING, which can't be imported
// directly here (main process and renderer never cross-import in this
// codebase), so keep the two in sync by hand.
export const MAX_SIMULTANEOUS_DOWNLOADS_CEILING = 5;
