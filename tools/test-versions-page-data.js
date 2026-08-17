#!/usr/bin/env node
/**
 * The versions-page-data keeper: what the Versions page is handed on entry.
 *
 *   node tools/test-versions-page-data.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `versions:page-data` replaced three IPCs on 2026-08-17, and one of the three
 * — `editor:get-versions` — was deleted with its 750-line handler. Everything
 * the flat page still read out of that handler is now the ~60 lines of
 * `readAnalysisEntry` in electron/versions-page-data.ts, so those lines carry a
 * behaviour nothing else in the repo covers.
 *
 * The library cannot cover it either: no project in Owen's 386 has a
 * content-analysis report on disk, so a test against the real library would pass
 * by never reaching the code. Hence fixtures — a synthetic library in a temp
 * directory, with the four shapes a report comes in.
 *
 * ── What is actually at stake ───────────────────────────────────────────────
 *
 * The analysis row says WHICH version of the book was analysed, and the page
 * hangs "Regenerate" off that answer. Getting it wrong re-runs an analysis
 * against a different file than the one the report is about. So the four cases
 * are the four ways the answer is reached:
 *
 *   modern     the report names its own target -> use it verbatim, never re-point
 *   legacy     no target -> reconcile by EXACT path against the variants
 *   orphaned   no target and no match -> say so; substitute NOTHING (no fallback)
 *   checkpoint an analysis still running -> partial, and its own flag count
 *
 * The fifth case is a project with neither: no row, and — the part that matters
 * for the audio rows — `audiobookFactsComplete: true`, because a book with no
 * audiobooks has nothing to derive and must not sit forever with its Generate
 * sentences button disabled waiting for a push that is never coming.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'versions-page-data.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-vpd-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));

const manifestService = require(path.join(REPO, 'dist', 'electron', 'manifest-service.js'));
const derivationCache = require(path.join(REPO, 'dist', 'electron', 'derivation-cache.js'));
const pageData = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-versions-page-data-'));
const LIB = path.join(TMP, 'library');
manifestService.setLibraryBasePath(LIB);
// Its own store, in temp: this test must not read or write the real user's cache.
derivationCache.setDerivationCachePath(path.join(TMP, 'derivation-cache.json'));

/**
 * A one-variant project with a content-analysis report of the given shape.
 * `checkpoint` writes it as `analysis-progress.json` (an analysis still running)
 * rather than `analysis.json`.
 */
function project(id, report, checkpoint = false) {
  const dir = path.join(LIB, 'projects', id);
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stages', '04-analysis'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive', 'book.epub'), 'not-a-real-epub', 'utf-8');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    projectId: id,
    metadata: { title: 'A Book' },
    variants: [{
      id: 'v-book',
      kind: 'ebook',
      format: 'epub',
      path: 'archive/book.epub',
      metadata: { title: 'A Book' },
      addedAt: new Date().toISOString(),
    }],
    primaryVariantId: 'v-book',
  }, null, 2), 'utf-8');
  if (report !== null) {
    fs.writeFileSync(
      path.join(dir, 'stages', '04-analysis', checkpoint ? 'analysis-progress.json' : 'analysis.json'),
      JSON.stringify(report, null, 2), 'utf-8');
  }
  return dir;
}

test('a modern report keeps the target it recorded, and is never re-pointed', async () => {
  project('modern', {
    // Deliberately naming a file that does NOT exist: a report that has said
    // which version it is about is not up for reinterpretation, so this path
    // must not be consulted at all.
    epubPath: 'Z:/somewhere/else/book.epub',
    statistics: { totalFlags: 12 },
    target: { versionId: 'v-book', versionType: 'ebook', versionLabel: 'A Book' },
  });
  const data = await pageData.readVersionsPageData('modern');
  assert.ok(data.analysis, 'a project with a report got no analysis row');
  assert.strictEqual(data.analysis.flagCount, 12);
  assert.strictEqual(data.analysis.isCheckpoint, false);
  assert.strictEqual(data.analysis.target.versionId, 'v-book',
    'the recorded target was overridden by a path match');
  assert.ok(data.analysis.path.endsWith('book.epub'),
    `the row addresses ${data.analysis.path}, not the target variant's file`);
  assert.ok(data.analysis.modifiedAt, 'the row carries no modifiedAt, so it cannot be dated');
});

test('a legacy report is reconciled to the variant at its recorded path', async () => {
  const dir = project('legacy', null);
  fs.writeFileSync(path.join(dir, 'stages', '04-analysis', 'analysis.json'), JSON.stringify({
    statistics: { totalFlags: 3 },
    epubPath: path.join(dir, 'archive', 'book.epub'),
  }), 'utf-8');
  const data = await pageData.readVersionsPageData('legacy');
  assert.strictEqual(data.analysis.target.versionId, 'v-book',
    'a report with no target was not matched to the variant its own path names');
  assert.strictEqual(data.analysis.flagCount, 3);
});

test('an orphaned report stays orphaned — nothing is substituted', async () => {
  project('orphan', { statistics: { totalFlags: 5 }, epubPath: 'Z:/gone/book.epub' });
  const data = await pageData.readVersionsPageData('orphan');
  assert.strictEqual(data.analysis.target.versionId, null,
    'a report whose file is gone was silently re-pointed at another version');
  assert.strictEqual(data.analysis.path, '',
    'a report with no locatable file was handed a path anyway');
});

test('a checkpoint is marked partial and counts its own flags', async () => {
  project('partial', {
    flags: [{}, {}],
    completedChapters: [1],
    totalChapters: 9,
    sourceEpubPath: 'Z:/gone/book.epub',
  }, true);
  const data = await pageData.readVersionsPageData('partial');
  assert.strictEqual(data.analysis.isCheckpoint, true,
    'an analysis still running was drawn as a finished one');
  assert.strictEqual(data.analysis.flagCount, 2,
    'a checkpoint counts the flags it has so far, from the array — it has no statistics block');
});

test('a finished report wins over a checkpoint left beside it', async () => {
  const dir = project('both', { statistics: { totalFlags: 9 }, epubPath: 'Z:/gone/book.epub' });
  fs.writeFileSync(path.join(dir, 'stages', '04-analysis', 'analysis-progress.json'),
    JSON.stringify({ flags: [{}], totalChapters: 4 }), 'utf-8');
  const data = await pageData.readVersionsPageData('both');
  assert.strictEqual(data.analysis.isCheckpoint, false,
    'the leftover checkpoint of a finished analysis was drawn instead of the report');
  assert.strictEqual(data.analysis.flagCount, 9);
});

test('a report that will not parse draws no row rather than a wrong one', async () => {
  const dir = project('broken', null);
  fs.writeFileSync(path.join(dir, 'stages', '04-analysis', 'analysis.json'), '{ not json', 'utf-8');
  const data = await pageData.readVersionsPageData('broken');
  assert.strictEqual(data.analysis, null,
    'an unreadable report produced a row, which would be a row made of guesses');
  // The rest of the page is unaffected — one bad file must not cost the versions.
  assert.strictEqual(data.variants.length, 1, 'a bad report took the variant rows with it');
});

test('a book with no report and no audio is COMPLETE on entry', async () => {
  project('none', null);
  const data = await pageData.readVersionsPageData('none');
  assert.strictEqual(data.analysis, null, 'a project with no report got an analysis row');
  assert.strictEqual(data.audiobooks.length, 0);
  assert.strictEqual(data.audiobookFactsComplete, true,
    'a book with no audiobooks reported an incomplete derivation — its Generate sentences '
    + 'button would stay disabled forever waiting for a push that is never sent');
  assert.strictEqual(data.variants.length, 1);
  assert.strictEqual(data.variants[0].exists, true,
    'the variant path was not resolved against its own project directory');
  assert.strictEqual(data.primaryVariantId, 'v-book');
});

test('a missing project is a refusal, not an empty page', async () => {
  await assert.rejects(
    () => pageData.readVersionsPageData('no-such-project'),
    'a project that is not there answered with a page instead of saying so');
});

(async () => {
  try {
    for (const { name, fn } of tests) {
      try { await fn(); passed++; }
      catch (err) { failures.push({ name, err }); }
    }
  } finally {
    derivationCache.setDerivationCachePath(null);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\nversions page data: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
