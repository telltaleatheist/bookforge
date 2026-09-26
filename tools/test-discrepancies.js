#!/usr/bin/env node
/**
 * WHERE THE AUDIO AND THE BOOK DISAGREE — shared/sentence-align/discrepancies.ts
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-discrepancies.js
 *
 * Synthetic run: 30 evenly read sentences, then one stretched sentence (pace outlier),
 * a paraphrased one (placed by the aligner, low ASR agreement), an unplaced run, a
 * loud stretch with no heard words (music), and a stretch whose sentence pauses never
 * fall to the floor (a bed under the voice).
 */
'use strict';
const assert = require('assert');
const X = require('../dist/shared/sentence-align/discrepancies.js');
const { FRAME_S } = require('../dist/shared/sentence-align/cue-edges.js');

let passed = 0; const failed = [];
function check(name, fn) { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); } }

const sentences = []; const placements = []; const cues = []; const heard = [];
const placedByDiff = new Set();
let t = 1;
function read(text, dur, opts = {}) {
  const i = sentences.length; sentences.push({ text });
  const ws = text.split(' '); const per = dur / ws.length; const s0 = t;
  const words = ws.map((w, k) => ({ norm: w.toLowerCase(), start: s0 + k * per, end: s0 + (k + 0.8) * per, match: opts.agree === false && k % 2 ? null : 'exact' }));
  ws.forEach((w, k) => heard.push({ word: opts.heardAs ? opts.heardAs[k] || w : w, start: s0 + k * per, end: s0 + (k + 0.8) * per }));
  const coverage = words.filter((w) => w.match === 'exact').length / ws.length;
  placements.push({ index: i, status: 'placed', start: s0, end: s0 + dur, coverage, words });
  cues.push({ index: i, start: s0 - 0.2, end: s0 + dur + 0.2 });
  if (!opts.byAligner) placedByDiff.add(i);
  t = s0 + dur + (opts.pause ?? 0.6);
}
const S = 'The mists curled slowly around the silent keep tonight';   // 55 chars, ~3.7 s at 15 c/s
for (let i = 0; i < 30; i++) read(S, 3.7);
read(S, 9.0);                                                          // 31: stretched
read('Vin climbed the wall and looked down at the guards', 3.4, { byAligner: true, agree: false, heardAs: ['Vin', 'scaled', 'a', 'fence', 'then', 'stared', 'up', 'toward', 'the', 'sky'] });  // 32: paraphrase
for (let i = 0; i < 3; i++) { sentences.push({ text: 'This sentence was never read in the audio at all here.' });
  placements.push({ index: sentences.length - 1, status: 'unspoken', start: null, end: null, coverage: 0, words: [], reason: 'only 0% of its words were heard' }); }
for (let i = 0; i < 10; i++) read(S, 3.7);
const musicA = t; t += 6;                                             // 6 s of loud music, no words
for (let i = 0; i < 12; i++) read(S, 3.7, { pause: 0.8 });           // a bed under these pauses
const bedA = cues[cues.length - 12].start; const bedB = t;

// the envelope: floor -70 dB, speech -20 dB during words, music -25 dB, bed pauses -45 dB
const n = Math.ceil((t + 2) / FRAME_S); const db = new Float32Array(n).fill(-70);
for (const w of heard) for (let f = Math.floor(w.start / FRAME_S); f < Math.ceil(w.end / FRAME_S); f++) db[f] = -20;
for (let f = Math.floor(musicA / FRAME_S); f < Math.ceil((musicA + 6) / FRAME_S); f++) db[f] = -25;
for (let f = Math.floor(bedA / FRAME_S); f < Math.ceil(bedB / FRAME_S); f++) if (db[f] < -45) db[f] = -45;

const r = X.findDiscrepancies({ sentences, placements, placedByDiff, cues, heard, extraAudio: [], env: { db } });
const of = (kind) => r.items.filter((x) => x.kind === kind);

check('the stretched sentence is a pace outlier, and the evenly read ones are not', () => {
  const p = of('pace_outlier'); assert.ok(p.some((x) => x.sentences[0] === 30 && x.what === 'stretched'), JSON.stringify(p.map((x) => x.sentences)));
  assert.ok(p.every((x) => x.sentences[0] >= 30), 'an even sentence was flagged');
});
check('a sentence the aligner placed with little ASR agreement is a paraphrase', () => {
  assert.ok(of('paraphrase').some((x) => x.sentences[0] === 31));
});
check('a run of unplaced sentences is text_not_in_audio with its neighbours\' times', () => {
  const u = of('text_not_in_audio').filter((x) => x.what === 'unplaced_run');
  assert.strictEqual(u.length, 1); assert.deepStrictEqual(u[0].sentences, [32, 33, 34]); assert.ok(u[0].start !== null && u[0].end !== null);
});
check('loud audio with no heard word is non_speech_audio', () => {
  const m = of('non_speech_audio'); assert.ok(m.some((x) => x.start <= musicA + 0.5 && x.end >= musicA + 5), JSON.stringify(m));
});
check('sentence pauses that never reach the floor are a bed under the voice', () => {
  const b = of('music_under_speech'); assert.strictEqual(b.length, 1, JSON.stringify(b)); assert.ok(b[0].start >= bedA - 5 && b[0].end <= bedB + 1);
});
check('the summary counts every kind', () => {
  for (const k of ['pace_outlier', 'paraphrase', 'text_not_in_audio', 'non_speech_audio', 'music_under_speech']) assert.ok(r.summary[k] && r.summary[k].count > 0, k);
});

console.log(`\ndiscrepancies: ${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
