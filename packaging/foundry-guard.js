#!/usr/bin/env node
/**
 * Build the vendored Foundry subtree from its current source, every time a
 * package is made.
 *
 * `foundry-app/` is a VENDORED copy of the Foundry desktop app (see its
 * VENDORED.md) with its OWN toolchain, and its `dist/` and `node_modules/` are
 * gitignored, per-machine build output. Nothing else in package:mac /
 * package:win builds it, and electron-builder copies only what `build.files`
 * names.
 *
 * TWO SHIPPED FAILURES, ONE CAUSE: packaging trusted whatever build happened to
 * be on the disk.
 * - Until Aug 26 2026 `build.files` never mentioned foundry-app, so every
 *   packaged build died at launch with "Foundry is not built". The answer then
 *   was to refuse when `mount.js` was MISSING.
 * - 2026-10-02 the installer shipped a dist built Sep 29, three re-vendors
 *   stale. `mount.js` existed, so the guard passed, and the packaged clean step
 *   called `client.lease()`, which Crucible 1.0.76 removed. The row parked on
 *   "client.lease is not a function" forever.
 *
 * Present-but-stale passes any existence check, and a staleness check by mtime
 * is a guess (git checkouts stamp files with checkout time). So the subtree is
 * BUILT here, from what is checked out, and a package can only ever carry the
 * Foundry its own commit names. `npm install`, not `npm ci`: a running dev
 * server holds esbuild.exe open, and `npm ci` deletes node_modules first
 * (CLAUDE.md, Worktree Hygiene).
 *
 * Same contract as pkg-guard.js: every script that invokes electron-builder
 * must call this BEFORE spawning the builder.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const FOUNDRY = path.resolve(__dirname, '..', 'foundry-app');
const MOUNT = path.join(FOUNDRY, 'dist', 'electron', 'mount.js');

function buildVendoredFoundry(label) {
  for (const cmd of ['npm install --no-audit --no-fund', 'npm run build']) {
    console.log(`\n[${label}] foundry-app $ ${cmd}`);
    try {
      execSync(cmd, { cwd: FOUNDRY, stdio: 'inherit', env: process.env });
    } catch {
      console.error(`[${label}] REFUSING TO PACKAGE: building the vendored Foundry subtree failed at "${cmd}".`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(MOUNT)) {
    console.error(`[${label}] REFUSING TO PACKAGE: foundry-app built but ${MOUNT} is missing.`);
    process.exit(1);
  }
}

module.exports = { buildVendoredFoundry, FOUNDRY_MOUNT: MOUNT };
