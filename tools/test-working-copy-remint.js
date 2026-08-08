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
 * What is asserted here is the SENTENCE, because the sentence is the fix. The
 * counting lives in manifest-service (it is the thing holding the manifest) and
 * the deciding lives in ensureBookEpub; what is pure — and what both main's
 * console line and the picker's alert read — is this.
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

/** The shape of the book the failure happened to. */
const killingAmerica = {
  relPath: 'source/Killing America.working.epub',
  deletedBlockIds: 412,
  deletedPages: 7,
  narrationStrikes: 386,
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

test('it corrects the belief that deleting the file starts the book over', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(/does not start the book over/.test(said), `no correction in: ${said}`);
});

test('the counts that still apply are stated, both of them', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(said.includes('412 deleted block(s)'), `blocks missing from: ${said}`);
  assert.ok(said.includes('7 deleted page(s)'), `pages missing from: ${said}`);
  assert.ok(/still apply/.test(said), `it does not say they apply: ${said}`);
});

test('strikes are reported as GONE, because the re-mint drops them', () => {
  // registerEpubExport replaces outputs.epub wholesale, and the strikes live
  // inside it. Telling the user they carried over would be the opposite of true.
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(said.includes('386 element(s)'), `strike count missing from: ${said}`);
  assert.ok(/went with it/.test(said), `it does not say they are gone: ${said}`);
});

test('a book with no strikes says nothing about strikes', () => {
  const said = describeWorkingCopyRemint({ ...killingAmerica, narrationStrikes: 0 });
  assert.ok(!/element\(s\)/.test(said), `it mentions strikes anyway: ${said}`);
  // and still says everything else
  assert.ok(said.includes('412 deleted block(s)'), `blocks missing from: ${said}`);
});

test('a re-mint that carried nothing still says the file was made again', () => {
  // The zero case is real — a book deleted before anything was struck out of it —
  // and it is still news: the file the user was looking at is not the file that
  // is there now.
  const said = describeWorkingCopyRemint({
    relPath: 'source/Quiet.working.epub',
    deletedBlockIds: 0,
    deletedPages: 0,
    narrationStrikes: 0,
  });
  assert.ok(/made again/.test(said), `no re-mint in: ${said}`);
  assert.ok(said.includes('0 deleted block(s)'), `it hides the zero: ${said}`);
});

test('it names the button that actually starts over, in the button\'s words', () => {
  const said = describeWorkingCopyRemint(killingAmerica);
  assert.ok(said.includes('Erase all changes and start over'),
    `the way out is not named in: ${said}`);
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
