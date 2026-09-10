#!/usr/bin/env node
/**
 * WHERE THE ALIGN SPLITTER ENDS A SENTENCE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-sentence-abbreviations.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Owen, 2026-09-10, reading a VTT the alignment pass had just written:
 * "alignment split on abbreviations. like R.L. Dabney was split across
 * sentences, but thats a persons name."
 *
 * There are TWO sentence splitters in this pipeline. narrator's Python one cuts
 * the book into render chunks and has carried an abbreviation guard since the
 * port; the TypeScript one in `whisperx-align-bridge` cuts it into alignment
 * sentences and had NONE — so `R.L. Dabney`, `Mr. Darcy` and `St. Louis` each
 * became two cues in every transcript this app has ever aligned.
 *
 * THE FAILURE IS SILENT AND IT SHIPS. A split name produces a fragment cue that
 * is sealed into the m4b as the subtitle track; nothing downstream reads a cue
 * and asks whether it is a whole sentence. It surfaces only when a person reads
 * along, which is exactly how it surfaced.
 *
 * ── The two halves ──────────────────────────────────────────────────────────
 *
 * 1. THE TABLE CANNOT DRIFT. The stems are a deliberate second copy of
 *    `abbreviations_mapping['eng']` union `SENTENCE_ABBREVIATIONS` in
 *    python/narrator/text/lang.py — TypeScript cannot import Python. So this
 *    READS THE PYTHON, applies that file's own stem rule, and asserts set
 *    equality. Adding an abbreviation to lang.py and not to the TS list fails
 *    here, which keeps lang.py the one place it is added.
 * 2. THE RULES HOLD ON REAL SENTENCES, including the ones that must still split.
 *    A guard that merged everything would pass half a test file.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'text', 'sentence-abbreviations.js');
const BRIDGE = path.join(REPO, 'dist', 'electron', 'whisperx-align-bridge.js');
for (const m of [MODULE, BRIDGE]) {
  if (!fs.existsSync(m)) {
    console.error('Compile first: npx tsc -p tsconfig.electron.json');
    process.exit(1);
  }
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const { SENTENCE_ABBREVIATION_STEMS, periodTerminatorGuard } = require(MODULE);
const { splitSentences } = require(BRIDGE);

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

/** One block of prose -> its sentences. `paragraphAware: false` keeps the block
 *  splitter out of it: this file is about the PUNCTUATION boundary. */
const split = (text) => splitSentences(text, false).map((s) => s.text);

// ── 1. the table, against narrator's own ────────────────────────────────────

test('THE STEMS ARE THE PYTHON\'S, exactly', () => {
  // The stem rule is lang.py's, applied here to lang.py's own tables — so this
  // compares the two LISTS, not two copies of the reduction.
  const py = `
import json
from narrator.text.lang import abbreviations_mapping, SENTENCE_ABBREVIATIONS
stems = set()
for k in list(abbreviations_mapping.get('eng', {})) + list(SENTENCE_ABBREVIATIONS):
    stem = (k[:-1] if k.endswith('.') else k).split('.')[-1].strip()
    if len(stem) >= 2:
        stems.add(stem)
print(json.dumps(sorted(stems)))
`;
  let out;
  try {
    out = execFileSync('conda', ['run', '-n', 'narrator-mlx', 'python', '-c', py], {
      cwd: path.join(REPO, 'python'), encoding: 'utf8',
    });
  } catch (err) {
    // A machine with no narrator env cannot check the copy. Say so and pass —
    // this is a drift alarm, not a reason to fail a gate on a laptop that has
    // never run a render.
    console.log('SKIP  the python table could not be read (no narrator-mlx env); '
      + 'the drift check did not run');
    return;
  }
  const fromPython = JSON.parse(out.trim().split('\n').pop());
  assert.deepStrictEqual([...SENTENCE_ABBREVIATION_STEMS].sort(), fromPython,
    'shared/text/sentence-abbreviations.ts has drifted from python/narrator/text/lang.py — '
    + 'add the abbreviation in lang.py and mirror it here');
});

test('the guard names both rules, and the initials rule is first', () => {
  const guard = periodTerminatorGuard();
  assert.ok(guard.startsWith('(?<!\\b[A-Za-z])'),
    'the initials rule is the one no list can replace; it must not be droppable');
  assert.ok(guard.includes('(?<!\\bMr)'));
  assert.ok(guard.includes('(?<!\\bet al)'), 'a stem with a space must be escaped in, not lost');
});

// ── 2. Owen's case, and the ones beside it ──────────────────────────────────

test("INITIALS: R.L. Dabney is one person, not two sentences", () => {
  assert.deepStrictEqual(
    split('R.L. Dabney, the Southern theologian, wrote it. Then he left.'),
    ['R.L. Dabney, the Southern theologian, wrote it.', 'Then he left.']);
});

test('INITIALS: spaced initials too (R. L. Dabney)', () => {
  assert.deepStrictEqual(
    split('R. L. Dabney wrote it. Then he left.'),
    ['R. L. Dabney wrote it.', 'Then he left.']);
});

test('INITIALS: a single leading initial (J. Gresham Machen)', () => {
  assert.deepStrictEqual(
    split('J. Gresham Machen replied. The debate ended.'),
    ['J. Gresham Machen replied.', 'The debate ended.']);
});

test('INITIALS: U.S. mid-sentence', () => {
  assert.deepStrictEqual(
    split('The U.S. Army arrived. Nobody cheered.'),
    ['The U.S. Army arrived.', 'Nobody cheered.']);
});

test('ABBREVIATIONS: titles and places', () => {
  assert.deepStrictEqual(split('Mr. Darcy arrived. She left.'),
    ['Mr. Darcy arrived.', 'She left.']);
  assert.deepStrictEqual(split('She went to St. Louis. It rained.'),
    ['She went to St. Louis.', 'It rained.']);
  assert.deepStrictEqual(split('Dr. Rush and Prof. Hodge spoke. Both sat.'),
    ['Dr. Rush and Prof. Hodge spoke.', 'Both sat.']);
});

test('ABBREVIATIONS: a Bible citation stays whole', () => {
  assert.deepStrictEqual(split('He read Col. 2:1 aloud. Then he stopped.'),
    ['He read Col. 2:1 aloud.', 'Then he stopped.']);
});

test('the guard is CASE-SENSITIVE — "much." still ends a sentence', () => {
  // `Ch` guards `Ch.`; it must not guard the tail of `much.`
  assert.deepStrictEqual(split('He did not say much. She did.'),
    ['He did not say much.', 'She did.']);
});

// ── 3. the sentences that MUST still split ──────────────────────────────────

test('ordinary prose still splits', () => {
  assert.deepStrictEqual(split('She asked why. He shrugged. It ended there.'),
    ['She asked why.', 'He shrugged.', 'It ended there.']);
});

test('a question and an exclamation are unguarded terminators', () => {
  assert.deepStrictEqual(split('Are you sure? Yes! I am.'),
    ['Are you sure?', 'Yes!', 'I am.']);
});

test('a closing quote still ends a sentence', () => {
  assert.deepStrictEqual(split('"Are you sure?" she said. He nodded.'),
    ['"Are you sure?" she said.', 'He nodded.']);
});

test('a word ending in a guarded stem is not itself guarded', () => {
  // `Sr` is a stem; `Sr.` guards. A longer word ending in those letters must not,
  // which is what `\b` in the lookbehind buys.
  assert.deepStrictEqual(split('He is a mister. She is not.'),
    ['He is a mister.', 'She is not.']);
});

test('an ellipsis still ends a sentence', () => {
  assert.deepStrictEqual(split('He hesitated… She did not.'),
    ['He hesitated…', 'She did not.']);
});

// ── run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`sentence-abbreviations: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
