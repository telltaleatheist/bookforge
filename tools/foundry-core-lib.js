/**
 * Where a keeper reads the installed @owen/foundry-core and the book window from.
 *
 * The tarball ships compiled code rather than TypeScript, so `libText` is the
 * .js and the .d.ts together, bodies from the one and declarations from the
 * other, with tsc's CommonJS spellings put back: `(0, host_1.foundryHost)()` reads
 * `foundryHost()` and `export declare function` reads `export function`. A keeper
 * pinning a line of the library's source then reads the line it pinned.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'node_modules', '@owen', 'foundry-core');
const DIST = path.join(LIB, 'dist');
const NODE_DIST = path.join(DIST, 'node');
const SHARED_DIST = path.join(DIST, 'shared');
const ENGINE_BUNDLE = path.join(LIB, 'engine', 'foundry-engine.cjs');
const WINDOW_MAIN = path.join(REPO, 'foundry-app', 'electron');

/** One library module and the files it was split into (`job-queue` is also `job-queue-run`, ...). */
function libText(name) {
  const files = fs.readdirSync(NODE_DIST)
    .filter((file) => /\.(js|d\.ts)$/.test(file))
    .filter((file) => file.replace(/\.(js|d\.ts)$/, '') === name || file.startsWith(`${name}-`));
  if (files.length === 0) throw new Error(`no module ${name} in ${NODE_DIST}`);
  return files.sort()
    .map((file) => fs.readFileSync(path.join(NODE_DIST, file), 'utf8'))
    .join('\n')
    .replace(/\(0, [A-Za-z0-9_$]+_\d+\.([A-Za-z0-9_$]+)\)/g, '$1')
    .replace(/\b[A-Za-z0-9_$]+_\d+\.([A-Za-z0-9_$]+)/g, '$1')
    .replace(/\bexport declare (function|const|class)\b/g, 'export $1');
}

/** Every `ipc*.ts` of the window: the door table and its families. */
function windowIpcText() {
  return fs.readdirSync(WINDOW_MAIN)
    .filter((file) => /^ipc.*\.ts$/.test(file))
    .sort()
    .map((file) => fs.readFileSync(path.join(WINDOW_MAIN, file), 'utf8'))
    .join('\n');
}

module.exports = { REPO, LIB, DIST, NODE_DIST, SHARED_DIST, ENGINE_BUNDLE, WINDOW_MAIN, libText, windowIpcText };
