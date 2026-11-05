#!/usr/bin/env node
/**
 * THE SHARED TEXT RULES, HELD TO THE PYTHON'S OWN ANSWERS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-text.js
 *
 * `tools/fixtures/narrator-text-cases.json` was captured from the Python narrator before it
 * left the repo: the hard cases by hand (exotic whitespace, astral characters, tag spellings,
 * bad pauses) and a sample of the library's rows. The whole library was measured once
 * (109,180 rows, four variants each, 0 differences); this pins that result.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const NARRATOR = path.join(REPO, 'dist', 'electron', 'narrator');
if (!fs.existsSync(path.join(NARRATOR, 'text', 'sml.js'))) {
  console.log(skipLine('dist/electron/narrator/text/sml.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const py = require(path.join(NARRATOR, 'py-compat.js'));
const sml = require(path.join(NARRATOR, 'text', 'sml.js'));
const gaps = require(path.join(NARRATOR, 'text', 'gaps.js'));
const sp = require(path.join(NARRATOR, 'text', 'spoken.js'));
const caps = require(path.join(NARRATOR, 'text', 'caps.js'));
const listen = require(path.join(REPO, 'dist', 'shared', 'listen-text', 'normalize.js'));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'narrator-text-cases.json'), 'utf8'));

const pyBool = (b) => (b ? 'True' : 'False');
function answers(text) {
  const a = {};
  a.fold = caps.foldCapsRun(text);
  a.spoken = sp.spoken(text);
  a.glyphs = sp.stripNarratorGlyphs(text);
  try {
    const [before, after] = gaps.classifyGap(text);
    a.gap = `${py.pyFloatRepr(before)}|${py.pyFloatRepr(after)}`;
  } catch (err) {
    a.gap = `refused: ${err.message}`;
  }
  const [ok, norm] = sml.normalizeSmlTags(text);
  a.norm = `${pyBool(ok)}|${norm}`;
  const [esc, blocks] = sml.escapeSml(text);
  a.esc = esc;
  a.blocks = blocks.join('\x01');
  a.restored = sml.restoreSml(esc, blocks);
  a.stripped = sml.stripEscapedSml(esc);
  a.has = pyBool(sml.hasEscapedSml(esc));
  a.edges = sml.splitSmlEdges(esc).join('\x01');
  a.heading = pyBool(sml.headingRowTest(blocks)(esc));
  a.item = pyBool(sml.markerRowTest(blocks, 'item')(esc));
  a.headPat = pyBool(sml.SML_HEADING_PATTERN.test(text));
  return a;
}

let passed = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err.message || err).slice(0, 700)}`);
  }
}

for (const [group, cases] of [['hard', fixture.hard], ['row', fixture.rows]]) {
  for (const [text, want] of Object.entries(cases)) {
    check(`${group}: ${JSON.stringify(text).slice(0, 80)}`, () => assert.deepStrictEqual(answers(text), want));
  }
}

check('the stated sentence gap reaches the answer, and zero means zero', () => {
  assert.deepStrictEqual(gaps.classifyGap('A sentence.', 0.25), [0, 0.25]);
  assert.deepStrictEqual(gaps.classifyGap('A sentence.', 0), [0, 0]);
  assert.deepStrictEqual(gaps.classifyGap('tail [pause:1.5]', 0.25), [0, 1.5]);
  assert.deepStrictEqual(gaps.classifyGap('[pause:1.5] lead', 0.25), [1.5, 0.25]);
});

check('Listen reads the one fold, not a copy of it', () => {
  assert.strictEqual(listen.foldCapsRun, caps.foldCapsRun);
  assert.strictEqual(listen.CAPS_ACRONYMS, caps.CAPS_ACRONYMS);
  assert.strictEqual(listen.LETTERED_ACRONYMS, caps.LETTERED_ACRONYMS);
});

const total = passed + failed.length;
console.log(`\ntest-narrator-text: ${passed}/${total} passed`);
process.exit(failed.length ? 1 : 0);
