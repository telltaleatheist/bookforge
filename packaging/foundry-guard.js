#!/usr/bin/env node
/**
 * Build the book window's renderer from its current source, every time a
 * package is made.
 *
 * `foundry-app/` is BookForge's book window. Its main-process half compiles in
 * BookForge's own `npm run build:electron`; its Angular renderer has its own
 * toolchain in `foundry-app/` and builds to `dist/foundry-app/renderer`, which
 * nothing else in package:mac / package:win builds.
 *
 * TWO SHIPPED FAILURES, ONE CAUSE: packaging trusted whatever build happened to
 * be on the disk.
 * - Until Aug 26 2026 `build.files` never mentioned the window, so every
 *   packaged build died at launch with "Foundry is not built".
 * - 2026-10-02 the installer shipped a window built Sep 29, three copies stale,
 *   whose clean step called `client.lease()`, which Crucible 1.0.76 removed.
 *
 * Present-but-stale passes any existence check, and a staleness check by mtime
 * is a guess (git checkouts stamp files with checkout time). So the renderer is
 * BUILT here, from what is checked out. `npm install`, not `npm ci`: a running
 * dev server holds esbuild.exe open, and `npm ci` deletes node_modules first
 * (CLAUDE.md, Worktree Hygiene).
 *
 * Same contract as pkg-guard.js: every script that invokes electron-builder
 * must call this BEFORE spawning the builder.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const WINDOW = path.resolve(__dirname, '..', 'foundry-app');
const RENDERER_INDEX = path.resolve(__dirname, '..', 'dist', 'foundry-app', 'renderer', 'browser', 'index.html');

function buildVendoredFoundry(label) {
  for (const cmd of ['npm install --no-audit --no-fund', 'npm run build']) {
    console.log(`\n[${label}] foundry-app $ ${cmd}`);
    try {
      execSync(cmd, { cwd: WINDOW, stdio: 'inherit', env: process.env });
    } catch {
      console.error(`[${label}] REFUSING TO PACKAGE: building the book window's renderer failed at "${cmd}".`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(RENDERER_INDEX)) {
    console.error(`[${label}] REFUSING TO PACKAGE: foundry-app built but ${RENDERER_INDEX} is missing.`);
    process.exit(1);
  }
}

module.exports = { buildVendoredFoundry, FOUNDRY_RENDERER_INDEX: RENDERER_INDEX };
