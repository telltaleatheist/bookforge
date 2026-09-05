#!/usr/bin/env node
/**
 * NOTHING SPAWNS ebook2audiobook ANY MORE.
 *
 *   node tools/test-no-e2a-doors.js
 *
 * ── Why a grep is the right test here ───────────────────────────────────────
 *
 * The doors that moved in Phase 3 are covered by the argv snapshot, which reads
 * the six argv literals and the plan each produces. What that CANNOT see is a
 * SEVENTH door — one nobody remembered, in a file nobody was looking at.
 *
 * There was one. `tts-bridge.ts:startConversion` built
 * `<e2a>/app.py --headless --tts_engine xtts --fine_tuned ScarlettJohansson`
 * with the six XTTS sampling flags, wired all the way to the renderer through
 * `tts:start-conversion`. It survived the whole cut-over because nothing called
 * it: `AudiobookService` had zero injectors. Then `checkAvailable()` — the guard
 * that had been refusing it by accident, by asking whether `<e2a>/app.py` existed
 * — was correctly re-pointed at `narratorReady()`, and the dead door became a
 * one-call path to spawning a file that is not there.
 *
 * A snapshot of the doors we know about could never have caught that. This
 * asserts the absence of the shapes instead.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

/** Every TS source under electron/ and src/, with comments stripped. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name)) {
        const raw = fs.readFileSync(p, 'utf-8');
        // Comments are stripped because the history is written down on purpose —
        // several files explain what the deleted door DID, and a test that fails
        // on its own explanation teaches people to delete explanations.
        // NB no `$` on the line-comment pattern: this repo is core.autocrlf=true,
        // a split on '\n' leaves '\r', and `.` will not cross a carriage return.
        const code = raw
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
        out.push({ file: path.relative(REPO, p).replace(/\\/g, '/'), code });
      }
    }
  };
  walk(path.join(REPO, 'electron'));
  walk(path.join(REPO, 'src'));
  return out;
}

const FILES = sources();

console.log('no source builds a path to an e2a entry point');
for (const script of ['app.py', 'worker.py']) {
  check(`nothing joins <e2a>/${script}`, () => {
    const hits = FILES.filter(({ code }) =>
      new RegExp(`['"\`]${script.replace('.', '\\.')}['"\`]`).test(code));
    assert.strictEqual(hits.length, 0,
      `${script} is named in: ${hits.map((h) => h.file).join(', ')}`);
  });
}

console.log('the tts:* IPC family is gone');
for (const channel of ['tts:start-conversion', 'tts:stop-conversion', 'tts:check-available',
  'tts:get-voices', 'tts:generate-filename', 'tts:progress']) {
  check(`no channel '${channel}'`, () => {
    const hits = FILES.filter(({ code }) => code.includes(`'${channel}'`) || code.includes(`"${channel}"`));
    assert.strictEqual(hits.length, 0,
      `${channel} is still wired in: ${hits.map((h) => h.file).join(', ')}`);
  });
}

check('the renderer has no electron.tts surface', () => {
  const hits = FILES.filter(({ file, code }) =>
    file.startsWith('src/') && /\belectron\.tts\b/.test(code));
  assert.strictEqual(hits.length, 0, hits.map((h) => h.file).join(', '));
});

check('AudiobookService is gone, not merely unused', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'src/app/features/audiobook/services/audiobook.service.ts')),
    'audiobook.service.ts is back');
});

console.log('the retired engine cannot be named as a render target');
check("no source passes --tts_engine 'xtts'", () => {
  const hits = FILES.filter(({ code }) => /--tts_engine['"\s,]+['"]xtts['"]/.test(code));
  assert.strictEqual(hits.length, 0, hits.map((h) => h.file).join(', '));
});
check('no SPAWN hard-codes the ScarlettJohansson default voice', () => {
  // electron/ only, deliberately. The deleted door put this literal into an argv
  // as `--fine_tuned ScarlettJohansson`, and that is what must never return.
  //
  // It also survives in the renderer as a Listen VOICE-LIST entry and default
  // (`play.types.ts`, `play-view.component.ts`) — an XTTS voice offered by a UI
  // that no longer has an XTTS engine behind it. That is a real leftover and it is
  // Phase 5's (the XTTS removal), not this door's: changing which voice the Listen
  // tab defaults to is a product decision, not a cleanup, and widening this check
  // to catch it would smuggle that decision in as a test failure.
  const hits = FILES.filter(({ file, code }) =>
    file.startsWith('electron/') && /ScarlettJohansson/.test(code));
  assert.strictEqual(hits.length, 0, hits.map((h) => h.file).join(', '));
});

console.log('and no kill pattern hunts a process that cannot exist');
for (const pattern of ['ebook2audiobook.*\\\\.py', 'app\\\\.py', 'worker\\\\.py']) {
  check(`no sweep matches /${pattern.replace(/\\\\/g, '\\')}/`, () => {
    // BOTH spellings. `code.includes('worker\\\\.py')` finds the pattern written as
    // a quoted STRING, which is how every current sweep writes it — and misses the
    // same pattern written as a TS REGEX LITERAL, `/worker\\.py/`, where the source
    // carries one backslash where a string carries two. A stale sweep in the form the
    // check cannot see is the entire hazard: it matches nothing, reports success, and
    // leaves a python holding the GPU.
    const asRegexLiteral = pattern.replace(/\\\\/g, '\\');
    const hits = FILES.filter(({ code }) =>
      code.includes(pattern) || code.includes(asRegexLiteral));
    assert.strictEqual(hits.length, 0,
      `a stale kill pattern survives in: ${hits.map((h) => h.file).join(', ')}. `
      + 'A pattern that matches nothing reports success and leaves a python on the GPU.');
  });
}
check('no WINDOWTITLE sweep, which can never match a spawned python', () => {
  // A python.exe started by spawn() has no window title at all, so
  // `taskkill /FI "WINDOWTITLE eq *x*"` is a command that cannot do anything —
  // and reads, in a shutdown path, as though something was cleaned up.
  const hits = FILES.filter(({ code }) => /WINDOWTITLE/i.test(code));
  assert.strictEqual(hits.length, 0, hits.map((h) => h.file).join(', '));
});

console.log(failures === 0 ? '\nNo e2a doors remain.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
