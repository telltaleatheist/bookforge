#!/usr/bin/env node
/**
 * Tests for the Adopt door — `electron/foundry-adopt.ts`, against REAL Foundry
 * project folders and a REAL BookForge library, both in temp directories.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-adopt.js
 *
 * The problem it exists for: a Foundry project can exist in two places BookForge
 * cannot see. Standalone Foundry's own library (its root is in
 * `%APPDATA%/Foundry/app-settings.json`), and — as an orphan — inside our own
 * hosted root, mapped by no book's manifest. Owen edits a book in standalone
 * Foundry and wants it in BookForge; there was no door.
 *
 * What these pin, and why each one is worth a test:
 *
 *  - ADOPTION PRODUCES THE STATE `onImport` + THE SWEEP WOULD HAVE. A project, an
 *    archive variant, `foundryProject { dir, sourceVariantId }`, and every EPUB
 *    already in `final/` on the versions page. That is the whole contract: an
 *    adopted book must be indistinguishable from one imported through the Foundry
 *    window, because everything downstream — the Process button, the versions
 *    nesting, the Edit-in-Foundry deep link — reads only that state.
 *  - COPY, NEVER MOVE. Standalone Foundry's library is another program's data and
 *    Owen still works in it. The source must be byte-identical afterwards.
 *  - ADOPTING TWICE COSTS NOTHING. The second press must not mint a second book,
 *    must not re-copy over a hosted project the user has since worked in, and
 *    must not re-land the exports (which would re-stamp their `landedAt` and
 *    reorder the shelf). This is the one that is easiest to get wrong.
 *  - A COLLISION IS REFUSED BY NAME. A DIFFERENT project already under that key's
 *    folder name is a refusal, not an overwrite — overwriting would destroy the
 *    hosted project silently.
 *  - REFUSALS SAY WORDS. Every one of them names the folder and ends by saying
 *    nothing was adopted, because they surface at a button the user just pressed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
const ADOPT = path.join(REPO, 'dist', 'electron', 'foundry-adopt.js');
if (!fs.existsSync(MANIFEST) || !fs.existsSync(ADOPT)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
// The same arrangement `tools/test-foundry-landing.js` runs under: the module
// graph reaches the component catalog, which `require('electron')` at load time,
// and the CLI's stub intercepts that and throws loudly on any surface it has not
// deliberately stubbed. Loaded FIRST, before anything reaches for it.
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-adopt-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const manifestService = require(MANIFEST);
const adopt = require(ADOPT);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ORIGINAL_NAME = 'Adopted Book. Tester, Terry. (2024).pdf';
const ORIGINAL_BYTES = 'PRISTINE SCAN BYTES';

/**
 * A world: a BookForge library, a place standalone Foundry keeps its projects,
 * and a stand-in for Foundry's own userData folder.
 *
 * All three are temp directories and NOTHING here ever touches a real library —
 * `setLibraryBasePath` is re-pointed per test, which is the one knob the manifest
 * service has (there is no env var), and the same one the landing keeper uses.
 */
function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-adopt-'));
  const library = path.join(root, 'BookForge');
  const hosted = path.join(library, 'foundry', 'projects');
  const standaloneLibrary = path.join(root, 'Documents', 'Foundry');
  const standalone = path.join(standaloneLibrary, 'projects');
  const foundryUserData = path.join(root, 'AppData', 'Foundry');

  fs.mkdirSync(path.join(library, 'projects'), { recursive: true });
  fs.mkdirSync(hosted, { recursive: true });
  fs.mkdirSync(standalone, { recursive: true });
  manifestService.setLibraryBasePath(library);

  const changed = [];
  return {
    root, library, hosted, standalone, standaloneLibrary, foundryUserData, changed,
    onChanged: (bookDir) => changed.push(bookDir),
    /** Write standalone Foundry's settings file, as its own app-settings.ts does. */
    installStandaloneSettings: (libraryDir = standaloneLibrary) => {
      fs.mkdirSync(foundryUserData, { recursive: true });
      fs.writeFileSync(
        path.join(foundryUserData, 'app-settings.json'),
        `${JSON.stringify({ keepServerWarmMinutes: 0, libraryDir }, null, 2)}\n`);
    },
    books: () => fs.readdirSync(path.join(library, 'projects')),
    manifestOf: (projectId) => JSON.parse(fs.readFileSync(
      path.join(library, 'projects', projectId, 'manifest.json'), 'utf-8')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A Foundry project on disk, in the shape `foundry-app/electron/projects.ts`
 * writes: a `project.json` catalogue and the pristine import in `archive/`.
 *
 * The catalogue carries only what this side reads — version, key, stem, title,
 * archive — deliberately. A fixture that mirrored every field of Foundry's
 * manifest would be a second copy of somebody else's schema, going stale on
 * their schedule; what is pinned here is the SIGNATURE, which is the contract
 * the door actually depends on.
 */
function makeFoundryProject(root, key, over = {}) {
  const dir = path.join(root, key);
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  const catalogue = {
    version: 2,
    key,
    title: 'Adopted Book',
    stem: 'Adopted Book. Tester, Terry. (2024)',
    createdAt: Date.now(),
    archive: { file: ORIGINAL_NAME, kind: 'pdf', contentKey: key.slice(-8), originPath: null },
    documents: [],
    working: { files: [] },
    final: [],
    reading: null,
    ...over,
  };
  if (over.archive !== undefined) catalogue.archive = over.archive;
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(catalogue, null, 2));
  if (catalogue.archive && typeof catalogue.archive.file === 'string') {
    fs.writeFileSync(
      path.join(dir, 'archive', catalogue.archive.file),
      over.bytes || ORIGINAL_BYTES);
  }
  return dir;
}

/** Put a file in a project's export tray, as Foundry's `final/` holds them. */
function addExport(projectDir, name, bytes) {
  const tray = path.join(projectDir, 'final');
  fs.mkdirSync(tray, { recursive: true });
  fs.writeFileSync(path.join(tray, name), bytes);
  return path.join(tray, name);
}

const run = (fn) => async () => {
  const w = makeWorld();
  try { await fn(w); } finally { w.cleanup(); }
};

const doAdopt = (w, dir) => adopt.adoptFoundryProject(dir, w.hosted, w.onChanged);

// ── The signature: what counts as a Foundry project ────────────────────────

test('a folder with no project.json is refused, and the sentence says so', run(async (w) => {
  const notAProject = path.join(w.root, 'just-a-folder');
  fs.mkdirSync(notAProject, { recursive: true });
  const res = await doAdopt(w, notAProject);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(/is not a Foundry project/.test(res.reason), res.reason);
  assert.ok(/no project\.json/.test(res.reason), res.reason);
  assert.ok(/Nothing was adopted/.test(res.reason), 'a refusal states what did not happen');
  assert.deepStrictEqual(w.books(), [], 'nothing was minted');
}));

test('a catalogue that is not JSON is refused by name', run(async (w) => {
  const dir = path.join(w.standalone, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), '{ not json');
  const res = await doAdopt(w, dir);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(/is not JSON/.test(res.reason), res.reason);
}));

test('a catalogue of an unknown version is refused rather than guessed at', run(async (w) => {
  const dir = makeFoundryProject(w.standalone, 'future-1234abcd', { version: 99 });
  const res = await doAdopt(w, dir);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(/version 99/.test(res.reason), res.reason);
}));

test('a project with no archived original is refused — there is nothing to make a book from', run(async (w) => {
  const dir = makeFoundryProject(w.standalone, 'no-archive-1234abcd', { archive: null });
  const res = await doAdopt(w, dir);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(/records no imported original/.test(res.reason), res.reason);
  assert.deepStrictEqual(w.books(), []);
}));

test('a project whose archived original is gone is refused, naming the missing file', run(async (w) => {
  const dir = makeFoundryProject(w.standalone, 'lost-1234abcd');
  fs.rmSync(path.join(dir, 'archive', ORIGINAL_NAME));
  const res = await doAdopt(w, dir);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(res.reason.includes(ORIGINAL_NAME), res.reason);
  assert.deepStrictEqual(w.books(), []);
}));

// ── Adopting one from standalone Foundry ───────────────────────────────────

test('a standalone project is copied in, minted as a book, and mapped', run(async (w) => {
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  const res = await doAdopt(w, src);
  assert.strictEqual(res.outcome, 'adopted', res.reason);
  assert.strictEqual(res.minted, true, 'a book was created');
  assert.strictEqual(res.copied, true, 'the project was copied under the library');
  assert.strictEqual(res.key, 'Adopted-Book-e5836de0');

  // The copy is where the host looks, and it is whole.
  const hostedDir = path.join(w.hosted, 'Adopted-Book-e5836de0');
  assert.ok(fs.existsSync(path.join(hostedDir, 'project.json')), 'the catalogue came with it');
  assert.strictEqual(
    fs.readFileSync(path.join(hostedDir, 'archive', ORIGINAL_NAME), 'utf-8'), ORIGINAL_BYTES);

  // The book exists, with the pristine original as its archive.
  assert.deepStrictEqual(w.books(), [res.projectId]);
  const m = w.manifestOf(res.projectId);
  const original = (m.archive || []).find((a) => a.role === 'original');
  assert.ok(original, 'the imported original is archived');
  assert.strictEqual(
    fs.readFileSync(path.join(res.bookDir, ...original.path.split('/')), 'utf-8'),
    ORIGINAL_BYTES);

  // The mapping, in the exact shape `onImport` writes.
  assert.strictEqual(m.foundryProject.dir, 'Adopted-Book-e5836de0');
  assert.strictEqual(m.foundryProject.sourceVariantId, `arch:${original.path}`,
    'the mapping names the version the project was made from');
  assert.strictEqual(res.sourceVariantId, m.foundryProject.sourceVariantId);

  // The archive variant is what a version row is drawn from.
  const variants = manifestService.getVariants(m).variants;
  const archived = variants.find((v) => v.id === m.foundryProject.sourceVariantId);
  assert.ok(archived, 'the archive variant is present');
  assert.strictEqual(archived.kind, 'ebook');
  assert.strictEqual(archived.format, 'pdf');

  assert.ok(w.changed.includes(res.bookDir), 'the windows were told the mapping changed');
}));

test("the source is COPIED, never moved — Owen's own library is not ours to empty", run(async (w) => {
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  await doAdopt(w, src);
  assert.ok(fs.existsSync(path.join(src, 'project.json')), 'the standalone project is still there');
  assert.strictEqual(
    fs.readFileSync(path.join(src, 'archive', ORIGINAL_NAME), 'utf-8'), ORIGINAL_BYTES,
    'and byte-identical');
}));

test('adopting the same project twice mints nothing the second time', run(async (w) => {
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  const first = await doAdopt(w, src);
  assert.strictEqual(first.outcome, 'adopted');

  const second = await doAdopt(w, src);
  assert.strictEqual(second.outcome, 'already-mapped', second.reason);
  assert.strictEqual(second.projectId, first.projectId, 'it names the book that already has it');
  assert.ok(/already in this library/.test(second.message), second.message);
  assert.deepStrictEqual(w.books(), [first.projectId], 'one book, not two');
}));

test('a second adopt does not re-copy over the hosted project', run(async (w) => {
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  await doAdopt(w, src);
  // The user has since worked in the hosted copy. A re-adopt that copied would
  // destroy this.
  const worked = path.join(w.hosted, 'Adopted-Book-e5836de0', 'readings', 'bank.jsonl');
  fs.mkdirSync(path.dirname(worked), { recursive: true });
  fs.writeFileSync(worked, 'HOURS OF GPU');

  await doAdopt(w, src);
  assert.strictEqual(fs.readFileSync(worked, 'utf-8'), 'HOURS OF GPU',
    'work done in the hosted copy survives a second adopt');
}));

test('a DIFFERENT project already under that folder name is refused, nothing copied', run(async (w) => {
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  // Same folder name in the hosted root, different catalogue key: two books that
  // happen to slug the same way.
  const occupant = makeFoundryProject(w.hosted, 'Adopted-Book-e5836de0', {
    key: 'Something-Else-99999999',
    title: 'Something Else',
  });
  fs.writeFileSync(path.join(occupant, 'archive', ORIGINAL_NAME), 'THE OTHER BOOK');

  const res = await doAdopt(w, src);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(/already occupies/.test(res.reason), res.reason);
  assert.ok(/Something-Else-99999999/.test(res.reason), 'it names the occupant');
  assert.strictEqual(
    fs.readFileSync(path.join(occupant, 'archive', ORIGINAL_NAME), 'utf-8'), 'THE OTHER BOOK',
    'the occupant was not overwritten');
  assert.deepStrictEqual(w.books(), [], 'and no book was minted');
}));

// ── The orphan in our own hosted root ──────────────────────────────────────

test('an orphan already in the hosted root is adopted in place, not copied', run(async (w) => {
  const orphan = makeFoundryProject(w.hosted, 'Orphan-Book-aabbccdd');
  const res = await doAdopt(w, orphan);
  assert.strictEqual(res.outcome, 'adopted', res.reason);
  assert.strictEqual(res.copied, false, 'it is already where the host looks');
  assert.strictEqual(res.minted, true);
  const m = w.manifestOf(res.projectId);
  assert.strictEqual(m.foundryProject.dir, 'Orphan-Book-aabbccdd');
  assert.deepStrictEqual(
    fs.readdirSync(w.hosted), ['Orphan-Book-aabbccdd'], 'nothing was duplicated beside it');
}));

// ── Exports already in the tray ────────────────────────────────────────────

test("EPUBs already in final/ land as versions the moment the project is adopted", run(async (w) => {
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  addExport(src, 'Adopted Book.epub', 'CLEANED BYTES');
  addExport(src, 'Adopted Book.txt', 'PLAIN TEXT');
  addExport(src, 'notes.md', 'NOT A KIND THE VERSIONS PAGE HOLDS');

  const res = await doAdopt(w, src);
  assert.strictEqual(res.outcome, 'adopted', res.reason);
  assert.strictEqual(res.exportsLanded, 2, 'the epub and the txt, not the md');

  const m = w.manifestOf(res.projectId);
  const landed = manifestService.getVariants(m).variants.filter((v) => v.foundrySource);
  assert.strictEqual(landed.length, 2);
  const epub = landed.find((v) => v.format === 'epub');
  assert.ok(epub, 'the export is a version');
  assert.ok(epub.path.startsWith('output/'), `lands in output/, not ${epub.path}`);
  assert.strictEqual(fs.readFileSync(path.join(res.bookDir, ...epub.path.split('/')), 'utf-8'),
    'CLEANED BYTES');
  assert.strictEqual(epub.foundrySource.projectKey, 'Adopted-Book-e5836de0');
  assert.strictEqual(epub.foundrySource.parentVariantId, m.foundryProject.sourceVariantId,
    'an export nests under the version the project was made from');
}));

test('a second adopt does not re-land the exports', run(async (w) => {
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  addExport(src, 'Adopted Book.epub', 'CLEANED BYTES');
  const first = await doAdopt(w, src);
  assert.strictEqual(first.exportsLanded, 1);

  const second = await doAdopt(w, src);
  assert.strictEqual(second.outcome, 'already-mapped');
  assert.strictEqual(second.exportsLanded, 0, 'a sweep is invisible to a library already correct');
  const landed = manifestService.getVariants(w.manifestOf(first.projectId)).variants
    .filter((v) => v.foundrySource);
  assert.strictEqual(landed.length, 1, 'one version, not two');
}));

// ── A book this library already has ────────────────────────────────────────

test('a book already made from the same file is JOINED, not duplicated', run(async (w) => {
  // The user imported the PDF into BookForge the ordinary way first, and built
  // the Foundry project from the same file separately. Two copies of their book
  // would be the wrong answer.
  const loose = path.join(w.root, ORIGINAL_NAME);
  fs.writeFileSync(loose, ORIGINAL_BYTES);
  const { importEpubProject } = require(path.join(REPO, 'dist', 'electron', 'import-epub-project.js'));
  const already = await importEpubProject(loose, { projectType: 'book' });
  assert.ok(already.success, already.error);

  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  const res = await doAdopt(w, src);
  assert.strictEqual(res.outcome, 'adopted', res.reason);
  assert.strictEqual(res.minted, false, 'the existing book was joined');
  assert.strictEqual(res.projectId, already.projectId);
  assert.deepStrictEqual(w.books(), [already.projectId], 'still one book');
  const m = w.manifestOf(already.projectId);
  assert.strictEqual(m.foundryProject.dir, 'Adopted-Book-e5836de0');
  assert.ok(m.foundryProject.sourceVariantId, 'and it names the version, not nothing');
}));

test('adopting a TWIN does not re-point a book off the project it is joined to', run(async (w) => {
  // Two projects made from the same file mint the same book, so adopting the
  // second lands on the first's book — and writing the new key would re-point
  // the book away from a project that may hold the user's work, in an act the
  // user read as "import". The Flashpoint accident, 2026-08-17: an empty twin
  // was adopted after the real project and won the mapping by coming last.
  const real = makeFoundryProject(w.standalone, 'Real-Work-Book-e5836de0');
  const first = await doAdopt(w, real);
  assert.strictEqual(first.outcome, 'adopted', first.reason);

  const twin = makeFoundryProject(w.standalone, 'Empty-Twin-Book-e5836de0');
  const res = await doAdopt(w, twin);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(res.reason.includes('Real-Work-Book-e5836de0'), `names the joined project: ${res.reason}`);
  assert.ok(/nothing was adopted/i.test(res.reason), res.reason);
  const m = w.manifestOf(first.projectId);
  assert.strictEqual(m.foundryProject.dir, 'Real-Work-Book-e5836de0', 'the mapping did not move');
  assert.deepStrictEqual(
    fs.readdirSync(w.hosted), ['Real-Work-Book-e5836de0'],
    'the refused twin\'s copy was rolled back');
}));

test('the re-point IS taken when the joined project is gone — the healing case', run(async (w) => {
  const real = makeFoundryProject(w.standalone, 'Real-Work-Book-e5836de0');
  const first = await doAdopt(w, real);
  assert.strictEqual(first.outcome, 'adopted', first.reason);
  // The joined project is deleted out from under the book — a mapping to
  // nothing. Adopting another project made from the same file heals it.
  fs.rmSync(path.join(w.hosted, 'Real-Work-Book-e5836de0'), { recursive: true });

  const replacement = makeFoundryProject(w.standalone, 'Replacement-Book-e5836de0');
  const res = await doAdopt(w, replacement);
  assert.strictEqual(res.outcome, 'adopted', res.reason);
  assert.strictEqual(res.minted, false, 'the same book, re-joined');
  assert.strictEqual(
    w.manifestOf(first.projectId).foundryProject.dir, 'Replacement-Book-e5836de0');
}));

// ── Discovery ──────────────────────────────────────────────────────────────

test('both halves are listed, with origin, edited date and the exports badge', run(async (w) => {
  w.installStandaloneSettings();
  makeFoundryProject(w.standalone, 'Standalone-One-11111111');
  const withExports = makeFoundryProject(w.standalone, 'Standalone-Two-22222222');
  addExport(withExports, 'Adopted Book.epub', 'X');
  makeFoundryProject(w.hosted, 'Orphan-Three-33333333');

  const root = await adopt.standaloneFoundryProjectsRoot(w.foundryUserData, w.root);
  assert.strictEqual(root, w.standalone, 'the settings file names where Foundry keeps them');

  const listing = await adopt.listAdoptableFoundryProjects(w.hosted, root);
  const byKey = new Map(listing.projects.map((p) => [p.key, p]));
  assert.strictEqual(listing.projects.length, 3);
  assert.strictEqual(byKey.get('Standalone-One-11111111').origin, 'standalone');
  assert.strictEqual(byKey.get('Orphan-Three-33333333').origin, 'hosted');
  assert.strictEqual(byKey.get('Standalone-Two-22222222').hasExports, true);
  assert.strictEqual(byKey.get('Standalone-One-11111111').hasExports, false);
  assert.strictEqual(byKey.get('Standalone-One-11111111').title, 'Adopted Book');
  assert.strictEqual(byKey.get('Standalone-One-11111111').originalKind, 'pdf');
  assert.ok(!isNaN(+new Date(byKey.get('Standalone-One-11111111').modifiedAt)),
    'the edited date is a real timestamp');
}));

test('a project a book already claims is not offered again', run(async (w) => {
  w.installStandaloneSettings();
  const src = makeFoundryProject(w.standalone, 'Adopted-Book-e5836de0');
  const root = await adopt.standaloneFoundryProjectsRoot(w.foundryUserData, w.root);

  const before = await adopt.listAdoptableFoundryProjects(w.hosted, root);
  assert.strictEqual(before.projects.length, 1, 'unadopted, it is on the list');

  await doAdopt(w, src);
  const after = await adopt.listAdoptableFoundryProjects(w.hosted, root);
  assert.deepStrictEqual(after.projects, [],
    'adopted, it is neither offered from standalone nor as a hosted orphan');
}));

test('no standalone settings file means no standalone half, not an error', run(async (w) => {
  // Nothing installed: `%APPDATA%/Foundry` does not exist at all.
  const root = await adopt.standaloneFoundryProjectsRoot(w.foundryUserData, w.root);
  assert.strictEqual(root, null, 'absent is answered as absent');

  makeFoundryProject(w.hosted, 'Orphan-Only-44444444');
  const listing = await adopt.listAdoptableFoundryProjects(w.hosted, root);
  assert.strictEqual(listing.projects.length, 1, 'the hosted half still answers');
  assert.deepStrictEqual(listing.refusals, [], 'and nothing is refused over it');
}));

test('a settings file that names no library falls to where Foundry itself would look', run(async (w) => {
  fs.mkdirSync(w.foundryUserData, { recursive: true });
  fs.writeFileSync(path.join(w.foundryUserData, 'app-settings.json'),
    JSON.stringify({ keepServerWarmMinutes: 0 }));
  const root = await adopt.standaloneFoundryProjectsRoot(w.foundryUserData, w.root);
  assert.strictEqual(root, path.join(w.root, 'Documents', 'Foundry', 'projects'),
    "Foundry at its defaults keeps them in ~/Documents/Foundry, and that is where we look");
}));

test('a stray folder is passed over silently; an unreadable catalogue is a greyed ROW', run(async (w) => {
  fs.mkdirSync(path.join(w.hosted, 'somebodys-folder'), { recursive: true });
  const broken = path.join(w.hosted, 'half-a-project');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'project.json'), '{ not json');

  const listing = await adopt.listAdoptableFoundryProjects(w.hosted, null);
  assert.deepStrictEqual(listing.projects, []);

  // Owen's ruling, 2026-08-22: a project that cannot be adopted is DRAWN and
  // greyed, not explained in a paragraph beside a list it is absent from. The
  // folder with no catalogue stays silent — that one is somebody's folder and
  // not a project that failed.
  assert.strictEqual(listing.blocked.length, 1,
    'a folder with no catalogue is somebody’s folder; one with a broken catalogue is a row');
  assert.strictEqual(listing.blocked[0].key, 'half-a-project');
  assert.strictEqual(listing.blocked[0].origin, 'hosted');
  assert.deepStrictEqual(listing.refusals, [],
    'nothing about a single project is prose any more');

  // The tooltip has to be a tooltip: one clause, and not the paragraph the
  // press-time refusal still throws.
  const { reason } = listing.blocked[0];
  assert.ok(reason.length <= 80, `the row's reason is a tooltip, not a paragraph: ${reason}`);
  assert.ok(!/Nothing was adopted/.test(reason),
    'the row is not the answer to a press, so it must not talk about what was adopted');
}));

test('every unadoptable shape is a row, and each says something different', run(async (w) => {
  // One folder per refusal `readFoundryProjectSignature` can raise, so a new one
  // added without a short form shows up here as a duplicate rather than as a
  // tooltip nobody notices is wrong.
  const shapes = {
    'not-json': '{ not json',
    'not-an-object': '[]',
    'wrong-version': JSON.stringify({ version: 9, key: 'k', archive: { file: 'a.pdf', kind: 'pdf' } }),
    'no-key': JSON.stringify({ version: 2, archive: { file: 'a.pdf', kind: 'pdf' } }),
    'no-original': JSON.stringify({ version: 2, key: 'no-original' }),
    'missing-file': JSON.stringify({ version: 2, key: 'missing-file', archive: { file: 'gone.pdf', kind: 'pdf' } }),
  };
  for (const [name, body] of Object.entries(shapes)) {
    const dir = path.join(w.hosted, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), body);
  }

  const listing = await adopt.listAdoptableFoundryProjects(w.hosted, null);
  assert.deepStrictEqual(listing.projects, []);
  assert.strictEqual(listing.blocked.length, Object.keys(shapes).length,
    'every unadoptable project is offered as a row to grey');
  assert.deepStrictEqual(listing.refusals, []);

  const reasons = listing.blocked.map((b) => b.reason);
  assert.strictEqual(new Set(reasons).size, reasons.length,
    `two shapes share a tooltip, so one of them is unexplained: ${reasons.join(' | ')}`);
  for (const reason of reasons) {
    assert.ok(reason.length <= 80, `not a tooltip: ${reason}`);
  }
}));

test('a project that is adoptable in one root is never ALSO greyed from the other', run(async (w) => {
  // The same key readable hosted and broken standalone. Offering it and greying
  // it in one list is the single outcome that reads as a bug rather than as an
  // answer, so `listAdoptableFoundryProjects` drops the blocked twin.
  const key = 'two-faced-abcd1234';
  fs.mkdirSync(path.join(w.standalone, key), { recursive: true });
  fs.writeFileSync(path.join(w.standalone, key, 'project.json'), '{ not json');
  makeFoundryProject(w.hosted, key, { title: 'Two Faced' });

  const listing = await adopt.listAdoptableFoundryProjects(w.hosted, w.standalone);
  assert.strictEqual(listing.projects.length, 1, 'the readable one is offered');
  assert.strictEqual(listing.projects[0].key, key);
  assert.deepStrictEqual(listing.blocked, [],
    'the broken twin is dropped rather than drawn beside the row that works');
}));

// ── Re-adopting brings the copy forward ────────────────────────────────────
//
// Adoption was copy-once. Owen adopted Reinhold Krause at 04:53 with three
// steps, worked on it in standalone Foundry until 07:24, re-imported, and the
// three-step copy stood — while the message said "already in this library.
// Nothing was adopted again" and reconciled a tray four steps out of date.

/** Push a file's mtime forward, so "the source changed after we copied" is real. */
function touchLater(file, msLater) {
  const at = new Date(fs.statSync(file).mtime.getTime() + msLater);
  fs.utimesSync(file, at, at);
  return at;
}

test('re-adopting an already-mapped project brings its stale copy forward', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-a82de0d9');
  const first = await doAdopt(w, source);
  assert.strictEqual(first.outcome, 'adopted');

  // Work happens in standalone Foundry AFTER the copy: a new export lands in
  // its tray and the catalogue is rewritten.
  addExport(source, 'krause (en).epub', Buffer.from('EPUB-EN'));
  touchLater(path.join(source, 'project.json'), 60_000);

  const again = await doAdopt(w, source);
  assert.strictEqual(again.outcome, 'already-mapped');

  const copied = path.join(w.hosted, 'Krause-a82de0d9', 'final', 'krause (en).epub');
  assert.ok(fs.existsSync(copied), 'the export made after the first adoption reached the copy');
  assert.ok(/brought up to date/.test(again.message), again.message);
  assert.ok(again.exportsLanded >= 1,
    `the refreshed tray is what reconcile then reads: ${again.exportsLanded}`);
}));

// WHICH MACHINE WATCHES THE NEXT TWO FAIL: not this one, if this one is Windows.
//
// `fs.cp` preserves mtimes on win32 (measured 2026-08-22: 0 ms delta, local disk
// and SMB share alike) and does not on macOS. So the bug these were written for
// — an untouched copy reading as NEWER than its original — cannot reproduce on
// Windows, where a fresh copy already carries the source's timestamp and the
// comparison happens to come out right. They are still real gates; the Mac is
// the machine they bite on. Stated here so a green run on Windows is not
// mistaken for these having been exercised.
test('re-adopting with NOTHING changed says up to date, not "newer"', run(async (w) => {
  // The regression bookforge-mac-2 caught minutes after the refresh landed: a
  // copy is BY CONSTRUCTION younger than the file it was copied from, so
  // `hostedAt > sourceAt` was the resting state of every fresh copy and every
  // no-op re-adopt claimed the library's copy was newer than Foundry's — while
  // printing two identical timestamps in its own sentence. `current` was
  // unreachable at the same time, needing exact-millisecond equality between a
  // file and its copy. The fix stamps the copy with the source's own mtime.
  const source = makeFoundryProject(w.standalone, 'Krause-e4e4e4e4');
  assert.strictEqual((await doAdopt(w, source)).outcome, 'adopted');

  const again = await doAdopt(w, source);
  assert.strictEqual(again.outcome, 'already-mapped');
  assert.ok(/already up to date/.test(again.message),
    `a no-op re-adopt must say nothing changed: ${again.message}`);
  assert.ok(!/NEWER/.test(again.message),
    `a copy is younger than its original; that is not the hosted side doing work: ${again.message}`);
}));

test('the copy carries the ORIGINAL\'s timestamp, not the moment it was copied', run(async (w) => {
  // The mechanism under the test above, asserted directly: without this the
  // comparison cannot mean what it says, and every branch of it drifts.
  const source = makeFoundryProject(w.standalone, 'Krause-f5f5f5f5');
  assert.strictEqual((await doAdopt(w, source)).outcome, 'adopted');

  const sourceAt = fs.statSync(path.join(source, 'project.json')).mtime.getTime();
  const copyAt = fs.statSync(path.join(w.hosted, 'Krause-f5f5f5f5', 'project.json')).mtime.getTime();
  assert.ok(Math.abs(copyAt - sourceAt) <= 2000,
    `the copy should carry the source's mtime; source ${sourceAt}, copy ${copyAt}`);
}));

test('a hosted copy NEWER than the source is never overwritten, and says so', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-b1b1b1b1');
  assert.strictEqual((await doAdopt(w, source)).outcome, 'adopted');

  // This test used to pass without the touch below, because a fresh copy already
  // read as newer — so it could not tell "the hosted window did work" from "this
  // is a copy", and would have kept passing with the detection removed entirely.
  const untouched = await doAdopt(w, source);
  assert.ok(!/NEWER/.test(untouched.message),
    `the hosted-newer verdict must require actual hosted work: ${untouched.message}`);

  // The hosted window edits its own copy; the standalone original does not move.
  const hostedCatalogue = path.join(w.hosted, 'Krause-b1b1b1b1', 'project.json');
  addExport(path.join(w.hosted, 'Krause-b1b1b1b1'), 'hosted-only.epub', Buffer.from('HOSTED'));
  touchLater(hostedCatalogue, 60_000);

  const again = await doAdopt(w, source);
  assert.strictEqual(again.outcome, 'already-mapped');
  assert.ok(/NEWER/.test(again.message), again.message);
  assert.ok(
    fs.existsSync(path.join(w.hosted, 'Krause-b1b1b1b1', 'final', 'hosted-only.epub')),
    'work that exists only in the hosted copy survived the re-adoption');
}));

test('an unclaimed stale copy is refreshed before the book is minted from it', run(async (w) => {
  // The orphan case: a copy left under the hosted root that no book claims. It
  // used to be adopted as-is, so the book was minted from a stale original.
  const source = makeFoundryProject(w.standalone, 'Krause-c2c2c2c2');
  const orphan = makeFoundryProject(w.hosted, 'Krause-c2c2c2c2', { title: 'Stale Copy' });
  addExport(source, 'fresh.epub', Buffer.from('FRESH'));
  touchLater(path.join(source, 'project.json'), 60_000);

  const res = await doAdopt(w, source);
  assert.strictEqual(res.outcome, 'adopted');
  assert.ok(fs.existsSync(path.join(orphan, 'final', 'fresh.epub')),
    'the orphan copy was brought forward before the book was minted from it');
}));

test('no .adopting- or .superseded- scratch survives a refresh', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-d3d3d3d3');
  await doAdopt(w, source);
  touchLater(path.join(source, 'project.json'), 60_000);
  await doAdopt(w, source);

  const strays = fs.readdirSync(w.hosted).filter((n) => n.startsWith('.'));
  assert.deepStrictEqual(strays, [], `scratch folders were left behind: ${strays.join(', ')}`);
}));

// ── Reload from Foundry: the third door ───────────────────────────────────
//
// `refreshAdoptedProject` is the button on a book that already HAS a project.
// It exists because the refresh adoption performs was unreachable once a book
// claimed the project: `listAdoptableFoundryProjects` filters claimed keys out,
// so there was no press to make. What these pin is the half that is new — that
// it moves ONLY the files that differ, that it deletes what the original no
// longer has, and that every way it can decline says which one it was.

const doReload = (w, bookDir) =>
  adopt.refreshAdoptedProject(bookDir, w.hosted, w.standalone, w.onChanged);

/** Put a step document in a project, as Foundry's working files sit. */
function addWorkingFile(projectDir, name, bytes) {
  const dir = path.join(projectDir, 'working');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  return path.join(dir, name);
}

test('reload brings across ONLY the files that changed', run(async (w) => {
  // The whole point of the button as Owen asked for it: "just the files that
  // would be affected by it". A project is mostly its imported original; a
  // reload that rewrote all of it would cost a gigabyte to carry a paragraph.
  const source = makeFoundryProject(w.standalone, 'Krause-11111111');
  addWorkingFile(source, 'step-1.html', 'ONE');
  addWorkingFile(source, 'step-2.html', 'TWO');
  const first = await doAdopt(w, source);
  assert.strictEqual(first.outcome, 'adopted');

  // One document is rewritten in standalone Foundry, and the catalogue with it.
  addWorkingFile(source, 'step-2.html', 'TWO, TRANSLATED');
  touchLater(path.join(source, 'working', 'step-2.html'), 60_000);
  touchLater(path.join(source, 'project.json'), 60_000);

  const res = await doReload(w, path.join(w.library, 'projects', first.projectId));
  assert.strictEqual(res.outcome, 'refreshed', res.reason || res.message);
  // The catalogue and the one document. NOT the original, not step-1.
  assert.strictEqual(res.filesCopied, 2,
    `only the changed files should be written: ${res.message}`);
  assert.strictEqual(res.filesRemoved, 0);

  const copy = path.join(w.hosted, 'Krause-11111111');
  assert.strictEqual(
    fs.readFileSync(path.join(copy, 'working', 'step-2.html'), 'utf-8'), 'TWO, TRANSLATED',
    'the file that changed came across');
  assert.strictEqual(
    fs.readFileSync(path.join(copy, 'working', 'step-1.html'), 'utf-8'), 'ONE',
    'the file that did not change is still there');
}));

test('reload removes what the original no longer has', run(async (w) => {
  // The honest half of "reload": a step deleted in Foundry must not stand in
  // the copy forever — the copy is what the hosted window opens.
  const source = makeFoundryProject(w.standalone, 'Krause-22222222');
  addWorkingFile(source, 'struck.html', 'GONE SOON');
  const first = await doAdopt(w, source);
  assert.ok(fs.existsSync(path.join(w.hosted, 'Krause-22222222', 'working', 'struck.html')));

  fs.rmSync(path.join(source, 'working', 'struck.html'));
  touchLater(path.join(source, 'project.json'), 60_000);

  const res = await doReload(w, path.join(w.library, 'projects', first.projectId));
  assert.strictEqual(res.outcome, 'refreshed', res.reason || res.message);
  assert.strictEqual(res.filesRemoved, 1, res.message);
  assert.ok(!fs.existsSync(path.join(w.hosted, 'Krause-22222222', 'working', 'struck.html')),
    'the deleted step is gone from the copy too');
}));

test('reload leaves the standalone project byte-identical', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-33333333');
  addWorkingFile(source, 'step.html', 'WORK');
  const first = await doAdopt(w, source);
  touchLater(path.join(source, 'project.json'), 60_000);
  await doReload(w, path.join(w.library, 'projects', first.projectId));

  assert.strictEqual(fs.readFileSync(path.join(source, 'working', 'step.html'), 'utf-8'), 'WORK');
  assert.strictEqual(
    fs.readFileSync(path.join(source, 'archive', ORIGINAL_NAME), 'utf-8'), ORIGINAL_BYTES,
    "standalone Foundry's library is another program's data");
}));

test('a reload with nothing to bring says it is up to date, and does not lie about it', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-44444444');
  const first = await doAdopt(w, source);
  const res = await doReload(w, path.join(w.library, 'projects', first.projectId));
  assert.strictEqual(res.outcome, 'current', res.reason || res.message);
  assert.ok(/already up to date/.test(res.message), res.message);
  assert.ok(!/NEWER/.test(res.message),
    `a copy resting at its source is not the hosted side doing work: ${res.message}`);
}));

test('a reload declines when the hosted copy is the newer one', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-55555555');
  const first = await doAdopt(w, source);

  // The hosted window exported something; the standalone original did not move.
  const copy = path.join(w.hosted, 'Krause-55555555');
  addExport(copy, 'hosted-only.epub', Buffer.from('HOSTED'));
  touchLater(path.join(copy, 'project.json'), 60_000);

  const res = await doReload(w, path.join(w.library, 'projects', first.projectId));
  assert.strictEqual(res.outcome, 'declined', res.reason || res.message);
  assert.ok(/NEWER/.test(res.message), res.message);
  assert.ok(fs.existsSync(path.join(copy, 'final', 'hosted-only.epub')),
    'a reload must never overwrite hosted work with an older original');
}));

test('a reload restores a copy that has gone missing', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-66666666');
  const first = await doAdopt(w, source);
  fs.rmSync(path.join(w.hosted, 'Krause-66666666'), { recursive: true, force: true });

  const res = await doReload(w, path.join(w.library, 'projects', first.projectId));
  assert.strictEqual(res.outcome, 'refreshed', res.reason || res.message);
  assert.ok(/was missing/.test(res.message), res.message);
  assert.ok(fs.existsSync(path.join(w.hosted, 'Krause-66666666', 'archive', ORIGINAL_NAME)),
    'the book\'s mapping names a folder the hosted window opens; it must be there');
}));

test('a reload lands an export made in standalone since the last press', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-77777777');
  const first = await doAdopt(w, source);
  addExport(source, 'krause (en).epub', Buffer.from('EXPORTED LATER'));
  touchLater(path.join(source, 'project.json'), 60_000);

  const res = await doReload(w, path.join(w.library, 'projects', first.projectId));
  assert.strictEqual(res.outcome, 'refreshed', res.reason || res.message);
  assert.strictEqual(res.exportsLanded, 1, res.message);
  const landed = manifestService.getVariants(w.manifestOf(first.projectId)).variants
    .filter((v) => v.foundrySource);
  assert.strictEqual(landed.length, 1, 'the export is on the versions page');
}));

test('a book with no Foundry project is refused rather than guessed at', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-88888888');
  const first = await doAdopt(w, source);
  // Any book will do — this one simply has its mapping taken away.
  const bookDir = path.join(w.library, 'projects', first.projectId);
  const mf = JSON.parse(fs.readFileSync(path.join(bookDir, 'manifest.json'), 'utf-8'));
  delete mf.foundryProject;
  fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify(mf, null, 2));

  const res = await doReload(w, bookDir);
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(/not joined to a Foundry project/.test(res.reason), res.reason);
  assert.ok(/Nothing was changed/.test(res.reason), res.reason);
}));

test('a project that exists only inside BookForge is refused by name', run(async (w) => {
  // The ordinary state of a book imported through the hosted window: there is
  // no standalone copy anywhere, and the sentence must say that rather than
  // reporting a missing folder.
  const orphan = makeFoundryProject(w.hosted, 'Hosted-99999999');
  const first = await doAdopt(w, orphan);
  assert.strictEqual(first.outcome, 'adopted');

  const res = await doReload(w, path.join(w.library, 'projects', first.projectId));
  assert.strictEqual(res.outcome, 'refused');
  assert.ok(/only inside BookForge/.test(res.reason), res.reason);
}));

test('findStandaloneSource answers the button, and null covers every way there is none', run(async (w) => {
  const source = makeFoundryProject(w.standalone, 'Krause-aaaaaaaa');
  const found = await adopt.findStandaloneSource(w.standalone, 'Krause-aaaaaaaa');
  assert.ok(found !== null, 'a project that is there is offered');
  assert.strictEqual(found.dir, source);
  assert.strictEqual(
    found.modifiedAt, fs.statSync(path.join(source, 'project.json')).mtime.toISOString());

  assert.strictEqual(await adopt.findStandaloneSource(null, 'Krause-aaaaaaaa'), null,
    'no standalone Foundry on this machine');
  assert.strictEqual(await adopt.findStandaloneSource(w.standalone, 'no-such-1234abcd'), null,
    'no folder under that key');
  const empty = path.join(w.standalone, 'empty-1234abcd');
  fs.mkdirSync(empty, { recursive: true });
  assert.strictEqual(await adopt.findStandaloneSource(w.standalone, 'empty-1234abcd'), null,
    'a folder with no catalogue is not a source');
}));

test('a root that does not exist is not a refusal', run(async (w) => {
  const listing = await adopt.listAdoptableFoundryProjects(
    path.join(w.root, 'no', 'such', 'place'), path.join(w.root, 'nor', 'here'));
  assert.deepStrictEqual(listing.projects, []);
  assert.deepStrictEqual(listing.refusals, [],
    'a library with no Foundry project has no foundry/projects, and that is ordinary');
}));

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; }
    catch (err) { failures.push({ name, err }); }
  }
  console.log(`\nfoundry adopt: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.stack || f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
