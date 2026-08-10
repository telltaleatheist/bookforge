#!/usr/bin/env node
/**
 * Tests for shared/document/artifact-open.ts — you open your book, you land on
 * the file you can edit.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-artifact-open.js
 *
 * Owen, 2026-08-09: "instead of prompting the user to open the working copy,
 * lets just open the working copy… theyll open the original version — the
 * archive epub created by the vlm. but it will ACTUALLY open the working copy
 * with the changes applied."
 *
 * Every door into a project pointed at an archive-grade file — an EPUB project's
 * `archive/<Book>.epub` because the export aligns against the book's own markup,
 * a PDF project's cast book because that is what the working copy is minted from
 * — and both landed the user in front of a read-only banner whose only offer was
 * to take them one click further to the file they had asked for.
 *
 * What is asserted here is the decision, and only the decision. Ensuring the
 * copy exists is main's job (`book:ensure-working-copy`) and showing the
 * conversion flow is the main window's; what is pure — and what the picker's
 * `resolveProjectOpen` reads — is this.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'artifact-open.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { planArtifactOpen } = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A project imported AS an EPUB: an archive original, and a copy of it. */
const epubNative = {
  archiveOriginal: 'C:/lib/Killing America/archive/Killing America.epub',
  generatedEpub: null,
  workingCopy: 'C:/lib/Killing America/source/Killing America.working.epub',
};

/** A project imported as a PDF whose pages have been read into a book. */
const pdfRead = {
  archiveOriginal: 'C:/lib/Deathstalker/archive/Deathstalker.pdf',
  generatedEpub: 'C:/lib/Deathstalker/source/Deathstalker.generated.epub',
  workingCopy: 'C:/lib/Deathstalker/source/Deathstalker.working.epub',
};

/** The same PDF project before anything read its pages. */
const pdfUnread = {
  archiveOriginal: 'C:/lib/Deathstalker/archive/Deathstalker.pdf',
  generatedEpub: null,
  workingCopy: null,
};

const plan = (project, asked) => planArtifactOpen({ ...project, asked }).kind;

test('the archive EPUB the user handed us opens the working copy', () => {
  assert.strictEqual(plan(epubNative, epubNative.archiveOriginal), 'working-copy');
});

test('the book cast from a PDF opens the working copy', () => {
  // Archive-grade since 2026-08-09 — it is what every working copy of this book
  // is minted from, and re-casting it costs an hour of GPU.
  assert.strictEqual(plan(pdfRead, pdfRead.generatedEpub), 'working-copy');
});

test('the working copy opens as itself — there is nowhere else to send it', () => {
  assert.strictEqual(plan(epubNative, epubNative.workingCopy), 'as-asked');
  assert.strictEqual(plan(pdfRead, pdfRead.workingCopy), 'as-asked');
});

test('an archive EPUB with NO copy yet still redirects — the caller mints one', () => {
  // The redirect is not conditional on the copy already existing. A project
  // whose copy was deleted, or which has never been opened, must still land the
  // user on their book; `book:ensure-working-copy` is what makes that true, and
  // it refuses loudly when it cannot.
  const neverOpened = { ...epubNative, workingCopy: null };
  assert.strictEqual(plan(neverOpened, neverOpened.archiveOriginal), 'working-copy');
});

test('a PDF whose pages have never been read is offered the conversion', () => {
  // The one open that offers a job instead of a file: there is nothing to copy,
  // and reading the pages is the only way to get a book.
  assert.strictEqual(plan(pdfUnread, pdfUnread.archiveOriginal), 'offer-conversion');
});

test('a PDF that HAS a book opens as itself — read-only browsing, no modal', () => {
  // Owen: opening the PDF of a project that already has a book is browsing, and
  // the banner over it carries the way across. Offering the conversion here
  // would be offering an hour of GPU to somebody who already has the answer.
  assert.strictEqual(plan(pdfRead, pdfRead.archiveOriginal), 'as-asked');
});

test('a PDF with a cast but no copy is browsed, never re-cast', () => {
  // The copy is missing and can be minted from the cast for the price of a file
  // copy. Offering the conversion would sell an hour of GPU for that.
  const castOnly = { ...pdfRead, workingCopy: null };
  assert.strictEqual(plan(castOnly, castOnly.archiveOriginal), 'as-asked');
});

test('the narration copy opens as itself — previewing it is the point', () => {
  const tts = 'C:/lib/Killing America/source/Killing America.tts.epub';
  assert.strictEqual(plan(epubNative, tts), 'as-asked');
});

test('a file that is none of the three artifacts opens as asked', () => {
  // A stage output, a variant edition, a diff preview. Only the archive-grade
  // books are redirected; everything else is shown as it was asked for.
  assert.strictEqual(
    plan(epubNative, 'C:/lib/Killing America/stages/01-cleanup/simplified.epub'), 'as-asked');
});

test('a project with no archive record redirects nothing', () => {
  // A real state — an imported audiobook has no document original — and the
  // honest answer is to show what was asked for and let the read-only banner
  // say what it is.
  const noArchive = { archiveOriginal: null, generatedEpub: null, workingCopy: null };
  assert.strictEqual(plan(noArchive, 'C:/lib/Somewhere/archive/Book.epub'), 'as-asked');
});

test('paths are matched the way the rest of the pipeline matches them', () => {
  // Separators and case, because a manifest-derived path and an IPC payload
  // spell one Windows file two ways — and two spellings of the archive original
  // would be a redirect that silently stops happening.
  assert.strictEqual(
    plan(epubNative, 'C:\\lib\\Killing America\\archive\\Killing America.epub'), 'working-copy');
  assert.strictEqual(
    plan(pdfRead, 'c:/lib/deathstalker/source/deathstalker.working.epub'), 'as-asked');
});

test('the working copy is recognised BEFORE the cast, whatever the records say', () => {
  // The ordering is load-bearing: a project migrated by `ensureGeneratedEpub`
  // had its working copy adopted as the source of its generated book, and if
  // those two records ever named one file, asking about the cast first would
  // send the user away from the file they were already standing on.
  const sameFile = {
    archiveOriginal: 'C:/lib/Old/archive/Old.pdf',
    generatedEpub: 'C:/lib/Old/source/Old.working.epub',
    workingCopy: 'C:/lib/Old/source/Old.working.epub',
  };
  assert.strictEqual(plan(sameFile, sameFile.workingCopy), 'as-asked');
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
