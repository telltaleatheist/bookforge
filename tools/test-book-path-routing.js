#!/usr/bin/env node
/**
 * Which paths the EPUB path is allowed to claim.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-path-routing.js
 *
 * A book used to be a file ending in `.epub`, so every site asked
 * `endsWith('.epub')` for itself. The working copy then became an exploded
 * DIRECTORY, `source/<stem>.working/`, and every one of those checks quietly
 * started answering "no" for the books the app exists to edit — and the `else`
 * on the other side of each of them is the PDF/mupdf path, which does something
 * plausible with anything and so never raised its hand.
 *
 * That is the failure this suite is written against, and it can only fail in
 * two directions, both silent:
 *
 *   a wrong NO  — a book routed to mupdf: the picker rasters the book instead of
 *                 showing its own DOM, and the export rebuilds preserved markup.
 *   a wrong YES — `<Original>.working.pdf` (the working document of a PDF
 *                 project, minted by document-binding.ts) claimed by the EPUB
 *                 path: a PDF handed to a zip reader.
 *
 * The second is why the rule is on the FINAL suffix and never `includes`, and
 * why that trap gets its own section below.
 *
 * Names only. `isBookPath` is a statement about the name, asked in the renderer
 * (no `fs`) and asked about paths that do not exist yet — so nothing here
 * touches the disk, and nothing here should.
 */
'use strict';

const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const {
  isBookPath, isExplodedBookPath, WORKING_COPY_SUFFIX, EPUB_SUFFIX,
} = require(path.join(DIST, 'shared/document/book-path.js'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/** Assert the routing decision for one path, and say which way it went wrong. */
function isBook(documentPath, expected) {
  assertEqual(isBookPath(documentPath), expected,
    expected
      ? `${JSON.stringify(documentPath)} is a book and was sent to the PDF path`
      : `${JSON.stringify(documentPath)} is not a book and was claimed by the EPUB path`);
}
function isExploded(documentPath, expected) {
  assertEqual(isExplodedBookPath(documentPath), expected,
    expected
      ? `${JSON.stringify(documentPath)} is an exploded directory and was treated as a zip`
      : `${JSON.stringify(documentPath)} is not an exploded directory and was treated as one`);
}

/**
 * A real book in the library, chosen because its stem is hostile: spaces, a
 * comma, an initial's period, and parentheses. Anything that reaches for a
 * regex, a `split('.')`, or `path.extname` on a name like this gets a different
 * answer than anything that reads the final suffix.
 */
const PROJECT = 'E:\\Shared\\BookForge\\projects\\P\\source';
const NUREMBERG = 'Nuremberg. Persico, Joseph E. (1994)';
const at = (suffix) => `${PROJECT}\\${NUREMBERG}${suffix}`;

/** Every name the app mints, and the shapes that must never be confused with them. */
const BOOKS = [
  'X.epub',
  'X.EPUB',
  'X.Epub',
  'X.working',
  'X.WORKING',
  'X.Working',
  'X.working.epub',
  'X.tts.epub',
  'X.generated.epub',
  at('.epub'),
  at('.working'),
  at('.WORKING'),
  at('.working.epub'),
  at('.tts.epub'),
  at('.generated.epub'),
  // The same book seen from WSL, where generation runs. Forward slashes must not
  // change the answer, because the answer is about the suffix.
  `/mnt/e/Shared/BookForge/projects/P/source/${NUREMBERG}.working`,
  `/mnt/e/Shared/BookForge/projects/P/source/${NUREMBERG}.epub`,
];

const NOT_BOOKS = [
  'X.pdf',
  'X.working.pdf',
  'X.WORKING.PDF',
  at('.pdf'),
  at('.working.pdf'),
  'X.txt',
  'X.mobi',
  'X.azw3',
  'X.docx',
  // A book exported back out to something else: `.epub` is in the name but the
  // file is a PDF, and the final suffix is the only part that knows.
  'X.epub.pdf',
  // Near-misses on the suffix itself.
  'X.epubx',
  'X.workings',
  'epub',
  'working',
  // A bare name and a directory that is not a book.
  'X',
  PROJECT,
  '',
];

const EXPLODED = [
  'X.working',
  'X.WORKING',
  'X.Working',
  at('.working'),
  at('.WORKING'),
  `/mnt/e/Shared/BookForge/projects/P/source/${NUREMBERG}.working`,
];

console.log('book path routing\n');

console.log('the naming rule');
check('the suffixes are the ones the app mints names with', () => {
  assertEqual(WORKING_COPY_SUFFIX, '.working', 'the exploded working-copy suffix');
  assertEqual(EPUB_SUFFIX, '.epub', 'the zipped-book suffix');
});

console.log('\na book — everything the EPUB path must claim');
check('a book stored as a zip is a book', () => {
  isBook('X.epub', true);
  isBook('X.working.epub', true);
  isBook('X.tts.epub', true);
  isBook('X.generated.epub', true);
});
check('an exploded working copy is a book, though it is a directory', () => {
  // The regression this whole file exists for: before the predicate, this was
  // the one answer every call site got wrong.
  isBook('X.working', true);
});
check('the case of the suffix does not decide it', () => {
  isBook('X.EPUB', true);
  isBook('X.Epub', true);
  isBook('X.WORKING', true);
  isBook('X.Working', true);
});
check('a full Windows path is answered the same as a bare name', () => {
  isBook(at('.epub'), true);
  isBook(at('.working'), true);
  isBook(at('.working.epub'), true);
  isBook(at('.tts.epub'), true);
  isBook(at('.generated.epub'), true);
});
check('a real book name — spaces, commas, parentheses, an initial\'s period', () => {
  // "Nuremberg. Persico, Joseph E. (1994).working" has four periods before the
  // suffix. A split-on-dot reading of the extension calls this book "
  // Persico, Joseph E" and routes it to mupdf.
  isBook(at('.working'), true);
  isExploded(at('.working'), true);
  isBook(at('.working.epub'), true);
  assert(NUREMBERG.includes('.') && NUREMBERG.includes(' ') && NUREMBERG.includes(','),
    'the fixture stopped being a hostile name');
});
check('every name the app mints is a book', () => {
  for (const p of BOOKS) isBook(p, true);
  assertEqual(BOOKS.length, 17, 'the number of book names exercised');
});

console.log('\nnot a book — the PDF path keeps these');
check('a PDF is not a book', () => {
  isBook('X.pdf', false);
  isBook(at('.pdf'), false);
});
check('THE TRAP: <Original>.working.pdf is a PDF, not an exploded book', () => {
  // document-binding.ts mints this for every PDF project. Its name CONTAINS
  // `.working`, so an `includes` reading of the rule hands a PDF to the zip
  // reader — which is why the rule is `endsWith` and this test is here.
  assert(`X${WORKING_COPY_SUFFIX}.pdf`.includes(WORKING_COPY_SUFFIX),
    'the fixture no longer contains the suffix, so it no longer tests the trap');
  isBook('X.working.pdf', false);
  isBook('X.WORKING.PDF', false);
  isBook(at('.working.pdf'), false);
  isExploded('X.working.pdf', false);
  isExploded(at('.working.pdf'), false);
});
check('other ebook formats are not books to this app', () => {
  // `.mobi` and `.azw3` are books to a reader and not to BookForge: nothing
  // downstream of here can open one, so claiming them would only fail later.
  isBook('X.mobi', false);
  isBook('X.azw3', false);
  isBook('X.txt', false);
  isBook('X.docx', false);
});
check('a name with no extension at all is not a book', () => {
  isBook('X', false);
  isBook(PROJECT, false);
});
check('the empty string is not a book', () => {
  isBook('', false);
  isExploded('', false);
});
check('the suffix must be the whole final segment, not a prefix of one', () => {
  isBook('X.epubx', false);
  isBook('X.workings', false);
  isBook('epub', false);
  isBook('working', false);
});
check('a book exported back out to another format is that format', () => {
  isBook('X.epub.pdf', false);
});
check('nothing in the not-a-book list is claimed', () => {
  for (const p of NOT_BOOKS) isBook(p, false);
  assertEqual(NOT_BOOKS.length, 17, 'the number of non-book names exercised');
});

console.log('\nexploded or zipped — the container question, by name');
check('only a .working is exploded', () => {
  for (const p of EXPLODED) isExploded(p, true);
  assertEqual(EXPLODED.length, 6, 'the number of exploded names exercised');
});
check('every zipped member of the family is NOT exploded', () => {
  isExploded('X.epub', false);
  isExploded('X.EPUB', false);
  isExploded('X.working.epub', false);
  isExploded('X.tts.epub', false);
  isExploded('X.generated.epub', false);
  isExploded(at('.epub'), false);
  isExploded(at('.working.epub'), false);
  isExploded(at('.tts.epub'), false);
  isExploded(at('.generated.epub'), false);
});
check('.working in the MIDDLE of a name is not an exploded copy', () => {
  // `<stem>.working.epub` is the ARCHIVED working copy — a zip. It is a book,
  // and handing it to a directory reader would fail on a file that is there.
  isBook('X.working.epub', true);
  isExploded('X.working.epub', false);
  isBook(at('.working.epub'), true);
  isExploded(at('.working.epub'), false);
});
check('nothing that is not a book is ever exploded', () => {
  for (const p of NOT_BOOKS) isExploded(p, false);
});
check('exploded implies book, for every name in the suite', () => {
  // The invariant the call sites lean on: code that has already established
  // `isBookPath` may ask `isExplodedBookPath` to pick a reader, and must never
  // be told a path is an exploded book that is not a book at all.
  for (const p of [...BOOKS, ...NOT_BOOKS, ...EXPLODED]) {
    if (isExplodedBookPath(p)) {
      assert(isBookPath(p), `${JSON.stringify(p)} is exploded but not a book`);
    }
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
