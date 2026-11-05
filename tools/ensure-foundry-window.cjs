#!/usr/bin/env node
/**
 * ensure-foundry-window — build the book window's renderer when it is missing or
 * older than its sources. `npm run electron:dev` runs this first.
 *
 *   node tools/ensure-foundry-window.cjs
 *
 * The window's main half compiles in BookForge's own build:electron, but its
 * Angular renderer is a separate build in foundry-app/, to dist/foundry-app/renderer.
 * Without it the window opens on "The renderer did not load", which reads as a
 * broken app. So a dev start makes sure it is there and current:
 *
 *   - foundry-app/node_modules missing: `npm install` there first (a fresh clone).
 *     Only then: an install that is present is left as it is.
 *   - the built index.html missing, or older than the newest file the renderer is
 *     made from: `npm run build` there.
 *   - otherwise nothing, in a few milliseconds.
 *
 * Newest-mtime is the same honest proxy tools/run-keepers.js uses for dist/electron:
 * a build rewrites its outputs, so a build after the last edit always wins.
 */
'use strict';
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const WINDOW = path.join(REPO, 'foundry-app');
const INDEX = path.join(REPO, 'dist', 'foundry-app', 'renderer', 'browser', 'index.html');
/** What the renderer is built from: its sources, its config and the library it bundles. */
const INPUTS = [
  path.join(WINDOW, 'src'),
  path.join(WINDOW, 'angular.json'),
  path.join(WINDOW, 'package.json'),
  path.join(WINDOW, 'tsconfig.json'),
  path.join(WINDOW, 'tsconfig.app.json'),
  path.join(WINDOW, 'node_modules', '@owen', 'foundry-core', 'package.json'),
];

function newest(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return 0; }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let most = 0;
  for (const entry of fs.readdirSync(file)) most = Math.max(most, newest(path.join(file, entry)));
  return most;
}

function run(command) {
  console.log(`[foundry-window] foundry-app $ ${command}`);
  execSync(command, { cwd: WINDOW, stdio: 'inherit', env: process.env });
}

if (!fs.existsSync(path.join(WINDOW, 'node_modules'))) run('npm install --no-audit --no-fund');

const built = fs.existsSync(INDEX) ? fs.statSync(INDEX).mtimeMs : 0;
const source = Math.max(...INPUTS.map(newest));
if (built === 0) {
  console.log('[foundry-window] the window\'s renderer is not built yet');
  run('npm run build');
} else if (source > built) {
  console.log('[foundry-window] the window\'s renderer is older than its sources');
  run('npm run build');
} else {
  console.log('[foundry-window] the window\'s renderer is current');
}
