#!/usr/bin/env node
/**
 * GENERATE SENTENCES FOR CLIPS — the pure logic (shared/sentence-align/clip-locate).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-clip-locate.js
 *
 * Pins, on a synthetic book and stitched "heard" transcript:
 *  1. stitchPlan puts each clip after the previous one and a gap.
 *  2. splitHeardByClip deals words back to their clips in clip-local seconds, and a
 *     word heard in a gap belongs to nobody.
 *  3. locateClip finds each clip in the book whatever the clips' order, with the
 *     book stretch covering the clip's sentences.
 *  4. A misheard proper noun does not stop a clip being located.
 *  5. A clip whose words occur nowhere uniquely is unlocated (null), never guessed.
 *  6. A located clip diffed against its stretch places its own sentences with the
 *     EPUB text, and a sentence cut by the clip's edge is not placed.
 */
'use strict';
const assert = require('assert');
const L = require('../dist/shared/sentence-align/clip-locate.js');
const D = require('../dist/shared/sentence-align/book-diff.js');

let passed = 0; const failed = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const book = [
  'Vin crouched on the rooftop above the keep.',                       // 0
  'The mists curled around her like living things.',                   // 1
  'Kelsier had told her to wait for the signal.',                      // 2
  'She burned tin and the night sharpened around her.',                // 3
  'Somewhere below, a guard coughed and shifted his spear.',           // 4
  'Elend Venture was reading in the library again.',                   // 5
  'He had three books open and a fourth in his lap.',                  // 6
  'Sazed folded his hands and waited for the king to speak.',          // 7
  'The Lord Ruler had ruled for a thousand years.',                    // 8
  'Nobody remembered a time before the ash began to fall.',            // 9
  'Marsh watched the obligators file into the chamber.',               // 10
  'He said nothing.',                                                  // 11
].map((text) => ({ text }));

// Three clips, stitched OUT of book order: [5,6], [1,2], [9 + first half of 10]
let t = 0; const heard = []; const durations = [];
function clip(sentenceTexts) {
  const start = t;
  for (const s of sentenceTexts) {
    for (const w of s.split(' ')) { heard.push({ word: w, start: t, end: t + 0.3 }); t += 0.35; }
    t += 0.5;
  }
  const d = t - start; durations.push(d); t = start + d + L.STITCH_GAP_S;
}
clip(['Ellen Venture was reading in the library again.', 'He had three books open and a fourth in his lap.']);   // misheard Elend
clip(['The mists curled around her like living things.', 'Kelsier had told her to wait for the signal.']);
clip(['Nobody remembered a time before the ash began to fall.', 'Marsh watched the']);                          // cut mid-sentence
// a word hallucinated in the gap after clip 0
heard.push({ word: 'um', start: durations[0] + 0.5, end: durations[0] + 0.7 });
heard.sort((a, b) => a.start - b.start);

const plan = L.stitchPlan(durations);
check('stitchPlan: each clip starts after the one before and a gap', () => {
  assert.strictEqual(plan[0].offset, 0);
  assert.ok(Math.abs(plan[1].offset - (durations[0] + L.STITCH_GAP_S)) < 1e-9);
  assert.ok(Math.abs(plan[2].offset - (plan[1].offset + durations[1] + L.STITCH_GAP_S)) < 1e-9);
});

const { perClip, inGaps } = L.splitHeardByClip(heard, plan);
check('splitHeardByClip: words land in their own clip, in clip-local seconds', () => {
  assert.strictEqual(perClip[0][0].word, 'Ellen');
  assert.strictEqual(perClip[1][0].word, 'The');
  assert.ok(perClip[1][0].start >= 0 && perClip[1][0].start < 0.01, `clip 1 starts at ${perClip[1][0].start}`);
  assert.strictEqual(perClip[2][perClip[2].length - 1].word, 'the');
});
check('a word heard in the gap belongs to no clip', () => assert.strictEqual(inGaps, 1));

const index = L.buildBookIndex(book);
const locs = perClip.map((h) => L.locateClip(index, h));
check('each clip is located whatever the stitch order', () => {
  assert.ok(locs[0] && locs[0].sentenceFrom <= 5 && locs[0].sentenceTo >= 6, JSON.stringify(locs[0]));
  assert.ok(locs[1] && locs[1].sentenceFrom <= 1 && locs[1].sentenceTo >= 2, JSON.stringify(locs[1]));
  assert.ok(locs[2] && locs[2].sentenceFrom <= 9 && locs[2].sentenceTo >= 10, JSON.stringify(locs[2]));
});
check('a misheard proper noun does not stop the clip being located (4-word runs carry it)', () => assert.strictEqual(locs[0].n, 4));
check('a clip with no unique run in the book is unlocated, never guessed', () => {
  assert.strictEqual(L.locateClip(index, [{ word: 'He', start: 0, end: 0.2 }, { word: 'said', start: 0.3, end: 0.5 }]), null);
  assert.strictEqual(L.locateClip(index, []), null);
});

check('diffed against its stretch, a clip places its own sentences with the EPUB text', () => {
  const sub = book.slice(locs[0].sentenceFrom, locs[0].sentenceTo + 1);
  const diff = D.diffBookAgainstHeard(sub, perClip[0]);
  const at = (i) => diff.sentences[i - locs[0].sentenceFrom];
  assert.strictEqual(at(5).status, 'placed'); assert.strictEqual(at(6).status, 'placed');
  assert.ok(at(5).start < 0.01, `sentence 5 starts at ${at(5).start}`);
});
check('the sentence the clip edge cuts is not placed', () => {
  const sub = book.slice(locs[2].sentenceFrom, locs[2].sentenceTo + 1);
  const diff = D.diffBookAgainstHeard(sub, perClip[2]);
  const s10 = diff.sentences[10 - locs[2].sentenceFrom];
  assert.notStrictEqual(s10.status, 'placed');
  assert.ok(s10.coverage > 0, 'part of it was heard');
  assert.strictEqual(diff.sentences[9 - locs[2].sentenceFrom].status, 'placed');
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { process.exitCode = 1; }
