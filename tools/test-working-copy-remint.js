#!/usr/bin/env node
/**
 * Tests for shared/document/working-copy-remint.ts — a re-mint has to be SAID.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-working-copy-remint.js
 *
 * The measured failure (2026-08-08): a user deleted `source/<book>.working.epub`
 * believing that started the book over. `ensureBookEpub` made it again from the
 * archive, byte-identical, in silence — and every deletion recorded in the
 * manifest still described those bytes, so they all applied to the "fresh" copy.
 *
 * The belief was right and the code was wrong (Owen, 2026-08-09: "if i delete
 * the working copy, all of its deletions and changes should go with it"). A
 * re-mint now runs the same wholesale reset the "Erase all changes and start
 * over" button runs, and THEN mints; the sentence is the receipt for it.
 *
 * What is asserted here is that sentence. The counting lives in manifest-service
 * (it is the thing holding the manifest) and the clearing lives in
 * ensureBookEpub; what is pure — and what both main's console line and the
 * picker's notice read — is this.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'working-copy-remint.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { describeWorkingCopyRemint } = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** The shape of the book the failure happened to — a project imported AS an EPUB. */
const killingAmerica = {
  relPath: 'source/Killing America.working.epub',
  source: 'archive-epub',
  deletedBlockIds: 412,
  deletedPages: 7,
  narrationStrikes: 386,
  // Nothing has been RUN over this book — no simplify, no translate — so the
  // fresh copy is the archive-grade original exactly. That is the case the
  // original failure happened in, and it is still the common one.
  kept: [],
};

test('it names the file, so the user knows which one came back', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(said.includes('source/Killing America.working.epub'),
    `the path is not in: ${said}`);
});

test('it says the file was made again from the archive', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(/made again/.test(said), `no re-mint in: ${said}`);
  assert.ok(/archive/.test(said), `the archive is not named in: ${said}`);
});

test('it CONFIRMS that deleting the file starts the book over', () => {
  // The old sentence corrected this belief, because the old code kept the
  // records. The code changed; if this sentence ever goes back to correcting
  // the user it will be describing a re-mint that no longer happens.
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(/is how a book is started over/.test(said), `no confirmation in: ${said}`);
  assert.ok(!/does not start the book over/.test(said), `it still corrects the user: ${said}`);
});

test('the records are said to be CLEARED, not carried over', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(/cleared with it/.test(said), `it does not say they were cleared: ${said}`);
  assert.ok(!/still apply/.test(said), `it still claims they apply: ${said}`);
});

test('every count is on the receipt, all three of them', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(said.includes('412 deleted block(s)'), `blocks missing from: ${said}`);
  assert.ok(said.includes('7 deleted page(s)'), `pages missing from: ${said}`);
  assert.ok(said.includes('386 element(s) struck out for narration'),
    `strike count missing from: ${said}`);
});

test('it says the copy on screen is the unedited archive original', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(/archive original, unedited/.test(said), `it does not say what the copy is: ${said}`);
});

test('a PDF-origin book is told it came back from the READING of its pages', () => {
  // Its archive is a PDF, so there is no archive EPUB it could have been copied
  // from. Saying "the archive original" to that user would name a file that does
  // not exist and imply their PDF is what they are looking at.
  const said = describeWorkingCopyRemint({ ...killingAmerica, source: 'generated-epub' });
  assert.ok(/read out of this project's pages/.test(said), `it does not name the cast: ${said}`);
  assert.ok(!/archive original/.test(said), `it still claims an archive EPUB: ${said}`);
  assert.ok(/exactly as it was read, with none of your edits/.test(said),
    `it does not say what the copy is: ${said}`);
  // Everything the archive case says is still said.
  assert.ok(/made again/.test(said), `no re-mint in: ${said}`);
  assert.ok(said.includes('412 deleted block(s)'), `blocks missing from: ${said}`);
});

test('a book with no strikes says nothing about strikes', () => {
  const said = describeWorkingCopyRemint({ ...killingAmerica, narrationStrikes: 0 });
  assert.ok(!/element\(s\)/.test(said), `it mentions strikes anyway: ${said}`);
  // and still says everything else
  assert.ok(said.includes('412 deleted block(s)'), `blocks missing from: ${said}`);
});

test('a re-mint that cleared nothing still says the file was made again', () => {
  // The zero case is real — a book deleted before anything was struck out of it —
  // and it is still news: the file the user was looking at is not the file that
  // is there now.
  const said = describeWorkingCopyRemint({
    relPath: 'source/Quiet.working.epub',
    source: 'archive-epub',
    deletedBlockIds: 0,
    deletedPages: 0,
    narrationStrikes: 0,
    kept: [],
  });
  assert.ok(/made again/.test(said), `no re-mint in: ${said}`);
  assert.ok(said.includes('0 deleted block(s)'), `it hides the zero: ${said}`);
});

test('a book with recorded passes is NOT told it got the original back', () => {
  // The fresh copy of a book that has been simplified is derived from the
  // snapshot that pass left, because that is the only file with it applied.
  // Saying "the archive original, unedited" there would describe a file the
  // project did not make.
  const said = describeWorkingCopyRemint({ ...killingAmerica, kept: ['Simplify'] });
  assert.ok(!/archive original, unedited/.test(said), `it claims the original is back: ${said}`);
  assert.ok(/with Simplify applied/.test(said), `it does not name what stood: ${said}`);
  assert.ok(/ledger/.test(said), `it does not say where that record lives: ${said}`);
  // The counts are still owed, exactly as in the ordinary case.
  assert.ok(said.includes('412 deleted block(s)'), `blocks missing from: ${said}`);
  assert.ok(said.includes('386 element(s) struck out for narration'),
    `strike count missing from: ${said}`);
});

test('the "start over" button is NOT named — there is nothing to get out of', () => {
  // It was named while a re-mint kept the records and the user needed a way to
  // undo one. Pointing at it now would tell a user who has already started the
  // book over to go and start it over.
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(!said.includes('Erase all changes and start over'),
    `it still sends the user to the button: ${said}`);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
