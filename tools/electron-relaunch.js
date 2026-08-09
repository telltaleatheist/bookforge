#!/usr/bin/env node
/**
 * Put a harness where a browser exists.
 *
 * Anything that analyzes an EPUB now goes through quire, and quire paginates in
 * a real `BrowserWindow` — so a harness that calls `PDFAnalyzer` on a book has
 * to run under Electron. `tools/test-quire.js` has done this since the package
 * existed; this is the same three lines, in one place, for the harnesses that
 * inherited the requirement rather than choosing it.
 *
 * Call it BEFORE the harness makes any temp directories: the process is
 * replaced, and anything the first one created is left behind.
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

function relaunchUnderElectron(entryFile) {
  if (process.versions.electron) return;
  const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  const result = spawnSync(electron, [entryFile, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  process.exit(result.status === null ? 1 : result.status);
}

/**
 * Everything quire needs from the host, done once: the scheme registered before
 * the app is ready, and the app told not to quit when the analysis window it
 * makes and destroys leaves it with no windows. Returns a promise that resolves
 * when the app is ready.
 */
function prepareQuireHost(distDir) {
  const { app } = require('electron');
  const { Quire } = require(path.join(distDir, 'packages/quire/src/index.js'));
  Quire.registerScheme();
  // quire's analysis window is a real BrowserWindow, so destroying it can leave
  // the app with none — and Electron's default reaction to that is to quit. In
  // BookForge the main window keeps the app alive; in a harness nothing does.
  app.on('window-all-closed', () => { /* the harness decides when it is done */ });
  return app.whenReady();
}

module.exports = { relaunchUnderElectron, prepareQuireHost };
