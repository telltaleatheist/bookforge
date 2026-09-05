#!/usr/bin/env node
/**
 * THE ORPHEUS ARGV DID NOT MOVE.
 *
 *   node tools/test-orpheus-argv-snapshot.js
 *
 * ── What this proves, and why it is worth a file ────────────────────────────
 *
 * Adding Higgs meant touching `parallel-tts-bridge.ts` — a 9,500-line file that
 * every Orpheus audiobook goes through — at the prep, worker and assembly spawn
 * sites. The failure mode of that kind of edit is not a crash. It is one flag
 * that moved, or one that is now conditional, and the first person to find out
 * is whoever renders a book and hears something wrong four hours later.
 *
 * So the baseline in `tools/snapshots/orpheus-argv-base.json` was generated from
 * `01a3799b` — the commit the Higgs branch was cut from, BEFORE any of this work
 * — and this compares the current source against it. Five doors, all of them:
 * prep, retake, the lightweight worker, the app.py worker, assembly. Comments and
 * whitespace are normalised away, so reformatting passes and a moved flag fails.
 *
 * ── If this fails ───────────────────────────────────────────────────────────
 *
 * It is not automatically a bug — an Orpheus argv is allowed to change. What is
 * not allowed is changing it BY ACCIDENT while doing something else. Read the
 * diff it prints, decide whether that change was intended, and regenerate the
 * baseline deliberately if it was:
 *
 *   node tools/orpheus-argv-extract.js electron/parallel-tts-bridge.ts \
 *     > tools/snapshots/orpheus-argv-base.json
 *
 * ── The second assertion ────────────────────────────────────────────────────
 *
 * Identical argv is necessary and not sufficient: the same flags handed to a
 * different interpreter, or routed into WSL differently, is still a changed
 * Orpheus job. So the added seam is also checked to be INERT for every engine
 * but Higgs — `prepEngineFor` must be the identity, and `isHiggsJob` must be
 * false, for orpheus and for every retired id.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO, 'electron', 'parallel-tts-bridge.ts');
const BASELINE = path.join(__dirname, 'snapshots', 'orpheus-argv-base.json');
const { extract } = require('./orpheus-argv-extract');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

console.log('orpheus argv snapshot (baseline: 01a3799b, pre-Higgs)');

/**
 * NO SUBSTITUTIONS. The current source must match the pre-Higgs baseline
 * EXACTLY, in all five doors.
 *
 * There used to be one licensed substitution here: the prep spawn read
 * `prepEngine.envEngine` / `prepEngine.cliEngine` where it had read
 * `settings.ttsEngine`, because a Higgs prep was being routed to ebook2audiobook
 * as `--tts_engine orpheus` scaffolding. That whole mechanism is gone — Higgs
 * prep goes to narrator now (review finding 5) — so the prep argv is byte-for-byte
 * what it was at `01a3799b` again and the escape hatch is not needed.
 *
 * If a substitution is ever needed again, it must be named here AND backed by an
 * assertion, never by regenerating the baseline to make a red test green.
 */

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
const current = extract(fs.readFileSync(SOURCE, 'utf-8'));

check('every door in the baseline is still present', () => {
  for (const door of Object.keys(baseline)) {
    assert.ok(door in current, `the "${door}" spawn is gone from the bridge`);
  }
});

for (const door of Object.keys(baseline)) {
  check(`${door}: argv unchanged`, () => {
    if (current[door] === baseline[door]) return;
    // Print the first differing token rather than two 900-character strings.
    const a = baseline[door].split(' ');
    const b = (current[door] || '').split(' ');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    throw new Error(
      `first difference at token ${i}:\n` +
      `      was:  ...${a.slice(Math.max(0, i - 4), i + 6).join(' ')}\n` +
      `      now:  ...${b.slice(Math.max(0, i - 4), i + 6).join(' ')}`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The added seam is inert for everything but Higgs
// ─────────────────────────────────────────────────────────────────────────────
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'parallel-tts-bridge.js'))) {
  console.error('\nCompile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// The bridge pulls in electron's `app` at import time.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: {
    app: { getAppPath: () => REPO, isPackaged: false, getPath: () => REPO, on: () => {} },
    BrowserWindow: class {},
    ipcMain: { handle: () => {}, on: () => {} },
  },
};

console.log('the Higgs seam is inert for every other engine');

const bridge = require(path.join(DIST, 'parallel-tts-bridge.js'));

check('isHiggsJob is false for orpheus and for every retired id', () => {
  for (const id of ['orpheus', 'xtts', 'f5', 'voxtral']) {
    assert.strictEqual(bridge.isHiggsJob({ ttsEngine: id }), false, `${id} took the Higgs branch`);
  }
});

check('isHiggsJob is true only for higgs', () => {
  assert.strictEqual(bridge.isHiggsJob({ ttsEngine: 'higgs' }), true);
});

check('the prep spawn no longer has a Higgs seam in it at all', () => {
  // `prepEngineFor` existed only to tell e2a's packer `orpheus` while running in
  // the bundled env. Higgs prep goes to narrator now, so the function is gone and
  // the prep argv is the untouched pre-Higgs one — which the door comparison
  // above proves without any licensed substitution.
  assert.strictEqual(bridge.prepEngineFor, undefined,
    'prepEngineFor is back; if that is deliberate, the snapshot needs its substitution again');
});

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
