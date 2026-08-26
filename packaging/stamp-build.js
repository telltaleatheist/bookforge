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
  // A stage cut with `git archive` has no .git — the deploy recipe passes the
  // sha it extracted instead (TITAN.md). The override IS the provenance there.
  if (process.env.BOOKFORGE_BUILD_SHA) return process.env.BOOKFORGE_BUILD_SHA.trim();
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // REFUSE rather than stamp 'nogit'. This file exists so an installed build
    // can always be traced to its commit; a build that writes 'nogit' destroys
    // exactly that, silently, and the staged-deploy recipe shipped one before
    // anyone noticed (bookforge-pc-3, 2026-08-26 — it held the deploy rather
    // than ship the lie). No git and no override is a misconfigured build.
    console.error('[stamp-build] No .git here and BOOKFORGE_BUILD_SHA is not set. '
      + 'Refusing to stamp a build nobody can trace — pass the sha this tree was '
      + 'extracted from (see TITAN.md, "Deploying an update").');
    process.exit(1);
  }
}

function gitDirty() {
  // An archive-extracted stage is clean BY CONSTRUCTION — it holds exactly one
  // commit's bytes — so the override implies not-dirty.
  if (process.env.BOOKFORGE_BUILD_SHA) return false;
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
