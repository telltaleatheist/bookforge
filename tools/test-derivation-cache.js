#!/usr/bin/env node
/**
 * The derivation-cache keeper: a fact is remembered, and forgotten the instant
 * the file it was derived from stops being the same file.
 *
 *   node tools/test-derivation-cache.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `electron/derivation-cache.ts` is what stops a book's Versions page hashing
 * every multi-gigabyte audiobook on every visit (measured 2026-08-17 on the real
 * library: 4.0-9.6 s a page, of which 3.7-8.3 s was one SHA-256). Everything it
 * is worth rests on one property — it never hands back a fact about bytes that
 * are no longer there. A cache that answers slightly wrong is worse than no
 * cache at all: it would draw a Generate sentences button over a transcript that
 * IS in the file, or hide one that is not.
 *
 * So the three things checked here are the three ways it could be wrong:
 *
 *   1. A HIT is only a hit when mtime AND size both still match. Either one
 *      moving is a miss, and a miss means the caller re-derives.
 *   2. The store SURVIVES a restart (it is written to disk and read back), and
 *      survives being corrupted — a store that will not parse is said out loud
 *      and started over, never partially believed.
 *   3. Two namespaces over one file cannot read each other's answers, and
 *      Windows' two spellings of one path are one entry.
 *
 * ── Fixtures ────────────────────────────────────────────────────────────────
 *
 * Real files in a temp directory, stat'd for real. Nothing is mocked: the whole
 * question is what `fs.stat` says about a file that has been touched, and a fake
 * stat would be a test of the fake.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'derivation-cache.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
// The module reaches for `app.getPath('userData')` when nobody has told it where
// to keep its store. This test always tells it, but the require itself pulls in
// `electron`, so the CLI's stub goes in first — the arrangement every other tool
// here runs under.
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dc-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const cache = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-derivation-cache-'));
let storeSeq = 0;

/** A fresh store, so one test's entries are never another's. */
function freshStore() {
  const store = path.join(TMP, `store-${++storeSeq}.json`);
  cache.setDerivationCachePath(store);
  return store;
}

/** A fixture file with known bytes. */
function fixture(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/**
 * Move a file's mtime forward by a whole second.
 *
 * A whole second, not a millisecond: this is the granularity a real rewrite
 * moves it by, and a sub-millisecond nudge would be testing something finer than
 * the cache claims to catch (see the module header, which says so).
 */
function touchLater(filePath) {
  const stat = fs.statSync(filePath);
  const later = new Date(stat.mtimeMs + 1000);
  fs.utimesSync(filePath, later, later);
}

// ── 1. A hit is a hit only while the bytes are the same ─────────────────────

test('a fact put against a file comes back for that same file', async () => {
  freshStore();
  const file = fixture('same.txt', 'hello');
  const id = await cache.readFileIdentity(file);
  cache.putDerived('ns', file, id, { eligible: true, cueCount: 42 });
  const got = cache.getDerived('ns', file, await cache.readFileIdentity(file));
  assert.deepStrictEqual(got, { eligible: true, cueCount: 42 },
    'the fact just stored was not handed back for an untouched file');
});

test('a file with nothing stored about it is a miss, not an empty answer', async () => {
  freshStore();
  const file = fixture('unknown.txt', 'hello');
  const got = cache.getDerived('ns', file, await cache.readFileIdentity(file));
  assert.strictEqual(got, null,
    'a file never derived from must miss — an answer here would be invented');
});

test('a changed MTIME (same size) is a miss', async () => {
  freshStore();
  const file = fixture('mtime.txt', 'hello');
  cache.putDerived('ns', file, await cache.readFileIdentity(file), { eligible: true });
  touchLater(file);
  const after = await cache.readFileIdentity(file);
  assert.strictEqual(fs.statSync(file).size, 5, 'the fixture changed size — wrong thing tested');
  assert.strictEqual(cache.getDerived('ns', file, after), null,
    'a file whose mtime moved still answered from the cache');
});

test('a changed SIZE (same mtime) is a miss', async () => {
  freshStore();
  const file = fixture('size.txt', 'hello');
  // Both writes are pinned to the SAME whole-second mtime, so the only thing
  // that differs between them is length. This is the one case a size-blind
  // cache would get wrong, and the reason size is in the key. Pinned before
  // the fact is stored as well as after, because `utimes` truncates the
  // sub-millisecond part and a fact stored against the untruncated mtime would
  // miss on mtime instead — which would pass this test for the wrong reason.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(file, pinned, pinned);
  const before = await cache.readFileIdentity(file);
  cache.putDerived('ns', file, before, { eligible: true });

  fs.writeFileSync(file, 'hello world', 'utf-8');
  fs.utimesSync(file, pinned, pinned);
  const after = await cache.readFileIdentity(file);
  assert.strictEqual(after.mtimeMs, before.mtimeMs, 'the mtime did not pin — wrong thing tested');
  assert.notStrictEqual(after.size, before.size, 'the file did not change size');
  assert.strictEqual(cache.getDerived('ns', file, after), null,
    'a file that changed size still answered from the cache');
});

test('a file that is gone has no identity, so nothing can be asked of it', async () => {
  freshStore();
  const file = fixture('gone.txt', 'hello');
  cache.putDerived('ns', file, await cache.readFileIdentity(file), { eligible: true });
  fs.unlinkSync(file);
  assert.strictEqual(await cache.readFileIdentity(file), null,
    'a deleted file still reported an identity');
});

test('a directory is not a file and has no identity', async () => {
  freshStore();
  assert.strictEqual(await cache.readFileIdentity(TMP), null,
    'a directory was given a file identity, which would key a fact to a folder');
});

test('forgetting a fact makes the next read a miss', async () => {
  freshStore();
  const file = fixture('forget.txt', 'hello');
  const id = await cache.readFileIdentity(file);
  cache.putDerived('ns', file, id, { eligible: true });
  cache.forgetDerived('ns', file);
  assert.strictEqual(cache.getDerived('ns', file, id), null,
    'a forgotten fact was still remembered');
});

// ── 2. The store survives a restart, and survives being broken ──────────────

test('a flushed store is read back by the next session', async () => {
  const store = freshStore();
  const file = fixture('persist.txt', 'hello');
  const id = await cache.readFileIdentity(file);
  cache.putDerived('ns', file, id, { eligible: true, cueCount: 7 });
  await cache.flushDerivationCache();
  assert.ok(fs.existsSync(store), 'the store was never written to disk');

  // A restart, as far as this module is concerned: drop everything in memory and
  // point it back at the same file.
  cache.setDerivationCachePath(null);
  cache.setDerivationCachePath(store);
  assert.deepStrictEqual(
    cache.getDerived('ns', file, await cache.readFileIdentity(file)),
    { eligible: true, cueCount: 7 },
    'the fact did not survive a restart, so every page pays full price again');
});

test('a flushed store does NOT resurrect a fact whose file has since changed', async () => {
  const store = freshStore();
  const file = fixture('persist-stale.txt', 'hello');
  cache.putDerived('ns', file, await cache.readFileIdentity(file), { eligible: true });
  await cache.flushDerivationCache();
  touchLater(file);
  cache.setDerivationCachePath(null);
  cache.setDerivationCachePath(store);
  assert.strictEqual(cache.getDerived('ns', file, await cache.readFileIdentity(file)), null,
    'a restart brought back a fact about bytes that had moved on');
});

test('a corrupt store is started over rather than half-believed', async () => {
  const store = freshStore();
  const file = fixture('corrupt.txt', 'hello');
  cache.putDerived('ns', file, await cache.readFileIdentity(file), { eligible: true });
  await cache.flushDerivationCache();
  fs.writeFileSync(store, '{"version":1,"entries":{ this is not json', 'utf-8');
  cache.setDerivationCachePath(null);
  cache.setDerivationCachePath(store);
  assert.strictEqual(cache.getDerived('ns', file, await cache.readFileIdentity(file)), null,
    'a fact was read out of a store that does not parse');
  // And it must still be usable afterwards — a corrupt store costs one slow
  // page, not the cache for the rest of the session.
  const id = await cache.readFileIdentity(file);
  cache.putDerived('ns', file, id, { eligible: false });
  assert.deepStrictEqual(cache.getDerived('ns', file, id), { eligible: false },
    'the cache stopped working after recovering from a corrupt store');
});

test('a store written by another version is started over', async () => {
  const store = freshStore();
  fs.writeFileSync(store, JSON.stringify({ version: 99, entries: { 'ns x': {} } }), 'utf-8');
  cache.setDerivationCachePath(null);
  cache.setDerivationCachePath(store);
  const file = fixture('versioned.txt', 'hello');
  assert.strictEqual(cache.getDerived('ns', file, await cache.readFileIdentity(file)), null,
    'entries from a store this build cannot read were believed anyway');
});

test('an absent store is the ordinary first run, not a failure', async () => {
  cache.setDerivationCachePath(path.join(TMP, 'never-written', 'store.json'));
  const file = fixture('firstrun.txt', 'hello');
  const id = await cache.readFileIdentity(file);
  assert.strictEqual(cache.getDerived('ns', file, id), null);
  cache.putDerived('ns', file, id, { eligible: true });
  await cache.flushDerivationCache();
  assert.deepStrictEqual(cache.getDerived('ns', file, id), { eligible: true },
    'the cache could not be used before its store directory existed');
});

// ── 3. One file, two questions; one file, two spellings ─────────────────────

test('two namespaces over one file do not read each other', async () => {
  freshStore();
  const file = fixture('two-ns.txt', 'hello');
  const id = await cache.readFileIdentity(file);
  cache.putDerived('transcript', file, id, { eligible: true });
  assert.strictEqual(cache.getDerived('report', file, id), null,
    'one derivation read another derivation\'s answer about the same file');
  cache.putDerived('report', file, id, { status: 'valid' });
  assert.deepStrictEqual(cache.getDerived('transcript', file, id), { eligible: true },
    'storing the second fact overwrote the first');
});

test('two spellings of one path are one entry', async () => {
  freshStore();
  const file = fixture('CasedName.txt', 'hello');
  const id = await cache.readFileIdentity(file);
  cache.putDerived('ns', file, id, { eligible: true });
  const other = path.join(path.dirname(file), 'casedname.txt');
  assert.deepStrictEqual(cache.getDerived('ns', other, id), { eligible: true },
    'the same file under a different case was a different entry, so one of the two '
    + 'would always be stale');
});

(async () => {
  try {
    for (const { name, fn } of tests) {
      try { await fn(); passed++; }
      catch (err) { failures.push({ name, err }); }
    }
  } finally {
    cache.setDerivationCachePath(null);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\nderivation cache: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
