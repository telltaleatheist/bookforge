#!/usr/bin/env node
/**
 * Tests for the hosted Foundry's two manifest records in
 * electron/manifest-service.ts — against a REAL project directory on disk, in a
 * temp library.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-host.js
 *
 * Both records are REFERENCES into `<library>/foundry`, which BookForge does not
 * own the contents of, and both are worded so they survive the library moving to
 * another drive. That is what these tests pin:
 *
 *  - `setFoundryProject` stores a KEY. A path — absolute or nested — is refused
 *    by name rather than trimmed into one, because a stored path names a volume
 *    and every one of them is wrong after a move.
 *  - `appendFoundryExport` is append-only WITH ONE EXCEPTION: a re-export of the
 *    same file replaces that record in place, keeping its id and its position.
 *    Same path means same version row; two rows for one file leaves the user
 *    guessing which of them their next act addresses.
 *  - `forgetFoundryExport` forgets a REFERENCE. Nothing here touches a file.
 *
 * And the legacy rule that bounds all of it: a project carrying neither key
 * answers "no project" and "no exports" — real states, never refusals.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const manifestService = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PROJECT_ID = 'Test_Book_-_A_Author_-_1999';

/** A bare project — no foundry keys at all, which is what every book on disk is. */
function makeProject(over = {}) {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-foundry-host-'));
  const projectDir = path.join(library, 'projects', PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  const manifest = {
    version: 2,
    projectId: PROJECT_ID,
    type: 'book',
    metadata: { title: 'Test Book' },
    ...over,
  };
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  manifestService.setLibraryBasePath(library);
  return {
    library,
    projectDir,
    read: () => JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf-8')),
    cleanup: () => fs.rmSync(library, { recursive: true, force: true }),
  };
}

const run = (fn, over) => async () => {
  const p = makeProject(over);
  try { await fn(p); } finally { p.cleanup(); }
};

const EXPORT_REL = 'foundry/projects/test-book/final/Test Book.epub';

// ── The project mapping ─────────────────────────────────────────────────────

test('a project with no mapping has no Foundry project — null, not a refusal', run(async (p) => {
  assert.strictEqual(await manifestService.readFoundryProject(p.projectDir), null);
}));

test('the mapping round-trips as a KEY', run(async (p) => {
  await manifestService.setFoundryProject(p.projectDir, 'test-book');
  assert.strictEqual(await manifestService.readFoundryProject(p.projectDir), 'test-book');
  assert.deepStrictEqual(p.read().foundryProject, { dir: 'test-book' },
    'the manifest stores the key and nothing else');
}));

test('an absolute path is refused by name and nothing is written', run(async (p) => {
  await assert.rejects(
    () => manifestService.setFoundryProject(p.projectDir, path.join(p.library, 'foundry', 'projects', 'x')),
    /not a Foundry project key/);
  assert.strictEqual(p.read().foundryProject, undefined);
}));

test('a nested path is refused too — a key is one folder name', run(async (p) => {
  await assert.rejects(
    () => manifestService.setFoundryProject(p.projectDir, 'projects/test-book'),
    /not a Foundry project key/);
}));

test('an empty key is refused', run(async (p) => {
  await assert.rejects(() => manifestService.setFoundryProject(p.projectDir, '   '), /no project key/);
}));

// ── The export list ─────────────────────────────────────────────────────────

test('a project with no exports has exported nothing — an empty list', run(async (p) => {
  assert.deepStrictEqual(await manifestService.readFoundryExports(p.projectDir), []);
}));

test('an export lands with an fx- id and the time it landed', run(async (p) => {
  const rec = await manifestService.appendFoundryExport(p.projectDir,
    { path: EXPORT_REL, kind: 'epub', title: 'Test Book' });
  assert.match(rec.id, /^fx-[0-9a-f]{8}$/, 'the id is fx- and eight hex characters');
  assert.strictEqual(rec.path, EXPORT_REL, 'the path is stored library-relative, verbatim');
  assert.ok(!isNaN(+new Date(rec.landedAt)), 'landedAt is a real timestamp');
  const stored = await manifestService.readFoundryExports(p.projectDir);
  assert.deepStrictEqual(stored, [rec]);
}));

test('two different files are two rows, oldest first', run(async (p) => {
  const a = await manifestService.appendFoundryExport(p.projectDir,
    { path: EXPORT_REL, kind: 'epub', title: 'Test Book' });
  const b = await manifestService.appendFoundryExport(p.projectDir,
    { path: 'foundry/projects/test-book/final/Test Book.txt', kind: 'txt', title: 'Test Book (text)' });
  const stored = await manifestService.readFoundryExports(p.projectDir);
  assert.deepStrictEqual(stored.map((r) => r.id), [a.id, b.id]);
}));

test('a RE-export of the same file replaces its row — id and position kept', run(async (p) => {
  const first = await manifestService.appendFoundryExport(p.projectDir,
    { path: EXPORT_REL, kind: 'epub', title: 'Test Book' });
  await manifestService.appendFoundryExport(p.projectDir,
    { path: 'foundry/projects/test-book/final/Test Book.txt', kind: 'txt', title: 'Test Book (text)' });
  const again = await manifestService.appendFoundryExport(p.projectDir,
    { path: EXPORT_REL, kind: 'epub', title: 'Test Book, second pass' });

  assert.strictEqual(again.id, first.id, 'the row keeps its id — it is the same version row');
  const stored = await manifestService.readFoundryExports(p.projectDir);
  assert.strictEqual(stored.length, 2, 'one file on disk is one row, never two');
  assert.strictEqual(stored[0].id, first.id, 'and it keeps its position');
  assert.strictEqual(stored[0].title, 'Test Book, second pass', 'the title is the new one');
}));

test('an absolute export path is refused, and nothing is recorded', run(async (p) => {
  await assert.rejects(
    () => manifestService.appendFoundryExport(p.projectDir,
      { path: path.join(p.library, 'foundry', 'x.epub'), kind: 'epub', title: 'X' }),
    /relative to the library root/);
  assert.deepStrictEqual(await manifestService.readFoundryExports(p.projectDir), []);
}));

test('a path that climbs out of the library is refused', run(async (p) => {
  await assert.rejects(
    () => manifestService.appendFoundryExport(p.projectDir,
      { path: 'foundry/../../elsewhere/x.epub', kind: 'epub', title: 'X' }),
    /climbs out of the library root/);
}));

test('a kind the tray cannot hold is refused', run(async (p) => {
  await assert.rejects(
    () => manifestService.appendFoundryExport(p.projectDir,
      { path: EXPORT_REL, kind: 'm4b', title: 'X' }),
    /not a kind of Foundry export/);
}));

test('an untitled export is refused — the title is what the row says', run(async (p) => {
  await assert.rejects(
    () => manifestService.appendFoundryExport(p.projectDir,
      { path: EXPORT_REL, kind: 'epub', title: '  ' }),
    /no title/);
}));

// ── Forgetting one ──────────────────────────────────────────────────────────

test('forgetting an export removes the record and leaves the file alone', run(async (p) => {
  const abs = path.join(p.library, ...EXPORT_REL.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'EXPORTED BYTES');

  const rec = await manifestService.appendFoundryExport(p.projectDir,
    { path: EXPORT_REL, kind: 'epub', title: 'Test Book' });
  const forgotten = await manifestService.forgetFoundryExport(p.projectDir, rec.id);

  assert.strictEqual(forgotten.id, rec.id);
  assert.deepStrictEqual(await manifestService.readFoundryExports(p.projectDir), []);
  assert.ok(fs.existsSync(abs), 'the file belongs to the foundry project and must survive');
}));

test('forgetting an id the project does not have refuses by name', run(async (p) => {
  await assert.rejects(
    () => manifestService.forgetFoundryExport(p.projectDir, 'fx-deadbeef'),
    /records no Foundry export/);
}));

// ── Legacy safety ───────────────────────────────────────────────────────────

test('neither record is written to a project that never asked for one', run(async (p) => {
  await manifestService.readFoundryProject(p.projectDir);
  await manifestService.readFoundryExports(p.projectDir);
  const m = p.read();
  assert.strictEqual(m.foundryProject, undefined, 'reading must not mint a mapping');
  assert.strictEqual(m.foundryExports, undefined, 'reading must not mint a list');
}));

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; }
    catch (err) { failures.push({ name, err }); }
  }
  console.log(`\nfoundry host records: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
