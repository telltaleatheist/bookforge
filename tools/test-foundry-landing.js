#!/usr/bin/env node
/**
 * Tests for what happens when Foundry exports a file for a book —
 * `addFoundryOutputVariant` and `promoteVariantToArchive` in
 * electron/library-actions.ts, plus the shelf's Process target and the TTS mark
 * in electron/manifest-service.ts. Against a REAL project directory on disk, in
 * a temp library.
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
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
const ACTIONS = path.join(REPO, 'dist', 'electron', 'library-actions.js');
if (!fs.existsSync(MANIFEST) || !fs.existsSync(ACTIONS)) {
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

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PROJECT_ID = 'Test_Book_-_A_Author_-_1999';
const KEY = 'test-book';

/** A project holding whatever variants the test needs, plus Foundry's tray. */
function makeProject(variants = []) {
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
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
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

const run = (fn, variants) => async () => {
  const p = makeProject(variants);
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
  { projectKey: KEY, fileName: path.basename(srcAbs), parentVariantId: null, ...over },
  over.title || 'Test Book (cleaned)');

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
