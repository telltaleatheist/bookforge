#!/usr/bin/env node
/**
 * Keeper: one Quit quits, with the book window open (Owen, 2026-11-07).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-one-quit.js
 *
 * Owen: *"i have to right-click bookforge's tray icon and hit quit bookforge twice for
 * it to actually quit."* Measured with a probe Electron of the same shape (hidden
 * windows): the first Quit ran before-quit's whole cleanup and quit again; the book
 * window's `close` then asked its documents and prevented the close, which CANCELS
 * `app.quit()`; the window closed on the answer and the app stayed in the tray with
 * its queue shut down. The second Quit found no book window and exited.
 *
 * Held: before-quit asks the book window FIRST, before anything shuts down, and quits
 * again from its yes; the window's own once-only ask is still there (the reason for
 * the gate); the tray's Quit and the second Ctrl+Q both go through before-quit.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const gatePath = path.join(REPO, 'dist', 'electron', 'quit-gate.js');
if (!fs.existsSync(gatePath)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { quitWaitsForBookWindow } = require(gatePath);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); } catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};
const open = { isDestroyed: () => false };
const gone = { isDestroyed: () => true };

check('a quit waits for an open book window that has not been let go, and only then', () => {
  assert.strictEqual(quitWaitsForBookWindow(open, false), true, 'an open book window is not asked');
  assert.strictEqual(quitWaitsForBookWindow(open, true), false, 'a window already let go is asked again');
  assert.strictEqual(quitWaitsForBookWindow(null, false), false, 'no book window, and the quit waits');
  assert.strictEqual(quitWaitsForBookWindow(gone, false), false, 'a destroyed window holds the quit');
});

const main = read('electron/main.ts');
const body = main.slice(main.indexOf("app.on('before-quit', async (event) => {"));
const at = (s) => {
  const i = body.indexOf(s);
  assert.ok(i >= 0, `before-quit no longer contains: ${s}`);
  return i;
};

check('before-quit asks the book window before it shuts anything down, and quits from the yes', () => {
  const gate = at('if (quitWaitsForBookWindow(foundryMount.foundryWindow(), foundryMount.windowLetGo())) {');
  at("foundryMount.letTheWindowGo(() => { isQuitting = true; app.quit(); });");
  assert.ok(gate < at('if (cleanupDone) return;'), 'the cleanup guard runs before the book window is asked');
  assert.ok(gate < at('await queueEngine.shutdown();'), 'the queue is shut down before the book window is asked');
  assert.ok(gate < at('event.preventDefault();\n  cleanupDone = true;'), 'the cleanup starts before the book window is asked');
  // A "keep it open" leaves the ✕ hiding the main window, as before the press.
  assert.ok(body.slice(gate, at("foundryMount.letTheWindowGo(")).includes('isQuitting = false;'),
    'a quit the documents refused leaves isQuitting set');
});

check('the window still asks once on close and closes on a yes (the reason for the gate)', () => {
  const win = read('foundry-app/electron/window.ts');
  assert.ok(/mainWindow\.on\('close', \(event\) => \{\n\s*if \(letGo\) return;\n\s*event\.preventDefault\(\);\n\s*letTheWindowGo\(\(\) => mainWindow\?\.close\(\)\);/.test(win),
    'the window close handler changed: re-measure whether a quit still needs the gate');
  const mount = read('foundry-app/electron/mount.ts');
  assert.ok(mount.includes("export { letTheWindowGo, windowLetGo } from './window';"), 'the mount no longer exposes the gate');
});

check('the tray Quit and the second Ctrl+Q both quit through before-quit', () => {
  assert.ok(main.includes('quit: () => { isQuitting = true; app.quit(); },'), 'the tray Quit changed');
  assert.ok(/\/\/ Second press — actually quit\n[\s\S]{0,200}?app\.quit\(\);/.test(main), 'the second Ctrl+Q no longer quits');
});

console.log(failed === 0 ? '\none quit: all checks passed' : `\none quit: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
