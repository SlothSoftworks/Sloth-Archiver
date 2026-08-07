// Pure type-checking aid, no runtime effect: makes jest-dom's matcher types
// (toBeInTheDocument, toHaveAttribute, toBeVisible, ...) visible to `tsc -b`
// for every test file under src/. The runtime side of this (actually
// extending `expect`) is handled separately by vitest.setup.ts's
// `import '@testing-library/jest-dom/vitest'` -- that file lives at the repo
// root, outside tsconfig.app.json's `include: ["src"]`, so tsc never picks
// up its type augmentation on its own.
/// <reference types="@testing-library/jest-dom" />
