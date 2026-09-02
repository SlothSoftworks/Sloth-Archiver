import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // .venv-build is the Python venv build-ytdlp-bin.mjs creates locally (pip-
  // installed packages, including vendored/minified JS files from yt-dlp's
  // own JS-challenge solver and urllib3) -- never source this repo owns, and
  // not present in a fresh checkout, but picked up by the **/*.{js,mjs} glob
  // below whenever it exists on disk.
  { ignores: ['dist', '.venv-build', 'build'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  // Electron main process + build scripts -- plain Node ESM, no bundler/JSX,
  // previously outside this config's `files` scope entirely (CC-013,
  // reports/cleanCodeAnalysis.md).
  {
    extends: [js.configs.recommended],
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  // The one CommonJS file in this otherwise all-ESM app: Electron's
  // sandboxed preload loader doesn't support import/export syntax.
  {
    extends: [js.configs.recommended],
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
)
