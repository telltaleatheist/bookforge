#!/usr/bin/env node
/**
 * Rekey a library's bookshelf stores from path ids to variant ids.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * A Bookshelf book's durable data — resume position, listened coverage,
 * bookmarks, listening analytics — was filed under a key derived from the
 * book's FILE PATH. So "Add to archive", which moves output/X.m4b to
 * archive/X.m4b, silently renamed the book and left the reader's progress in an
 * orphaned folder. Owen's live library has twelve projects with two store
 * folders each for exactly that reason.
 *
 * The work itself is `electron/bookshelf-id-migration.ts`, and the rules it
 * obeys are in `electron/bookshelf-identity.ts`. Read that module's header
 * before running this: it states what a book now IS, and this file will not
 * make a decision it does not sanction. This file is the sweep around it and
 * the report out of it.
 *
 * The design is tools/migrate-legacy-variants.js's, deliberately:
 *
 *   1. **A DRY RUN IS THE DEFAULT.** It reports every id it would rekey, every
 *      collision it would fold, and every id it could not place and is
 *      therefore leaving exactly where it is. It opens nothing for writing.
 *      THE REPORT IS THE DELIVERABLE — it is meant to be read before anything
 *      is written.
 *   2. **It backs up first.** `--apply` copies `.bookshelf` to
 *      `.bookshelf.bak-<date>` in the SAME library before touching a byte, so
 *      the undo is a rename by whoever is standing there.
 *   3. **An id it cannot place is KEPT, never dropped.** Listed in the report,
 *      left on disk under the name it has.
 *   4. **Idempotent.** A second `--apply` finds every id already canonical and
 *      writes nothing.
 *   5. **BookForge must not be running.** `--apply` rewrites the very stores an
 *      open window is reading and writing.
 *
 * ── How to run it ───────────────────────────────────────────────────────────
 *
 *   node tools/migrate-bookshelf-ids.js "E:\Bookforge"
 *   node tools/migrate-bookshelf-ids.js "E:\Bookforge" --apply
 *
 * Optional: `--verbose` to list every rekey (by default they are counted and
 * the collisions + unresolved ids are what gets printed, because those are the
 * two things a person has to look at).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MIGRATION = path.join(REPO, 'dist', 'electron', 'bookshelf-id-migration.js');
if (!fs.existsSync(MIGRATION)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
// The migration reaches manifest-service to resolve a path to its variant, and
// that module's dependency graph reaches the component catalog, which
// `require('electron')` at load time. The CLI solved this once: its stub
// intercepts that require and throws loudly on any surface it has not
// deliberately stubbed. Loaded FIRST — the same arrangement cli/library.js and
// tools/migrate-legacy-variants.js run under.
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bookshelf-ids-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const { migrateBookshelfIds } = require(MIGRATION);

// ── Arguments ────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

/**
 * The library being swept is the FIRST bare argument — no default, for the
 * reason tools/migrate-legacy-variants.js gives: a migration that guessed which
 * library it was rewriting is not one to run unattended.
 */
const LIBRARY = process.argv.slice(2).find((a) => !a.startsWith('--'));

if (!LIBRARY) {
  console.error(
    'Say which library to sweep:\n'
    + '  node tools/migrate-bookshelf-ids.js "E:\\Bookforge"          (dry run — writes nothing)\n'
    + '  node tools/migrate-bookshelf-ids.js "E:\\Bookforge" --apply  (rekeys what it found)');
  process.exit(2);
}
if (!fs.existsSync(path.join(LIBRARY, 'projects'))) {
  console.error(`${LIBRARY} has no projects/ folder, so it is not a BookForge library.`);
  process.exit(2);
}
if (!fs.existsSync(path.join(LIBRARY, '.bookshelf'))) {
  console.error(`${LIBRARY} has no .bookshelf folder — nothing has ever been read from this library.`);
  process.exit(2);
}

// ── BookForge must not be running ────────────────────────────────────────────
//
// `--apply` rewrites the stores an open window is actively reading and writing:
// a position saved by the running server a second after this rewrote its file
// would land back under the old key.

function bookforgeRunning() {
  if (process.platform !== 'win32') {
    const out = execSync('ps -A -o comm=', { encoding: 'utf-8' });
    return /(^|\/)BookForge$/m.test(out) || /(^|\/)Electron$/m.test(out);
  }
  const out = execSync('tasklist /FO CSV', { encoding: 'utf-8' });
  return /"BookForge\.exe"/i.test(out) || /"electron\.exe"/i.test(out);
}

if (APPLY && bookforgeRunning()) {
  console.error(
    'BookForge is running. Close it and run this again: this rewrites the very stores its bookshelf '
    + 'server is reading and writing. Nothing was done.');
  process.exit(3);
}

// ── The sweep ────────────────────────────────────────────────────────────────

console.log(
  `${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'}\n`
  + `  library: ${LIBRARY}\n`);

const report = migrateBookshelfIds(LIBRARY, { apply: APPLY });

if (report.backupPath) console.log(`backup     ${report.backupPath}\n`);

if (report.collisions.length > 0) {
  console.log('COLLISIONS — two or more old ids name the same book. Their records are folded with the '
    + 'same merge the server reads them back with (newest position, unioned coverage, latest bookmark '
    + 'per id).');
  for (const c of report.collisions) {
    console.log(`  ${c.newKey}`);
    for (const f of c.from) console.log(`      ${APPLY ? 'folded  ' : 'would fold'} ${f}`);
  }
  console.log('');
}

// The one inference this migration makes, printed on its own so it is read.
const moved = [...new Map(report.rekeys.filter((r) => r.viaFilename).map((r) => [r.oldKey, r])).values()];
if (moved.length > 0) {
  console.log('MATCHED BY FILENAME — the file at the old path is gone, and exactly one variant in that '
    + 'project bears its name. This is a move ("Add to archive" is the usual one), and it is the only '
    + 'inference made here. Read them:');
  for (const r of moved) console.log(`  ${r.oldKey}\n      → ${r.newKey}`);
  console.log('');
}

if (report.unresolved.length > 0) {
  // Deduped: one id can appear in several stores and the reason is the same.
  const seen = new Map();
  for (const u of report.unresolved) {
    const e = seen.get(u.key);
    if (e) e.stores.add(u.store);
    else seen.set(u.key, { why: u.why, stores: new Set([u.store]) });
  }
  console.log('KEPT AS THEY ARE — nothing could place these, so nothing moved them:');
  for (const [key, e] of seen) {
    console.log(`  ${key}\n      ${e.why}  [${[...e.stores].join(', ')}]`);
  }
  console.log('');
}

if (VERBOSE && report.rekeys.length > 0) {
  console.log('REKEYED:');
  for (const r of report.rekeys) console.log(`  [${r.store}] ${r.oldKey}\n      → ${r.newKey}`);
  console.log('');
}

console.log('─'.repeat(78));
for (const [store, c] of Object.entries(report.counts)) {
  if (c.scanned === 0) continue;
  console.log(
    `${store.padEnd(12)} scanned ${String(c.scanned).padStart(5)}   `
    + `${APPLY ? 'rekeyed' : 'to rekey'} ${String(c.rekeyed).padStart(5)}   `
    + `kept as-is ${String(c.unresolved).padStart(5)}`);
}
console.log(
  `\nalready anchored: ${report.alreadyCanonical}   collisions: ${report.collisions.length}`);
if (!APPLY) {
  console.log('\nNothing was written. Re-run with --apply (and BookForge closed) to rekey it.');
}
