import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const { version } = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
const errors = [];

// Normalized before matching -- on Windows checkouts (core.autocrlf=true,
// the default there) these files are CRLF on disk, and a literal \n in the
// regexes below never matches inside a \r\n pair. Without this, both regex
// matches below silently fail on every Windows machine regardless of the
// actual README/CHANGELOG content, which is exactly the bug this comment is
// here to prevent someone from reintroducing.
const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf-8').replace(/\r\n/g, '\n');
const downloadSection = readme.match(/## Download\n([\s\S]*?)\n## /)?.[1];
if (!downloadSection) {
    errors.push('could not find the "## Download" section in README.md');
} else {
    const stale = [...new Set(downloadSection.match(/\d+\.\d+\.\d+/g) ?? [])].filter((v) => v !== version);
    if (stale.length > 0) {
        errors.push(`README.md's Download section still references ${stale.join(', ')} -- update the 5 download links (and the comment above them)`);
    }
}

const changelog = fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf-8');
if (!changelog.includes(`## [${version}]`)) {
    errors.push(`CHANGELOG.md has no "## [${version}]" entry -- add one for this release`);
}

if (errors.length > 0) {
    console.error(`package.json is at ${version}, but:`);
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
}
