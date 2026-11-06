#!/usr/bin/env node
/**
 * Keeper: an export Foundry filed without metadata reaches the book window's
 * notice tray.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-landing-problem-notice.js
 *
 * `ExportLanding.problem` (foundry-core 0.1.1) says the book was filed without
 * metadata. The function is driven for real; the wiring on either side of it
 * lives in electron/main.ts and the window copy, read from source.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const { sayLandingProblem } = require(path.join(REPO, 'dist', 'electron', 'foundry-landing-notice.js'));

const PROBLEM = '"keeper.epub" was filed without metadata: keeper\'s record could not be read.';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}

function window(destroyed = false) {
  const sent = [];
  return { sent, isDestroyed: () => destroyed, webContents: { send: (channel, text) => sent.push([channel, text]) } };
}

/** Runs fn with console.error captured, and returns the lines. */
function logged(fn) {
  const lines = [];
  const real = console.error;
  console.error = (line) => lines.push(line);
  try { fn(); } finally { console.error = real; }
  return lines;
}

check('a landing with a problem says it in the book window, on the channel the window listens to', () => {
  const win = window();
  sayLandingProblem({ problem: PROBLEM }, win);
  assert.deepStrictEqual(win.sent, [['host-ops:notice', PROBLEM]]);
});

check('a landing with nothing to say sends nothing', () => {
  const win = window();
  assert.deepStrictEqual(logged(() => sayLandingProblem({}, win)), []);
  assert.deepStrictEqual(win.sent, []);
});

check('with no book window, or a closed one, it is a named console line and does not throw', () => {
  const closed = window(true);
  for (const target of [null, closed]) {
    const lines = logged(() => sayLandingProblem({ problem: PROBLEM }, target));
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes(PROBLEM), lines[0]);
  }
  assert.deepStrictEqual(closed.sent, []);
});

check('main passes every landing to it, from the host\'s onExport, with the book window', () => {
  const main = read('electron/main.ts');
  const start = main.indexOf('    onExport: (landing) => {');
  assert.ok(start >= 0, 'the host\'s onExport is gone');
  const body = main.slice(start, main.indexOf('    onImport: (landing)', start));
  assert.ok(/sayLandingProblem\(landing, foundryMount\.foundryWindow\(\)\);/.test(body),
    'onExport no longer says the landing\'s problem in the book window');
  assert.ok(/readonly problem\?: string;/.test(main), 'FoundryExportLanding no longer mirrors `problem`');
});

check('the window turns that channel into a notice', () => {
  const preload = read('foundry-app/electron/preload.ts');
  assert.ok(/onHostNotice:[\s\S]{0,300}'host-ops:notice'/.test(preload), 'the window\'s preload no longer listens on host-ops:notice');
  assert.ok(/onHostNotice\(\(text\) => this\.notices\.notice\.set\(text\)\);/.test(read('foundry-app/src/app/app.ts')),
    'the window no longer puts a host notice in its tray');
});

console.log(failed === 0 ? '\nlanding problem notice: all checks passed' : `\nlanding problem notice: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
