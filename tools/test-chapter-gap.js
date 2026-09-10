#!/usr/bin/env node
/**
 * THE SILENCE BETWEEN CHAPTERS, on the BookForge side.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-chapter-gap.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * narrator's own tests prove the gap reaches the audio, the chapter markers and
 * both transcripts (`narrator/tests/test_assemble_chapter_gap.py`). What they
 * cannot see is the half of the contract that lives here, and every part of it
 * fails SILENTLY — with a book that is simply assembled the wrong way:
 *
 *  - ABSENT IS NOT ZERO. Every config field is optional, and the ordinary path
 *    leaves it unset. If absence resolved to 0 rather than to BookForge's
 *    default, the feature would be off for every door that has no control for it
 *    (the CLI, the Correct Sentences re-assembly, a language-learning row) and
 *    nothing would say so.
 *  - AN EXPLICIT ZERO IS A REAL ANSWER and has to survive the trip. A `...(x ?
 *    {x} : {})` anywhere on the path turns "no gap, please" back into the
 *    default, which is the one value the user was trying to get away from.
 *  - A BAD NUMBER IS REFUSED BY NAME rather than defaulted, because a caller
 *    that computed a gap and got it wrong would otherwise ship a book that
 *    quietly ignored it.
 *  - THE RUN DESCRIPTION CARRIES IT to the assembly step, or the dialog's
 *    control does nothing at all.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const GAP_MODULE = path.join(REPO, 'dist', 'shared', 'audio', 'chapter-gap.js');
const RUN_MODULE = path.join(REPO, 'dist', 'shared', 'queue', 'narration-run.js');
for (const m of [GAP_MODULE, RUN_MODULE]) {
  if (!fs.existsSync(m)) {
    console.error('Compile first: npx tsc -p tsconfig.electron.json');
    process.exit(1);
  }
}

const { DEFAULT_CHAPTER_GAP, MAX_CHAPTER_GAP, resolveChapterGap } = require(GAP_MODULE);
const { buildNarrationSteps } = require(RUN_MODULE);

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

const BOOK = {
  epubPath: 'E:/lib/projects/Twain-a1b2/exports/book.epub',
  projectDir: 'E:/lib/projects/Twain-a1b2',
  variantId: 'v-7',
  title: 'Roughing It',
  author: 'Mark Twain',
  year: '1872',
  coverPath: '',
  outputFilename: 'Roughing It.m4b',
  isArticle: false,
};

const settings = (over = {}) => Object.assign({
  language: 'en',
  textCleanup: 'required',
  ttsEngine: 'orpheus',
  voice: 'leah',
  device: 'gpu',
  temperature: 0.6,
  topP: 0.9,
  repetitionPenalty: 1.1,
  speed: 1,
  workers: 1,
  outputDir: 'E:/audiobooks',
  finalDenoise: false,
  enhancementOrder: 'denoise-first',
  applyDeRing: false,
  rvc: null,
  startFresh: false,
}, over);

const stages = (over = {}) =>
  Object.assign({ narrate: true, enhance: false, assemble: true }, over);

const assemblyOf = (over) =>
  buildNarrationSteps(BOOK, settings(over), stages()).find((s) => s.type === 'reassembly');

// ── the resolver ────────────────────────────────────────────────────────────

test('the house default is three seconds', () => {
  assert.strictEqual(DEFAULT_CHAPTER_GAP, 3.0);
  assert.ok(MAX_CHAPTER_GAP > DEFAULT_CHAPTER_GAP,
    'a slider that cannot reach past the default is not a control');
});

test('ABSENT IS THE DEFAULT, not zero', () => {
  assert.strictEqual(resolveChapterGap(undefined), DEFAULT_CHAPTER_GAP);
});

test('an explicit zero is honoured', () => {
  assert.strictEqual(resolveChapterGap(0), 0,
    'somebody asking for the butt-joined book must get it');
});

test('a stated number is used as given', () => {
  assert.strictEqual(resolveChapterGap(1.5), 1.5);
  assert.strictEqual(resolveChapterGap(MAX_CHAPTER_GAP), MAX_CHAPTER_GAP);
});

test('a nonsense gap is refused BY NAME, never defaulted', () => {
  for (const bad of [-1, -0.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => resolveChapterGap(bad), /chapterGap/,
      `${bad} must be refused rather than silently replaced with the default`);
  }
});

// ── the run description ─────────────────────────────────────────────────────

test('the assembly step carries a stated gap', () => {
  assert.strictEqual(assemblyOf({ chapterGap: 4.5 }).config.chapterGap, 4.5);
});

test('an explicit zero reaches the assembly step', () => {
  const config = assemblyOf({ chapterGap: 0 }).config;
  assert.ok('chapterGap' in config,
    'a zero dropped here becomes the default at the bridge — the opposite of what was asked');
  assert.strictEqual(config.chapterGap, 0);
});

test('a run that states nothing states nothing, and the bridge defaults it', () => {
  const config = assemblyOf({}).config;
  assert.ok(!('chapterGap' in config),
    'absence is the run saying "I did not choose"; it must not be written as 0');
  assert.strictEqual(resolveChapterGap(config.chapterGap), DEFAULT_CHAPTER_GAP);
});

test('an upstream enhancement pass does NOT take the gap off the assembly', () => {
  // Unlike `sentenceGap`, which moves to whichever pass reads the raw sentences:
  // nothing before the assembly can bake a CHAPTER boundary.
  const steps = buildNarrationSteps(
    BOOK,
    settings({ chapterGap: 2, finalDenoise: true, sentenceGap: 0.4 }),
    stages({ enhance: true }),
  );
  const assembly = steps.find((s) => s.type === 'reassembly');
  assert.strictEqual(assembly.config.chapterGap, 2);
  assert.strictEqual(assembly.config.sentenceGap, undefined,
    'the sentence gap moved upstream; the chapter gap has nowhere to move to');
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
console.log(`chapter-gap: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
