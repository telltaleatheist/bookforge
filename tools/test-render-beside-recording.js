#!/usr/bin/env node
/**
 * Keeper: a render filed BESIDE a human recording gets its voice in its filename,
 * so the two versions never share the `<projectId>/<filename>` identity the
 * Bookshelf app keys downloads and positions on (Owen, 2026-09-07, Mutineers'
 * Moon: the deathstalker render played where the professionally-read book was
 * expected).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-render-beside-recording.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const Module = require('module');
const REPO = path.resolve(__dirname, '..');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === 'electron') return 'estub'; return orig.call(this, r, ...a); };
require.cache['estub'] = { id: 'estub', filename: 'estub', loaded: true, exports: { app: { getPath: () => REPO, on() {} }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class {} } };
const ms = require(path.join(REPO, 'dist', 'electron', 'manifest-service.js'));
const filing = require(path.join(REPO, 'dist', 'electron', 'audiobook-variant-filing.js'));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const BASE = "Mutineer's Moon (Dahak Book 1). Weber, David. (1991).m4b";
const mutineer = {
  metadata: { title: "Mutineer's Moon (Dahak Book 1)", author: 'David Weber' },
  variants: [
    { id: 'audiobook', kind: 'audiobook', path: `archive/${BASE}`, professionallyRead: true },
    { id: 'd1140b57', kind: 'ebook', path: "archive/Mutineers' Moon.epub" },
  ],
  outputs: { audiobook: { path: `output/${BASE}`, professionallyRead: false } },
};

console.log('who holds the base slot');
check('a professionally-read import holds it', () => {
  assert.strictEqual(ms.humanRecordingHoldsBaseSlot(mutineer), true);
});
check('an archived recording without the flag holds it too; a render does not', () => {
  assert.strictEqual(ms.humanRecordingHoldsBaseSlot({ variants: [{ id: 'audiobook', kind: 'audiobook', path: 'archive/x.m4b' }] }), true);
  assert.strictEqual(ms.humanRecordingHoldsBaseSlot({ variants: [{ id: 'audiobook', kind: 'audiobook', path: 'output/x.m4b' }] }), false);
  assert.strictEqual(ms.humanRecordingHoldsBaseSlot({ variants: [] }), false);
  assert.strictEqual(ms.humanRecordingHoldsBaseSlot({}), false);
});
check('the fold still lists the recording AND the render as two versions', () => {
  const { variants } = ms.getVariants(mutineer);
  const audio = variants.filter((v) => v.kind === 'audiobook').map((v) => [v.id, v.path]);
  assert.deepStrictEqual(audio, [['audiobook', `archive/${BASE}`], [ms.OUTPUT_SLOT_VARIANT_ID, `output/${BASE}`]]);
});

console.log('the render beside it is named after its voice');
check("deathstalker's render carries the voice; the recording keeps the plain name", () => {
  assert.strictEqual(filing.renderBesideRecordingFilename(BASE, 'deathstalker'),
    "Mutineer's Moon (Dahak Book 1). Weber, David. (1991) - deathstalker.m4b");
  assert.notStrictEqual(filing.renderBesideRecordingFilename(BASE, 'deathstalker'), BASE);
});
check('a session with no voice is refused by name, never given the recording\'s name', () => {
  assert.throws(() => filing.renderBesideRecordingFilename(BASE, undefined), /records no voice/);
  assert.throws(() => filing.renderBesideRecordingFilename(BASE, '  '), /records no voice/);
});

if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nAll render-beside-recording checks passed.');
