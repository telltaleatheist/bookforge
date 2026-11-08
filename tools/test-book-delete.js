#!/usr/bin/env node
/**
 * Keeper: deleting a book deletes its Foundry project, Foundry first, and forgets
 * what was cached about both (2026-11-08).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-delete.js
 *
 * A book delete discarded `projects/<book>` and nothing else. A book imported
 * through Foundry keeps the file the user imported, the working copy and every
 * edit made in the Foundry window in `foundry/projects/<key>`, and that stayed:
 * Foundry's Home went on listing it, and the confirmation had promised all of it
 * would go. `duration-cache.json` and `derivation-cache.json` kept entries for the
 * deleted book's m4b for good.
 *
 * Run against a REAL temp library: the real manifest service and library trash,
 * the real foundry-core `deleteProjectFolder` (Foundry's own door, with its own
 * gate), the real derivation cache and the real Bookshelf duration cache.
 *
 * Fails on main: electron/book-delete.ts did not exist, `manifest:delete` and the
 * Bookshelf's DELETE /api/project called `manifestService.deleteProject`, and the
 * Foundry project survived every delete.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'book-delete.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-book-delete-'));
const userData = path.join(root, 'userData');
const library = path.join(root, 'library');
const foundryRoot = path.join(library, 'foundry');
fs.mkdirSync(userData, { recursive: true });

// The modules under test import `electron` for `app.getPath`; nothing else of it.
const realLoad = Module._load;
Module._load = function stubElectron(request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => userData, isPackaged: false, getVersion: () => '0.0.0' } };
  }
  return realLoad.call(this, request, ...rest);
};

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const derivation = require(path.join(DIST, 'electron', 'derivation-cache.js'));
const { bookshelfServer } = require(path.join(DIST, 'electron', 'bookshelf-server.js'));
const bookDelete = require(path.join(DIST, 'electron', 'book-delete.js'));
const { setPlatform } = require(require.resolve('@owen/foundry-core/node/platform', { paths: [REPO] }));
const { deleteProjectFolder } = require(require.resolve('@owen/foundry-core/node/doors-delete', { paths: [REPO] }));

// Foundry, standalone, with its library at <library>/foundry — the hosted layout.
fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify({ libraryDir: foundryRoot }));
setPlatform({
  userDataDir: () => userData,
  tempDir: () => path.join(root, 'temp'),
  broadcast: () => {},
  image: {
    createFromPath: () => { throw new Error('no image codec in this keeper'); },
    createFromBuffer: () => { throw new Error('no image codec in this keeper'); },
  },
});
manifestService.setLibraryBasePath(library);
derivation.setDerivationCachePath(path.join(userData, 'derivation-cache.json'));

let foundryCalls = [];
let durationsForgotten = [];
let foundryProjectsDir = path.join(foundryRoot, 'projects');
bookDelete.setBookDeleteDoors({
  foundryProjectsDir: () => foundryProjectsDir,
  deleteFoundryProject: async (dir) => { foundryCalls.push(dir); return deleteProjectFolder(dir); },
  forgetDurationsUnder: (dirs) => { durationsForgotten.push(...dirs); bookshelfServer.forgetDurationsUnder(dirs); },
});

/** A book, and when `key` is given its Foundry project, laid out as an import leaves them. */
function makeBook(id, key, { manifest = true } = {}) {
  const bookDir = path.join(library, 'projects', id);
  fs.mkdirSync(path.join(bookDir, 'output'), { recursive: true });
  fs.writeFileSync(path.join(bookDir, 'output', `${id}.m4b`), 'audio');
  if (manifest) {
    const record = { version: 2, projectId: id, projectType: 'book', metadata: { title: id }, variants: [] };
    if (key) record.foundryProject = { dir: key, sourceVariantId: 'v1' };
    fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify(record));
  }
  let foundryDir = null;
  if (key) {
    foundryDir = path.join(foundryRoot, 'projects', key);
    fs.mkdirSync(path.join(foundryDir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(foundryDir, 'working'), { recursive: true });
    fs.writeFileSync(path.join(foundryDir, 'archive', 'scan.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(foundryDir, 'working', 'scan.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(foundryDir, 'project.json'), JSON.stringify({
      version: 2, key, title: id, stem: 'scan', createdAt: 1,
      archive: { file: 'scan.pdf', kind: 'pdf', contentKey: key.slice(-8) },
      documents: [], working: { files: [] },
    }));
  }
  return { bookDir, foundryDir, m4b: path.join(bookDir, 'output', `${id}.m4b`) };
}

const identity = { mtimeMs: 1, size: 5 };
function cacheAbout(file) {
  derivation.putDerived('audiobook-transcript-v1', file, identity, { ok: true });
  bookshelfServer.durationCache.set(file, { duration: 60, mtimeMs: 1, size: 5 });
}
const inProjects = (bookDir) => fs.existsSync(bookDir);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a Foundry-backed book: its Foundry project goes first, the book follows, both trees forgotten', async () => {
  const kept = makeBook('Kept Book', null);
  const book = makeBook('Damaged Scan', 'damaged-scan-7c4157db');
  cacheAbout(book.m4b);
  cacheAbout(path.join(book.foundryDir, 'working', 'scan.pdf'));
  cacheAbout(kept.m4b);
  foundryCalls = []; durationsForgotten = [];

  assert.deepStrictEqual(await bookDelete.describeBookDelete('Damaged Scan'), { foundryDir: book.foundryDir });
  const result = await bookDelete.deleteBook('Damaged Scan');
  assert.strictEqual(result.success, true, result.error);
  assert.deepStrictEqual(foundryCalls, [book.foundryDir]);
  assert.strictEqual(fs.existsSync(book.foundryDir), false, 'the Foundry project survived the book delete');
  assert.strictEqual(inProjects(book.bookDir), false, 'the book folder is still in projects/');

  const key = (file) => derivation.getDerived('audiobook-transcript-v1', file, identity);
  assert.strictEqual(key(book.m4b), null, 'the deleted m4b is still in the derivation cache');
  assert.strictEqual(key(path.join(book.foundryDir, 'working', 'scan.pdf')), null, 'a file of the deleted Foundry project is still cached');
  assert.deepStrictEqual(key(kept.m4b), { ok: true }, 'another book\'s entry was forgotten too');
  assert.strictEqual(bookshelfServer.durationCache.has(book.m4b), false, 'the deleted m4b is still in the duration cache');
  assert.strictEqual(bookshelfServer.durationCache.has(kept.m4b), true, 'another book\'s duration was forgotten too');
  assert.deepStrictEqual(durationsForgotten, [book.bookDir, book.foundryDir]);
});

test('Foundry refuses: nothing is deleted, and the person reads Foundry\'s sentence', async () => {
  const book = makeBook('Refused Book', 'refused-book-1234abcd');
  cacheAbout(book.m4b);
  // Foundry's own gate: a folder that is not one of ITS projects is refused by name.
  // Pointing BookForge's idea of the projects root elsewhere makes the real door refuse.
  const elsewhere = path.join(root, 'elsewhere', 'projects');
  fs.mkdirSync(path.join(elsewhere, 'refused-book-1234abcd'), { recursive: true });
  foundryProjectsDir = elsewhere;
  try {
    const result = await bookDelete.deleteBook('Refused Book');
    assert.strictEqual(result.success, false);
    assert.ok(result.error && result.error.length > 0, 'no sentence came back');
    assert.strictEqual(inProjects(book.bookDir), true, 'the book was deleted although Foundry refused');
    assert.strictEqual(fs.existsSync(path.join(elsewhere, 'refused-book-1234abcd')), true);
    assert.deepStrictEqual(derivation.getDerived('audiobook-transcript-v1', book.m4b, identity), { ok: true },
      'a refused delete forgot the cache');
  } finally {
    foundryProjectsDir = path.join(foundryRoot, 'projects');
  }
});

test('a book with no Foundry project is deleted without asking Foundry', async () => {
  const book = makeBook('Plain Book', null);
  foundryCalls = [];
  assert.deepStrictEqual(await bookDelete.describeBookDelete('Plain Book'), { foundryDir: null });
  const result = await bookDelete.deleteBook('Plain Book');
  assert.strictEqual(result.success, true, result.error);
  assert.deepStrictEqual(foundryCalls, []);
  assert.strictEqual(inProjects(book.bookDir), false);
});

test('a Foundry project that is already gone does not stop the book delete', async () => {
  const book = makeBook('Half Gone', 'half-gone-9999abcd');
  fs.rmSync(book.foundryDir, { recursive: true, force: true });
  foundryCalls = [];
  assert.deepStrictEqual(await bookDelete.describeBookDelete('Half Gone'), { foundryDir: null });
  const result = await bookDelete.deleteBook('Half Gone');
  assert.strictEqual(result.success, true, result.error);
  assert.deepStrictEqual(foundryCalls, []);
  assert.strictEqual(inProjects(book.bookDir), false);
});

test('a manifest that will not read is refused by name, and nothing is deleted', async () => {
  const book = makeBook('Broken Record', 'broken-record-5555abcd');
  fs.writeFileSync(path.join(book.bookDir, 'manifest.json'), '{ not json');
  const result = await bookDelete.deleteBook('Broken Record');
  assert.strictEqual(result.success, false);
  assert.ok(/could not be read/.test(result.error), result.error);
  assert.strictEqual(inProjects(book.bookDir), true);
  assert.strictEqual(fs.existsSync(book.foundryDir), true);
});

test('both deletes come here, and nothing else discards a book', () => {
  const main = read('electron/main.ts');
  assert.ok(/ipcMain\.handle\('manifest:delete', async \(_event, projectId: string\) => \{\n\s*return deleteBook\(projectId\);/.test(main),
    'manifest:delete no longer calls deleteBook');
  assert.ok(main.includes('deleteFoundryProject: (dir) => foundryMount.deleteProjectFolder(dir),'),
    'main no longer hands book-delete Foundry\'s own door');
  assert.ok(read('electron/bookshelf-server.ts').includes('const result = await deleteBook(projectId);'),
    'the Bookshelf delete no longer comes through deleteBook');
  assert.ok(read('foundry-app/electron/mount.ts').includes("export { deleteProjectFolder } from '@owen/foundry-core/node/doors-delete';"),
    'the mount no longer exposes Foundry\'s project delete');
  const callers = [];
  for (const dir of ['electron', 'src']) {
    const walk = (d) => {
      for (const entry of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
        const rel = path.join(d, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
        if (!/\.ts$/.test(entry.name) || rel.endsWith('book-delete.ts') || rel.endsWith('manifest-service.ts')) continue;
        const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
        if (/manifestService\.deleteProject\(|\bdeleteProject\(projectId\)/.test(text)) callers.push(rel);
      }
    };
    walk(dir);
  }
  assert.deepStrictEqual(callers.filter(c => !c.includes('web-fetch-bridge')), [],
    'something discards a book without its Foundry project');
  assert.ok(read('src/app/features/studio/studio.component.ts').includes('this.studioService.describeDelete(id)'),
    'the confirmation no longer names the Foundry folder');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok    ${name}`); } catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  await derivation.flushDerivationCache();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed === 0 ? '\nbook delete: all checks passed' : `\nbook delete: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
