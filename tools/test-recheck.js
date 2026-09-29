#!/usr/bin/env node
/**
 * RE-HEAR A CORRECTED CUE ON ITS OWN AUDIO — shared/sentence-align/recheck.ts
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-recheck.js
 *
 *  1. every span is padded by RECHECK_PAD_S of real audio on both sides, and pieces sit end to end with KEEP_GAP_S
 *     of silence between them;
 *  2. spans whose padding overlaps are merged into one piece (never the same audio twice);
 *  3. padding is clamped to the recording, and a zero-length span is skipped;
 *  4. mapWordsBack returns re-heard words to the original timeline - a word inside a cue lands inside the cue.
 */
'use strict';
const assert = require('assert');
const R = require('../dist/shared/sentence-align/recheck.js');
const S = require('../dist/shared/sentence-align/silence-compact.js');

let passed = 0; const failed = [];
function check(name, fn) { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); } }
const near = (a, b) => Math.abs(a - b) < 1e-9;

check('1. padded, laid end to end with the gap', () => {
  const p = R.recheckPieces([{ start: 100, end: 110 }, { start: 200, end: 205 }], 1000, 1.5, 1.0);
  assert.strictEqual(p.length, 2);
  assert.ok(near(p[0].srcStart, 98.5) && near(p[0].srcEnd, 111.5) && near(p[0].dstStart, 0));
  assert.ok(near(p[1].srcStart, 198.5) && near(p[1].srcEnd, 206.5) && near(p[1].dstStart, 13 + 1.0));
});
check('2. overlapping padding merges (and input order does not matter)', () => {
  const p = R.recheckPieces([{ start: 112, end: 120 }, { start: 100, end: 110 }], 1000, 1.5, 1.0);
  assert.strictEqual(p.length, 1);
  assert.ok(near(p[0].srcStart, 98.5) && near(p[0].srcEnd, 121.5));
});
check('3. clamped to the recording; empty spans skipped', () => {
  const p = R.recheckPieces([{ start: 0.5, end: 3 }, { start: 998, end: 1000 }, { start: 50, end: 50 }], 1000, 1.5, 1.0);
  assert.strictEqual(p.length, 2);
  assert.ok(near(p[0].srcStart, 0) && near(p[1].srcEnd, 1000));
});
check('4. a re-heard word maps back inside its cue', () => {
  const p = R.recheckPieces([{ start: 100, end: 110 }, { start: 200, end: 205 }], 1000, 1.5, 1.0);
  // "The" at 1.9 s of the compact audio = 100.4 s; "since" at 14.6 s = second piece (dst 14) + 0.6 = 199.1 s
  const back = S.mapWordsBack([{ word: 'The', start: 1.8, end: 2.0 }, { word: 'since', start: 14.5, end: 14.7 }, { word: 'gap', start: 13.4, end: 13.6 }], p);
  assert.strictEqual(back.dropped, 1, 'the word heard in the silent gap is dropped');
  assert.ok(near(back.words[0].start, 100.3) && back.words[0].start >= 100 && back.words[0].end <= 110);
  assert.ok(near(back.words[1].start, 199.0));
});

/*
 * DECODE LOOPS (2026-09-28, Crucible 1.0.58): a looped piece comes back with NO words. Mapped back to the book's
 * timeline, a cue whose padded audio meets one gets no verdict from that listen, so a hole is never read as the
 * reader leaving words out (Third Reich tc, recheck piece 17395.2-17397.1 s).
 */
check('a loop in the re-hear audio maps back to the cue it covered, and that cue gets no re-hear verdict', () => {
  // two cues re-heard: 100-104 s and 200-203 s of the book
  const pieces = R.recheckPieces([{ start: 100, end: 104 }, { start: 200, end: 203 }], 1000);
  // the second piece starts after the first's padded length plus the gap
  const second = pieces[1];
  const loopInRecheck = { start: second.dstStart + 2.0, end: second.dstStart + 3.0 };
  const back = S.mapSpansBack([loopInRecheck], pieces);
  assert.strictEqual(back.length, 1);
  assert.ok(Math.abs(back[0].start - (second.srcStart + 2.0)) < 1e-9, JSON.stringify(back));
  assert.strictEqual(R.touchesDecodeLoop({ start: 200, end: 203 }, back), true, 'the looped cue was not caught');
  assert.strictEqual(R.touchesDecodeLoop({ start: 100, end: 104 }, back), false, 'a clean cue was caught');
  // A loop only in the PADDING still touches the cue: its words were heard through that audio.
  assert.strictEqual(R.touchesDecodeLoop({ start: 200, end: 203 }, [{ start: 203.5, end: 204 }]), true);
  // And the long pass is judged on the cue itself (pad 0).
  assert.strictEqual(R.touchesDecodeLoop({ start: 200, end: 203 }, [{ start: 203.5, end: 204 }], 0), false);
});

check('an OLD cache\'s loop is found by its repetition, and real repetition in a book is left alone', () => {
  const L = require('../dist/shared/sentence-align/repeat-loops.js');
  let t = 0; const say = (s) => s.split(' ').map((word) => { const w = { word, start: t, end: t + 0.3 }; t += 0.4; return w; });
  // WoA's shape: one sentence over and over
  const looped = [...say('he walked out'), ...say('the first thing that you need to do'.repeat(1)),
    ...say('the first thing that you need to do'), ...say('the first thing that you need to do'),
    ...say('the first thing that you need to do'), ...say('and then')];
  const runs = L.repeatedRuns(looped);
  assert.strictEqual(runs.length, 1, JSON.stringify(runs));
  assert.ok(runs[0].start >= looped[3].start - 1e-9 && runs[0].end <= looped[looped.length - 3].end + 1e-9);
  // One word, eight times
  t = 0; assert.strictEqual(L.repeatedRuns(say('no no no no no no no no')).length, 1);
  // Real repetition: a salute three times, "no" five times, ordinary prose
  t = 0; assert.deepStrictEqual(L.repeatedRuns(say('Heil Hitler! Heil Hitler! Heil Hitler! the crowd roared')), []);
  t = 0; assert.deepStrictEqual(L.repeatedRuns(say('no, no, no, no, no she said')), []);
  t = 0; assert.deepStrictEqual(L.repeatedRuns(say('it was the best of times it was the worst of times')), []);
});

console.log(`recheck: ${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
