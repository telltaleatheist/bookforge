/**
 * Package the built extension into a distributable zip.
 *
 * Run AFTER `node build.mjs --dist` (see the `package` npm script). Produces
 * `bookforge-reader-<version>.zip` whose contents sit inside a top-level
 * `bookforge-reader/` folder, so a user unzips it and gets one clean folder to
 * point Chrome's "Load unpacked" at. (For a Chrome Web Store upload you'd zip the
 * dist/ contents at the archive ROOT instead — see README.)
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FOLDER = 'bookforge-reader';
const { version } = JSON.parse(readFileSync('static/manifest.json', 'utf8'));
const zipName = `${FOLDER}-${version}.zip`;

// Sanity: the build must have run first.
try {
  statSync(join('dist', 'manifest.json'));
} catch {
  console.error('[package] dist/ not built — run `node build.mjs --dist` first.');
  process.exit(1);
}

// Stage dist/ under a named wrapper folder so the zip extracts cleanly.
const stage = join('.package-staging', FOLDER);
rmSync('.package-staging', { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync('dist', stage, { recursive: true });

rmSync(zipName, { force: true });
// ditto -c -k --sequesterRsrc keeps the zip free of macOS __MACOSX/AppleDouble
// cruft that confuses Chrome's unpacked loader.
execSync(`ditto -c -k --sequesterRsrc --keepParent "${stage}" "${zipName}"`, { stdio: 'inherit' });
rmSync('.package-staging', { recursive: true, force: true });

const mb = (statSync(zipName).size / (1024 * 1024)).toFixed(2);
console.log(`[package] wrote ${zipName} (${mb} MB) — unzip → chrome://extensions → Developer mode → Load unpacked → ${FOLDER}/`);
