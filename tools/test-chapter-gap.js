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
 *  - THE ALIGNER IS MEASURED ON THE SAME RULER. `narrator align` writes the
 *    measured `<stem>.sentences.vtt` and assembly seals that file UNTOUCHED, so
 *    an alignment run without the assembly's `--chapter-gap` writes cues that
 *    drift earlier by the gap at every chapter boundary. That is not a
 *    hypothetical: the gap reached the assembler on 2026-09-09 (efe021a2) and
 *    did not reach `coverage-align-job.ts` until 2026-09-11, so every book
 *    assembled in between carries a drifting transcript — the Pokemon book's
 *    cues ended 45 s early over 15 boundaries and nothing said so.
 *  - AND THE GATE THAT WOULD HAVE SAID SO reads BOTH directions. A transcript
 *    that ends early is a book measured on another ruler; a transcript that ends
 *    late is a truncated export. One tolerance, two verdicts, both refused.
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

/*
 * THE ALIGN DOOR'S ARGV, AND THE GATE'S ARITHMETIC.
 *
 * `coverage-align-job.js` imports `electron` for `app.getPath` and nothing on
 * this path calls it, so one stub is enough — the same stub `cli/coverage-align.js`
 * and the argv snapshot use. `coverageAlignArgs` is pure given its inputs, which
 * is exactly why it was split out of `runCoverageAlign`: the flag can be read
 * here without an aligner, a GPU or an app.
 */
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => REPO, isPackaged: false },
    BrowserWindow: class {},
  },
};
const { coverageAlignArgs } = require(path.join(REPO, 'dist', 'electron', 'coverage-align-job.js'));
const {
  TRANSCRIPT_LENGTH_TOLERANCE, transcriptLengthVerdict,
} = require(path.join(REPO, 'dist', 'shared', 'audio', 'transcript-length.js'));

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

// ── the aligner's command line ──────────────────────────────────────────────
//
// The transcript is a MEASUREMENT and assembly never rewrites one, so the number
// on `narrator align --chapter-gap` has to be the number on the assembler's
// `--chapter_gap`. Two spellings (narrator's own subcommand vs the compat door),
// one resolver.

const SPAWN_INPUTS = {
  reportPath: 'E:/lib/projects/Twain-a1b2/tts/hash/coverage.json',
  device: 'cuda',
  alignEnv: { python: '/home/fake/envs/qwen-align/bin/python' },
};
const alignArgv = (over = {}) => coverageAlignArgs(
  Object.assign({
    processDir: 'E:/lib/projects/Twain-a1b2/tts/hash',
    language: 'en',
    device: 'gpu',
  }, over),
  SPAWN_INPUTS,
);
/** The value that follows a flag in an argv, or undefined when the flag is absent. */
const valueOf = (argv, flag) => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};

test('the align door carries --chapter-gap at all', () => {
  assert.ok(alignArgv().includes('--chapter-gap'),
    'narrator align writes the transcript assembly seals; without this flag it writes it at '
    + 'gap 0 and the cues drift by the gap at every chapter boundary');
});

test("--chapter-gap is narrator's spelling on the align subcommand", () => {
  const argv = alignArgv();
  assert.ok(!argv.includes('--chapter_gap'),
    'the underscore spelling is the assembly compat door\'s; align would refuse it');
});

test('ABSENT resolves to the house default on the aligner too, not to zero', () => {
  assert.strictEqual(valueOf(alignArgv(), '--chapter-gap'), String(DEFAULT_CHAPTER_GAP));
  assert.strictEqual(valueOf(alignArgv(), '--chapter-gap'), '3',
    'a caller that states nothing gets the gap its assembly will get');
});

test('an explicit zero reaches the aligner as zero', () => {
  assert.strictEqual(valueOf(alignArgv({ chapterGap: 0 }), '--chapter-gap'), '0',
    'the butt-joined book must be measured butt-joined');
});

test('a stated gap reaches the aligner as stated', () => {
  assert.strictEqual(valueOf(alignArgv({ chapterGap: 4.5 }), '--chapter-gap'), '4.5');
});

test('the aligner and the assembler resolve the SAME number', () => {
  for (const stated of [undefined, 0, 1.5, 4.5, MAX_CHAPTER_GAP]) {
    assert.strictEqual(
      valueOf(alignArgv({ chapterGap: stated }), '--chapter-gap'),
      String(resolveChapterGap(stated)),
      `the align door disagrees with the resolver at ${stated}`);
  }
});

test('a nonsense gap is refused by the align door, never measured', () => {
  assert.throws(() => alignArgv({ chapterGap: -1 }), /chapterGap/);
});

// ── the gate that catches a transcript on the wrong ruler ───────────────────

test('a transcript that ends a chapter-gap-per-boundary early is REFUSED', () => {
  // The Pokemon book: 15 boundaries x 3 s = 45 s of silence the aligner never
  // knew about, so its last cue lands 45 s before the audio ends.
  const audio = 6 * 3600;
  assert.strictEqual(transcriptLengthVerdict(audio, audio - 45), 'transcript-short');
});

test('a transcript that ends after the audio is still the truncated export', () => {
  const audio = 6 * 3600;
  assert.strictEqual(transcriptLengthVerdict(audio, audio + 10), 'transcript-long');
});

test('the legitimate tail after the last cue passes', () => {
  const audio = 6 * 3600;
  assert.strictEqual(transcriptLengthVerdict(audio, audio - 1), 'ok');
  assert.strictEqual(transcriptLengthVerdict(audio, audio + 1), 'ok');
});

test('the tolerance is the same in both directions, and it is 5 s', () => {
  assert.strictEqual(TRANSCRIPT_LENGTH_TOLERANCE, 5);
  const audio = 1000;
  assert.strictEqual(transcriptLengthVerdict(audio, audio - 5), 'ok');
  assert.strictEqual(transcriptLengthVerdict(audio, audio + 5), 'ok');
  assert.strictEqual(transcriptLengthVerdict(audio, audio - 5.1), 'transcript-short');
  assert.strictEqual(transcriptLengthVerdict(audio, audio + 5.1), 'transcript-long');
});

test('an unmeasurable audio length is a verdict, not a shrug', () => {
  assert.strictEqual(transcriptLengthVerdict(null, 1000), 'unmeasurable');
  assert.strictEqual(transcriptLengthVerdict(NaN, 1000), 'unmeasurable');
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
