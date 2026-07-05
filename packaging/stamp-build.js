#!/usr/bin/env node
/**
 * Stamp build provenance into the compiled electron output.
 *
 * Writes dist/electron/build-info.json = { buildId, gitSha, builtAt, version }.
 *
 * Nothing at runtime reads this — it exists so an INSTALLED build can always be
 * traced to the exact commit + build time that produced it (open the file inside
 * the shipped app when "which build is this actually?" comes up; version numbers
 * alone have hidden a stale-build before). buildId is gitSha (+ dirty marker) +
 * timestamp, so no two builds ever share one.
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
// Unique per build: sha (+dirty marker) + timestamp. Two builds never collide.
const buildId = `${sha}${gitDirty() ? '-dirty' : ''}.${Date.now()}`;

// Record the auto-derived version (matches the .app's extraMetadata.version) so
// build-info.json is consistent with what app.getVersion() returns at runtime.
const info = { buildId, gitSha: sha, builtAt, version: computeVersion() };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(info, null, 2));
console.log(`[stamp-build] ${OUT}`);
console.log(`[stamp-build] buildId=${buildId} version=${info.version}`);
