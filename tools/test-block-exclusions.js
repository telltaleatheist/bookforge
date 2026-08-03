#!/usr/bin/env node
/**
 * Tests for shared/foundry/block-exclusions.ts — turning what the user deleted
 * back into block ids after foundry has re-segmented the book.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-block-exclusions.js
 *
 * ── What is actually being defended ─────────────────────────────────────────
 *
 * Foundry block ids are `page + POSITION ON THE PAGE`, re-minted by the blocks
 * stage on every run. The editor's deletions were persisted under them, so a
 * queue chain that re-ran ocr + blocks handed `foundry export` a list naming
 * blocks nobody deleted — loud when the ids had vanished (it validates), silent
 * when they still existed and meant something else. Scan LINE ids are the
 * identity that survives, and this module maps them back.
 *
 * Every case below is a shape a real re-run produces: a block split in two, two
 * blocks merged into one, a boundary moved through the middle of a deletion, a
 * line that is not there at all. The last two must STOP — dropping a block that
 * holds kept text and dropping nothing are both wrong and neither is visible in
 * the finished EPUB.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'shared', 'foundry');
if (!fs.existsSync(path.join(DIST, 'block-exclusions.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  blockIdsCoveredByLines,
  isFoundryBlockId,
  lineIdsOfBlocks,
  planFoundryExclusions,
  resolveExcludedBlockIds,
  FoundryExclusionError,
} = require(path.join(DIST, 'block-exclusions.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

const block = (id, page, ...lineIds) => ({ id, page, lineIds });

/** The blocks as one run left them: three blocks over two pages, seven lines. */
const before = [
  block('p0000b000', 0, 'p0000l0000', 'p0000l0001'),
  block('p0000b001', 0, 'p0000l0002', 'p0000l0003', 'p0000l0004'),
  block('p0001b000', 1, 'p0001l0000', 'p0001l0001'),
];

// ── the id shape ────────────────────────────────────────────────────────────

test('a foundry block id is recognised', () => {
  assert.ok(isFoundryBlockId('p0000b000'));
  assert.ok(isFoundryBlockId('p9999b999'));
});

test('no other block id in the app can be mistaken for one', () => {
  // In-app OCR, a picker merge, a text-layer block (12 hex chars), and a line id.
  for (const id of ['ocr_p0_eaz7rh_6', 'merge_7105nt', 'a3f91c2b7e04', 'p0000l0000', '']) {
    assert.ok(!isFoundryBlockId(id), id);
  }
});

// ── recording deletions ─────────────────────────────────────────────────────

test('the record is the lines of the deleted blocks, in block order', () => {
  assert.deepStrictEqual(
    lineIdsOfBlocks(before, ['p0001b000', 'p0000b000', 'p0000b000']),
    ['p0000l0000', 'p0000l0001', 'p0001l0000', 'p0001l0001'],
  );
});

test('recording a block the run does not have is refused, not skipped', () => {
  // Skipping it would write a record that quietly stops deleting that block.
  assert.throws(
    () => lineIdsOfBlocks(before, ['p0000b000', 'p0007b003']),
    (err) => err instanceof FoundryExclusionError && err.message.includes('p0007b003'),
  );
});

// ── resolving them against a later run ──────────────────────────────────────

test('unchanged blocks resolve to themselves', () => {
  assert.deepStrictEqual(
    resolveExcludedBlockIds(before, ['p0000l0002', 'p0000l0003', 'p0000l0004']),
    ['p0000b001'],
  );
});

test('renumbering is invisible: the same lines, different ids', () => {
  // What actually happened on Kershaw — the blocks stage re-ran and every id on
  // the page shifted. The deletion is unchanged because it never named an id.
  const renumbered = [
    block('p0000b000', 0, 'p0000l0002', 'p0000l0003', 'p0000l0004'),
    block('p0000b001', 0, 'p0000l0000', 'p0000l0001'),
  ];
  assert.deepStrictEqual(
    resolveExcludedBlockIds(renumbered, ['p0000l0002', 'p0000l0003', 'p0000l0004']),
    ['p0000b000'],
  );
});

test('a deleted block the re-run SPLIT excludes both halves', () => {
  const split = [
    block('p0000b000', 0, 'p0000l0000', 'p0000l0001'),
    block('p0000b001', 0, 'p0000l0002', 'p0000l0003'),
    block('p0000b002', 0, 'p0000l0004'),
  ];
  assert.deepStrictEqual(
    resolveExcludedBlockIds(split, ['p0000l0002', 'p0000l0003', 'p0000l0004']),
    ['p0000b001', 'p0000b002'],
  );
});

test('two deleted blocks the re-run MERGED excludes the one block', () => {
  const merged = [block('p0000b000', 0, 'p0000l0000', 'p0000l0001', 'p0000l0002')];
  assert.deepStrictEqual(
    resolveExcludedBlockIds(merged, ['p0000l0000', 'p0000l0001', 'p0000l0002']),
    ['p0000b000'],
  );
});

test('nothing deleted excludes nothing', () => {
  assert.deepStrictEqual(resolveExcludedBlockIds(before, []), []);
});

// ── the two stops ───────────────────────────────────────────────────────────

test('a block holding deleted AND kept lines stops the export, by name', () => {
  // The re-run merged a deleted block with a kept one. Excluding it drops text
  // nobody deleted; keeping it ships text somebody did. Neither is guessable.
  const straddling = [block('p0000b000', 0, 'p0000l0001', 'p0000l0002', 'p0000l0003')];
  assert.throws(
    () => resolveExcludedBlockIds(straddling, ['p0000l0002', 'p0000l0003']),
    (err) =>
      err instanceof FoundryExclusionError
      && err.message.includes('p0000b000')
      && err.message.includes('page 1'),
  );
});

test('a deleted line that is in no block stops the export, by name', () => {
  assert.throws(
    () => resolveExcludedBlockIds(before, ['p0000l0000', 'p0000l0001', 'p0042l0007']),
    (err) => err instanceof FoundryExclusionError && err.message.includes('p0042l0007'),
  );
});

test('a line claimed by two blocks is a corrupt run, said so', () => {
  const corrupt = [
    block('p0000b000', 0, 'p0000l0000'),
    block('p0000b001', 0, 'p0000l0000'),
  ];
  assert.throws(
    () => planFoundryExclusions(corrupt, []),
    (err) =>
      err instanceof FoundryExclusionError
      && err.message.includes('p0000b000')
      && err.message.includes('p0000b001'),
  );
});

// ── the editor's half: apply what resolved, report what did not ─────────────

test('the plan separates the answerable from the unanswerable', () => {
  const after = [
    block('p0000b000', 0, 'p0000l0000', 'p0000l0001'),
    block('p0000b001', 0, 'p0000l0002', 'p0000l0003'),
  ];
  const plan = planFoundryExclusions(after, ['p0000l0000', 'p0000l0001', 'p0000l0003', 'p0009l0000']);
  assert.deepStrictEqual(plan.excluded, ['p0000b000']);
  assert.deepStrictEqual(plan.straddled.map((b) => b.id), ['p0000b001']);
  assert.deepStrictEqual(plan.missing, ['p0009l0000']);
});

// ── a record that may be RE-DERIVED, not a deletion ─────────────────────────
//
// The one-title rule's "already ruled on" ledger is line-keyed for the same
// reason deletions are, but it fails the other way: the rule can look at the
// blocks and reach the same verdict again, so a unit it cannot place is simply
// judged afresh rather than stopping anything.

test('a ledger of lines resolves to the blocks that hold exactly them', () => {
  assert.deepStrictEqual(
    blockIdsCoveredByLines(before, ['p0000l0002', 'p0000l0003', 'p0000l0004']),
    ['p0000b001'],
  );
});

test('renumbering is invisible to the ledger too', () => {
  const renumbered = [
    block('p0000b000', 0, 'p0000l0002', 'p0000l0003', 'p0000l0004'),
    block('p0000b001', 0, 'p0000l0000', 'p0000l0001'),
  ];
  assert.deepStrictEqual(
    blockIdsCoveredByLines(renumbered, ['p0000l0002', 'p0000l0003', 'p0000l0004']),
    ['p0000b000'],
  );
});

test('a unit the re-run cut through drops OUT of the ledger instead of stopping', () => {
  // The same shape that throws for a deletion. Here it means "the rule has not
  // ruled on this block", which is the right answer: it is about to.
  const straddling = [block('p0000b000', 0, 'p0000l0001', 'p0000l0002', 'p0000l0003')];
  assert.deepStrictEqual(blockIdsCoveredByLines(straddling, ['p0000l0002', 'p0000l0003']), []);
});

test('a ruled line that is in no block is dropped, not a stop', () => {
  assert.deepStrictEqual(
    blockIdsCoveredByLines(before, ['p0000l0000', 'p0000l0001', 'p0042l0007']),
    ['p0000b000'],
  );
});

test('an empty ledger rules on nothing', () => {
  assert.deepStrictEqual(blockIdsCoveredByLines(before, []), []);
});

test('a corrupt run is still a stop, ledger or not', () => {
  // The one thing that is never re-derivable: blocks that do not partition the
  // scan's lines mean the run directory itself is wrong.
  const corrupt = [
    block('p0000b000', 0, 'p0000l0000'),
    block('p0000b001', 0, 'p0000l0000'),
  ];
  assert.throws(
    () => blockIdsCoveredByLines(corrupt, ['p0000l0000']),
    (err) => err instanceof FoundryExclusionError,
  );
});

if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`block-exclusions: ${passed} test(s) passed`);
