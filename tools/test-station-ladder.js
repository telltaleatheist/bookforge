#!/usr/bin/env node
/**
 * Tests for shared/document/stations.ts — the ladder the Next button walks.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-station-ladder.js
 *
 * The whole point of this module is that a station EXISTS when its artifact
 * exists, measured off the binding record, and never because a run reported
 * success. So the tests are written the way the pipeline is: feed in the four
 * measured stage booleans, and check that the ladder says what the files say.
 *
 * The second thing under test is the sentence. A locked Next that cannot name
 * the button which would unlock it is a dead end, and "disabled" is not
 * information — the user can see that. Every locked answer here is asserted to
 * name a button by name.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'stations.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const {
  STATIONS,
  STATION_LABELS,
  existingStations,
  nextStation,
  stationMintedBy,
} = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** The four measured stages, with everything off unless named. */
const stages = (over = {}) => ({
  getText: false, blocks: false, footnotes: false, reflow: false, ...over,
});

// ── What a book HAS ─────────────────────────────────────────────────────────

test('an untouched book has only its archive', () => {
  assert.deepStrictEqual(existingStations(stages()), ['archive']);
});

test('a cast book has a working copy', () => {
  assert.deepStrictEqual(
    existingStations(stages({ getText: true })), ['archive', 'working']);
});

test('detecting blocks mints no new station — it writes into the working copy', () => {
  assert.deepStrictEqual(
    existingStations(stages({ getText: true, blocks: true })),
    ['archive', 'working']);
});

test('a built book has an EPUB station', () => {
  assert.deepStrictEqual(
    existingStations(stages({ getText: true, blocks: true, reflow: true })),
    ['archive', 'working', 'epub']);
});

test('TTS is never an artifact this pipeline mints', () => {
  const all = existingStations(stages({
    getText: true, blocks: true, footnotes: true, reflow: true,
  }));
  assert.ok(!all.includes('tts'), 'TTS must not appear in the measured station list');
});

// ── Where Next goes ─────────────────────────────────────────────────────────

test('from the archive with nothing cast, Next is locked and names Cast', () => {
  const step = nextStation('archive', existingStations(stages()));
  assert.strictEqual(step.next, 'working');
  assert.ok(step.lockedReason, 'must be locked');
  assert.match(step.lockedReason, /OCR \/ Cast/);
});

test('from the archive with a working copy, Next is live', () => {
  const step = nextStation('archive', existingStations(stages({ getText: true })));
  assert.deepStrictEqual(step, { next: 'working', lockedReason: null });
});

test('from the working copy with no book, Next is locked and names Build the book', () => {
  const step = nextStation('working', existingStations(stages({ getText: true, blocks: true })));
  assert.strictEqual(step.next, 'epub');
  assert.match(step.lockedReason, /Build the book/);
});

test('from the working copy with a book, Next is live', () => {
  const present = existingStations(stages({ getText: true, blocks: true, reflow: true }));
  assert.deepStrictEqual(nextStation('working', present), { next: 'epub', lockedReason: null });
});

test('from the EPUB, Next goes to narration', () => {
  const present = existingStations(stages({ getText: true, blocks: true, reflow: true }));
  assert.deepStrictEqual(nextStation('epub', present), { next: 'tts', lockedReason: null });
});

test('the top of the ladder has no next and no complaint', () => {
  const present = existingStations(stages({ getText: true, blocks: true, reflow: true }));
  assert.deepStrictEqual(nextStation('tts', [...present, 'tts']),
    { next: null, lockedReason: null });
});

test('standing on a station the book does not have is refused by name', () => {
  assert.throws(
    () => nextStation('epub', existingStations(stages({ getText: true }))),
    /does not have one/,
  );
});

test('every station the ladder can lock at names a button', () => {
  // Walked rather than listed, so a station added later cannot be left with a
  // sentence that says only "you cannot go on".
  for (const from of STATIONS) {
    if (from === 'tts') continue;
    const step = nextStation(from, [from]);
    if (step.lockedReason === null) continue;
    assert.match(step.lockedReason, /press /,
      `${from}'s locked sentence must name the button that unlocks it`);
  }
});

test('every station has a label', () => {
  for (const id of STATIONS) {
    assert.strictEqual(typeof STATION_LABELS[id], 'string');
    assert.ok(STATION_LABELS[id].length > 0, `${id} has no label`);
  }
});

// ── What "open when finished" opens ─────────────────────────────────────────

test('the cast and the detect both land on the working copy', () => {
  assert.strictEqual(stationMintedBy('Get Text'), 'working');
  assert.strictEqual(stationMintedBy('Blocks'), 'working');
});

test('reflow lands on the EPUB', () => {
  assert.strictEqual(stationMintedBy('Reflow'), 'epub');
});

test('a stage that mints no artifact opens nothing', () => {
  // Null rather than a guess: a stage this does not know about has not been
  // proved to produce a station, and switching tabs on a guess moves the user
  // away from what they were doing.
  assert.strictEqual(stationMintedBy('Footnotes'), null);
  assert.strictEqual(stationMintedBy(''), null);
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
  console.error(`\nstation ladder: ${failures.length} test(s) failed`);
  process.exit(1);
}
console.log(`\nstation ladder: ${passed} test(s) passed`);
