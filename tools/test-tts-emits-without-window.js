#!/usr/bin/env node
/**
 * THE QUEUE HEARS A NARRATION WHETHER OR NOT A WINDOW IS OPEN.
 *
 * 2026-10-29, To Train Up a Child: every chunk rendered on Crucible and was
 * published into the project, while the TTS row read 0% and its step never
 * ended. The bridge gated every progress and completion emit on `mainWindow`,
 * and the queue (which lives in main and hears them on the bridge bus) had
 * been handed a window only at startup, so a recreated window left it holding
 * a destroyed one. Two pins, one per half:
 *
 *   1. parallel-tts-bridge.ts asks IN_APP, never `mainWindow`, before an emit;
 *      only `rendererSend` itself looks at the window.
 *   2. main.ts tells the queue about the window inside createWindow, so every
 *      window, not just the first, reaches it.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
}

// Code lines only: comments may tell the story of the old gate.
const code = bridge.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
const gated = code
  .map((l, i) => ({ l, i }))
  .filter(({ l }) => /\bif\s*\(\s*!?\s*mainWindow\b/.test(l) || /&&\s*mainWindow\s*\)/.test(l))
  .filter(({ l }) => !/mainWindow\.isDestroyed\(\)/.test(l));
check('no emit in the TTS bridge is gated on a window', gated.length === 0,
  gated.map(({ l }) => l.trim()).slice(0, 3).join(' | '));
check('the bridge decides by IN_APP (process.type === browser)',
  /const IN_APP = \(process as [^)]*\)\.type === 'browser'/.test(bridge));

const create = main.slice(main.indexOf('function createWindow(): void {'));
const body = create.slice(0, create.indexOf('\n}\n'));
check('createWindow hands every window to the queue', /setQueueMainWindow\(mainWindow\)/.test(body));
check('a closed window is taken back from the queue', /on\('closed',[\s\S]*?setQueueMainWindow\(null\)/.test(body));

console.log(`\ntts emits without a window: ${failed === 0 ? 'all clear' : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
