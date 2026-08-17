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

test('a stray folder is passed over silently; an unreadable catalogue is named', run(async (w) => {
  fs.mkdirSync(path.join(w.hosted, 'somebodys-folder'), { recursive: true });
  const broken = path.join(w.hosted, 'half-a-project');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'project.json'), '{ not json');

  const listing = await adopt.listAdoptableFoundryProjects(w.hosted, null);
  assert.deepStrictEqual(listing.projects, []);
  assert.strictEqual(listing.refusals.length, 1,
    'a folder with no catalogue is somebody’s folder; one with a broken catalogue is news');
  assert.ok(/half-a-project/.test(listing.refusals[0]), listing.refusals[0]);
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
