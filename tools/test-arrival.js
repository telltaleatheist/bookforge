#!/usr/bin/env node
/**
 * Tests for shared/document/arrival.ts and shared/document/open-when-finished.ts
 * — what happens the moment a book is opened, and the promise that outlives the
 * window which made it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-arrival.js
 *
 * Both modules exist because of what Owen found in the first real session
 * (docs/PIPELINE_V2_PLAN.md, 2026-08-04): a freshly imported book opened
 * read-only with no obvious way forward, and an "open when finished" checkbox
 * that only paid out for a user who had stayed and watched.
 *
 * The arrival rule is worth defending because both of its wrong answers cost the
 * user something real and neither one errors: casting a SCAN unasked spends
 * minutes and 1.4 GB of page renders behind their back, and refusing to cast a
 * TEXT PDF leaves them on a read-only page for the sake of thirty seconds of
 * work. So every input that moves the answer has a test, and so does every input
 * that must NOT move it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ARRIVAL = path.join(REPO, 'dist', 'shared', 'document', 'arrival.js');
const PROMISE = path.join(REPO, 'dist', 'shared', 'document', 'open-when-finished.js');
if (!fs.existsSync(ARRIVAL) || !fs.existsSync(PROMISE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { decideArrival } = require(ARRIVAL);
const { OpenWhenFinishedLedger } = require(PROMISE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const stages = (over = {}) => ({
  getText: false, blocks: false, footnotes: false, reflow: false, ...over,
});

/** A PDF project nobody has cast yet — the state every import starts in. */
const fresh = (over = {}) => ({
  hasProject: true,
  isCorpusBook: false,
  book: { hasPdfOriginal: true, workingStages: null, bookEpubExists: false },
  documentClass: 'text',
  stageRunning: false,
  ...over,
});

// ── the arrival decision ────────────────────────────────────────────────────

test('a text PDF is cast on open — seconds, so nothing is asked', () => {
  assert.strictEqual(decideArrival(fresh({ documentClass: 'text' })), 'cast-now');
});

test('a scan is OFFERED, never taken — minutes are not spent behind the user', () => {
  assert.strictEqual(decideArrival(fresh({ documentClass: 'scanned' })), 'offer-cast');
});

test('an unmeasured class stands still — there is no safe guess', () => {
  // NO FALLBACK. `text` would spend a book's worth of GPU on the wrong pipeline;
  // `scanned` would put a modal in front of a book that was thirty seconds from
  // ready. Standing still spends nothing and claims nothing.
  assert.strictEqual(decideArrival(fresh({ documentClass: null })), 'stand-on-archive');
});

test('a book that already has a working copy just stands on it', () => {
  for (const documentClass of ['text', 'scanned', null]) {
    assert.strictEqual(
      decideArrival(fresh({
        documentClass,
        book: { hasPdfOriginal: true, workingStages: stages({ getText: true }), bookEpubExists: false },
      })),
      'stand-on-working',
      `class ${documentClass}`
    );
  }
});

test('a cast book with no blocks yet still stands on the working copy', () => {
  // The cast is what makes the station exist; detecting is the next PRESS, not
  // a condition of standing there. This is the state every book is in between
  // the two, and it is where the Detect button lives.
  assert.strictEqual(
    decideArrival(fresh({
      book: {
        hasPdfOriginal: true,
        workingStages: stages({ getText: true, blocks: false }),
        bookEpubExists: false,
      },
    })),
    'stand-on-working'
  );
});

test('a book that arrived as an EPUB is never offered a cast', () => {
  // Not "not yet" — never. Main refuses to cast a working PDF from a book by
  // name, so offering it would be offering a button that refuses.
  assert.strictEqual(
    decideArrival(fresh({
      documentClass: 'text',
      book: { hasPdfOriginal: false, workingStages: null, bookEpubExists: true },
    })),
    'stand-on-archive'
  );
});

test('a book with no project has nowhere to put a working copy', () => {
  assert.strictEqual(decideArrival(fresh({ hasProject: false })), 'stand-on-archive');
});

test('a corpus book is never cast — it is deliberately not a project', () => {
  assert.strictEqual(decideArrival(fresh({ isCorpusBook: true })), 'stand-on-archive');
});

test('a stage already working on this book is never fought', () => {
  assert.strictEqual(decideArrival(fresh({ stageRunning: true })), 'stand-on-archive');
  assert.strictEqual(
    decideArrival(fresh({ documentClass: 'scanned', stageRunning: true })),
    'stand-on-archive'
  );
  // …but a book that already HAS its working copy is still stood on, because
  // that costs nothing and is where the user belongs while the stage runs.
  assert.strictEqual(
    decideArrival(fresh({
      stageRunning: true,
      book: { hasPdfOriginal: true, workingStages: stages({ getText: true }), bookEpubExists: false },
    })),
    'stand-on-working'
  );
});

// ── the open-when-finished promise ──────────────────────────────────────────

test('a promise is kept per project and taken exactly once', () => {
  const ledger = new OpenWhenFinishedLedger();
  ledger.request('/lib/a', 'working');
  assert.strictEqual(ledger.pending('/lib/a'), 'working');
  assert.strictEqual(ledger.take('/lib/a'), 'working');
  // The second taker gets nothing: two windows open on one book must not both
  // open the same station and fight over the viewer.
  assert.strictEqual(ledger.take('/lib/a'), null);
  assert.strictEqual(ledger.pending('/lib/a'), null);
});

test('a promise about one book is never paid on another', () => {
  const ledger = new OpenWhenFinishedLedger();
  ledger.request('/lib/a', 'working');
  assert.strictEqual(ledger.take('/lib/b'), null);
  assert.strictEqual(ledger.take('/lib/a'), 'working');
});

test('a request with no project is refused, not remembered under an empty name', () => {
  const ledger = new OpenWhenFinishedLedger();
  assert.throws(() => ledger.request('', 'working'), /name the project/);
});

test('only the stage that mints the promised station cashes it', () => {
  const ledger = new OpenWhenFinishedLedger();
  ledger.request('/lib/a', 'epub');
  // The queue's own bar labels, the picker's stage names and the pass kinds all
  // travel on document:stage-finished — all three are recognized.
  assert.strictEqual(ledger.awaits('/lib/a', 'Get Text'), false);
  assert.strictEqual(ledger.awaits('/lib/a', 'Detect blocks'), false);
  assert.strictEqual(ledger.awaits('/lib/a', 'Build the book'), true);
  assert.strictEqual(ledger.awaits('/lib/a', 'Reflow'), true);
  assert.strictEqual(ledger.awaits('/lib/a', 'reflow'), true);
  // A stage that mints nothing (footnote removal edits the book in place)
  // cashes nothing.
  assert.strictEqual(ledger.awaits('/lib/a', 'Footnote removal'), false);
});

test('a cast in a two-pass run does not cash a promise made about the book', () => {
  const ledger = new OpenWhenFinishedLedger();
  ledger.request('/lib/a', 'epub');
  assert.strictEqual(ledger.awaits('/lib/a', 'Read the pages'), false);
  assert.strictEqual(ledger.pending('/lib/a'), 'epub');
});

test('a withdrawn promise is not waiting for anything', () => {
  const ledger = new OpenWhenFinishedLedger();
  ledger.request('/lib/a', 'working');
  ledger.cancel('/lib/a');
  assert.strictEqual(ledger.awaits('/lib/a', 'Get Text'), false);
  assert.strictEqual(ledger.take('/lib/a'), null);
});

test('a second request over one book replaces the first', () => {
  // The user pressed something newer, and that is what they are waiting for.
  const ledger = new OpenWhenFinishedLedger();
  ledger.request('/lib/a', 'working');
  ledger.request('/lib/a', 'epub');
  assert.deepStrictEqual(ledger.outstanding(), [{ projectDir: '/lib/a', station: 'epub' }]);
});

for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

if (failures.length > 0) {
  console.error(`\narrival: ${failures.length} test(s) failed`);
  process.exit(1);
}
console.log(`\narrival: ${passed} test(s) passed`);
