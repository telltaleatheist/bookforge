#!/usr/bin/env node
/**
 * Keeper: the Narrate overlay is today's Narrate dialog, drawn over the book window.
 *
 *   node tools/test-narrate-overlay.js
 *
 * B5 (docs/REORG-PLAN.md) moved Narrate from BookForge's main window into an
 * overlay on the book window (electron/narrate-overlay.ts). The ruling is that it
 * queues EXACTLY what today's Narrate queues. The payload is proven field by field
 * at a UI sitting; this keeper holds the structure that makes it the same between
 * sittings, read from source:
 *
 *   1. ONE dialog binding in the shell, outside the overlay's chrome guard, so the
 *      overlay mounts the same component class with the same inputs.
 *   2. The overlay opens it with the context the press always used, 'document'.
 *   3. Main hands the press's target to the overlay as it was resolved, and the
 *      overlay's door returns that object unchanged.
 *   4. Same origin, so same localStorage: the overlay loads through the function
 *      the main window loads through, in the default session (no partition).
 *   5. The shell's guard returns before any of its startup work.
 *   6. A press queues ONE run, and is told so: no count of its steps crosses the door.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const shell = read('src/app/app.ts');
const main = read('electron/main.ts');
const overlay = read('electron/narrate-overlay.ts');
const role = read('src/app/core/window-role.ts');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}

check('the shell binds the narration dialog once, outside the overlay\'s chrome guard', () => {
  const bindings = shell.match(/<app-narration-modal\b/g) ?? [];
  assert.strictEqual(bindings.length, 1, `${bindings.length} <app-narration-modal> bindings in app.ts; one dialog serves both doors`);
  const guard = shell.indexOf('@if (!isNarrateOverlay) {');
  assert.ok(guard >= 0, 'the overlay\'s chrome guard `@if (!isNarrateOverlay) {` is gone');
  const guardEnd = shell.indexOf('<app-toast-host />\n    }\n', guard);
  assert.ok(guardEnd > guard, 'the chrome guard no longer closes right after the toast stack');
  assert.ok(shell.indexOf('<app-narration-modal') > guardEnd,
    'the dialog binding is inside the chrome guard, so the overlay would not draw it');
  for (const input of ['context', 'epubPath', 'variantId', 'projectDir', 'title', 'author', 'year',
    'coverPath', 'outputFilename', 'isArticle', 'pending']) {
    assert.ok(new RegExp(`\\[${input}\\]="r\\.(?:target\\.)?${input}"`).test(shell),
      `the dialog's [${input}] is no longer bound from the one request`);
  }
});

check('the overlay opens the dialog on main\'s target with the press\'s context, \'document\'', () => {
  assert.ok(/narrateOverlayTarget\(\)\.then\(\(target: NarrationTarget\) => \{\n\s*this\.narrationDialog\.open\(target, 'document'\);/.test(shell),
    'the overlay no longer opens narrationDialog with the target as main sent it and the context \'document\'');
});

check('main hands the press\'s target to the overlay as resolved, and the door returns it unchanged', () => {
  assert.ok(/openNarrateOverlay\(bookWindow, opened, narrateOverlayDeps\);/.test(main),
    'narrateFromFoundry no longer passes its resolved `opened` target straight to the overlay');
  assert.ok(/ipcMain\.handle\('narrate-overlay:target', \(event\) => overlayOf\(event\.sender\)\.target\);/.test(overlay),
    'the overlay\'s target door no longer returns the stored target unchanged');
});

check('the overlay loads the way the main window loads, in the default session', () => {
  assert.ok(/load: \(contents, hash\) => \{ void loadBookForgeRenderer\(contents, hash\); \}/.test(main),
    'the overlay is no longer loaded through loadBookForgeRenderer');
  assert.ok(/void loadBookForgeRenderer\(mainWindow\.webContents\);/.test(main)
    && /loadBookForgeRenderer\(mainWindow\.webContents\)\.catch\(/.test(main),
    'the main window no longer loads through loadBookForgeRenderer, in dev and packaged');
  assert.ok(/deps\.load\(view\.webContents, '\/narrate'\);/.test(overlay), 'the overlay no longer loads #/narrate');
  const prefs = /new WebContentsView\(\{[\s\S]*?\}\);/.exec(overlay);
  assert.ok(prefs !== null, 'the overlay\'s WebContentsView could not be found');
  assert.ok(!/partition|session/.test(prefs[0]),
    'the overlay names a partition or session: another session is another localStorage');
});

check('the overlay route is a standalone window, and the shell starts none of its work there', () => {
  assert.ok(/'#\/narrate'/.test(role.slice(role.indexOf('STANDALONE_ROUTES'))), '#/narrate is not in STANDALONE_ROUTES');
  const init = shell.slice(shell.indexOf('  ngOnInit() {'));
  const back = init.indexOf('if (this.isNarrateOverlay) {');
  const returned = init.indexOf('return;', back);
  assert.ok(back > 0 && returned > back, 'ngOnInit has no overlay branch that returns');
  for (const work of ['watchEnginePresence()', 'queueToasts.start()', 'onShowBookConversion(',
    'onFoundryOpenQueue(', 'watchForUpgrades()']) {
    const at = init.indexOf(work);
    assert.ok(at > returned, `${work} runs before the overlay branch returns`);
  }
});

check('one press is one run, and no count of its steps reaches the sentence', () => {
  // Owen, 2026-11-06: one narration on one book said "4 narration runs are queued".
  // The 4 was the run's steps. Prepare, TTS, align, assembly and a video all say one sentence.
  const queue = read('src/app/features/queue/services/queue.service.ts');
  const body = queue.slice(queue.indexOf('async submitNarration('), queue.indexOf('/** The mirrored row for a step id'));
  assert.strictEqual((body.match(/bridge\.enqueue\(/g) ?? []).length, 1, 'submitNarration no longer enqueues exactly one run');
  assert.ok(!/for \([^)]*\)\s*\{[^}]*bridge\.enqueue\(/.test(body), 'submitNarration enqueues inside a loop');
  const modal = read('src/app/features/studio/components/narration-modal/narration-modal.component.ts');
  assert.ok(/readonly queued = output<void>\(\);/.test(modal), 'the dialog\'s queued event carries something again');
  assert.ok(!/queued\.emit\(\{/.test(modal), 'the dialog emits a count again');
  const door = /ipcMain\.handle\('narrate-overlay:done'[\s\S]*?\n  \}\);/.exec(overlay);
  assert.ok(door !== null, 'the done door could not be found');
  assert.ok(!/\bjobs\b|\bruns\b/.test(door[0]), 'the done door reads a count, or says "runs"');
  assert.ok(door[0].includes('The narration is queued. It is on the queue shelf.'), 'the sentence changed');
  for (const [name, text] of [['preload', read('electron/preload.ts')], ['electron.service', read('src/app/core/services/electron.service.ts')], ['shell', shell]]) {
    assert.ok(!/(narrateDone|narrateOverlayDone)\(?[^\n]*\bjobs\b/.test(text), `${name} carries jobs to the done door`);
  }
});

console.log(failed === 0 ? '\nnarrate overlay: all checks passed' : `\nnarrate overlay: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
