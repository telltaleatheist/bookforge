#!/usr/bin/env node
/**
 * Tests for the editor-state SIDECAR — where the picker's working state lives,
 * and which copy is real while a library is half-migrated.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-editor-state-store.js
 *
 * What is asserted here is the part that decides whether a book's editing work
 * can be lost:
 *
 *   (a) PRECEDENCE — while manifest.json still carries `editor`, that copy is
 *       authoritative and the sidecar beside it is ignored and overwritten. Once
 *       the key is gone, the sidecar is the sole authority. The two are NEVER
 *       merged.
 *   (b) MIGRATION — the move is byte-faithful, compact, leaves the manifest
 *       without the key and with everything else (including untyped sub-fields)
 *       intact, does not restamp `modifiedAt`, and is idempotent.
 *   (c) THE WRITE PATHS — no manifest write can put the key back, and no
 *       manifest write can DROP an unmigrated project's state on the floor.
 *   (d) THE SWEEP — a whole library at once, with a malformed project skipped
 *       and left exactly as it was rather than aborting the rest.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'editor-state-store.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const store = require(path.join(DIST, 'editor-state-store.js'));
const manifestService = require(path.join(DIST, 'manifest-service.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── A throwaway library, so the manifest service's own paths resolve ────────
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-editor-state-'));
fs.mkdirSync(path.join(LIB, 'projects'), { recursive: true });
manifestService.setLibraryBasePath(LIB);
const PROJECTS = path.join(LIB, 'projects');

/** A project directory holding exactly the manifest it is given. */
function project(id, manifest) {
  const dir = path.join(PROJECTS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      version: 2,
      projectId: id,
      projectType: 'book',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      source: { type: 'pdf', originalFilename: `${id}.pdf` },
      metadata: { title: id, author: 'Nobody', language: 'en' },
      chapters: [],
      pipeline: {},
      outputs: {},
      ...manifest,
    }, null, 2),
  );
  return dir;
}

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
const sidecarPath = (dir) => path.join(dir, 'editor-state.json');
const hasSidecar = (dir) => fs.existsSync(sidecarPath(dir));

/**
 * The shape a real bloated manifest carries — including a sub-field NO manifest
 * declaration admits, because dropping those is precisely what a typed
 * round-trip would do and what the raw read/write exists to prevent.
 */
const records = () => ({
  undoStack: [{ type: 'delete', ids: ['1e1e93ec0a08'], timestamp: 't' }],
  redoStack: [],
  ocrBlocks: [{ id: 'b-1', page: 4, x: 1, y: 2, text: 'Chapter One' }],
  categoryCorrections: [['9b4c3543d1dd', 'body']],
  ocrCategories: { title: { id: 'title', name: 'Titles' } },
  sourceFileSha256: 'deadbeef',
  aFieldNoTypeAdmits: { and: ['nested', 'values'] },
});

// ── (a) Precedence ─────────────────────────────────────────────────────────

test('(a) while the manifest holds the key, THAT copy is what is read', async () => {
  const dir = project('precedence-manifest-wins', { editor: records() });
  // A sidecar from a crashed earlier attempt, holding something else entirely.
  store.writeEditorStateSync(dir, { undoStack: [{ type: 'stale' }] });

  assert.deepStrictEqual(store.peekEditorStateSync(dir), records(),
    'the manifest key must outrank a sidecar beside it');
  assert.deepStrictEqual(await store.peekEditorState(dir), records());

  // And reading it for real re-migrates: the stale sidecar is OVERWRITTEN, not
  // merged into — a merge would resurrect an undo stack the user never had.
  assert.deepStrictEqual(await store.readEditorState(dir), records());
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(sidecarPath(dir), 'utf-8')), records());
});

test('(a) once the key is gone, the sidecar is the sole authority', async () => {
  const dir = project('precedence-sidecar-wins', {});
  await store.writeEditorState(dir, records());
  assert.deepStrictEqual(await store.readEditorState(dir), records());
  assert.strictEqual(readManifest(dir).editor, undefined);
});

test('(a) a project with neither file has NO editor state, which is an answer', async () => {
  const dir = project('precedence-nothing', {});
  assert.strictEqual(await store.readEditorState(dir), null);
  assert.strictEqual(store.peekEditorStateSync(dir), null);
  assert.strictEqual(hasSidecar(dir), false, 'reading must not mint an empty sidecar');
});

test('(a) peeking NEVER writes — a project inspected is byte-identical after', async () => {
  const dir = project('peek-is-read-only', { editor: records() });
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');
  await store.peekEditorState(dir);
  store.peekEditorStateSync(dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'), before);
  assert.strictEqual(hasSidecar(dir), false);
});

// ── (b) Migration ──────────────────────────────────────────────────────────

test('(b) the move is byte-faithful and takes the key off the manifest', async () => {
  const dir = project('migrate-faithful', {
    editor: records(),
    tags: ['keep', 'me'],
  });
  const before = readManifest(dir);

  assert.strictEqual(await store.migrateEditorState(dir), true);

  const after = readManifest(dir);
  assert.strictEqual(after.editor, undefined, 'the key must be gone from the manifest');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(sidecarPath(dir), 'utf-8')), records(),
    'every field, including the one no type admits, must survive the round-trip');
  // Everything else about the project is untouched, key for key.
  delete before.editor;
  assert.deepStrictEqual(after, before, 'the migration must change nothing but the key');
});

test('(b) the sidecar is written COMPACT', async () => {
  const dir = project('migrate-compact', { editor: records() });
  await store.migrateEditorState(dir);
  const raw = fs.readFileSync(sidecarPath(dir), 'utf-8');
  assert.strictEqual(raw.includes('\n'), false, 'no pretty-printing: this file is machine-read');
  assert.strictEqual(raw, JSON.stringify(records()));
});

test('(b) `modifiedAt` is NOT restamped — the shelf must not reorder itself', async () => {
  const dir = project('migrate-no-touch-modified', { editor: records() });
  const before = readManifest(dir).modifiedAt;
  await store.migrateEditorState(dir);
  assert.strictEqual(readManifest(dir).modifiedAt, before);
});

test('(b) a second migration is a no-op', async () => {
  const dir = project('migrate-idempotent', { editor: records() });
  assert.strictEqual(await store.migrateEditorState(dir), true);
  const manifestAfterFirst = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');
  const sidecarAfterFirst = fs.readFileSync(sidecarPath(dir), 'utf-8');

  assert.strictEqual(await store.migrateEditorState(dir), false,
    'nothing was left to migrate, and it must say so');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'), manifestAfterFirst);
  assert.strictEqual(fs.readFileSync(sidecarPath(dir), 'utf-8'), sidecarAfterFirst);
});

test('(b) an EMPTY `editor` key still migrates — the key is what makes it authoritative',
  async () => {
    const dir = project('migrate-empty-key', { editor: {} });
    assert.strictEqual(await store.migrateEditorState(dir), true);
    assert.strictEqual(readManifest(dir).editor, undefined);
    assert.deepStrictEqual(await store.readEditorState(dir), {});
  });

test('(b) a malformed manifest THROWS and is left exactly as it is', async () => {
  const dir = path.join(PROJECTS, 'migrate-malformed');
  fs.mkdirSync(dir, { recursive: true });
  const broken = '{ "version": 2, "editor": { "undoStack": [';
  fs.writeFileSync(path.join(dir, 'manifest.json'), broken);

  await assert.rejects(() => store.migrateEditorState(dir));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'), broken,
    'a manifest that could not be read must never be overwritten with a guess');
  assert.strictEqual(hasSidecar(dir), false);
});

test('(b) a malformed SIDECAR throws by name rather than reading as "no state"', () => {
  const dir = project('sidecar-malformed', {});
  fs.writeFileSync(sidecarPath(dir), '{ "undoStack": [');
  assert.throws(() => store.peekEditorStateSync(dir), /editor-state\.json is not readable as JSON/);
});

test('(b) a directory that is not a project migrates nothing and complains about nothing',
  async () => {
    const dir = path.join(PROJECTS, 'not-a-project');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(await store.migrateEditorState(dir), false);
  });

// ── (c) The manifest write paths ───────────────────────────────────────────

test('(c) an unrelated manifest write MIGRATES the state instead of dropping it', async () => {
  const dir = project('write-path-preserves', { editor: records() });
  // Anything at all that rewrites the manifest — here, a tag change.
  const saved = await manifestService.updateManifest({
    projectId: 'write-path-preserves', metadata: { title: 'Renamed' },
  });
  assert.strictEqual(saved.success, true, saved.error);

  assert.strictEqual(readManifest(dir).editor, undefined, 'the key must not survive the write');
  assert.deepStrictEqual(await store.readEditorState(dir), records(),
    'and an evening of editing must not be dropped by a metadata edit');
  assert.strictEqual(readManifest(dir).metadata.title, 'Renamed');
});

test('(c) a stale manifest handed to saveManifest cannot put the key back', async () => {
  const dir = project('write-path-strips', {});
  await store.writeEditorState(dir, records());

  const stale = readManifest(dir);
  stale.editor = { undoStack: [{ type: 'from-a-stale-renderer' }] };
  const saved = await manifestService.saveManifest(stale);
  assert.strictEqual(saved.success, true, saved.error);

  assert.strictEqual(readManifest(dir).editor, undefined,
    'a renderer holding a pre-migration manifest must not re-bloat the file');
  assert.deepStrictEqual(await store.readEditorState(dir), records(),
    'and it must not overwrite the authoritative sidecar either');
});

test('(c) an editor update merges into the sidecar and leaves the manifest alone', async () => {
  const dir = project('write-path-update', {});
  await store.writeEditorState(dir, { deletedSelectors: ['.ad'], undoStack: [] });

  const saved = await manifestService.updateManifest({
    projectId: 'write-path-update',
    editor: { deletedSelectors: ['.ad', '.promo'] },
  });
  assert.strictEqual(saved.success, true, saved.error);

  assert.deepStrictEqual(await store.readEditorState(dir),
    { deletedSelectors: ['.ad', '.promo'], undoStack: [] },
    'a partial update layers over what is stored, exactly as it did in the manifest');
  assert.strictEqual(readManifest(dir).editor, undefined);
});

test('(c) deleting the state is not an error when there is none', async () => {
  const dir = project('delete-absent', {});
  await store.deleteEditorState(dir);
  await store.deleteEditorState(dir);
  assert.strictEqual(hasSidecar(dir), false);
});

// ── (d) The sweep ──────────────────────────────────────────────────────────

test('(d) one sweep migrates the whole library and reports what it did', async () => {
  const sweepLib = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-editor-sweep-'));
  const dirs = path.join(sweepLib, 'projects');
  fs.mkdirSync(dirs, { recursive: true });

  const made = [];
  for (let i = 0; i < 12; i++) {
    const dir = path.join(dirs, `book-${i}`);
    fs.mkdirSync(dir);
    // Two thirds carry editor state; the rest are already clean.
    const manifest = i % 3 === 0
      ? { version: 2, projectId: `book-${i}` }
      : { version: 2, projectId: `book-${i}`, editor: records() };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    made.push(dir);
  }
  // A project whose manifest cannot be parsed at all.
  const brokenDir = path.join(dirs, 'broken');
  fs.mkdirSync(brokenDir);
  const broken = '{ "editor": {';
  fs.writeFileSync(path.join(brokenDir, 'manifest.json'), broken);
  // And a stray directory that is not a project.
  fs.mkdirSync(path.join(dirs, 'scratch'));

  const result = await store.sweepEditorState(dirs, 4);
  assert.strictEqual(result.scanned, 14);
  assert.strictEqual(result.migrated, 8, 'eight of the twelve books carried editor state');
  assert.strictEqual(result.failed, 1);

  for (const dir of made) {
    assert.strictEqual(readManifest(dir).editor, undefined, `${dir} still holds the key`);
  }
  assert.strictEqual(fs.readFileSync(path.join(brokenDir, 'manifest.json'), 'utf-8'), broken,
    'the unreadable project must be left exactly as it was');
  assert.strictEqual(fs.existsSync(path.join(brokenDir, 'editor-state.json')), false);

  fs.rmSync(sweepLib, { recursive: true, force: true });
});

test('(d) a library that does not exist yet is not a failure', async () => {
  const result = await store.sweepEditorState(path.join(os.tmpdir(), 'bf-no-such-library-xyz'));
  assert.deepStrictEqual(result, { scanned: 0, migrated: 0, failed: 0 });
});

// ── run ────────────────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push({ name, err });
    }
  }
  for (const { name, err } of failures) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
  console.log(`\n${passed}/${tests.length} passed`);
  fs.rmSync(LIB, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
})();
