#!/usr/bin/env node
/**
 * Tests for what happens when Foundry exports a file for a book —
 * `addFoundryOutputVariant` and `promoteVariantToArchive` in
 * electron/library-actions.ts, the tray reconcile in
 * electron/foundry-export-sweep.ts, plus the shelf's Process target and the TTS
 * mark in electron/manifest-service.ts. Against a REAL project directory on
 * disk, in a temp library.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-landing.js
 *
 * Owen's ruling, 2026-08-17: "I think exports should go to the project as a
 * version. The user can mark the file as a tts file if they want. I think the
 * user should be able to send any EPUB through tts." And, refining it: "maybe
 * the exports should be moved to output and visually be smaller indented line
 * items under their parent file... And maybe we have an option to make it an
 * archive file if we want."
 *
 * What that turns into, and what these tests pin:
 *
 *  - An export is COPIED into `output/` and minted as an ordinary variant. The
 *    file is the project's own from then on; Foundry's tray is not read again.
 *  - RE-EXPORT REPLACES IN PLACE. The identity is (projectKey, fileName), so a
 *    book exported five times has ONE version, not five — and it is the same
 *    version, with the same id, so the user's TTS mark and descriptor survive.
 *    This is the test that matters most: getting it wrong fills the versions
 *    page with a row per export and silently drops the mark each time.
 *  - "Add to archive" MOVES the file to `archive/` and CLEARS the provenance.
 *    One file before, one after; the version keeps its id; and it stops being
 *    drawn nested, because it is the user's own top-level file now.
 *  - The shelf's Process target follows a stated precedence — marked, then the
 *    newest export, then a sole EPUB — and is ABSENT when the book has several
 *    EPUBs and no answer. Absent is the point: guessing would narrate whichever
 *    version sorted first.
 *  - THE SWEEP RECONCILES AND NOTHING MORE. Owen, later the same day: "if theres
 *    an exported doc in the foundry window, it should show in the versions
 *    window too" — so an export nobody announced becomes a version, dated by the
 *    file's own mtime rather than by the morning it was swept. And, the half
 *    that is easier to get wrong: a file that IS already a version is skipped
 *    outright, never handed to the re-export branch, because that branch
 *    overwrites bytes and re-stamps `landedAt` — a sweep must be invisible to a
 *    library that is already correct.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
const ACTIONS = path.join(REPO, 'dist', 'electron', 'library-actions.js');
const SWEEP = path.join(REPO, 'dist', 'electron', 'foundry-export-sweep.js');
if (!fs.existsSync(MANIFEST) || !fs.existsSync(ACTIONS) || !fs.existsSync(SWEEP)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
// library-actions pulls in metadata-tools -> the component catalog, which
// `require('electron')` at load time. The CLI already solved this: its stub
// intercepts that require and throws loudly on any surface it has not
// deliberately stubbed. Loaded FIRST, before anything reaches for it — the same
// arrangement cli/library.js runs these very functions under.
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-landing-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const manifestService = require(MANIFEST);
const actions = require(ACTIONS);
// The sweep is a sibling module rather than a function in main.ts precisely so
// it can be reached from here — the Electron entry point cannot be required.
const sweepModule = require(SWEEP);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PROJECT_ID = 'Test_Book_-_A_Author_-_1999';
const KEY = 'test-book';

/**
 * A project holding whatever variants the test needs, plus Foundry's tray.
 *
 * `extra` is merged into the manifest — the sweep tests use it to say which
 * version was imported into the Foundry project (`foundryProject.sourceVariantId`),
 * and one of them uses it to take the mapping away entirely.
 */
function makeProject(variants = [], extra = {}) {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-foundry-landing-'));
  const projectDir = path.join(library, 'projects', PROJECT_ID);
  fs.mkdirSync(path.join(projectDir, 'archive'), { recursive: true });
  const manifest = {
    version: 2,
    projectId: PROJECT_ID,
    type: 'book',
    projectType: 'book',
    metadata: { title: 'Test Book', author: 'A Author', year: '1999' },
    variants,
    // A book Foundry has exported for HAS a mapping — that is how the export
    // reached it — so every project here carries one. The sweep visits books by
    // this field and no other, so it is also what the mapping-less test removes.
    foundryProject: { dir: KEY },
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  manifestService.setLibraryBasePath(library);

  const tray = path.join(library, 'foundry', 'projects', KEY, 'final');
  fs.mkdirSync(tray, { recursive: true });

  return {
    library, projectDir, tray,
    /** Write what Foundry "exported", and hand back its absolute path. */
    exportFile: (name, bytes) => {
      const abs = path.join(tray, name);
      fs.writeFileSync(abs, bytes);
      return abs;
    },
    read: () => JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf-8')),
    variants: () => manifestService.getVariants(
      JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf-8'))).variants,
    abs: (rel) => path.join(projectDir, ...rel.split('/')),
    cleanup: () => fs.rmSync(library, { recursive: true, force: true }),
  };
}

const run = (fn, variants, extra) => async () => {
  const p = makeProject(variants, extra);
  try { await fn(p); } finally { p.cleanup(); }
};

/** A plain ebook variant the user already had — the thing an export nests under. */
function ebookVariant(id, name) {
  return {
    id, kind: 'ebook', format: 'epub', path: `archive/${name}`,
    metadata: { title: 'Test Book' }, addedAt: '2026-01-01T00:00:00.000Z',
  };
}

const land = (p, srcAbs, over = {}) => actions.addFoundryOutputVariant(
  PROJECT_ID, srcAbs,
  {
    projectKey: KEY,
    fileName: path.basename(srcAbs),
    parentVariantId: null,
    // The live path's answer. There is no default inside the function — the
    // sweep's answer is the file's mtime, and a hidden now() would have let a
    // sweep re-date the library to the morning it ran.
    landedAt: new Date().toISOString(),
    ...over,
  },
  over.title || 'Test Book (cleaned)');

/**
 * Run the reconcile over this temp library, collecting the per-project change
 * notices main.ts turns into `foundry-host:versions-changed` broadcasts.
 */
const sweep = async (p) => {
  const changed = [];
  const result = await sweepModule.sweepFoundryExportTrays(
    path.join(p.library, 'foundry', 'projects'),
    'in a test',
    (bookDir) => changed.push(bookDir));
  return { ...result, changed };
};

// ── Landing ────────────────────────────────────────────────────────────────

test('an export is copied into output/ and becomes a version', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'CLEANED BYTES');
  const res = await land(p, src);
  assert.ok(res.success, res.error);
  assert.strictEqual(res.replaced, false, 'a first landing adds a version');

  const v = p.variants().find((x) => x.id === res.variantId);
  assert.ok(v, 'the variant is in the manifest');
  assert.ok(v.path.startsWith('output/'), `lands in output/, not ${v.path}`);
  assert.strictEqual(fs.readFileSync(p.abs(v.path), 'utf-8'), 'CLEANED BYTES');
  assert.strictEqual(v.format, 'epub');
  assert.strictEqual(v.kind, 'ebook');
  assert.ok(fs.existsSync(src), "Foundry's tray is not ours to empty");
}));

test('the landing records where it came from', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'X');
  const res = await land(p, src, { parentVariantId: 'parent-1' });
  const v = p.variants().find((x) => x.id === res.variantId);
  assert.strictEqual(v.foundrySource.projectKey, KEY);
  assert.strictEqual(v.foundrySource.fileName, 'Test Book.epub');
  assert.strictEqual(v.foundrySource.parentVariantId, 'parent-1');
  assert.ok(!isNaN(+new Date(v.foundrySource.landedAt)), 'landedAt is a real timestamp');
}));

// ── The mint's declaration (ExportLanding.metadata, foundry@6646153) ────────

/** A mint block the way Wave 47's modal announces one. */
const MINT = {
  title: 'Protestant Church Leadership and Hitler',
  subtitle: 'The Chancellor Reception',
  contributors: [{ first: 'Martin', last: 'Niemoller' }, { first: 'Jane', last: 'Doe' }],
  year: '2022',
  language: 'en',
  filename: 'Protestant Church Leadership and Hitler - The Chancellor Reception. Niemoller, Martin and Doe, Jane. (2022).epub',
};

test("a landing that declares itself is the mint's book, under the mint's own name", run(async (p) => {
  const src = p.exportFile('evangelische kirche (en).epub', 'ENGLISH BYTES');
  const res = await actions.addFoundryOutputVariant(
    PROJECT_ID, src,
    { projectKey: KEY, fileName: path.basename(src), parentVariantId: null,
      landedAt: new Date().toISOString(), stepId: 'step-en' },
    'evangelische kirche (en).epub', MINT);
  assert.ok(res.success, res.error);

  const v = p.variants().find((x) => x.id === res.variantId);
  assert.strictEqual(path.basename(v.path), MINT.filename,
    "filed under the minted name, not renamed to the project's — the mint already said whose it is");
  assert.strictEqual(v.metadata.title, MINT.title);
  assert.strictEqual(v.metadata.subtitle, MINT.subtitle);
  assert.strictEqual(v.metadata.author, 'Martin Niemoller, Jane Doe',
    'the combined string is the metadata editor\'s display rule, never the file-as inversion');
  assert.deepStrictEqual(v.metadata.contributors, MINT.contributors);
  assert.strictEqual(v.metadata.year, '2022');
  assert.strictEqual(v.metadata.language, 'en',
    'the language is the MINT\'s declaration — the field the German-for-English incident was about');
  assert.strictEqual(v.foundrySource.stepId, 'step-en');
}));

test('a re-export with a declaration refreshes the declared facts and keeps the rest', run(async (p) => {
  const src = p.exportFile('evangelische kirche (en).epub', 'FIRST');
  const first = await actions.addFoundryOutputVariant(
    PROJECT_ID, src,
    { projectKey: KEY, fileName: path.basename(src), parentVariantId: null,
      landedAt: new Date().toISOString() },
    'evangelische kirche (en).epub', MINT);
  assert.ok(first.success, first.error);

  // The user re-exports with a corrected mint: the subtitle dropped, the
  // language corrected. The row survives; the declaration follows the bytes.
  fs.writeFileSync(src, 'SECOND');
  const second = await actions.addFoundryOutputVariant(
    PROJECT_ID, src,
    { projectKey: KEY, fileName: path.basename(src), parentVariantId: null,
      landedAt: new Date().toISOString() },
    'evangelische kirche (en).epub',
    { ...MINT, subtitle: undefined, language: 'de' });
  assert.ok(second.success, second.error);
  assert.strictEqual(second.variantId, first.variantId, 'same row — re-export replaces in place');
  assert.strictEqual(second.replaced, true);

  const v = p.variants().find((x) => x.id === first.variantId);
  assert.strictEqual(v.metadata.subtitle, undefined,
    'a mint that dropped the subtitle CLEARS it — the block is a complete declaration');
  assert.strictEqual(v.metadata.language, 'de');
  assert.strictEqual(v.metadata.title, MINT.title);
  assert.strictEqual(v.descriptor, 'evangelische kirche (en).epub',
    'the descriptor stays the user\'s, exactly as any re-export leaves it');
}));

test('a landing without the block inherits the project, exactly as before', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'UNDECLARED');
  const res = await land(p, src);
  const v = p.variants().find((x) => x.id === res.variantId);
  assert.strictEqual(v.metadata.title, 'Test Book');
  assert.strictEqual(v.metadata.author, 'A Author');
  assert.strictEqual(v.metadata.subtitle, undefined);
  assert.strictEqual(v.metadata.contributors, undefined);
  assert.ok(path.basename(v.path).startsWith('Test Book.'),
    'and it keeps the project-named rename it always had');
}));

test('an export never becomes the book identity, and never marks itself', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'X');
  await land(p, src);
  const m = p.read();
  assert.strictEqual(m.primaryVariantId, undefined, 'an export is not the book');
  assert.strictEqual(m.ttsVariantId, undefined,
    'the TTS mark is the USER\'s — an export that marked itself would redirect the shelf');
}));

test('a landing whose bytes match an existing version is NOT refused', run(async (p) => {
  // Exporting an unedited book produces exactly this, and refusing it (as
  // addVariant's hash guard would) means the export the user just made never
  // appears anywhere.
  fs.writeFileSync(p.abs('archive/orig.epub'), 'SAME BYTES');
  const src = p.exportFile('Test Book.epub', 'SAME BYTES');
  const res = await land(p, src);
  assert.ok(res.success, res.error);
}, [ebookVariant('parent-1', 'orig.epub')]));

// ── Re-export ──────────────────────────────────────────────────────────────

test('re-exporting the same file replaces it in place — one version, same id', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'FIRST');
  const first = await land(p, src);
  const firstPath = p.variants().find((x) => x.id === first.variantId).path;

  fs.writeFileSync(src, 'SECOND');
  const again = await land(p, src);

  assert.strictEqual(again.success, true, again.error);
  assert.strictEqual(again.replaced, true, 'the second landing REPLACES');
  assert.strictEqual(again.variantId, first.variantId, 'same version id');
  const exports = p.variants().filter((v) => !!v.foundrySource);
  assert.strictEqual(exports.length, 1, `one row per exported file, got ${exports.length}`);
  assert.strictEqual(exports[0].path, firstPath, 'the file is overwritten at the same path');
  assert.strictEqual(fs.readFileSync(p.abs(firstPath), 'utf-8'), 'SECOND');
}));

test('a re-export keeps the TTS mark and the descriptor the user typed', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'FIRST');
  const first = await land(p, src);
  await actions.setTtsVariant(PROJECT_ID, first.variantId);

  fs.writeFileSync(src, 'SECOND');
  await land(p, src);

  assert.strictEqual(p.read().ttsVariantId, first.variantId,
    'the mark survives — this is why the id is kept');
  const v = p.variants().find((x) => x.id === first.variantId);
  assert.strictEqual(v.descriptor, 'Test Book (cleaned)');
}));

test('a DIFFERENT file from the same project is its own version', run(async (p) => {
  const a = await land(p, p.exportFile('Book.epub', 'A'));
  const b = await land(p, p.exportFile('Book notes.txt', 'B'));
  assert.notStrictEqual(a.variantId, b.variantId);
  assert.strictEqual(p.variants().filter((v) => !!v.foundrySource).length, 2);
}));

test('the same file name from ANOTHER foundry project is its own version', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'A');
  const a = await land(p, src);
  const b = await land(p, src, { projectKey: 'some-other-project' });
  assert.notStrictEqual(a.variantId, b.variantId,
    'the key is half the identity: two projects can both export "Test Book.epub"');
}));

// ── The tray sweep ─────────────────────────────────────────────────────────
//
// The backstop for exports no live announcement ever caught: everything made
// before this pipeline existed, and anything whose `onExport` was missed. The
// tray is the truth; these pin that the manifest is brought up to it and that
// nothing else about the library moves.

test('an export nobody announced becomes a version', run(async (p) => {
  p.exportFile('Test Book.epub', 'NEVER ANNOUNCED');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 1, 'the file in the tray is a version now');
  assert.strictEqual(res.refused, 0);
  assert.deepStrictEqual(res.changed, [p.projectDir],
    'the versions page is told once, for this project');

  const v = p.variants().find((x) => !!x.foundrySource);
  assert.ok(v, 'a variant carrying the provenance exists');
  assert.ok(v.path.startsWith('output/'), `lands in output/, not ${v.path}`);
  assert.strictEqual(fs.readFileSync(p.abs(v.path), 'utf-8'), 'NEVER ANNOUNCED');
  assert.strictEqual(v.foundrySource.projectKey, KEY);
  assert.strictEqual(v.foundrySource.fileName, 'Test Book.epub');
  assert.strictEqual(v.descriptor, 'Test Book.epub',
    "the row is named the file's own name — the same thing Foundry's landing would have called it");
  assert.ok(fs.existsSync(path.join(p.tray, 'Test Book.epub')),
    "Foundry's tray is not ours to empty");
}));

test('a swept export is dated by the FILE, not by the morning it was swept', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'OLD');
  const when = new Date('2026-03-04T05:06:07.000Z');
  fs.utimesSync(src, when, when);

  await sweep(p);

  const v = p.variants().find((x) => !!x.foundrySource);
  assert.strictEqual(v.foundrySource.landedAt, when.toISOString(),
    'now() here would re-date the whole library and reorder every "newest export"');
  assert.strictEqual(v.addedAt, when.toISOString(),
    'the row appeared when the file did, by the same reasoning');
}));

test("a swept export carries the step Foundry's catalogue records for it", run(async (p) => {
  // The 2026-08-24 lesson: a swept export that cannot name its step can never
  // match a step-shaped Narrate press, so the press falls to the auto-export
  // arm — which, handed a step from the wrong side of a translation, cast and
  // narrated the German of a book whose English was sitting in the tray. The
  // catalogue (Foundry's project.json `final[]`) knows the step, so the sweep
  // reads it. The spelling differs in case on purpose: the match must be the
  // same case-insensitive one every other landing comparison uses.
  fs.writeFileSync(path.join(p.library, 'foundry', 'projects', KEY, 'project.json'),
    JSON.stringify({
      final: [
        { file: 'other.epub', kind: 'epub', madeAt: 1, stepId: 'step-of-other' },
        { file: 'TEST BOOK.EPUB', kind: 'epub', madeAt: 2, stepId: 'step-abc' },
      ],
    }));
  p.exportFile('Test Book.epub', 'CAST FROM step-abc');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 1);
  const v = p.variants().find((x) => !!x.foundrySource);
  assert.strictEqual(v.foundrySource.stepId, 'step-abc',
    'the step press that made this file must find it filed');
}));

test('a tray file the catalogue does not know lands, without a step', run(async (p) => {
  // Absence means "I do not know", never "no step" — and it must not cost the
  // version: the directory witnesses the file; only its provenance is unknown.
  fs.writeFileSync(path.join(p.library, 'foundry', 'projects', KEY, 'project.json'),
    JSON.stringify({ final: [{ file: 'other.epub', kind: 'epub', madeAt: 1, stepId: 's1' }] }));
  p.exportFile('Test Book.epub', 'UNCATALOGUED');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 1, 'an uncatalogued file still becomes a version');
  const v = p.variants().find((x) => !!x.foundrySource);
  assert.strictEqual(v.foundrySource.stepId, undefined);
}));

test('a broken catalogue costs the step, never the landing', run(async (p) => {
  fs.writeFileSync(
    path.join(p.library, 'foundry', 'projects', KEY, 'project.json'), 'NOT JSON {');
  p.exportFile('Test Book.epub', 'BYTES');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 1, 'the tray is the truth even when the catalogue is not');
  assert.strictEqual(res.refused, 0);
  const v = p.variants().find((x) => !!x.foundrySource);
  assert.strictEqual(v.foundrySource.stepId, undefined);
}));

test('a file that is already a version is skipped — a sweep NEVER replaces', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'FIRST');
  const landed = await land(p, src);
  const v0 = p.variants().find((x) => x.id === landed.variantId);

  // The tray file changes underneath — which is exactly what a re-export looks
  // like, and exactly what a sweep must NOT act on. Only the user's own export
  // gets to overwrite a version's bytes.
  fs.writeFileSync(src, 'CHANGED IN THE TRAY');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 0, 'nothing to reconcile — this file is already listed');
  assert.deepStrictEqual(res.changed, [], 'and nothing to announce, so no redraw');

  const v1 = p.variants().find((x) => x.id === landed.variantId);
  assert.strictEqual(p.variants().filter((x) => !!x.foundrySource).length, 1,
    'no second row for the same file');
  assert.strictEqual(v1.path, v0.path);
  assert.strictEqual(fs.readFileSync(p.abs(v1.path), 'utf-8'), 'FIRST',
    'the replace-in-place branch was never reached — the version keeps its bytes');
  assert.strictEqual(v1.foundrySource.landedAt, v0.foundrySource.landedAt,
    're-stamping landedAt on a restart would reorder the shelf behind the sweep');
}));

test('the already-landed check is case-insensitive on the file name', run(async (p) => {
  // The identity the re-export branch matches on is (projectKey, fileName) with
  // the name compared case-insensitively. A sweep that compared it exactly would
  // hand this file back to that branch and silently overwrite the version.
  const src = p.exportFile('Test Book.epub', 'BYTES');
  await land(p, src, { fileName: 'TEST BOOK.EPUB' });

  const res = await sweep(p);
  assert.strictEqual(res.landed, 0, 'same file, different casing — already listed');
  assert.strictEqual(p.variants().filter((x) => !!x.foundrySource).length, 1);
}));

test('a foreign extension in the tray is ignored', run(async (p) => {
  // Foundry's tray holds what Foundry puts there. Only the kinds the versions
  // page holds are exports: epub, txt, pdf.
  p.exportFile('notes.md', 'X');
  p.exportFile('proof.png', 'X');
  p.exportFile('.gitkeep', '');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 0);
  assert.strictEqual(res.refused, 0, 'not a refusal — simply not an export');
  assert.strictEqual(p.variants().filter((x) => !!x.foundrySource).length, 0);
}));

test('every kind the versions page holds is swept, and only those', run(async (p) => {
  p.exportFile('Book.epub', 'A');
  p.exportFile('Book.txt', 'B');
  p.exportFile('Book.pdf', 'C');
  p.exportFile('Book.docx', 'D');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 3, 'epub, txt and pdf — the docx is not an export');
  assert.deepStrictEqual(
    p.variants().filter((x) => !!x.foundrySource).map((x) => x.format).sort(),
    ['epub', 'pdf', 'txt']);
}));

test('a book whose Foundry project has no tray yet is a no-op, not a failure', run(async (p) => {
  // The common case by far: a book opened in Foundry but never exported from,
  // and a library whose foundry data has not synced to this machine. Nothing to
  // reconcile is not a failure to reconcile.
  fs.rmSync(p.tray, { recursive: true, force: true });

  const res = await sweep(p);
  assert.strictEqual(res.landed, 0);
  assert.strictEqual(res.refused, 0, 'a missing final/ is a real answer');
  assert.strictEqual(res.booksVisited, 0, 'there was no tray to read');
  assert.deepStrictEqual(res.changed, []);
}));

test('a Foundry project directory that is missing entirely is the same no-op', run(async (p) => {
  fs.rmSync(path.join(p.library, 'foundry'), { recursive: true, force: true });
  const res = await sweep(p);
  assert.strictEqual(res.landed, 0);
  assert.strictEqual(res.refused, 0);
}));

test('a book with no Foundry mapping is never visited', run(async (p) => {
  // Only `foundryProject` says which tray belongs to which book. A tray under a
  // key no book claims is left entirely alone — guessing its owner is the thing
  // the import announcement exists to avoid.
  p.exportFile('Test Book.epub', 'X');
  const m = p.read();
  delete m.foundryProject;
  fs.writeFileSync(path.join(p.projectDir, 'manifest.json'), JSON.stringify(m, null, 2));

  const res = await sweep(p);
  assert.strictEqual(res.booksVisited, 0);
  assert.strictEqual(res.landed, 0);
  assert.strictEqual(p.variants().filter((x) => !!x.foundrySource).length, 0);
}));

test('a swept export nests under the version the mapping names', run(async (p) => {
  // Same derivation the live landing uses: the parent is whatever
  // `foundryProject.sourceVariantId` says at the moment the file is filed, never
  // inferred from the export's contents.
  p.exportFile('Test Book.epub', 'X');
  await sweep(p);
  const v = p.variants().find((x) => !!x.foundrySource);
  assert.strictEqual(v.foundrySource.parentVariantId, 'parent-1');
}, [ebookVariant('parent-1', 'orig.epub')], { foundryProject: { dir: KEY, sourceVariantId: 'parent-1' } }));

test('a mapping naming no source version lands the export at top level', run(async (p) => {
  p.exportFile('Test Book.epub', 'X');
  await sweep(p);
  const v = p.variants().find((x) => !!x.foundrySource);
  assert.strictEqual(v.foundrySource.parentVariantId, null,
    'no source is a real answer, and it renders at top level rather than under a guess');
}));

test('one entry that is not a file does not cost the rest of the tray', run(async (p) => {
  // A directory named like an export. It is skipped and the sweep carries on —
  // one bad entry must never abort a tray.
  fs.mkdirSync(path.join(p.tray, 'Draft.epub'));
  p.exportFile('Real.epub', 'REAL');

  const res = await sweep(p);
  assert.strictEqual(res.landed, 1, 'the real export still landed');
  const v = p.variants().find((x) => !!x.foundrySource);
  assert.strictEqual(v.foundrySource.fileName, 'Real.epub');
}));

test('sweeping twice changes nothing the second time', run(async (p) => {
  p.exportFile('Test Book.epub', 'X');
  const first = await sweep(p);
  const second = await sweep(p);
  assert.strictEqual(first.landed, 1);
  assert.strictEqual(second.landed, 0, 'a reconciled library is invisible to the next sweep');
  assert.deepStrictEqual(second.changed, [], 'and nothing is redrawn on every startup');
  assert.strictEqual(p.variants().filter((x) => !!x.foundrySource).length, 1);
}));

// ── Add to archive ─────────────────────────────────────────────────────────

test('"Add to archive" MOVES the file and clears the provenance', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'BYTES');
  const landed = await land(p, src);
  const before = p.variants().find((x) => x.id === landed.variantId).path;

  const res = await actions.promoteVariantToArchive(PROJECT_ID, landed.variantId);
  assert.ok(res.success, res.error);

  const v = p.variants().find((x) => x.id === landed.variantId);
  assert.ok(v.path.startsWith('archive/'), `promoted into archive/, not ${v.path}`);
  assert.strictEqual(v.foundrySource, undefined,
    'promotion severs the nesting on purpose — it is the user\'s own file now');
  assert.strictEqual(fs.readFileSync(p.abs(v.path), 'utf-8'), 'BYTES');
  assert.ok(!fs.existsSync(p.abs(before)), 'a MOVE leaves nothing behind in output/');
  assert.strictEqual(landed.variantId, v.id, 'the id is stable, so the TTS mark survives');
}));

test('a promoted version is not overwritten by the next export of that file', run(async (p) => {
  const src = p.exportFile('Test Book.epub', 'FIRST');
  const landed = await land(p, src);
  await actions.promoteVariantToArchive(PROJECT_ID, landed.variantId);

  fs.writeFileSync(src, 'SECOND');
  const again = await land(p, src);

  assert.strictEqual(again.replaced, false,
    'the promoted copy is the user\'s to keep; the new export is a new version');
  assert.strictEqual(fs.readFileSync(p.abs(
    p.variants().find((x) => x.id === landed.variantId).path), 'utf-8'), 'FIRST');
}));

test('promoting a version that is not an export is refused by name', run(async (p) => {
  const res = await actions.promoteVariantToArchive(PROJECT_ID, 'parent-1');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /already one of this book/);
}, [ebookVariant('parent-1', 'orig.epub')]));

// ── The TTS mark ───────────────────────────────────────────────────────────

test('marking a second version clears the first — one slot, one answer', run(async (p) => {
  await actions.setTtsVariant(PROJECT_ID, 'a');
  assert.strictEqual(p.read().ttsVariantId, 'a');
  await actions.setTtsVariant(PROJECT_ID, 'b');
  assert.strictEqual(p.read().ttsVariantId, 'b', 'the previous mark is gone by construction');
  await actions.setTtsVariant(PROJECT_ID, null);
  assert.strictEqual(p.read().ttsVariantId, undefined, 'clearing is a real act');
}, [ebookVariant('a', 'a.epub'), ebookVariant('b', 'b.epub')]));

test('marking a version that does not exist is refused', run(async (p) => {
  const res = await actions.setTtsVariant(PROJECT_ID, 'nope');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /not found/);
}, [ebookVariant('a', 'a.epub')]));

test('a mark on a version that is deleted does not move to a survivor', run(async (p) => {
  // The rule variant:delete carries: primary passes to whoever is left because
  // a project must have one; the TTS mark is a STATED CHOICE and is cleared, so
  // the shelf falls back to its own precedence rather than narrating a file the
  // user never picked under a mark they never made. This pins the manifest side
  // of it — the deletion itself lives in the variant:delete IPC handler.
  await actions.setTtsVariant(PROJECT_ID, 'a');
  const m = p.read();
  m.variants = m.variants.filter((v) => v.id !== 'a');
  if (m.ttsVariantId === 'a') delete m.ttsVariantId;
  fs.writeFileSync(path.join(p.projectDir, 'manifest.json'), JSON.stringify(m, null, 2));

  fs.writeFileSync(p.abs('archive/b.epub'), 'X');
  const t = await target(p);
  assert.strictEqual(t.rule, 'sole-epub', 'not "marked" — the mark went with the row');
  assert.strictEqual(t.variantId, 'b');
}, [ebookVariant('a', 'a.epub'), ebookVariant('b', 'b.epub')]));

// ── The shelf's Process target ─────────────────────────────────────────────

/** listProjects derives the target; this is the only door onto it. */
async function target(p) {
  const listed = await manifestService.listProjects();
  assert.ok(listed.success, listed.error);
  assert.ok(listed.ttsTargets, 'the map is always present');
  return listed.ttsTargets[PROJECT_ID];
}

test('a book with no EPUB gets no Process button', run(async (p) => {
  assert.strictEqual(await target(p), undefined);
}));

test('a sole EPUB is the target, and says which rule chose it', run(async (p) => {
  fs.writeFileSync(p.abs('archive/orig.epub'), 'X');
  const t = await target(p);
  assert.strictEqual(t.variantId, 'parent-1');
  assert.strictEqual(t.rule, 'sole-epub');
  assert.strictEqual(t.exists, true);
  assert.strictEqual(t.absPath, p.abs('archive/orig.epub'));
}, [ebookVariant('parent-1', 'orig.epub')]));

test('several EPUBs with nothing to choose between them gets NO button', run(async (p) => {
  fs.writeFileSync(p.abs('archive/a.epub'), 'X');
  fs.writeFileSync(p.abs('archive/b.epub'), 'X');
  assert.strictEqual(await target(p), undefined,
    'the shelf cannot say which — guessing would narrate whichever sorted first');
}, [ebookVariant('a', 'a.epub'), ebookVariant('b', 'b.epub')]));

test('the newest export outranks a sole EPUB — the case the button exists for', run(async (p) => {
  fs.writeFileSync(p.abs('archive/orig.epub'), 'X');
  const landed = await land(p, p.exportFile('Test Book.epub', 'CLEANED'));
  const t = await target(p);
  assert.strictEqual(t.variantId, landed.variantId);
  assert.strictEqual(t.rule, 'newest-export');
}, [ebookVariant('parent-1', 'orig.epub')]));

test('the NEWEST export wins among several', run(async (p) => {
  const older = await land(p, p.exportFile('Older.epub', 'A'));
  await new Promise((r) => setTimeout(r, 5));
  const newer = await land(p, p.exportFile('Newer.epub', 'B'));
  const t = await target(p);
  assert.strictEqual(t.variantId, newer.variantId, `expected the newer export, got ${t.variantId}`);
  assert.notStrictEqual(t.variantId, older.variantId);
}));

test('a marked version outranks everything', run(async (p) => {
  fs.writeFileSync(p.abs('archive/orig.epub'), 'X');
  await land(p, p.exportFile('Test Book.epub', 'CLEANED'));
  await actions.setTtsVariant(PROJECT_ID, 'parent-1');
  const t = await target(p);
  assert.strictEqual(t.variantId, 'parent-1', 'a stated choice beats a derived one');
  assert.strictEqual(t.rule, 'marked');
}, [ebookVariant('parent-1', 'orig.epub')]));

test('a mark naming a version that is gone falls through, it does not veto', run(async (p) => {
  fs.writeFileSync(p.abs('archive/orig.epub'), 'X');
  await actions.setTtsVariant(PROJECT_ID, 'parent-1');
  // The row is deleted out from under the pointer.
  const m = p.read();
  m.variants = [];
  m.variants.push(ebookVariant('other', 'orig.epub'));
  fs.writeFileSync(path.join(p.projectDir, 'manifest.json'), JSON.stringify(m, null, 2));
  const t = await target(p);
  assert.ok(t, 'a dangling pointer is not a book forbidden a button');
  assert.strictEqual(t.rule, 'sole-epub');
}, [ebookVariant('parent-1', 'orig.epub')]));

test('a target whose file has gone reports exists:false rather than vanishing', run(async (p) => {
  // No file written: output/ was cleared, or the archive copy was removed.
  const t = await target(p);
  assert.ok(t, 'the row still names the version');
  assert.strictEqual(t.exists, false, 'so the card can refuse by naming the missing file');
}, [ebookVariant('parent-1', 'orig.epub')]));

test('a PDF version is never a TTS target, marked or not', run(async (p) => {
  fs.writeFileSync(p.abs('archive/scan.pdf'), 'X');
  await actions.setTtsVariant(PROJECT_ID, 'pdf-1');
  assert.strictEqual(await target(p), undefined,
    'narration reads a book; a button here would fail an hour into the job');
}, [{
  id: 'pdf-1', kind: 'ebook', format: 'pdf', path: 'archive/scan.pdf',
  metadata: { title: 'Test Book' }, addedAt: '2026-01-01T00:00:00.000Z',
}]));

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; }
    catch (err) { failures.push({ name, err }); }
  }
  console.log(`\nfoundry landing: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.stack || f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
