#!/usr/bin/env node
/**
 * Stamp a unique build id into the compiled electron output.
 *
 * Writes dist/electron/build-info.json = { buildId, gitSha, builtAt, version }.
 *
 * The launcher uses buildId to decide whether a freshly-installed .app's baked
 * bundle differs from the one pinned in userData — so a REBUILD at the SAME
 * version number is still adopted on reinstall (no manual version bump needed;
 * see electron/launcher/bootstrap.ts). buildId is gitSha + build timestamp, so it
 * is unique for every build (a rebuild of identical source still gets a new id —
 * which is what we want: reinstalling always takes effect).
 *
 * Run as the last step of `build:electron`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const OUT = path.resolve(__dirname, '..', 'dist', 'electron', 'build-info.json');

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
}

function gitDirty() {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

const { computeVersion } = require('./app-version');
const sha = gitSha();
const builtAt = new Date().toISOString();
// Unique per build: sha (+dirty marker) + timestamp. Two builds never collide, so
// reinstalling any fresh package is always adopted by the launcher.
const buildId = `${sha}${gitDirty() ? '-dirty' : ''}.${Date.now()}`;

// Record the auto-derived version (matches the .app's extraMetadata.version) so
// build-info.json is consistent with what app.getVersion() returns at runtime.
const info = { buildId, gitSha: sha, builtAt, version: computeVersion() };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(info, null, 2));
console.log(`[stamp-build] ${OUT}`);
console.log(`[stamp-build] buildId=${buildId} version=${info.version}`);
