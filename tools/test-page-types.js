/**
 * Tests for page-level marking — shared/ocr/page-types.ts and the labels.json
 * round-trip in electron/corpus-book.ts.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-page-types.js
 *
 * Two things are worth a test here and nothing else is.
 *
 * The SPECK RULE, because it is the one piece of judgement in the gesture and
 * because its threshold is borrowed from a module this repo may not edit
 * (`display-run-merge.ts`, byte-identical with foundry's copy). The test asserts
 * the borrowed constant is what decides, so a local re-definition of the floor
 * would fail here rather than quietly teach the model that a 3pt smudge is a
 * book title.
 *
 * The ROUND-TRIP, because `pageTypes` is a new top-level field in a file the
 * corpus tooling also reads. What has to hold is that saving writes it, loading
 * returns it, a save that says nothing about marks preserves the ones on disk,
 * an empty map removes the field rather than leaving `{}` behind, and none of it
 * disturbs the fingerprint guard or the orphan check.
 *
 * `trainingRootDir` is stubbed to a temp directory: nothing here may write to
 * the real corpus.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'shared', 'ocr', 'page-types.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-page-types-'));
const TRAINING_DATA = path.join(DIST, 'electron', 'training-data.js');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
  })();
  const loaded = origLoad.apply(this, arguments);
  if (resolved === TRAINING_DATA) {
    return { ...loaded, trainingRootDir: () => ROOT };
  }
  return loaded;
};

const {
  DISPLAY_RUN_RULE,
} = require(path.join(DIST, 'shared', 'ocr', 'display-run-merge.js'));
const {
  isSpeckFontSize, planPageTypeLabels, bookModalFontSize, isCorpusPageType,
  PageTypeInputError,
} = require(path.join(DIST, 'shared', 'ocr', 'page-types.js'));
const {
  loadCorpusBook, saveCorpusLabels, fingerprintCorpusFile,
} = require(path.join(DIST, 'electron', 'corpus-book.js'));

let passed = 0;
let failures = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label} — ${err.message}`);
  }
}

// ── the speck rule ──────────────────────────────────────────────────────────

const MODAL = 10;
const FLOOR = DISPLAY_RUN_RULE.KICKER_MIN_FSIZE_RATIO * MODAL;

check('the speck floor is the merge rule\'s kicker floor, not a local number', () => {
  assert.strictEqual(isSpeckFontSize(FLOOR, MODAL), false, 'exactly at the floor is type');
  assert.strictEqual(isSpeckFontSize(FLOOR - 0.01, MODAL), true, 'just under the floor is a speck');
});

check('an image placeholder (no type size) is a speck', () => {
  assert.strictEqual(isSpeckFontSize(0, MODAL), true);
});

check('a missing or unusable type size reads as a speck, never as a title', () => {
  assert.strictEqual(isSpeckFontSize(NaN, MODAL), true);
  assert.strictEqual(isSpeckFontSize(undefined, MODAL), true);
});

check('a title page labels its type `title` and its specks `discard`', () => {
  const blocks = [
    { id: 'kicker', font_size: 7 },     // 0.7x modal: a caps kicker, real type
    { id: 'title', font_size: 28 },
    { id: 'subtitle', font_size: 14 },
    { id: 'fleuron', font_size: 3 },    // 0.3x modal: OCR read a dingbat as 'Ap'
    { id: 'plus', font_size: 0 },       // an image block
  ];
  const plan = planPageTypeLabels('title', blocks, MODAL);
  assert.deepStrictEqual(plan, [
    { blockId: 'kicker', categoryId: 'title' },
    { blockId: 'title', categoryId: 'title' },
    { blockId: 'subtitle', categoryId: 'title' },
    { blockId: 'fleuron', categoryId: 'discard' },
    { blockId: 'plus', categoryId: 'discard' },
  ]);
});

check('a copyright page discards everything, specks included', () => {
  const blocks = [{ id: 'a', font_size: 9 }, { id: 'b', font_size: 2 }];
  assert.deepStrictEqual(planPageTypeLabels('copyright', blocks, MODAL), [
    { blockId: 'a', categoryId: 'discard' },
    { blockId: 'b', categoryId: 'discard' },
  ]);
});

check('every block on the page gets an entry, already-labelled ones included', () => {
  const blocks = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, font_size: 12 }));
  assert.strictEqual(planPageTypeLabels('title', blocks, MODAL).length, 6);
});

check('an undefined body type size is refused by name, not guessed around', () => {
  assert.throws(() => planPageTypeLabels('title', [{ id: 'a', font_size: 10 }], 0),
    (err) => err instanceof PageTypeInputError);
});

check('the modal body size comes from the merge rule (mode over multi-line blocks)', () => {
  const pageDimensions = [{ width: 612, height: 792 }];
  const blocks = [
    // Three multi-line blocks at 10pt and a big display block: the display block
    // must not set the baseline, which is the whole point of the multi-line pool.
    { id: 'a', page: 0, x: 72, y: 100, width: 400, height: 60, text: 'aaa', font_size: 10, font_name: 'x', char_count: 3, region: 'body', category_id: 'body', line_count: 4 },
    { id: 'b', page: 0, x: 72, y: 200, width: 400, height: 60, text: 'bbb', font_size: 10, font_name: 'x', char_count: 3, region: 'body', category_id: 'body', line_count: 5 },
    { id: 'c', page: 0, x: 72, y: 300, width: 400, height: 60, text: 'ccc', font_size: 10, font_name: 'x', char_count: 3, region: 'body', category_id: 'body', line_count: 6 },
    { id: 'd', page: 0, x: 72, y: 40, width: 400, height: 40, text: 'TITLE', font_size: 40, font_name: 'x', char_count: 5, region: 'body', category_id: 'title', line_count: 1 },
  ];
  assert.strictEqual(bookModalFontSize(blocks, pageDimensions), 10);
});

check('a block on a page with no recorded size is refused by name', () => {
  const blocks = [{ id: 'a', page: 3, x: 0, y: 0, width: 10, height: 10, text: 'a', font_size: 10, font_name: 'x', char_count: 1, region: 'body', category_id: 'body', line_count: 1 }];
  assert.throws(() => bookModalFontSize(blocks, [{ width: 612, height: 792 }]),
    (err) => err instanceof PageTypeInputError && /page 4/.test(err.message));
});

check('only the two marks are page types', () => {
  assert.strictEqual(isCorpusPageType('title'), true);
  assert.strictEqual(isCorpusPageType('copyright'), true);
  assert.strictEqual(isCorpusPageType('body'), false);
  assert.strictEqual(isCorpusPageType(undefined), false);
});

// ── the labels.json round-trip ──────────────────────────────────────────────

const BOOK = path.join(ROOT, 'page_types_test_book');

function freshBook() {
  fs.rmSync(BOOK, { recursive: true, force: true });
  fs.mkdirSync(BOOK, { recursive: true });
  fs.writeFileSync(path.join(BOOK, 'book.pdf'), '%PDF-1.4\n');
  fs.writeFileSync(path.join(BOOK, 'blocks.json'), JSON.stringify({
    pdf: path.join(BOOK, 'book.pdf'),
    engine: 'tesseract',
    pageDimensions: [
      { width: 612, height: 792 },
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ],
    blocks: [
      { id: 'b0', page: 0, x: 72, y: 100, w: 400, h: 40, text: 'A TITLE', fsize: 28, lineCount: 1 },
      { id: 'b1', page: 0, x: 72, y: 300, w: 20, h: 8, text: 'Ap', fsize: 3, lineCount: 1 },
      { id: 'b2', page: 1, x: 72, y: 100, w: 400, h: 200, text: 'copyright', fsize: 9, lineCount: 8 },
      { id: 'b3', page: 2, x: 72, y: 100, w: 400, h: 200, text: 'body text', fsize: 10, lineCount: 9 },
    ],
  }, null, 2));
}

function readLabelsFile() {
  return JSON.parse(fs.readFileSync(path.join(BOOK, 'labels.json'), 'utf-8'));
}

const LABEL_SET = ['body', 'title', 'discard'];

async function roundTrip() {
  freshBook();

  // 1. a first save carrying marks writes them
  await saveCorpusLabels(BOOK, {
    labels: { b0: 'title', b1: 'discard', b2: 'discard' },
    labelSet: LABEL_SET,
    pageTypes: { 0: 'title', 1: 'copyright' },
  });
  check('the first save writes pageTypes into labels.json', () => {
    assert.deepStrictEqual(readLabelsFile().pageTypes, { 0: 'title', 1: 'copyright' });
  });

  let book = await loadCorpusBook(BOOK);
  check('loading a book reads its marks back', () => {
    assert.deepStrictEqual(book.session.pageTypes, { 0: 'title', 1: 'copyright' });
  });
  check('the marks do not disturb the labels', () => {
    assert.deepStrictEqual(book.session.labels, { b0: 'title', b1: 'discard', b2: 'discard' });
  });

  // 2. a save that says nothing about marks leaves the file's own alone
  await saveCorpusLabels(BOOK, {
    labels: { b0: 'title', b1: 'discard', b2: 'discard', b3: 'body' },
    labelSet: LABEL_SET,
  }, book.fingerprint);
  check('a save with no pageTypes preserves the ones on disk', () => {
    assert.deepStrictEqual(readLabelsFile().pageTypes, { 0: 'title', 1: 'copyright' });
  });

  // 3. an empty map removes the field rather than leaving {} behind
  book = await loadCorpusBook(BOOK);
  await saveCorpusLabels(BOOK, {
    labels: { b0: 'title', b1: 'discard', b2: 'discard', b3: 'body' },
    labelSet: LABEL_SET,
    pageTypes: {},
  }, book.fingerprint);
  check('an empty map clears the field outright', () => {
    assert.strictEqual('pageTypes' in readLabelsFile(), false);
  });
  book = await loadCorpusBook(BOOK);
  check('a book with no marks loads with none, not with a broken field', () => {
    assert.strictEqual(book.session.pageTypes, undefined);
    assert.strictEqual(book.session.blocks.length, 4);
  });

  // 4. the fingerprint guard is untouched by any of it
  const stale = { ...book.fingerprint, size: book.fingerprint.size + 1 };
  let refused = null;
  try {
    await saveCorpusLabels(BOOK, {
      labels: { b0: 'title' }, labelSet: LABEL_SET, pageTypes: { 0: 'title' },
    }, stale);
  } catch (err) {
    refused = err.message;
  }
  check('a stale fingerprint still refuses the write, marks and all', () => {
    assert.ok(refused && /rewritten on disk/.test(refused), `got: ${refused}`);
    assert.strictEqual('pageTypes' in readLabelsFile(), false);
  });

  // 5. a mark naming a page the book does not have is refused by name
  const fresh = await fingerprintCorpusFile(path.join(BOOK, 'labels.json'));
  let rejected = null;
  try {
    await saveCorpusLabels(BOOK, {
      labels: { b0: 'title' }, labelSet: LABEL_SET, pageTypes: { 9: 'title' },
    }, fresh);
  } catch (err) {
    rejected = err.message;
  }
  check('a mark on a page the book does not have is refused', () => {
    assert.ok(rejected && /page 10/.test(rejected), `got: ${rejected}`);
  });

  // 6. a corrupt marks field is caught at LOAD, next to the orphan check
  const file = readLabelsFile();
  file.pageTypes = { 0: 'frontispiece' };
  fs.writeFileSync(path.join(BOOK, 'labels.json'), JSON.stringify(file, null, 2));
  let loadError = null;
  try {
    await loadCorpusBook(BOOK);
  } catch (err) {
    loadError = err.message;
  }
  check('an illegal page type is named at load time', () => {
    assert.ok(loadError && /frontispiece/.test(loadError), `got: ${loadError}`);
  });
}

roundTrip()
  .catch(err => { failures++; console.log(`FAIL  round-trip threw — ${err.stack}`); })
  .finally(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(`page-types: ${passed} test(s) passed${failures ? `, ${failures} FAILED` : ''}`);
    process.exit(failures ? 1 : 0);
  });
