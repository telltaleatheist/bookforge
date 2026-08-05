#!/usr/bin/env node
/**
 * Tests for shared/document/stations.ts — the ladder the Next button walks.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-station-ladder.js
 *
 * The whole point of this module is that a station EXISTS when its artifact
 * exists, measured off the documents, and never because a run reported success.
 * So the tests are written the way the pipeline is: feed in what the documents
 * say, and check that the ladder says what the files say.
 *
 * The second thing under test is the sentence. A locked Next that cannot name
 * the button which would unlock it is a dead end, and "disabled" is not
 * information — the user can see that. Worse than a dead end is a sentence that
 * names a button which would REFUSE the user, which is what a book with no PDF
 * ancestor got when its Working station read as "not yet" instead of "never".
 * Both are asserted here.
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
  ARTIFACT_STATIONS,
  existingStations,
  stationPresence,
  nextStation,
  nextStationFromViewed,
  stationForArtifact,
  viewedArtifactOf,
  stationMintedBy,
} = require(MODULE);
const { samePath } = require(path.join(REPO, 'dist', 'shared', 'document', 'same-path.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** The four measured stages, with everything off unless named. */
const stages = (over = {}) => ({
  getText: false, blocks: false, footnotes: false, reflow: false, ...over,
});

/** A book imported as a PDF: it has an original a working copy can be cast from. */
const pdfBook = (over = {}) => ({
  hasPdfOriginal: true,
  workingStages: stages(),
  bookEpubExists: false,
  ...over,
});

/**
 * A book imported as an EPUB. It has NO PDF to cast from — main refuses one by
 * name — so it never has a binding record and `workingStages` is null forever.
 */
const epubBook = (over = {}) => ({
  hasPdfOriginal: false,
  workingStages: null,
  bookEpubExists: false,
  ...over,
});

// ── What a book HAS ─────────────────────────────────────────────────────────

test('an untouched book has only its archive', () => {
  assert.deepStrictEqual(existingStations(pdfBook()), ['archive']);
});

test('a cast book has a working copy', () => {
  assert.deepStrictEqual(
    existingStations(pdfBook({ workingStages: stages({ getText: true }) })),
    ['archive', 'working']);
});

test('detecting blocks mints no new station — it writes into the working copy', () => {
  assert.deepStrictEqual(
    existingStations(pdfBook({ workingStages: stages({ getText: true, blocks: true }) })),
    ['archive', 'working']);
});

test('a built book has an EPUB station', () => {
  assert.deepStrictEqual(
    existingStations(pdfBook({
      workingStages: stages({ getText: true, blocks: true }),
      bookEpubExists: true,
    })),
    ['archive', 'working', 'epub']);
});

test('TTS is never an artifact this pipeline mints', () => {
  const all = existingStations(pdfBook({
    workingStages: stages({ getText: true, blocks: true, footnotes: true, reflow: true }),
    bookEpubExists: true,
  }));
  assert.ok(!all.includes('tts'), 'TTS must not appear in the measured station list');
});

test('the book EPUB is measured by the export record, not by the binding', () => {
  // A binding that says reflow ran is not the question — the question is whether
  // the project HAS a book, and a book with no PDF ancestor has no binding at
  // all. One measure for both kinds, so neither can be stranded.
  assert.ok(existingStations(pdfBook({
    workingStages: stages({ getText: true, reflow: true }),
    bookEpubExists: false,
  })).includes('epub') === false);
  assert.ok(existingStations(epubBook({ bookEpubExists: true })).includes('epub'));
});

// ── A book with no PDF ancestor ─────────────────────────────────────────────

test('a book that arrived as an EPUB has an archive and nothing else, at first', () => {
  assert.deepStrictEqual(existingStations(epubBook()), ['archive']);
});

test('its Working station is NOT APPLICABLE, not absent', () => {
  // The distinction is the whole fix: "absent" points at OCR / Cast, and that
  // button refuses this book by name.
  assert.strictEqual(stationPresence('working', epubBook()), 'not-applicable');
  assert.strictEqual(stationPresence('working', pdfBook()), 'absent');
  assert.strictEqual(
    stationPresence('working', pdfBook({ workingStages: stages({ getText: true }) })),
    'present');
});

test('Next at its archive skips the working copy and asks for the book', () => {
  const step = nextStation('archive', epubBook());
  assert.strictEqual(step.next, 'epub');
  assert.match(step.lockedReason, /Build the book/);
});

test('and never sends it to OCR / Cast, which would refuse it', () => {
  const step = nextStation('archive', epubBook());
  assert.doesNotMatch(step.lockedReason, /Cast/,
    'a book with no PDF must never be pointed at the cast button');
});

test('once built, Next walks archive → epub → narration with no working rung', () => {
  const built = epubBook({ bookEpubExists: true });
  assert.deepStrictEqual(nextStation('archive', built), { next: 'epub', lockedReason: null });
  assert.deepStrictEqual(nextStation('epub', built), { next: 'tts', lockedReason: null });
});

test('its narration station is reachable exactly when the book is', () => {
  assert.strictEqual(stationPresence('tts', epubBook()), 'absent');
  assert.strictEqual(stationPresence('tts', epubBook({ bookEpubExists: true })), 'present');
});

test('standing on its Working station is refused — it does not have one', () => {
  assert.throws(() => nextStation('working', epubBook()), /does not have one/);
});

// ── Where Next goes ─────────────────────────────────────────────────────────

test('from the archive with nothing cast, Next is locked and names Cast', () => {
  const step = nextStation('archive', pdfBook());
  assert.strictEqual(step.next, 'working');
  assert.ok(step.lockedReason, 'must be locked');
  assert.match(step.lockedReason, /OCR \/ Cast/);
});

test('from the archive with a working copy, Next is live', () => {
  const step = nextStation('archive', pdfBook({ workingStages: stages({ getText: true }) }));
  assert.deepStrictEqual(step, { next: 'working', lockedReason: null });
});

test('from the working copy with no book, Next is locked and names Build the book', () => {
  const step = nextStation('working',
    pdfBook({ workingStages: stages({ getText: true, blocks: true }) }));
  assert.strictEqual(step.next, 'epub');
  assert.match(step.lockedReason, /Build the book/);
});

test('from the working copy with a book, Next is live', () => {
  const book = pdfBook({
    workingStages: stages({ getText: true, blocks: true }),
    bookEpubExists: true,
  });
  assert.deepStrictEqual(nextStation('working', book), { next: 'epub', lockedReason: null });
});

test('from the EPUB, Next goes to narration', () => {
  const book = pdfBook({
    workingStages: stages({ getText: true, blocks: true }),
    bookEpubExists: true,
  });
  assert.deepStrictEqual(nextStation('epub', book), { next: 'tts', lockedReason: null });
});

test('the top of the ladder has no next and no complaint', () => {
  const book = pdfBook({
    workingStages: stages({ getText: true, blocks: true }),
    bookEpubExists: true,
  });
  assert.deepStrictEqual(nextStation('tts', book), { next: null, lockedReason: null });
});

test('standing on a station the book does not have is refused by name', () => {
  assert.throws(
    () => nextStation('epub', pdfBook({ workingStages: stages({ getText: true }) })),
    /does not have one/,
  );
});

test('every locked sentence names a button, for both kinds of book', () => {
  // Walked rather than listed, so a station added later cannot be left with a
  // sentence that says only "you cannot go on".
  for (const book of [pdfBook(), epubBook(), pdfBook({ workingStages: stages({ getText: true }) })]) {
    for (const from of STATIONS) {
      if (stationPresence(from, book) !== 'present') continue;
      const step = nextStation(from, book);
      if (step.lockedReason === null) continue;
      assert.match(step.lockedReason, /press /,
        `${from}'s locked sentence must name the button that unlocks it`);
    }
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

test('the queue names its stages differently, and lands in the same places', () => {
  // Both producers of `document:stage-finished` are real: the picker path uses
  // document-ipc's names, the queue path uses processing-passes' bar labels. A
  // background run that opened nothing because the label differed would be a
  // checkbox that works only when you are watching it.
  assert.strictEqual(stationMintedBy('Read the pages'), 'working');
  assert.strictEqual(stationMintedBy('Detect blocks'), 'working');
  assert.strictEqual(stationMintedBy('Build the book'), 'epub');
});

test('a pass kind lands where its stage does', () => {
  assert.strictEqual(stationMintedBy('get-text'), 'working');
  assert.strictEqual(stationMintedBy('blocks'), 'working');
  assert.strictEqual(stationMintedBy('reflow'), 'epub');
});

test('a stage that mints no artifact opens nothing', () => {
  // Null rather than a guess: a stage this does not know about has not been
  // proved to produce a station, and switching tabs on a guess moves the user
  // away from what they were doing.
  assert.strictEqual(stationMintedBy('Footnotes'), null);
  assert.strictEqual(stationMintedBy(''), null);
});

// ── The ladder does not go backwards ────────────────────────────────────────
//
// RULED 2026-08-04 (second real session). Reflow is the gate into the EPUB
// world; once the book exists, Next from the book is narration. Owen: "we left
// the working (pdf) copy to reflow the epub, we dont need to go back to the
// working copy once its reflowed."

const builtBook = () => pdfBook({
  workingStages: stages({ getText: true, blocks: true, reflow: true }),
  bookEpubExists: true,
});

test('Next from the book is narration, never the working copy', () => {
  const step = nextStationFromViewed('epub', builtBook());
  assert.strictEqual(step.next, 'tts');
  assert.strictEqual(step.lockedReason, null);
});

test('no station ever walks back down the ladder', () => {
  // The property, not one case of it: whatever Next answers, it is further along
  // STATIONS than where it was asked from. A single wrong branch anywhere in the
  // walk shows up here.
  const books = [pdfBook(), pdfBook({ workingStages: stages({ getText: true }) }),
    builtBook(), epubBook(), epubBook({ bookEpubExists: true })];
  for (const book of books) {
    for (const from of STATIONS) {
      const step = nextStationFromViewed(from, book);
      if (step.next === null) continue;
      assert.ok(
        STATIONS.indexOf(step.next) > STATIONS.indexOf(from),
        `Next from ${from} offered ${step.next}, which is backwards`);
    }
  }
});

test('a station the book does not measure as present is answered forwards, not sent home', () => {
  // The bug this replaces, exactly: the picker answered a not-present station by
  // asking `nextStation('archive', book)`, so standing on the built book with the
  // EPUB station momentarily unmeasured produced "Next: Working" — the rung the
  // user had already climbed, offered as progress.
  const unmeasured = pdfBook({
    workingStages: stages({ getText: true, blocks: true }),
    bookEpubExists: false,
  });
  assert.strictEqual(stationPresence('epub', unmeasured), 'absent');
  const step = nextStationFromViewed('epub', unmeasured);
  assert.strictEqual(step.next, 'tts');
  assert.match(step.lockedReason, /Build the book/);
  // And the strict entry point still refuses to be asked about it, which is what
  // guards callers that DO know where the book is.
  assert.throws(() => nextStation('epub', unmeasured));
});

// ── The station is a fact about what is on screen ───────────────────────────

const BOOK = 'C:\\lib\\Kershaw\\source\\Kershaw.epub';
const PDF = 'C:\\lib\\Kershaw\\archive\\Kershaw.pdf';

test('the project PDF on screen is the source, whichever source station it is', () => {
  const artifact = viewedArtifactOf({
    displayedPath: PDF, curatedPdfPath: PDF, bookEpubPath: BOOK,
  });
  assert.strictEqual(artifact, 'source');
  assert.strictEqual(stationForArtifact('archive', artifact), 'archive');
  assert.strictEqual(stationForArtifact('working', artifact), 'working');
});

test('the project book on screen is the book', () => {
  assert.strictEqual(viewedArtifactOf({
    displayedPath: BOOK, curatedPdfPath: PDF, bookEpubPath: BOOK,
  }), 'book');
});

test('a PDF book showing an EPUB is showing the built book, before main answers', () => {
  // `bookEpubPath` is a round trip to main and arrives late. A PDF book's source
  // is a PDF, so an EPUB on screen can only be what reflow wrote — and this
  // answer needs no round trip, which is what keeps the window from standing on
  // a source station over the book for the length of one IPC call.
  assert.strictEqual(viewedArtifactOf({
    displayedPath: BOOK, curatedPdfPath: PDF, bookEpubPath: null,
  }), 'book');
});

test('a book that arrived as an EPUB is at its ARCHIVE, not at an EPUB station', () => {
  // Its original is an EPUB too, and the archive is where it is curated. Reading
  // it as "the book" would lock curation on the one station it has.
  assert.strictEqual(viewedArtifactOf({
    displayedPath: 'C:\\lib\\Sagan\\archive\\Sagan.epub',
    curatedPdfPath: null,
    bookEpubPath: null,
  }), 'source');
});

test('...until it has been built, and its own export is on screen', () => {
  const exported = 'C:\\lib\\Sagan\\source\\Sagan.epub';
  assert.strictEqual(viewedArtifactOf({
    displayedPath: exported, curatedPdfPath: null, bookEpubPath: exported,
  }), 'book');
  assert.strictEqual(viewedArtifactOf({
    displayedPath: 'C:\\lib\\Sagan\\archive\\Sagan.epub',
    curatedPdfPath: null, bookEpubPath: exported,
  }), 'source');
});

test('nothing on screen is the source, and never throws', () => {
  assert.strictEqual(viewedArtifactOf({
    displayedPath: '', curatedPdfPath: null, bookEpubPath: null,
  }), 'source');
});

test('the same file spelled two ways is one file', () => {
  // Main resolves with backslashes; manifests record forward slashes. A window
  // that read those as two files would stand on the wrong station.
  assert.strictEqual(viewedArtifactOf({
    displayedPath: 'C:/lib/Kershaw/source/Kershaw.epub',
    curatedPdfPath: PDF,
    bookEpubPath: BOOK,
  }), 'book');
  assert.ok(samePath('C:\\lib\\a.epub', 'c:/lib/A.EPUB'));
  assert.ok(!samePath('C:\\lib\\a.epub', 'C:\\lib\\b.epub'));
});

test('a station the artifact cannot carry resolves to one it can', () => {
  // Not an error: the window asks for a station and the file arrives, in either
  // order. What must never happen is the two disagreeing afterwards.
  assert.strictEqual(stationForArtifact('working', 'book'), 'epub');
  assert.strictEqual(stationForArtifact('archive', 'book'), 'epub');
  assert.strictEqual(stationForArtifact('epub', 'source'), 'archive');
  assert.strictEqual(stationForArtifact('tts', 'source'), 'archive');
  assert.strictEqual(stationForArtifact('tts', 'book'), 'tts');
});

test('every station belongs to exactly one artifact, and every artifact is closed', () => {
  const seen = [...ARTIFACT_STATIONS.source, ...ARTIFACT_STATIONS.book];
  assert.deepStrictEqual([...seen].sort(), [...STATIONS].sort());
  assert.strictEqual(new Set(seen).size, seen.length);
  // Whatever is asked for, the answer is a station of the artifact on screen.
  for (const artifact of ['source', 'book']) {
    for (const requested of STATIONS) {
      assert.ok(ARTIFACT_STATIONS[artifact].includes(stationForArtifact(requested, artifact)));
    }
  }
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
