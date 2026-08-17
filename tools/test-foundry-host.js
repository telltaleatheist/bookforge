#!/usr/bin/env node
/**
 * Tests for the hosted Foundry's manifest record in
 * electron/manifest-service.ts — against a REAL project directory on disk, in a
 * temp library.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-host.js
 *
 * The record is a REFERENCE into `<library>/foundry`, which BookForge does not
 * own the contents of, and it is worded so it survives the library moving to
 * another drive. That is what these tests pin:
 *
 *  - `setFoundryProject` stores a KEY. A path — absolute or nested — is refused
 *    by name rather than trimmed into one, because a stored path names a volume
 *    and every one of them is wrong after a move. It also stores WHICH VERSION
 *    was imported, which is the parent every export from that project nests
 *    under, and it stores `null` as an absent field rather than a hole.
 *
 * The EXPORT LIST that stood beside it (`appendFoundryExport`,
 * `forgetFoundryExport`, `readFoundryExports`) was retired on 2026-08-17 and
 * deleted in the wave after it — an export lands as a version now, see
 * test-foundry-landing.js — so its tests went with it rather than going on
 * pinning code nothing can call.
 *
 * And the legacy rule that bounds all of it: a project carrying no key answers
 * "no project" — a real state, never a refusal.
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

// ── The project mapping ─────────────────────────────────────────────────────

test('a project with no mapping has no Foundry project — null, not a refusal', run(async (p) => {
  assert.strictEqual(await manifestService.readFoundryProject(p.projectDir), null);
}));

test('the mapping round-trips as a KEY, with no source version', run(async (p) => {
  await manifestService.setFoundryProject(p.projectDir, 'test-book', null);
  assert.strictEqual(await manifestService.readFoundryProject(p.projectDir), 'test-book');
  assert.deepStrictEqual(p.read().foundryProject, { dir: 'test-book' },
    'a null source version is an ABSENT field, not a stored null');
}));

test('the mapping remembers WHICH version was imported', run(async (p) => {
  await manifestService.setFoundryProject(p.projectDir, 'test-book', 'var-1');
  const ref = await manifestService.readFoundryProjectRef(p.projectDir);
  assert.deepStrictEqual(ref, { dir: 'test-book', sourceVariantId: 'var-1' });
}));

test('re-importing from a different version REPLACES the source, never merges', run(async (p) => {
  await manifestService.setFoundryProject(p.projectDir, 'test-book', 'var-1');
  await manifestService.setFoundryProject(p.projectDir, 'test-book', 'var-2');
  const ref = await manifestService.readFoundryProjectRef(p.projectDir);
  assert.strictEqual(ref.sourceVariantId, 'var-2');
  // The whole point: a stale parent would nest tomorrow's exports under a
  // version they did not come from.
  await manifestService.setFoundryProject(p.projectDir, 'test-book', null);
  const cleared = await manifestService.readFoundryProjectRef(p.projectDir);
  assert.strictEqual(cleared.sourceVariantId, undefined,
    'a re-import that names no version of ours erases the old source');
}));

test('a project with no mapping has no ref at all', run(async (p) => {
  assert.strictEqual(await manifestService.readFoundryProjectRef(p.projectDir), null);
}));

test('an absolute path is refused by name and nothing is written', run(async (p) => {
  await assert.rejects(
    () => manifestService.setFoundryProject(p.projectDir, path.join(p.library, 'foundry', 'projects', 'x'), null),
    /not a Foundry project key/);
  assert.strictEqual(p.read().foundryProject, undefined);
}));

test('a nested path is refused too — a key is one folder name', run(async (p) => {
  await assert.rejects(
    () => manifestService.setFoundryProject(p.projectDir, 'projects/test-book', null),
    /not a Foundry project key/);
}));

test('an empty key is refused', run(async (p) => {
  await assert.rejects(() => manifestService.setFoundryProject(p.projectDir, '   ', null), /no project key/);
}));

// ── Legacy safety ───────────────────────────────────────────────────────────

test('the record is not written to a project that never asked for one', run(async (p) => {
  await manifestService.readFoundryProject(p.projectDir);
  await manifestService.readFoundryProjectRef(p.projectDir);
  assert.strictEqual(p.read().foundryProject, undefined, 'reading must not mint a mapping');
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
