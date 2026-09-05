#!/usr/bin/env node
/**
 * Tests for THE SHAPE OF A NARRATION RUN (shared/queue/narration-run.ts).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-chain.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Owen's ruling of 2026-08-29 turned one enhancement pass into two, in an order
 * the user picks. That makes FOUR enhancement shapes where there was one, and the
 * things that can go wrong in them are all silent:
 *
 *  - the inter-sentence gap must be applied EXACTLY ONCE, on RAW sentences, by
 *    whichever pass touches them first. A gap applied twice pads every sentence
 *    twice; a gap applied to already-enhanced audio does nothing at all, because
 *    the exactly-zero pad it detects is gone. Neither reads as an error — you
 *    hear it, an hour later, in the finished book.
 *  - the conversion must NOT carry `finalDenoise` any more. If it did, the job
 *    would refuse the row, and the user would have spent a narration getting
 *    there.
 *  - the assembly must stop stating a gap the moment anything upstream bakes one,
 *    or one knob is answered in two places.
 *  - and a run that converts sentences it did not render must file as a SECOND
 *    audiobook, because filing it as the first destroys the original.
 *
 * Every one of those is a pure function of the settings and the stages, which is
 * exactly what this file drives — no queue, no disk, no Electron.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'queue', 'narration-run.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  buildNarrationSteps,
  narrationEnhancementPasses,
  requireNarrationStages,
} = require(MODULE);

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

const RVC = {
  voiceId: 'deathstalker-sigma',
  indexRate: 0.3,
  protectRate: 0.1,
  nSemitones: -2,
};

/** Settings with the enhancement dials set however this case needs them. */
function settings(over = {}) {
  return Object.assign({
    language: 'en',
    // The cleanup is a question with three answers (9e1baa00): a run states it.
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
}

const stages = (over = {}) =>
  Object.assign({ narrate: true, enhance: false, assemble: true }, over);

/** The step types of a run, in order — the shape, said in one line. */
const shapeOf = (steps) => steps.map((s) => s.type);
const find = (steps, type) => steps.find((s) => s.type === type);

// ── the four shapes ─────────────────────────────────────────────────────────

test('NEITHER PASS: narrate → assemble, and the assembly owns the gap', () => {
  const steps = buildNarrationSteps(BOOK, settings({ sentenceGap: 0.4 }), stages());
  assert.deepStrictEqual(shapeOf(steps), ['tts-conversion', 'reassembly']);
  assert.strictEqual(find(steps, 'reassembly').config.sentenceGap, 0.4,
    'nothing upstream bakes it, so the assembly states it');
});

test('DENOISE ONLY: narrate → denoise → assemble, gap on the denoise', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, sentenceGap: 0.4 }), stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'final-denoise', 'reassembly']);
  assert.strictEqual(find(steps, 'final-denoise').config.sentenceGap, 0.4);
  assert.strictEqual('sentenceGap' in find(steps, 'reassembly').config, false,
    'the assembly is handed a set the gap is already in');
});

test('RVC ONLY: narrate → convert → assemble, and THE CONVERSION owns the gap', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC, sentenceGap: 0.4 }), stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'rvc-enhancement', 'reassembly']);
  // The case the split fixed: with no denoise in the run, nothing used to apply
  // the gap at all — the assembly skipped it because "rvc bakes it" and the rvc
  // job only ran a gap pass as part of a denoise it was no longer doing.
  assert.strictEqual(find(steps, 'rvc-enhancement').config.sentenceGap, 0.4);
  assert.strictEqual('sentenceGap' in find(steps, 'reassembly').config, false);
});

test('BOTH, default order: narrate → denoise → convert → assemble', () => {
  const steps = buildNarrationSteps(
    BOOK,
    settings({ finalDenoise: true, rvc: RVC, sentenceGap: 0.4 }),
    stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'final-denoise', 'rvc-enhancement', 'reassembly']);
  assert.strictEqual(find(steps, 'final-denoise').config.sentenceGap, 0.4,
    'the denoise is first, so it reads the raw sentences and bakes the gap');
  assert.strictEqual('sentenceGap' in find(steps, 'rvc-enhancement').config, false,
    'the second pass must NOT restate it — the pad it needs is already gone');
});

test('BOTH, reversed: narrate → convert → denoise → assemble, gap moves with it', () => {
  const steps = buildNarrationSteps(
    BOOK,
    settings({
      finalDenoise: true, rvc: RVC, sentenceGap: 0.4, enhancementOrder: 'rvc-first',
    }),
    stages({ enhance: true }));
  assert.deepStrictEqual(shapeOf(steps),
    ['tts-conversion', 'rvc-enhancement', 'final-denoise', 'reassembly']);
  assert.strictEqual(find(steps, 'rvc-enhancement').config.sentenceGap, 0.4,
    'the conversion is first now, so the gap is its job');
  assert.strictEqual('sentenceGap' in find(steps, 'final-denoise').config, false);
  assert.strictEqual('sentenceGap' in find(steps, 'reassembly').config, false);
});

test('the gap is stated EXACTLY ONCE in every shape', () => {
  for (const order of ['denoise-first', 'rvc-first']) {
    for (const finalDenoise of [false, true]) {
      for (const rvc of [null, RVC]) {
        const enhance = finalDenoise || rvc !== null;
        const steps = buildNarrationSteps(
          BOOK,
          settings({ finalDenoise, rvc, sentenceGap: 0.4, enhancementOrder: order }),
          stages({ enhance }));
        const stated = steps.filter(
          (s) => s.type !== 'tts-conversion' && s.config.sentenceGap !== undefined);
        assert.strictEqual(stated.length, 1,
          `${order}/denoise=${finalDenoise}/rvc=${rvc !== null}: ${stated.length} steps state a gap`);
      }
    }
  }
});

test('an untouched gap is stated NOWHERE — provenance stays in charge', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, rvc: RVC }), stages({ enhance: true }));
  for (const step of steps) {
    assert.strictEqual(step.config.sentenceGap, undefined, step.type);
  }
});

// ── the coupling that had to go ─────────────────────────────────────────────

test('THE CONVERSION NEVER CARRIES finalDenoise ANY MORE', () => {
  for (const order of ['denoise-first', 'rvc-first']) {
    const steps = buildNarrationSteps(
      BOOK,
      settings({ finalDenoise: true, rvc: RVC, enhancementOrder: order }),
      stages({ enhance: true }));
    const rvc = find(steps, 'rvc-enhancement');
    assert.strictEqual('finalDenoise' in rvc.config, false,
      `${order}: the job refuses that flag by name, so it must never be set`);
  }
});

test('the two enhancement rows are named apart', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, rvc: RVC }), stages({ enhance: true }));
  assert.strictEqual(find(steps, 'final-denoise').metadata.title, 'Denoise');
  assert.strictEqual(find(steps, 'rvc-enhancement').metadata.title, 'Voice conversion');
});

// ── what the stage flag means ───────────────────────────────────────────────

test('enhance OFF runs neither pass however the settings are set', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true, rvc: RVC }), stages({ enhance: false }));
  assert.deepStrictEqual(shapeOf(steps), ['tts-conversion', 'reassembly']);
});

test('the order is only consulted when both passes run', () => {
  // A nonsense order beside ONE pass is not an error, because no order is being
  // stated: with one pass there is nothing to order.
  const s = settings({ finalDenoise: true, enhancementOrder: 'nonsense' });
  assert.deepStrictEqual(narrationEnhancementPasses(s, stages({ enhance: true })), ['denoise']);
});

test('an unreadable order beside BOTH passes is refused, never assumed', () => {
  const s = settings({ finalDenoise: true, rvc: RVC, enhancementOrder: 'nonsense' });
  assert.throws(() => narrationEnhancementPasses(s, stages({ enhance: true })),
    /neither "denoise-first" nor "rvc-first"/);
});

// ── the refusals ────────────────────────────────────────────────────────────

test('a checked Enhance with neither pass on is refused BY NAME', () => {
  assert.throws(
    () => requireNarrationStages(stages({ enhance: true }), settings()),
    /neither enhancement pass is turned on/);
});

test('enhancement with no assembly is refused', () => {
  assert.throws(
    () => requireNarrationStages(
      { narrate: true, enhance: true, assemble: false }, settings({ finalDenoise: true })),
    /leave nothing to listen to/);
});

test('a run with no stage at all is refused', () => {
  assert.throws(
    () => requireNarrationStages(
      { narrate: false, enhance: false, assemble: false }, settings()),
    /nothing to queue/);
});

test('a conversion with no voice is refused before anything is built', () => {
  assert.throws(
    () => buildNarrationSteps(
      BOOK,
      settings({ rvc: Object.assign({}, RVC, { voiceId: '' }) }),
      stages({ enhance: true })),
    /no enhancement voice is selected/);
});

// ── where the audiobook is filed ────────────────────────────────────────────

test('a CACHE run that converts files as a SECOND audiobook, named by the voice', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC }), stages({ narrate: false, enhance: true }));
  const asm = find(steps, 'reassembly').config;
  assert.strictEqual(asm.registerAsNewVariant, true);
  assert.strictEqual(asm.rvcVoiceId, RVC.voiceId);
});

test('a CACHE run that only DENOISES files into the base slot', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true }), stages({ narrate: false, enhance: true }));
  const asm = find(steps, 'reassembly').config;
  assert.strictEqual(asm.registerAsNewVariant, false,
    'a denoise is the same narration with its hiss taken out, not a second edition');
  assert.strictEqual('rvcVoiceId' in asm, false);
});

test('a run that RENDERED what it converts files into the base slot', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ rvc: RVC }), stages({ enhance: true }));
  assert.strictEqual(find(steps, 'reassembly').config.registerAsNewVariant, false);
});

// ── what the first step reads ───────────────────────────────────────────────

test('a cache run starting on a DENOISE points at the session, by kind', () => {
  const steps = buildNarrationSteps(
    BOOK, settings({ finalDenoise: true }), stages({ narrate: false, enhance: true }));
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'audio-session' },
    'named by kind with no path: which session it is, is a question about the disk');
  assert.strictEqual(steps[1].sourceRef, undefined, 'only the first step says');
});

test('a cache run starting on a CONVERSION points at the session too', () => {
  const steps = buildNarrationSteps(
    BOOK,
    settings({ finalDenoise: true, rvc: RVC, enhancementOrder: 'rvc-first' }),
    stages({ narrate: false, enhance: true }));
  assert.strictEqual(steps[0].type, 'rvc-enhancement');
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'audio-session' });
});

test('a run that narrates reads the DOCUMENT it names', () => {
  const steps = buildNarrationSteps(BOOK, settings(), stages());
  assert.deepStrictEqual(steps[0].sourceRef, { kind: 'epub', path: BOOK.epubPath });
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
console.log(`narration-chain: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
