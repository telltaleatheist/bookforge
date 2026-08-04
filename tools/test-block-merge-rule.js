#!/usr/bin/env node
/**
 * Tests for shared/document/block-merge.ts — which selections are one block.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-block-merge-rule.js
 *
 * Adjacency is decided here rather than in the writer, because the writer sees
 * a merge only after something has already offered it. The Merge button, the
 * block menu and the service all ask this one function, so these are the tests
 * for all three of them: a rule that refuses in the service but is offered by
 * the button is a control the user can only discover is a lie by pressing it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RULE = path.join(REPO, 'dist', 'shared', 'document', 'block-merge.js');
if (!fs.existsSync(RULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { mergeRefusal, canMerge } = require(RULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A page of blocks in reading order, seq 0..n-1. */
function page(index, count, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${index}b${i + from}`, page: index, seq: i + from,
  }));
}

test('two consecutive blocks on one page are one block', () => {
  const [a, b] = page(0, 2);
  assert.strictEqual(mergeRefusal([a, b]), null);
  assert.strictEqual(canMerge([a, b]), true);
});

test('a whole run of consecutive blocks is one block', () => {
  assert.strictEqual(mergeRefusal(page(0, 6)), null);
});

test('reading order decides adjacency, not the order they were selected', () => {
  const blocks = page(0, 3);
  assert.strictEqual(mergeRefusal([blocks[2], blocks[0], blocks[1]]), null);
});

test('a gap in reading order is refused, and the sentence names how big it is', () => {
  const blocks = page(0, 5);
  const refusal = mergeRefusal([blocks[0], blocks[3]]);
  assert.ok(refusal, 'a selection with two blocks missing from the middle is not a merge');
  assert.ok(refusal.includes('2 blocks sit'), `should name the gap, said: ${refusal}`);
  assert.ok(refusal.includes(blocks[0].id) && refusal.includes(blocks[3].id),
    `should name both ends, said: ${refusal}`);
});

test('a gap of one says "block sits", not "blocks sit"', () => {
  const blocks = page(0, 3);
  const refusal = mergeRefusal([blocks[0], blocks[2]]);
  assert.ok(refusal.includes('1 block sits'), `said: ${refusal}`);
});

test('a gap anywhere in a long run is refused, not only at the ends', () => {
  const blocks = page(0, 8);
  const chosen = [blocks[0], blocks[1], blocks[2], blocks[5], blocks[6]];
  const refusal = mergeRefusal(chosen);
  assert.ok(refusal, 'the run is broken in the middle');
  assert.ok(refusal.includes(blocks[2].id) && refusal.includes(blocks[5].id),
    `should name the two blocks the gap is between, said: ${refusal}`);
});

test('one block is refused before anything else is judged', () => {
  const refusal = mergeRefusal(page(0, 1));
  assert.ok(refusal.includes('one block is already one block'), refusal);
  assert.strictEqual(mergeRefusal([]), refusal, 'and so is none');
});

test('the same block twice is one block, not two', () => {
  const [a] = page(0, 1);
  assert.ok(mergeRefusal([a, a]).includes('one block is already one block'));
});

test('a page break is refused by name, before adjacency is considered', () => {
  // Consecutive in reading order and still not mergeable: seq runs across the
  // page break, so the adjacency test alone would take this.
  const a = { id: 'p0b9', page: 0, seq: 9 };
  const b = { id: 'p1b0', page: 1, seq: 10 };
  const refusal = mergeRefusal([a, b]);
  assert.ok(refusal.includes('page 1') && refusal.includes('page 2'), refusal);
  assert.ok(refusal.includes('page break'), refusal);
});

test('a block with no place in reading order says so rather than being guessed at', () => {
  const [a] = page(0, 1);
  const stray = { id: 'client-side-image', page: 0 };
  const refusal = mergeRefusal([a, stray]);
  assert.ok(refusal.includes('client-side-image'), refusal);
  assert.ok(refusal.includes('reading order'), refusal);
});

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : err}`);
  }
}
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`block-merge rule: ${passed} test(s) passed`);
