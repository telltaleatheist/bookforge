#!/usr/bin/env node
/**
 * Keeper: a renamed audiobook takes ITS OWN transcript with it, by name.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-transcript-follows-audiobook.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * `moveVttFile` (parallel-tts-bridge) files the assembly's loose `.vtt` under
 * the audiobook's new name when `applyM4bMetadata` renames an output. Until
 * 2026-09-18 it did that by LISTING every `.vtt` in the directory, splitting
 * both filenames into words, taking the first whose words overlapped the
 * audiobook's by half or more — and then `unlink`ing it. One output folder now
 * keeps every render and any human recording filed there, so two books of one
 * series share more than half their title words: the wrong transcript was
 * moved and the right one destroyed.
 *
 * The relation between an audiobook and its loose transcript is the STEM, and
 * it has one owner: `looseTranscriptFor` / `filedTranscriptFor`, which is also
 * what `postProcessOutput` reads back. The claims:
 *
 *  1. With two audiobooks in one folder sharing most of their title words, the
 *     renamed one's OWN transcript is filed and the neighbour's is untouched.
 *  2. A `.M4B` is the same audiobook: the stem drops the extension whatever its
 *     case, so the filed name is `<stem>.vtt` and not `<stem>.M4B.vtt`.
 *     (`path.basename(p, '.m4b')` is case-sensitive; the reader uses `extname`.)
 *  3. No transcript under the audiobook's own name means NOTHING is deleted —
 *     a stray `.vtt` belonging to something else survives — and the miss is a
 *     console line naming the path that was expected.
 *  4. The reader agrees: `postProcessOutput` finds what `moveVttFile` filed.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'parallel-tts-bridge.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// The bridge is a main-process module; stub `electron` so plain node can load it.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'estub';
  return origResolve.call(this, request, ...rest);
};
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: {
    app: { getPath: () => REPO, getAppPath: () => REPO, on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: class {},
    shell: {},
  },
};
const bridge = require(MODULE);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-transcript-'));
let caseNumber = 0;
function freshDir() {
  const dir = path.join(ROOT, `case-${++caseNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let failed = 0;
const captured = [];
async function check(name, fn) {
  captured.length = 0;
  const realWarn = console.warn;
  const realError = console.error;
  const realLog = console.log;
  console.warn = (...a) => captured.push(a.map(String).join(' '));
  console.error = (...a) => captured.push(a.map(String).join(' '));
  console.log = (...a) => captured.push(a.map(String).join(' '));
  try {
    await fn();
    console.warn = realWarn; console.error = realError; console.log = realLog;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.warn = realWarn; console.error = realError; console.log = realLog;
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

(async () => {
  console.log('the transcript that moves is the audiobook\'s own');

  await check('a sibling whose title shares most of its words is neither moved nor deleted', async () => {
    const dir = freshDir();
    // A real series folder: both books' stems share "dahak", "trilogy",
    // "volume" — 3 of 5 words, which is what the old overlap heuristic took.
    // The neighbour sorts FIRST in readdir order, so the scan reached it first.
    const ours = path.join(dir, 'The Dahak Trilogy Volume Two.m4b');
    const theirs = path.join(dir, 'Another Dahak Trilogy Volume.m4b');
    fs.writeFileSync(ours, 'audio-two');
    fs.writeFileSync(theirs, 'audio-one');
    fs.writeFileSync(path.join(dir, 'The Dahak Trilogy Volume Two.vtt'), 'WEBVTT\n\nOURS\n');
    fs.writeFileSync(path.join(dir, 'Another Dahak Trilogy Volume.vtt'), 'WEBVTT\n\nTHEIRS\n');

    const out = freshDir();
    const renamed = path.join(out, 'Dahak. Weber, David. (1991).m4b');
    await bridge.moveVttFile(ours, renamed);

    const filed = path.join(out, 'vtt', 'Dahak. Weber, David. (1991).vtt');
    assert.ok(fs.existsSync(filed), `nothing was filed at ${filed}`);
    assert.match(fs.readFileSync(filed, 'utf-8'), /OURS/,
      'the transcript filed under the new name is not this audiobook\'s');
    assert.ok(fs.existsSync(path.join(dir, 'Another Dahak Trilogy Volume.vtt')),
      'the neighbour\'s transcript was destroyed');
    assert.ok(!fs.existsSync(path.join(dir, 'The Dahak Trilogy Volume Two.vtt')),
      'our own transcript was left behind at the old name');
  });

  await check('an upper-case .M4B is the same audiobook — the stem drops it', async () => {
    const dir = freshDir();
    const ours = path.join(dir, 'Alpha.M4B');
    fs.writeFileSync(ours, 'audio');
    fs.writeFileSync(path.join(dir, 'Alpha.vtt'), 'WEBVTT\n\nALPHA\n');

    const out = freshDir();
    const renamed = path.join(out, 'Renamed Alpha.M4B');
    await bridge.moveVttFile(ours, renamed);

    const filed = path.join(out, 'vtt', 'Renamed Alpha.vtt');
    assert.ok(fs.existsSync(filed),
      `filed nowhere the reader looks; the folder holds: ${
        fs.existsSync(path.join(out, 'vtt')) ? fs.readdirSync(path.join(out, 'vtt')).join(', ') : '(no vtt folder)'}`);
    assert.match(fs.readFileSync(filed, 'utf-8'), /ALPHA/);
  });

  await check('no transcript of our own: nothing is deleted, and the miss is said out loud', async () => {
    const dir = freshDir();
    const ours = path.join(dir, 'Working Towards The Fuhrer.m4b');
    fs.writeFileSync(ours, 'audio');
    // A stray that shares "towards"/"fuhrer" but belongs to another render.
    fs.writeFileSync(path.join(dir, 'Working Towards The Fuhrer - deathstalker.vtt'), 'WEBVTT\n\nSTRAY\n');

    const out = freshDir();
    const renamed = path.join(out, 'Kershaw.m4b');
    await bridge.moveVttFile(ours, renamed);

    assert.ok(fs.existsSync(path.join(dir, 'Working Towards The Fuhrer - deathstalker.vtt')),
      'a transcript this audiobook does not own was moved away');
    assert.ok(!fs.existsSync(path.join(out, 'vtt', 'Kershaw.vtt')),
      'a transcript was filed for an audiobook that has none');
    const expected = path.join(dir, 'Working Towards The Fuhrer.vtt');
    assert.ok(captured.some((line) => line.includes(expected)),
      `the miss was silent; nothing named ${expected}. Lines: ${JSON.stringify(captured)}`);
  });

  await check('the reader agrees: postProcessOutput finds what moveVttFile filed', async () => {
    const dir = freshDir();
    const ours = path.join(dir, 'Mutineers Moon.m4b');
    fs.writeFileSync(ours, 'audio');
    fs.writeFileSync(path.join(dir, 'Mutineers Moon.vtt'), 'WEBVTT\n\nMUTINEER\n');

    const out = freshDir();
    const renamed = path.join(out, "Mutineers' Moon. Weber, David. (1991).m4b");
    fs.writeFileSync(renamed, 'audio');
    await bridge.moveVttFile(ours, renamed);

    const found = await bridge.postProcessOutput(out, renamed);
    assert.ok(found.vttPath, 'the reader found no transcript for the audiobook it was just filed for');
    assert.match(fs.readFileSync(found.vttPath, 'utf-8'), /MUTINEER/);
  });

  try { fs.rmSync(ROOT, { recursive: true, force: true }); }
  catch { /* a temp dir that will not go is not a test failure */ }

  if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\nAll transcript-follows-audiobook checks passed.');
})().catch((err) => {
  console.error('transcript-follows-audiobook: the suite itself failed:', err);
  process.exit(1);
});
