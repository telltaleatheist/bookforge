/**
 * Rekey a library's `.bookshelf/` stores from path ids to variant ids.
 *
 * The rules live in electron/bookshelf-identity.ts — read that first; it says
 * what a book IS and why the path stopped being it. This module is the sweep
 * over one library's stores, and tools/migrate-bookshelf-ids.js is the report
 * around this. Nothing here decides identity; it only moves records from the
 * name they had to the name they have.
 *
 * ── What it touches ─────────────────────────────────────────────────────────
 *
 *   books/<bookId>/<device>.json   { [readerId]: BookRecord }  → folder renamed
 *   positions/<device>.json        { [readerId]: { [key]: … } } → inner keys
 *   heard/<device>.json            same shape                   → inner keys
 *   bookmarks/<device>.jsonl       one op per line, `key` field → the field
 *   events/<device>.jsonl          listening log, `bookKey`     → the field
 *
 * ── The five promises ───────────────────────────────────────────────────────
 *
 *   1. A DRY RUN IS THE DEFAULT. It reports every rekey it would make, every
 *      collision it would fold, and every id it could not place. It opens
 *      nothing for writing. `--apply` is the only way to change that.
 *   2. IT BACKS UP FIRST. `--apply` copies `.bookshelf` to
 *      `.bookshelf.bak-<YYYY-MM-DD>` in the SAME library before touching a
 *      byte, so the undo is a rename and needs no tooling.
 *   3. AN UNRESOLVABLE ID IS KEPT, NEVER DROPPED. A key naming a project that
 *      is gone, an `e:Uncategorized/…` from the retired ebooks catalog, an m4b
 *      no manifest points at — all stay exactly where they are, and are listed
 *      in the report. Guessing would file a reader's position under the wrong
 *      book; deleting would lose it.
 *   4. IT IS IDEMPOTENT. A second `--apply` finds every id already canonical
 *      and writes nothing — no re-folded records, no churned timestamps.
 *   5. COLLISIONS MERGE, THEY DO NOT OVERWRITE. When two old ids rekey onto
 *      one variant (the output/ + archive/ pairs this whole change exists
 *      for), their records are folded with `mergeBookRecords` — the identical
 *      function the server reads them back with.
 */

import * as fsSync from 'fs';
import * as path from 'path';

import { setLibraryBasePath } from './manifest-service';
import {
  AliasEntry, BookRecord,
  anchorForLegacyKey, anchorForMovedFile, bookIdFromKey, clearVariantsCache, isVariantKey,
  keyFromBookId, mergeBookStores, variantKey, writeAliasEntries,
} from './bookshelf-identity';

export interface RekeyRecord {
  oldKey: string;
  newKey: string;
  /** Where it was found — a store name, for the report. */
  store: string;
  /** True when the match came from anchorForMovedFile (the file at the old path
   *  is gone; exactly one variant in that project bears its name). Printed
   *  separately, because it is the one inference this migration makes. */
  viaFilename: boolean;
}

export interface UnresolvedRecord {
  key: string;
  store: string;
  why: string;
}

export interface CollisionRecord {
  newKey: string;
  /** Every old id that folded into it, canonical-or-not. */
  from: string[];
}

export interface MigrationReport {
  library: string;
  applied: boolean;
  backupPath: string | null;
  /** Books/positions/heard/bookmarks/events entries rekeyed, deduped by (store, oldKey). */
  rekeys: RekeyRecord[];
  /** Ids nothing could place. Kept exactly as they are. */
  unresolved: UnresolvedRecord[];
  /** Old ids that landed on a key another old id also landed on. */
  collisions: CollisionRecord[];
  /** Per-store counts, for the one-line summary. */
  counts: Record<string, { scanned: number; rekeyed: number; unresolved: number }>;
  /** Already-canonical stores found untouched — the idempotence signal. */
  alreadyCanonical: number;
}

interface Ctx {
  bookshelfDir: string;
  apply: boolean;
  report: MigrationReport;
  /** old key → new key, for the alias file and for the second pass. */
  aliases: Map<string, string>;
  resolved: Map<string, string | null>;
  /** Keys matched by anchorForMovedFile, so the report can name that inference. */
  viaFilename: Set<string>;
}

const STORES = ['books', 'positions', 'heard', 'bookmarks', 'events'] as const;

/**
 * The one place a legacy key becomes a canonical one — cached per run.
 *
 * Two routes, in order: the file the key names is still a variant's path
 * (exact), or the file is GONE and exactly one variant in that project bears
 * its name (a move — see anchorForMovedFile, which states the rule). The second
 * route is flagged so the report can print it separately; it is the only
 * inference here, and a dry run shows every instance of it before anything is
 * written.
 */
function canonical(ctx: Ctx, key: string): string | null {
  if (isVariantKey(key)) return key;
  if (ctx.resolved.has(key)) return ctx.resolved.get(key)!;

  let anchor = anchorForLegacyKey(key);
  let viaFilename = false;
  if (!anchor) {
    anchor = anchorForMovedFile(key);
    viaFilename = anchor !== null;
  }
  const to = anchor ? variantKey(anchor.projectId, anchor.variantId) : null;
  ctx.resolved.set(key, to);
  if (to) {
    ctx.aliases.set(key, to);
    if (viaFilename) ctx.viaFilename.add(key);
  }
  return to;
}

function note(ctx: Ctx, store: string, key: string, to: string | null, why: string): void {
  const c = ctx.report.counts[store];
  c.scanned++;
  if (isVariantKey(key)) { ctx.report.alreadyCanonical++; return; }
  if (to) {
    c.rekeyed++;
    ctx.report.rekeys.push({ oldKey: key, newKey: to, store, viaFilename: ctx.viaFilename.has(key) });
  } else {
    c.unresolved++;
    ctx.report.unresolved.push({ key, store, why });
  }
}

/** Why a key could not be placed, in a sentence a person can act on. */
function whyUnresolved(key: string): string {
  if (key.startsWith('p:')) return 'a reader ref, already project-anchored — nothing to rekey';
  if (key.startsWith('e:') && !key.startsWith('e:__archive__/')) {
    return 'an address from the retired ebooks/ catalog — no project owns it';
  }
  if (key.startsWith('a:') || key.startsWith('e:')) {
    return 'the project is gone, or no variant of it points at that file and none bears its name';
  }
  return 'not a form this migration knows';
}

// ─────────────────────────────────────────────────────────────────────────────
// The stores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * books/<bookId>/ — the folder name IS the key, so this renames folders and
 * folds the ones that collide.
 */
function migrateBooks(ctx: Ctx): void {
  const root = path.join(ctx.bookshelfDir, 'books');
  let ids: string[];
  try { ids = fsSync.readdirSync(root); } catch { return; }

  // Group by destination first: two old folders can land on the same new one,
  // and folding them is a different act from renaming one.
  const destinations = new Map<string, string[]>();
  for (const id of ids) {
    if (!fsSync.statSync(path.join(root, id)).isDirectory()) continue;
    let key: string;
    try { key = keyFromBookId(id); } catch { continue; }
    const to = canonical(ctx, key);
    note(ctx, 'books', key, to, whyUnresolved(key));
    if (!to || to === key) continue;
    const destId = bookIdFromKey(to);
    const list = destinations.get(destId);
    if (list) list.push(id); else destinations.set(destId, [id]);
  }

  for (const [destId, sourceIds] of destinations) {
    const targets = [...sourceIds];
    // An existing destination folder is a source too — a half-run migration, or
    // a device that already wrote under the new key.
    if (fsSync.existsSync(path.join(root, destId)) && !targets.includes(destId)) targets.push(destId);
    if (targets.length > 1) {
      ctx.report.collisions.push({
        newKey: keyFromBookId(destId),
        from: targets.map((t) => keyFromBookId(t)),
      });
    }
    if (!ctx.apply) continue;
    foldBookFolders(root, targets, destId);
  }
}

/** Move every device file from `sources` into `destId`, merging where a device
 *  wrote to both. */
function foldBookFolders(root: string, sources: string[], destId: string): void {
  const destDir = path.join(root, destId);
  fsSync.mkdirSync(destDir, { recursive: true });
  for (const src of sources) {
    if (src === destId) continue;
    const srcDir = path.join(root, src);
    for (const f of fsSync.readdirSync(srcDir)) {
      if (!f.endsWith('.json')) continue;
      const target = path.join(destDir, f);
      const incoming = readJson<Record<string, BookRecord>>(path.join(srcDir, f));
      if (incoming === null) continue;
      const existing = fsSync.existsSync(target) ? readJson<Record<string, BookRecord>>(target) : null;
      const merged = existing ? mergeBookStores([existing, incoming]) : incoming;
      writeJsonAtomic(target, merged);
      fsSync.rmSync(path.join(srcDir, f));
    }
    // Only remove the old folder when it is empty — anything we did not
    // understand stays put rather than being swept away with it.
    if (fsSync.readdirSync(srcDir).length === 0) fsSync.rmdirSync(srcDir);
  }
}

/** positions/ and heard/: `{ [readerId]: { [key]: value } }` per device file. */
function migrateKeyedStore(ctx: Ctx, store: 'positions' | 'heard'): void {
  const dir = path.join(ctx.bookshelfDir, store);
  let files: string[];
  try { files = fsSync.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }

  for (const f of files) {
    const file = path.join(dir, f);
    const parsed = readJson<Record<string, Record<string, unknown>>>(file);
    if (parsed === null) continue;
    let changed = false;
    const next: Record<string, Record<string, unknown>> = {};
    for (const [readerId, byKey] of Object.entries(parsed)) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(byKey || {})) {
        const to = canonical(ctx, key);
        note(ctx, store, key, to, whyUnresolved(key));
        const dest = to ?? key;
        if (dest !== key) changed = true;
        // A collision inside one file: two old keys, one new. Newest `at` wins,
        // which is what the server's own merge would do for a position, and is
        // the only sensible answer for a heard snapshot from one device.
        const prior = out[dest] as { at?: string } | undefined;
        const incoming = value as { at?: string } | undefined;
        out[dest] = prior && prior.at && incoming?.at && prior.at > incoming.at ? prior : value;
      }
      next[readerId] = out;
    }
    if (changed && ctx.apply) writeJsonAtomic(file, next);
  }
}

/** bookmarks/ and events/: one JSON object per line, with a key field. */
function migrateJsonlStore(ctx: Ctx, store: 'bookmarks' | 'events', field: 'key' | 'bookKey'): void {
  const dir = path.join(ctx.bookshelfDir, store);
  let files: string[];
  try { files = fsSync.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return; }

  for (const f of files) {
    const file = path.join(dir, f);
    let content: string;
    try { content = fsSync.readFileSync(file, 'utf-8'); } catch { continue; }
    let changed = false;
    const lines = content.split('\n').map((line) => {
      if (!line.trim()) return line;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { return line; } // a line we cannot read is left alone
      const raw = obj[field];
      if (typeof raw !== 'string' || !raw) return line;
      // The events log carries a BARE library-relative path, not an `a:` key —
      // it predates the prefix. Put the prefix on to resolve it, take it off
      // again if nothing resolves.
      const asKey = store === 'events' && !isVariantKey(raw) ? `a:${raw}` : raw;
      const to = canonical(ctx, asKey);
      note(ctx, store, asKey, to, whyUnresolved(asKey));
      if (!to || to === raw) return line;
      changed = true;
      return JSON.stringify({ ...obj, [field]: to });
    });
    if (changed && ctx.apply) writeFileAtomic(file, lines.join('\n'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface MigrateOptions {
  apply?: boolean;
  /** Which device's alias file to write. Defaults to a migration-owned name so
   *  the tool never has to guess at (or collide with) a real device id. */
  deviceId?: string;
  /** Today, as YYYY-MM-DD, for the backup folder. Injectable for the keeper. */
  today?: string;
}

export function migrateBookshelfIds(libraryRoot: string, options: MigrateOptions = {}): MigrationReport {
  const apply = options.apply === true;
  const bookshelfDir = path.join(libraryRoot, '.bookshelf');
  if (!fsSync.existsSync(bookshelfDir)) {
    throw new Error(`${libraryRoot} has no .bookshelf folder, so there is nothing to migrate.`);
  }

  // Every id resolution reads that project's manifest, so the library base path
  // has to BE this library for the whole run.
  setLibraryBasePath(libraryRoot);
  clearVariantsCache();

  const report: MigrationReport = {
    library: libraryRoot,
    applied: apply,
    backupPath: null,
    rekeys: [],
    unresolved: [],
    collisions: [],
    counts: Object.fromEntries(STORES.map((s) => [s, { scanned: 0, rekeyed: 0, unresolved: 0 }])),
    alreadyCanonical: 0,
  };
  const ctx: Ctx = { bookshelfDir, apply, report, aliases: new Map(), resolved: new Map(), viaFilename: new Set() };

  if (apply) report.backupPath = backupBookshelf(bookshelfDir, options.today ?? isoDay());

  migrateBooks(ctx);
  migrateKeyedStore(ctx, 'positions');
  migrateKeyedStore(ctx, 'heard');
  migrateJsonlStore(ctx, 'bookmarks', 'key');
  migrateJsonlStore(ctx, 'events', 'bookKey');

  // The alias file is what lets a phone still holding an old id resolve it,
  // forever. Written even when a store had nothing left to rekey (a second
  // --apply): the map is the durable half of this change, not the rename.
  if (apply && ctx.aliases.size > 0) {
    const at = new Date().toISOString();
    const entries: Record<string, AliasEntry> = {};
    for (const [oldKey, to] of ctx.aliases) entries[oldKey] = { to, at, by: 'migrate-bookshelf-ids' };
    writeAliasEntries(bookshelfDir, options.deviceId ?? 'migration', entries);
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem helpers
// ─────────────────────────────────────────────────────────────────────────────

function isoDay(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Copy `.bookshelf` to `.bookshelf.bak-<day>` beside it. In the SAME library on
 * purpose: the undo has to be a rename by whoever is standing there, not a
 * restore from somewhere they have to be told about. A backup that already
 * exists for today is left alone — re-copying would overwrite the pre-migration
 * state with the post-migration one, which is the opposite of a backup.
 */
function backupBookshelf(bookshelfDir: string, day: string): string {
  const dest = `${bookshelfDir}.bak-${day}`;
  if (fsSync.existsSync(dest)) return dest;
  fsSync.cpSync(bookshelfDir, dest, { recursive: true });
  return dest;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fsSync.readFileSync(file, 'utf-8')) as T; } catch { return null; }
}

function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value));
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.migrate.tmp`;
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.writeFileSync(tmp, content, 'utf-8');
  fsSync.renameSync(tmp, file);
}
