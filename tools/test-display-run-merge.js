#!/usr/bin/env node
/**
 * Tests for shared/ocr/display-run-merge.ts — the display-run merge rule.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-display-run-merge.js
 *
 * ── WHY THIS TEST EXISTS IN TWO REPOSITORIES ────────────────────────────────
 *
 * `shared/ocr/display-run-merge.ts` is checked in VERBATIM at
 * `src/blocks/display-run-merge.ts` in the foundry repo, because the merge has
 * to be the same decision on both sides: BookForge runs it when a corpus book's
 * blocks are formed, foundry runs it before its blocks model classifies
 * anything. A rule that drifted between the two would train the model on one
 * segmentation and infer with another — damage that reads as a bad model rather
 * than as a bug, which is exactly the failure the blocks encoder's replay test
 * exists to prevent.
 *
 * `shared/ocr/display-run-merge.fixture.json` is the drift alarm. The identical
 * file is checked into foundry at `fixtures/display-run-merge.fixture.json` and
 * replayed there by `test/blocks/display-run-merge.test.ts`. Change the rule in
 * one repo and the OTHER repo's test goes red.
 *
 * Beyond the replay: order-independence, idempotence, and that malformed
 * geometry throws naming the block.
 *
 * It used to also drive the rule through `processOcrPageResults`. That module —
 * with `ocr-line.ts` and `ocr-render.ts` — went with the Tesseract pipeline in
 * Aug 2026, and this test was its last consumer. The replay stayed: it is the
 * BookForge half of a drift alarm that lives in two repositories, and the rule
 * it guards is checked in verbatim on both sides.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'shared', 'ocr');
if (!fs.existsSync(path.join(DIST, 'display-run-merge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { planDisplayRuns, DisplayRunInputError, DISPLAY_RUN_RULE } =
  require(path.join(DIST, 'display-run-merge.js'));

const fixture = JSON.parse(
  fs.readFileSync(path.join(REPO, 'shared', 'ocr', 'display-run-merge.fixture.json'), 'utf-8')
);

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

// ── the shared fixture ──────────────────────────────────────────────────────

test('the fixture was written for this version of the rule', () => {
  assert.strictEqual(fixture.rule, DISPLAY_RUN_RULE.version);
});

for (const c of fixture.cases) {
  test(`fixture: ${c.name}`, () => {
    const plan = planDisplayRuns(c.blocks);
    assert.deepStrictEqual(plan.runs, c.expect.runs, c.why);
    assert.strictEqual(plan.modalFontSize, c.expect.modalFontSize);
    assert.strictEqual(plan.bodyColumnWidth, c.expect.bodyColumnWidth);
    assert.deepStrictEqual(plan.furnitureIds, c.expect.furnitureIds);
  });
}

for (const e of fixture.errors) {
  test(`fixture error: ${e.name}`, () => {
    let thrown = null;
    try {
      planDisplayRuns(e.blocks);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, `${e.why}\n  expected a throw, got none`);
    assert.ok(thrown instanceof DisplayRunInputError, `expected DisplayRunInputError, got ${thrown}`);
    // The message must NAME the offender: "a block is malformed", over a
    // 6,000-block book, is not actionable.
    assert.ok(
      thrown.message.includes(e.expectErrorContains),
      `${e.why}\n  message did not name ${e.expectErrorContains}: ${thrown.message}`
    );
  });
}

// ── properties the fixture cannot state as data ─────────────────────────────

/** Deterministic shuffle, so a failure is reproducible. */
function shuffle(items, seed) {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('the plan does not depend on the order blocks arrive in', () => {
  for (const c of fixture.cases) {
    const straight = planDisplayRuns(c.blocks);
    for (const seed of [1, 7, 99]) {
      const shuffled = planDisplayRuns(shuffle(c.blocks, seed));
      assert.deepStrictEqual(shuffled.runs, straight.runs, `${c.name} (seed ${seed})`);
      assert.deepStrictEqual(shuffled.furnitureIds, straight.furnitureIds, `${c.name} (seed ${seed})`);
    }
  }
});

test('running the rule on its own output is a no-op', () => {
  for (const c of fixture.cases) {
    const plan = planDisplayRuns(c.blocks);
    const byId = new Map(c.blocks.map(b => [b.id, b]));
    const swallowed = new Set(plan.runs.flatMap(r => r.slice(1)));
    const leadOf = new Map(plan.runs.map(r => [r[0], r]));
    const merged = [];
    for (const b of c.blocks) {
      if (swallowed.has(b.id)) continue;
      const run = leadOf.get(b.id);
      if (!run) { merged.push(b); continue; }
      const members = run.map(id => byId.get(id));
      const x0 = Math.min(...members.map(m => m.x));
      const y0 = Math.min(...members.map(m => m.y));
      merged.push({
        ...b,
        x: x0,
        y: y0,
        width: Math.max(...members.map(m => m.x + m.width)) - x0,
        height: Math.max(...members.map(m => m.y + m.height)) - y0,
        fontSize: Math.max(...members.map(m => m.fontSize)),
        lineCount: members.reduce((n, m) => n + m.lineCount, 0),
        text: members.map(m => m.text).join(' ').trim(),
      });
    }
    assert.deepStrictEqual(
      planDisplayRuns(merged).runs, [],
      `${c.name}: the merged blocks wanted merging again, so the fixed point is not one`
    );
  }
});

test('a book with no type size at all is refused, not guessed at', () => {
  assert.throws(() => planDisplayRuns([{
    id: 'sizeless', page: 0, x: 0, y: 0, width: 100, height: 20,
    fontSize: 0, lineCount: 0, pageWidth: 450, pageHeight: 666, text: '[Image 100x20]',
  }]), DisplayRunInputError);
});

if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`display-run-merge: ${passed} test(s) passed`);
