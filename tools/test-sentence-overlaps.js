#!/usr/bin/env node
/**
 * A SENTENCE ENDS BEFORE THE NEXT ONE BEGINS — shared/sentence-align/overlaps.ts
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-sentence-overlaps.js
 *
 * The real placements from The Coming of the Third Reich's book-text run (2026-09-29, align-report.json, indices
 * 1608-1612; training-pc 2026-10-02): sentence 1609's tail was stretched past the first words of the next three,
 * the edge stage then collapsed 1610 and 1611 to 0.05 s each, and the correction wrote their words into 1609.
 */
'use strict';
const assert = require('assert');
const { trimOverlaps, MIN_CUE_S } = require('../dist/shared/sentence-align/overlaps.js');

let passed = 0; const failed = [];
function check(name, fn) { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); } }

const w = (norm, start, end) => ({ norm, start, end, match: 'exact' });
const place = (index, words) => ({
  index, status: 'placed', coverage: 1, words,
  start: Math.min(...words.filter((x) => x.start !== null).map((x) => x.start)),
  end: Math.max(...words.filter((x) => x.end !== null).map((x) => x.end)),
});

// 1609's real tail (the stretched part from "these" on), after its last credible words.
const p1609 = place(1609, [
  w('the', 19407.95, 19408.11), w('french', 19408.11, 19408.27), w('god', 19417.59, 19417.81), w('that', 19418.03, 19418.11),
  w('we', 19418.11, 19418.35), w('dont', 19418.35, 19418.91), w('get', 19418.91, 19418.91), w('into', 19418.91, 19418.91),
  w('these', 19420.99, 19420.99), w('or', 19421.39, 19421.51), w('even', 19421.63, 19421.75), w('higher', 19421.87, 19421.87),
  w('numerical', 19422.11, 19422.67), w('values', 19422.67, 19423.15), w('overcrowding', 19427.25, 19428.07),
  w('lunatic', 19430.07, 19430.19), w('asylums', 19430.31, 19430.43), w('that', 19430.55, 19430.67),
  w('it', 19430.67, 19430.67), w('would', 19430.67, 19430.67), w('cause', 19430.67, 19430.67),
  { norm: '1', start: null, end: null, match: null },
]);
const p1610 = place(1610, [w('at', 19421.85, 19422.01), w('its', 19422.01, 19422.17), w('terrifying', 19423.69, 19424.2)]);
const p1611 = place(1611, [w('money', 19425.37, 19425.61), w('completely', 19426.65, 19427.2)]);
const p1612 = place(1612, [w('printing', 19428.25, 19428.57), w('only', 19440.73, 19441.0)]);

check('the real tc case: 1609 ends before 1610 begins, and nothing after it moves', () => {
  const { placed, trimmed } = trimOverlaps([p1609, p1610, p1611, p1612]);
  assert.deepStrictEqual(trimmed.map((t) => t.index), [1609]);
  assert.strictEqual(placed[0].end, 19421.75, 'its last word ending before "At its height" (19421.85) is "even"');
  assert.ok(placed[0].end <= placed[1].start);
  assert.deepStrictEqual(placed.slice(1), [p1610, p1611, p1612]);
  // So no cue after it is squeezed: every placement now starts at or after the one before it ends.
  for (let i = 1; i < placed.length; i++) assert.ok(placed[i].start >= placed[i - 1].end);
});

check('placements already in order are returned exactly', () => {
  const a = place(1, [w('a', 1, 2)]); const b = place(2, [w('b', 3, 4)]);
  const { placed, trimmed } = trimOverlaps([a, b]);
  assert.deepStrictEqual(trimmed, []);
  assert.deepStrictEqual(placed, [a, b]);
});

check('a placement with no word ending before the next start is left for the collapse flag', () => {
  const a = place(1, [w('a', 5, 9)]); const b = place(2, [w('b', 6, 7)]);
  const { placed, trimmed } = trimOverlaps([a, b]);
  assert.deepStrictEqual(trimmed, []);
  assert.strictEqual(placed[0].end, 9);
});

check('the short-cue guard is above the 0.05 s a collapsed cue gets', () => {
  assert.ok(MIN_CUE_S > 0.05 && MIN_CUE_S <= 0.2, String(MIN_CUE_S));
});

console.log(`\nsentence-overlaps: ${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
