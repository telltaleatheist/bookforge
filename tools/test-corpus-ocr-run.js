/**
 * Exercise electron/corpus-ocr-run.ts without Tesseract.
 *
 *   npx tsc -p tsconfig.electron.json
 *   node tools/test-corpus-ocr-run.js
 *
 * headless-ocr is stubbed, so "recognizing" a page is instant and deterministic
 * and no PDF is rendered. What is checked is the machinery a real run depends on
 * and that watching a live run cannot show you: that a resumed run does not
 * re-recognize pages already in the journal, that a hole in the middle is filled
 * and only the hole, that a run killed part-way leaves every completed page on
 * disk, and that blocks.json is always derived from the WHOLE journal rather
 * than the batch in flight.
 *
 * That last one is the expensive bug this component exists to prevent. The
 * classifier runs a global pass — body font size is the mode across all pages —
 * so blocks built from a four-page batch differ from the same four pages built
 * in the context of the book. It is invisible in the output and permanent in
 * the corpus.
 */
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIST = path.join(__dirname, '..', 'dist', 'electron');
const HEADLESS = path.join(DIST, 'headless-ocr.js');
const RUN = path.join(DIST, 'corpus-ocr-run.js');

const CORPUS_ROOT = path.join(os.homedir(), 'Documents', 'BookForge', 'training');
const BOOK = path.join(CORPUS_ROOT, '__ocr_run_test_tmp');
const BOOK_PAGES = 20;

// Every page the stub was asked to recognize, so "did it redo work?" is checkable.
let recognized = [];
let stopAfter = null;   // stop the stub run once this many pages are done

const stubService = {
  getPageCount: async () => BOOK_PAGES,
  getPageSizes: async (_pdf, pages) => {
    const m = new Map();
    for (const p of pages) m.set(p, { width: 612, height: 792 });
    return m;
  },
  processPdf: async (_pdfPath, options) => {
    for (const page of options.pages) {
      if (options.shouldStop && options.shouldStop()) break;
      if (stopAfter !== null && recognized.length >= stopAfter) break;
      recognized.push(page);
      // One line per page, at a size that makes the global body-font pass
      // meaningful: most pages are 10pt body, page 0 is 40pt display type.
      const size = page === 0 ? 40 : 10;
      const result = {
        page,
        text: `page ${page} text`,
        confidence: 0.95,
        textLines: [{
          text: `page ${page} text`,
          bbox: [100, 200, 400, 200 + size * 2.78],
          confidence: 0.95,
          blockNum: 1,
          parNum: 1,
          xSize: size * 2.78,
        }],
        pageWidth: 612,
        pageHeight: 792,
      };
      if (options.onPage) await options.onPage(result);
      if (options.onProgress) options.onProgress(recognized.length, options.pages.length);
    }
    return [];
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
  })();
  if (resolved === HEADLESS) {
    return { getHeadlessOcrService: () => stubService, HeadlessOcrService: function () {} };
  }
  return origLoad.apply(this, arguments);
};

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function freshBook() {
  if (fs.existsSync(BOOK)) fs.rmSync(BOOK, { recursive: true });
  fs.mkdirSync(BOOK, { recursive: true });
  const pdf = path.join(BOOK, 'source.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n');
  fs.writeFileSync(path.join(BOOK, 'book.json'), JSON.stringify({
    title: 'ocr run test', pdfPath: pdf, addedAt: new Date().toISOString(),
  }, null, 2));
  return pdf;
}

/**
 * Wait for a run to stop. `startCorpusOcrRun` returns as soon as the run is
 * registered — that is the point of it — so a test that reads the journal
 * straight after starting is reading a run that has barely begun.
 */
async function waitForRun(run) {
  for (let i = 0; i < 400; i++) {
    const state = run.attachCorpusOcrRun(BOOK);
    if (!state || state.status !== 'running') return state;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('run did not stop within 4s');
}

function journalPages() {
  const file = path.join(BOOK, 'ocr-journal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l).page);
}

function blockPages() {
  const file = path.join(BOOK, 'blocks.json');
  if (!fs.existsSync(file)) return [];
  return [...new Set(JSON.parse(fs.readFileSync(file, 'utf-8')).blocks.map(b => b.page))]
    .sort((a, b) => a - b);
}

(async () => {
  const run = require(RUN);

  // ── 1. a run that is interrupted leaves every completed page on disk ──────
  // The stub stops itself after 8 pages, standing in for a crash: no cancel, no
  // clean shutdown, nothing gets a chance to flush at the end.
  freshBook();
  recognized = [];
  stopAfter = 8;
  await run.startCorpusOcrRun({ bookDir: BOOK, engine: 'tesseract' });
  await waitForRun(run);

  check('interrupted run journalled what it finished',
    journalPages().length === 8, `${journalPages().length} pages`);
  check('interrupted run wrote blocks for those pages',
    blockPages().length === 8, `${blockPages().length} pages`);
  check('blocks cover exactly the journalled pages',
    JSON.stringify(blockPages()) === JSON.stringify(journalPages().sort((a, b) => a - b)));

  // ── 2. resuming recognizes only what is missing ───────────────────────────
  recognized = [];
  stopAfter = null;
  run.__resetCorpusOcrRunsForTest();
  await run.startCorpusOcrRun({ bookDir: BOOK, engine: 'tesseract' });
  await waitForRun(run);

  check('resume recognized only the missing pages',
    recognized.length === BOOK_PAGES - 8, `recognized ${recognized.length}, expected ${BOOK_PAGES - 8}`);
  check('resume did not re-recognize page 0',
    !recognized.includes(0));
  check('the whole book is now journalled',
    journalPages().length === BOOK_PAGES, `${journalPages().length} pages`);
  check('blocks cover the whole book',
    blockPages().length === BOOK_PAGES, `${blockPages().length} pages`);

  // ── 3. a hole in the middle is filled, and only the hole ──────────────────
  // Rewrite the journal without pages 10-14, the way a partial older run would
  // have left it.
  const kept = fs.readFileSync(path.join(BOOK, 'ocr-journal.jsonl'), 'utf-8')
    .split('\n').filter(Boolean)
    .filter(l => { const p = JSON.parse(l).page; return p < 10 || p > 14; });
  fs.writeFileSync(path.join(BOOK, 'ocr-journal.jsonl'), kept.join('\n') + '\n');

  recognized = [];
  run.__resetCorpusOcrRunsForTest();
  await run.startCorpusOcrRun({ bookDir: BOOK, engine: 'tesseract' });
  await waitForRun(run);

  check('gap in the middle was filled',
    JSON.stringify([...recognized].sort((a, b) => a - b)) === JSON.stringify([10, 11, 12, 13, 14]),
    `recognized ${JSON.stringify(recognized)}`);

  // ── 4. blocks are built from the whole journal, not the batch ─────────────
  // Page 0 is 40pt display type; every other page is 10pt body. Built in the
  // context of the book, the global body size is 10 and page 0's line is NOT
  // body. Built from a five-page batch of 10pt pages, it would have been.
  const all = JSON.parse(fs.readFileSync(path.join(BOOK, 'blocks.json'), 'utf-8'));
  const page0 = all.blocks.filter(b => b.page === 0);
  check('page 0 survived a run that only recognized pages 10-14',
    page0.length > 0, `${page0.length} blocks on page 0`);
  check('blocks.json covers the whole book after a five-page run',
    [...new Set(all.blocks.map(b => b.page))].length === BOOK_PAGES);

  // ── 5. a torn final line is dropped, not fatal ────────────────────────────
  fs.appendFileSync(path.join(BOOK, 'ocr-journal.jsonl'), '{"page":19,"text":"tor');
  const journal = await run.readOcrJournal(BOOK);
  check('torn final line dropped without losing the file',
    journal.size === BOOK_PAGES, `${journal.size} pages recovered`);

  // ── 6. starting a second run on a live book is refused ────────────────────
  recognized = [];
  run.__resetCorpusOcrRunsForTest();
  fs.writeFileSync(path.join(BOOK, 'ocr-journal.jsonl'), '');
  stopAfter = 3;
  const first = run.startCorpusOcrRun({ bookDir: BOOK, engine: 'tesseract', redo: true });
  await first;
  let refused = false;
  try {
    await run.startCorpusOcrRun({ bookDir: BOOK, engine: 'tesseract' });
  } catch (err) {
    refused = /already running/.test(err.message);
  }
  await run.cancelCorpusOcrRun(BOOK);
  check('a second concurrent run on the same book is refused', refused);

  fs.rmSync(BOOK, { recursive: true });
  console.log(failures === 0 ? '\nall checks passed.' : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  if (fs.existsSync(BOOK)) fs.rmSync(BOOK, { recursive: true });
  console.error(err);
  process.exit(1);
});
