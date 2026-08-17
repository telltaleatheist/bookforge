#!/usr/bin/env node
/**
 * The bookshelf-identity keeper: the id grammar, the alias map, and the
 * migration that rekeys a library's stores.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-bookshelf-ids.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * A Bookshelf book's durable data — where the reader stopped, what they have
 * heard, their bookmarks, their listening time — used to be filed under the
 * book's FILE PATH. Moving the file renamed the book. This suite guards the
 * replacement, and every case in it is a way a reader loses their place:
 *
 *   THE GRAMMAR      v:<projectId>/<variantId>, parsed on the FIRST slash so a
 *                    variant id is free to hold ':' and '/'. A parser that
 *                    split differently would mis-file every bilingual book.
 *   BOTH FORMS       a phone that has been offline for a month holds path-form
 *                    ids. If the alias map ever stops resolving them, that
 *                    reader's queue lands on books that do not exist.
 *   THE MERGE        two old folders fold into one. If the fold ever
 *                    overwrites instead of merging, "Add to archive" costs the
 *                    reader whichever half loses.
 *   DRY RUN          the default. If it ever writes, the report stops being
 *                    something you can read BEFORE deciding.
 *   IDEMPOTENCE      a second --apply must be a no-op. If it is not, running
 *                    it twice re-folds records and churns timestamps.
 *   NOTHING DROPPED  an id nothing can place is kept where it is and named in
 *                    the report. Guessing files a position under the wrong
 *                    book; deleting loses it.
 *
 * The fixture is a real library — projects with manifests, an m4b that has been
 * MOVED from output/ to archive/, a bilingual variant, and all five store types
 * with data in them — because the whole point of the change is what happens to
 * a book whose file moved, and that cannot be tested against a mock.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'bookshelf-id-migration.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ids-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));

const identity = require(path.join(DIST, 'bookshelf-identity.js'));
const { migrateBookshelfIds } = require(path.join(DIST, 'bookshelf-id-migration.js'));
const { setLibraryBasePath } = require(path.join(DIST, 'manifest-service.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e && e.message ? e.message : e}`);
  }
}

const READER = 'reader-1';
const DEVICE = 'pc-aaa';

// ─────────────────────────────────────────────────────────────────────────────
// The fixture library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two projects:
 *   mistborn  — its audiobook variant now points at archive/, but the stores
 *               were written when it lived in output/. THE bug, in a fixture.
 *   bilingual — an 'audiobook' variant plus a 'bilingual:en-de' one, so the
 *               grammar is exercised on an id that contains a colon.
 * Plus one store entry naming a project that does not exist, which must survive
 * the migration untouched.
 */
function buildLibrary() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-lib-'));
  const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf-8'); };

  const mistbornDir = path.join(lib, 'projects', 'mistborn');
  write(path.join(mistbornDir, 'archive', 'The Final Empire.m4b'), 'audio');
  write(path.join(mistbornDir, 'manifest.json'), JSON.stringify({
    projectId: 'mistborn',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { title: 'The Final Empire', author: 'Sanderson, Brandon' },
    // The variant row followed the file into archive/ — which is exactly what
    // makes the composite (project, variant) stable and the path not.
    variants: [{
      id: 'audiobook', kind: 'audiobook', format: 'm4b',
      path: 'archive/The Final Empire.m4b', addedAt: '2026-01-01T00:00:00.000Z',
    }],
  }, null, 2));

  const bilingualDir = path.join(lib, 'projects', 'zwei');
  write(path.join(bilingualDir, 'output', 'Zwei.m4b'), 'audio');
  write(path.join(bilingualDir, 'output', 'Zwei.de.m4b'), 'audio');
  write(path.join(bilingualDir, 'manifest.json'), JSON.stringify({
    projectId: 'zwei',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { title: 'Zwei', author: 'Anon' },
    outputs: {
      audiobook: { path: 'output/Zwei.m4b', completedAt: '2026-01-02T00:00:00.000Z' },
      bilingualAudiobooks: { 'en-de': { path: 'output/Zwei.de.m4b', completedAt: '2026-01-02T00:00:00.000Z' } },
    },
  }, null, 2));

  return lib;
}

const OLD_OUTPUT_KEY = 'a:projects/mistborn/output/The Final Empire.m4b';
const OLD_ARCHIVE_KEY = 'a:projects/mistborn/archive/The Final Empire.m4b';
const OLD_BILINGUAL_KEY = 'a:projects/zwei/output/Zwei.de.m4b';
const GHOST_KEY = 'a:projects/gone-forever/output/Nothing.m4b';

const NEW_MISTBORN = 'v:mistborn/audiobook';
const NEW_BILINGUAL = 'v:zwei/bilingual:en-de';

/** All five store types, with the mistborn book split across two path ids —
 *  half its history under output/, half under archive/. */
function seedStores(lib) {
  const bs = path.join(lib, '.bookshelf');
  const bookFile = (key) => path.join(bs, 'books', identity.bookIdFromKey(key), `${DEVICE}.json`);
  const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf-8'); };

  // books/: the pre-move half (a position and some coverage) …
  write(bookFile(OLD_OUTPUT_KEY), JSON.stringify({
    [READER]: {
      position: { kind: 'audio', value: 1200, at: '2026-02-01T00:00:00.000Z' },
      heard: { intervals: [[0, 1200]], at: '2026-02-01T00:00:00.000Z' },
      bookmarks: [{ op: 'add', bm: { id: 'bm-old', time: 300 }, at: '2026-02-01T00:00:00.000Z' }],
    },
  }));
  // … and the post-move half, which is the orphan this whole change is about.
  write(bookFile(OLD_ARCHIVE_KEY), JSON.stringify({
    [READER]: {
      position: { kind: 'audio', value: 4000, at: '2026-03-01T00:00:00.000Z' },
      heard: { intervals: [[3000, 4000]], at: '2026-03-01T00:00:00.000Z' },
      bookmarks: [{ op: 'add', bm: { id: 'bm-new', time: 3500 }, at: '2026-03-01T00:00:00.000Z' }],
    },
  }));
  // An id naming a project that no longer exists — must be left exactly as-is.
  write(bookFile(GHOST_KEY), JSON.stringify({
    [READER]: { position: { kind: 'audio', value: 7, at: '2026-01-01T00:00:00.000Z' } },
  }));

  // positions/ and heard/ (the pre-consolidation stores)
  write(path.join(bs, 'positions', `${DEVICE}.json`), JSON.stringify({
    [READER]: { [OLD_BILINGUAL_KEY]: { kind: 'audio', value: 55, at: '2026-02-02T00:00:00.000Z' } },
  }));
  write(path.join(bs, 'heard', `${DEVICE}.json`), JSON.stringify({
    [READER]: { [OLD_BILINGUAL_KEY]: { intervals: [[0, 55]], at: '2026-02-02T00:00:00.000Z' } },
  }));

  // bookmarks/ (jsonl, `key`)
  write(path.join(bs, 'bookmarks', `${DEVICE}.jsonl`),
    JSON.stringify({ readerId: READER, key: OLD_BILINGUAL_KEY, op: 'add', bm: { id: 'bm-z' }, at: '2026-02-02T00:00:00.000Z' }) + '\n');

  // events/ (jsonl, `bookKey` — a BARE library-relative path, no `a:` prefix)
  write(path.join(bs, 'events', `${DEVICE}.jsonl`),
    JSON.stringify({ readerId: READER, bookKey: 'projects/mistborn/output/The Final Empire.m4b', title: 'The Final Empire', author: 'S', day: '2026-02-01', seconds: 900, at: '2026-02-01T00:00:00.000Z' }) + '\n'
    + JSON.stringify({ readerId: READER, bookKey: 'projects/mistborn/archive/The Final Empire.m4b', title: 'The Final Empire', author: 'S', day: '2026-03-01', seconds: 600, at: '2026-03-01T00:00:00.000Z' }) + '\n');

  return bs;
}

/** Everything under a directory as path → content, for byte-identity checks. */
function snapshot(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, rel);
      else out[rel] = fs.readFileSync(p, 'utf-8');
    }
  };
  walk(dir, '');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The grammar
// ─────────────────────────────────────────────────────────────────────────────

check('a variant key round-trips through its parser', () => {
  const k = identity.variantKey('mistborn', 'audiobook');
  assert.strictEqual(k, 'v:mistborn/audiobook');
  assert.deepStrictEqual(identity.parseVariantKey(k), { projectId: 'mistborn', variantId: 'audiobook' });
});

check('a variant id may contain colons and slashes — the split is the FIRST slash', () => {
  assert.deepStrictEqual(identity.parseVariantKey('v:zwei/bilingual:en-de'),
    { projectId: 'zwei', variantId: 'bilingual:en-de' });
  assert.deepStrictEqual(identity.parseVariantKey('v:p/arch:archive/a book.epub'),
    { projectId: 'p', variantId: 'arch:archive/a book.epub' });
});

check('legacy and reader ids are not mistaken for variant keys', () => {
  for (const k of [OLD_OUTPUT_KEY, 'e:__archive__/p/x.epub', 'p:someproject', 'v:', 'v:x/', 'v:/y']) {
    assert.strictEqual(identity.isVariantKey(k), false, `${k} parsed as a variant key`);
  }
});

check('a project id with a slash in it is refused, not silently mangled', () => {
  assert.throws(() => identity.variantKey('a/b', 'audiobook'));
});

check('the on-disk book id round-trips, including non-ASCII', () => {
  const k = 'v:Gött/bilingual:en-de';
  assert.strictEqual(identity.keyFromBookId(identity.bookIdFromKey(k)), k);
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution against a real library
// ─────────────────────────────────────────────────────────────────────────────

const lib = buildLibrary();
setLibraryBasePath(lib);
identity.clearVariantsCache();

check('a moved file still resolves to the same variant', () => {
  assert.deepStrictEqual(identity.anchorForLegacyKey(OLD_ARCHIVE_KEY),
    { projectId: 'mistborn', variantId: 'audiobook' });
});

check('the pre-move path resolves to nothing — that is why the alias map exists', () => {
  // Nothing points at output/ any more, so the OLD key cannot be resolved by
  // looking at the manifest. Only the recorded alias can carry it forward.
  assert.strictEqual(identity.anchorForLegacyKey(OLD_OUTPUT_KEY), null);
});

check('a bilingual output resolves to its own variant', () => {
  assert.deepStrictEqual(identity.anchorForLegacyKey(OLD_BILINGUAL_KEY),
    { projectId: 'zwei', variantId: 'bilingual:en-de' });
});

check('an id for a project that is gone resolves to nothing (and is never guessed)', () => {
  assert.strictEqual(identity.anchorForLegacyKey(GHOST_KEY), null);
  assert.strictEqual(identity.anchorForLegacyKey('e:Uncategorized/loose.epub'), null);
  assert.strictEqual(identity.anchorForLegacyKey('p:mistborn'), null);
});

check("a variant's current path is where the file is NOW", () => {
  const p = identity.currentPathOfAnchor({ projectId: 'mistborn', variantId: 'audiobook' });
  assert.ok(p.endsWith(path.join('archive', 'The Final Empire.m4b')), p);
});

// ─────────────────────────────────────────────────────────────────────────────
// The record merge
// ─────────────────────────────────────────────────────────────────────────────

check('a merge keeps the newest position and unions the coverage', () => {
  const m = identity.mergeBookRecords([
    { position: { kind: 'audio', value: 10, at: '2026-01-01T00:00:00.000Z' }, heard: { intervals: [[0, 10]], at: '2026-01-01T00:00:00.000Z' } },
    { position: { kind: 'audio', value: 99, at: '2026-02-01T00:00:00.000Z' }, heard: { intervals: [[50, 99]], at: '2026-02-01T00:00:00.000Z' } },
  ]);
  assert.strictEqual(m.position.value, 99);
  assert.deepStrictEqual(m.heard.intervals, [[0, 10], [50, 99]]);
});

check('a reset tombstone erases every snapshot older than it, from any device', () => {
  const m = identity.mergeBookRecords([
    { heard: { intervals: [[0, 500]], at: '2026-01-01T00:00:00.000Z' } },
    { heardResetAt: '2026-02-01T00:00:00.000Z', heard: { intervals: [], at: '2026-02-01T00:00:00.000Z' } },
    { heard: { intervals: [[10, 20]], at: '2026-03-01T00:00:00.000Z' } },
  ]);
  assert.deepStrictEqual(m.heard.intervals, [[10, 20]], 'pre-reset coverage came back from the dead');
  assert.strictEqual(m.heardResetAt, '2026-02-01T00:00:00.000Z');
});

check('a merge is stable under re-merging (it is its own fixed point)', () => {
  const parts = [
    { position: { kind: 'audio', value: 10, at: '2026-01-01T00:00:00.000Z' }, heard: { intervals: [[0, 10]], at: '2026-01-01T00:00:00.000Z' } },
    { heard: { intervals: [[5, 30]], at: '2026-02-01T00:00:00.000Z' } },
  ];
  const once = identity.mergeBookRecords(parts);
  assert.deepStrictEqual(identity.mergeBookRecords([once]), once);
});

// ─────────────────────────────────────────────────────────────────────────────
// The migration
// ─────────────────────────────────────────────────────────────────────────────

const bs = seedStores(lib);
const before = snapshot(bs);

const dry = migrateBookshelfIds(lib, { apply: false, today: '2026-08-17' });

check('a dry run leaves the stores byte-identical', () => {
  assert.deepStrictEqual(snapshot(bs), before);
  assert.strictEqual(dry.applied, false);
  assert.strictEqual(dry.backupPath, null);
  assert.ok(!fs.existsSync(`${bs}.bak-2026-08-17`), 'a dry run made a backup');
});

check('the dry run report names the collision it would fold', () => {
  const c = dry.collisions.find((x) => x.newKey === NEW_MISTBORN);
  assert.ok(c, `no collision reported for ${NEW_MISTBORN}: ${JSON.stringify(dry.collisions)}`);
  assert.ok(c.from.includes(OLD_OUTPUT_KEY) && c.from.includes(OLD_ARCHIVE_KEY),
    `both halves must be named: ${JSON.stringify(c.from)}`);
});

check('the dry run report names the ids it is leaving alone, with a reason', () => {
  const u = dry.unresolved.find((x) => x.key === GHOST_KEY);
  assert.ok(u, `the ghost id was not reported: ${JSON.stringify(dry.unresolved)}`);
  assert.match(u.why, /no variant|never registered|deleted/i);
});

const applied = migrateBookshelfIds(lib, { apply: true, deviceId: 'migration', today: '2026-08-17' });

check('--apply backs .bookshelf up in the same library, before anything', () => {
  assert.strictEqual(applied.backupPath, `${bs}.bak-2026-08-17`);
  assert.deepStrictEqual(snapshot(applied.backupPath), before,
    'the backup is not the PRE-migration state');
});

check("the moved book's two halves are one book, with neither half lost", () => {
  const dir = path.join(bs, 'books', identity.bookIdFromKey(NEW_MISTBORN));
  const store = JSON.parse(fs.readFileSync(path.join(dir, `${DEVICE}.json`), 'utf-8'));
  const rec = store[READER];
  assert.strictEqual(rec.position.value, 4000, 'the newer position did not win');
  assert.deepStrictEqual(rec.heard.intervals, [[0, 1200], [3000, 4000]], 'coverage was overwritten, not unioned');
  const ids = rec.bookmarks.map((b) => b.bm.id).sort();
  assert.deepStrictEqual(ids, ['bm-new', 'bm-old'], 'a bookmark was lost in the fold');
});

check('the old book folders are gone, and the unplaceable one is untouched', () => {
  for (const k of [OLD_OUTPUT_KEY, OLD_ARCHIVE_KEY]) {
    assert.ok(!fs.existsSync(path.join(bs, 'books', identity.bookIdFromKey(k))), `${k} was left behind`);
  }
  const ghost = path.join(bs, 'books', identity.bookIdFromKey(GHOST_KEY), `${DEVICE}.json`);
  assert.ok(fs.existsSync(ghost), 'an id nothing could place was DROPPED');
  assert.strictEqual(JSON.parse(fs.readFileSync(ghost, 'utf-8'))[READER].position.value, 7);
});

check('positions, heard and bookmarks are rekeyed in place', () => {
  const pos = JSON.parse(fs.readFileSync(path.join(bs, 'positions', `${DEVICE}.json`), 'utf-8'));
  assert.ok(pos[READER][NEW_BILINGUAL], `positions still keyed by path: ${JSON.stringify(pos)}`);
  assert.ok(!pos[READER][OLD_BILINGUAL_KEY]);

  const heard = JSON.parse(fs.readFileSync(path.join(bs, 'heard', `${DEVICE}.json`), 'utf-8'));
  assert.ok(heard[READER][NEW_BILINGUAL]);

  const bm = fs.readFileSync(path.join(bs, 'bookmarks', `${DEVICE}.jsonl`), 'utf-8').trim();
  assert.strictEqual(JSON.parse(bm).key, NEW_BILINGUAL);
});

check('the listening log is rekeyed, so a moved book is one row not two', () => {
  const lines = fs.readFileSync(path.join(bs, 'events', `${DEVICE}.jsonl`), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const keys = new Set(lines.map((l) => l.bookKey));
  assert.deepStrictEqual([...keys], [NEW_MISTBORN],
    `both halves of the listening log should now name one book: ${[...keys]}`);
  assert.strictEqual(lines.reduce((n, l) => n + l.seconds, 0), 1500);
});

check('the alias map records both old ids, and resolves them', () => {
  const map = identity.readAliasMap(bs);
  assert.strictEqual(map.get(OLD_OUTPUT_KEY), NEW_MISTBORN,
    'the pre-move id is the one only the alias map can carry — it MUST be in it');
  assert.strictEqual(map.get(OLD_ARCHIVE_KEY), NEW_MISTBORN);
  assert.strictEqual(map.get(OLD_BILINGUAL_KEY), NEW_BILINGUAL);
  assert.strictEqual(map.has(GHOST_KEY), false, 'an id nothing placed must not be aliased to a guess');
});

check('the reverse map lets a read fold the old ids into the new one', () => {
  const back = identity.invertAliasMap(identity.readAliasMap(bs));
  assert.deepStrictEqual((back.get(NEW_MISTBORN) || []).sort(), [OLD_ARCHIVE_KEY, OLD_OUTPUT_KEY].sort());
});

check('an alias map that disagrees with itself throws instead of choosing', () => {
  const other = path.join(bs, 'aliases', 'someone-else.json');
  fs.writeFileSync(other, JSON.stringify({
    version: 1, entries: { [OLD_OUTPUT_KEY]: { to: 'v:mistborn/somethingelse', at: 'x', by: 'test' } },
  }), 'utf-8');
  assert.throws(() => identity.readAliasMap(bs), /disagrees with itself/);
  fs.rmSync(other);
});

const afterFirst = snapshot(bs);
const second = migrateBookshelfIds(lib, { apply: true, deviceId: 'migration', today: '2026-08-17' });

check('a second --apply changes nothing', () => {
  assert.deepStrictEqual(snapshot(bs), afterFirst, 'the migration is not idempotent');
  const rekeyed = Object.values(second.counts).reduce((n, c) => n + c.rekeyed, 0);
  assert.strictEqual(rekeyed, 0, `a re-run wanted to rekey ${rekeyed} more entries`);
  assert.ok(second.alreadyCanonical > 0, 'the re-run did not recognise the ids as already anchored');
});

check('the second run did not overwrite the backup with the post-migration state', () => {
  assert.deepStrictEqual(snapshot(`${bs}.bak-2026-08-17`), before);
});

fs.rmSync(lib, { recursive: true, force: true });
console.log(`${failed === 0 ? 'ok' : 'FAILED'}  bookshelf ids: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
