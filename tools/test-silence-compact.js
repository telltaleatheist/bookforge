#!/usr/bin/env node
/**
 * NEVER SEND SILENCE TO THE ASR — shared/sentence-align/silence-compact.ts
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-silence-compact.js
 *
 * A timeline with speech at 10-40 s and 3600-3630 s and digital silence everywhere else (a partial recording):
 *  1. keepPieces keeps exactly the two speech stretches (padded) and drops the hour of silence between them.
 *  2. A short quiet (a pause under MIN_SILENT_S) is not cut.
 *  3. A recording with no digital silence (room tone) is left alone: null.
 *  4. mapWordsBack puts compacted-timeline words back at their original times, and drops a word heard in a gap.
 */
'use strict';
const assert = require('assert');
const S = require('../dist/shared/sentence-align/silence-compact.js');
const { FRAME_S } = require('../dist/shared/sentence-align/cue-edges.js');

let passed = 0; const failed = [];
function check(name, fn) { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); } }

const dur = 3700; const n = Math.round(dur / FRAME_S);
const db = new Float32Array(n).fill(-180);                       // digital silence
const speak = (a, b) => { for (let f = Math.round(a / FRAME_S); f < Math.round(b / FRAME_S); f++) db[f] = -25; };
speak(10, 40); speak(3600, 3630);
for (let f = Math.round(20 / FRAME_S); f < Math.round(21 / FRAME_S); f++) db[f] = -180;   // a 1 s pause inside speech

const pieces = S.keepPieces({ db }, dur);
check('two speech stretches kept, the silent hour dropped', () => {
  assert.strictEqual(pieces.length, 2, JSON.stringify(pieces));
  assert.ok(Math.abs(pieces[0].srcStart - (10 - S.KEEP_PAD_S)) < 0.05 && Math.abs(pieces[0].srcEnd - (40 + S.KEEP_PAD_S)) < 0.05, JSON.stringify(pieces[0]));
  assert.ok(Math.abs(pieces[1].srcStart - (3600 - S.KEEP_PAD_S)) < 0.05, JSON.stringify(pieces[1]));
  assert.ok(S.compactedLength(pieces) < 70, `sent ${S.compactedLength(pieces)} s of ${dur}`);
});
check('a pause shorter than MIN_SILENT_S is not cut out of the speech', () => {
  assert.ok(pieces[0].srcStart < 20 && pieces[0].srcEnd > 21);
});
check('a recording with room tone and no digital silence passes through untouched', () => {
  const room = new Float32Array(n).fill(-65); assert.strictEqual(S.keepPieces({ db: room }, dur), null);
});
check('words map back to their original times; a word heard in a gap is dropped', () => {
  const p1 = pieces[1];
  const words = [
    { word: 'first', start: pieces[0].dstStart + 5, end: pieces[0].dstStart + 5.3 },
    { word: 'second', start: p1.dstStart + 2, end: p1.dstStart + 2.4 },
    { word: 'ghost', start: p1.dstStart - 0.6, end: p1.dstStart - 0.4 },          // inside the inserted gap
  ];
  const r = S.mapWordsBack(words, pieces);
  assert.strictEqual(r.dropped, 1);
  assert.ok(Math.abs(r.words[0].start - (pieces[0].srcStart + 5)) < 1e-6);
  assert.ok(Math.abs(r.words[1].start - (p1.srcStart + 2)) < 1e-6, JSON.stringify(r.words[1]));
});

console.log(`\nsilence-compact: ${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
