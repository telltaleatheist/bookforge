/**
 * What a Bookshelf book IS — the key everything durable is filed under.
 *
 * ── The bug this fixes ───────────────────────────────────────────────────────
 *
 * Every reader's resume position, listened coverage, bookmarks and listening
 * analytics are filed under a key derived from the book's FILE PATH:
 *
 *     a:projects/<projectDir>/output/<Title. Author. (Year)>.m4b
 *
 * The path is the key, so moving the file renames the book. "Add to archive"
 * moves `output/X.m4b` → `archive/X.m4b`, and the reader's half-finished book
 * silently becomes a different, empty one. This is not hypothetical: Owen's live
 * library has twelve projects with TWO store folders, several of them the same
 * filename under `output/` and under `archive/` —
 *   Mistborn_The_Final_Empire      output/The Final Empire… + archive/The Final Empire…
 *   The_Coming_of_the_Third_Reich  output/The Coming…       + archive/The Coming…
 * — one live, one orphaned, one reader who lost their place.
 *
 * ── The anchor ───────────────────────────────────────────────────────────────
 *
 * A book is anchored to its VARIANT: the composite (project folder, variant id).
 * The variant row is the thing that survives a move — `registerAudiobookOutput`
 * and the archive move both repoint the SAME row's `path` — so the composite
 * names the same book wherever its bytes are sitting today.
 *
 *     v:<projectId>/<variantId>
 *
 * `projectId` is a directory name, so it can never contain `/`; everything after
 * the FIRST slash is the variant id, which may contain `:` (`bilingual:en-de`)
 * and even `/` (the legacy `arch:archive/foo.epub` synthesis). Parsing splits on
 * that first slash and nothing else.
 *
 * ── Both forms resolve, forever ──────────────────────────────────────────────
 *
 * A phone that has been offline for a month is holding path-form ids in its own
 * queue, and an un-migrated library has path-form folders on disk. So:
 *
 *   - new-form ids resolve natively;
 *   - old path-form ids resolve through the persisted alias map
 *     (`<library>/.bookshelf/aliases/<deviceId>.json`, merged across devices the
 *     same way every other store here is, so Syncthing never sees two writers);
 *   - and on READ, a variant-keyed book also folds in whatever is filed under
 *     its own current path key, so an upgrade loses nothing even before the
 *     migration is run.
 *
 * Writes only ever go to the new form. The old folders are read, never grown.
 */

import * as fsSync from 'fs';
import * as path from 'path';

import {
  getVariants, getLibraryBasePath, getProjectsPath, getManifestPath, getProjectPath,
  normalizeManifestPaths,
} from './manifest-service';
import { normalizeFsPath } from './path-utils';
import type { ProjectManifest, ProjectVariant } from './manifest-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Record shapes (shared with bookshelf-server.ts, which stores them)
// ─────────────────────────────────────────────────────────────────────────────

export interface BookPosition { kind: string; value: unknown; at: string; }
export interface BookHeard { intervals: number[][]; at: string; }
export interface BookmarkOp { op: string; bm: Record<string, unknown> & { id?: string }; at: string; }
export interface BookRecord {
  position?: BookPosition;
  heard?: BookHeard;
  bookmarks?: BookmarkOp[];
  heardResetAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Id grammar
// ─────────────────────────────────────────────────────────────────────────────

export interface VariantAnchor { projectId: string; variantId: string; }

/** `v:<projectId>/<variantId>` — the anchored key. */
export function variantKey(projectId: string, variantId: string): string {
  if (!projectId || projectId.includes('/')) {
    throw new Error(`"${projectId}" is not a project folder name — a variant key cannot be built from it.`);
  }
  if (!variantId) throw new Error('A variant key needs a variant id; none was given.');
  return `v:${projectId}/${variantId}`;
}

/** The anchor inside a `v:` key, or null when this is not one. */
export function parseVariantKey(key: string): VariantAnchor | null {
  if (!key.startsWith('v:')) return null;
  const rest = key.slice(2);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { projectId: rest.slice(0, slash), variantId: rest.slice(slash + 1) };
}

export function isVariantKey(key: string): boolean {
  return parseVariantKey(key) !== null;
}

/** The on-disk folder name for a key (`books/<bookId>/`). */
export function bookIdFromKey(key: string): string {
  return Buffer.from(key, 'utf-8').toString('base64url');
}

/** The key a `books/` folder name stands for. */
export function keyFromBookId(bookId: string): string {
  return Buffer.from(bookId, 'base64url').toString('utf-8');
}

/** Library-relative, forward-slashed — the shape a legacy `a:` key carries. */
export function libraryRelativePath(absPath: string): string | null {
  const rel = path.relative(getLibraryBasePath(), absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** The legacy path-form key for an audiobook file. Kept because we still READ it. */
export function legacyAudioKey(absPath: string): string {
  return `a:${libraryRelativePath(absPath) ?? path.basename(absPath)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolving a legacy key (or a file path) to its anchor
// ─────────────────────────────────────────────────────────────────────────────

const normVariantPath = (p: string): string =>
  (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

/**
 * Every resolution below is SYNCHRONOUS on purpose. The desktop player reaches
 * these over IPC through methods that are sync today (`saveAudioPosition`,
 * `getAudioPosition`, …); making the anchor async would turn those async and
 * ripple into main.ts. A manifest is a small JSON file and the read is cached
 * on its own size+mtime, so a position write costs one `stat`.
 */
const variantsCache = new Map<string, { size: number; mtimeMs: number; variants: ProjectVariant[] }>();

/** A project's variants, straight off disk, cached on the manifest's identity. */
export function variantsOfProject(projectId: string): ProjectVariant[] | null {
  const manifestPath = getManifestPath(projectId);
  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(manifestPath);
  } catch {
    return null; // no such project
  }
  const hit = variantsCache.get(projectId);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.variants;

  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf-8')) as ProjectManifest;
  } catch (err) {
    throw new Error(
      `${projectId}'s manifest could not be read (${err instanceof Error ? err.message : String(err)}). `
      + 'Its books cannot be identified, and answering "no such variant" would file a reader\'s position '
      + 'under a made-up id.');
  }
  // Same NFC treatment getManifest() does on read — the library is synced
  // Mac↔Windows and a decomposed path simply does not match on NTFS.
  if (manifest.projectId) manifest.projectId = normalizeFsPath(manifest.projectId);
  normalizeManifestPaths(manifest);
  const { variants } = getVariants(manifest);
  variantsCache.set(projectId, { size: stat.size, mtimeMs: stat.mtimeMs, variants });
  return variants;
}

/**
 * The variant a project-relative artifact path belongs to, or null when the
 * project has no variant pointing at that file (a stale key for a deleted
 * output, an m4b nobody ever registered).
 */
export function anchorForProjectPath(
  projectId: string,
  projectRelativePath: string,
): VariantAnchor | null {
  const variants = variantsOfProject(projectId);
  if (!variants) return null;
  const want = normVariantPath(projectRelativePath);
  const hit = variants.find((v) => normVariantPath(v.path) === want);
  return hit ? { projectId, variantId: hit.id } : null;
}

/** The variant an absolute path under `projects/` belongs to. */
export function anchorForAbsolutePath(absPath: string): VariantAnchor | null {
  const rel = path.relative(getProjectsPath(), absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  return anchorForProjectPath(parts[0], parts.slice(1).join('/'));
}

/**
 * The anchor a LEGACY key names, or null when nothing resolves it.
 *
 *   `a:projects/<pid>/<rel>`       an audiobook file
 *   `e:__archive__/<pid>/<file>`   a reading edition (its archive/ file)
 *
 * Anything else — `e:Uncategorized/…` from the retired ebooks catalog, a key for
 * a project that is gone — resolves to null and is KEPT AS IT IS. A key we
 * cannot place is never guessed at and never dropped.
 */
export function anchorForLegacyKey(key: string): VariantAnchor | null {
  const at = legacyKeyLocation(key);
  return at ? anchorForProjectPath(at.projectId, at.projectRelativePath) : null;
}

/** The project and project-relative file a legacy key names, whether or not any
 *  variant still points at it. Null for a form this does not address. */
export function legacyKeyLocation(
  key: string,
): { projectId: string; projectRelativePath: string } | null {
  if (key.startsWith('a:')) {
    const parts = key.slice(2).split('/');
    if (parts[0] !== 'projects' || parts.length < 3) return null;
    return { projectId: parts[1], projectRelativePath: parts.slice(2).join('/') };
  }
  if (key.startsWith('e:')) {
    const parts = key.slice(2).split('/');
    if (parts[0] !== '__archive__' || parts.length < 3) return null;
    return { projectId: parts[1], projectRelativePath: `archive/${parts.slice(2).join('/')}` };
  }
  return null;
}

/**
 * The variant a MOVED file belonged to, matched by filename within its own
 * project — the only thing that can rescue a key whose path nothing points at
 * any more.
 *
 * This is the case the whole change exists for. When "Add to archive" moved
 * output/X.m4b to archive/X.m4b, the variant row followed the file, so the OLD
 * key resolves to nothing: there is no longer a variant at output/X.m4b. The
 * records filed under it are the reader's whole pre-move history.
 *
 * The rule is deliberately narrow, and it is a rule rather than a guess:
 *   - the SAME project (a filename never matches across projects);
 *   - EXACTLY ONE variant in it bears that filename (two candidates is an
 *     ambiguity, and an ambiguity is reported, not resolved);
 *   - and the old path is genuinely GONE (a file still sitting there is its own
 *     thing, not a stale name for something else).
 *
 * Used ONLY by the migration, where a dry run shows a person every match before
 * anything is written. Live request handling never reaches for it — an old id
 * resolves through the alias map the migration wrote, which is exact.
 */
export function anchorForMovedFile(key: string): VariantAnchor | null {
  const at = legacyKeyLocation(key);
  if (!at) return null;
  const variants = variantsOfProject(at.projectId);
  if (!variants) return null;

  const oldAbs = path.join(getProjectPath(at.projectId), at.projectRelativePath.split('/').join(path.sep));
  if (fsSync.existsSync(oldAbs)) return null; // still there — not a move

  const wanted = path.posix.basename(at.projectRelativePath).toLowerCase();
  const matches = variants.filter((v) => path.posix.basename(v.path.replace(/\\/g, '/')).toLowerCase() === wanted);
  if (matches.length !== 1) return null;
  return { projectId: at.projectId, variantId: matches[0].id };
}

/**
 * Where a variant's file sits RIGHT NOW, absolute. Used to fold whatever an
 * un-migrated library still has filed under the current path key.
 */
export function currentPathOfAnchor(anchor: VariantAnchor): string | null {
  const variants = variantsOfProject(anchor.projectId);
  if (!variants) return null;
  const hit = variants.find((v) => v.id === anchor.variantId);
  if (!hit?.path) return null;
  return path.join(getProjectPath(anchor.projectId), hit.path.split('/').join(path.sep));
}

/** Forget cached manifests — the migration rewrites nothing here, but a test
 *  that builds a fixture library twice in one process must not see the first. */
export function clearVariantsCache(): void {
  variantsCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// The alias map
//
// `<library>/.bookshelf/aliases/<deviceId>.json`, one writer per file, unioned
// on read — the identical arrangement books/, positions/ and events/ use, and
// for the identical reason: Syncthing must never see two machines editing one
// file. Entries are append-only in practice; nothing here deletes one.
// ─────────────────────────────────────────────────────────────────────────────

export interface AliasEntry {
  /** The new-form key this old id now names. */
  to: string;
  /** When it was recorded (ISO) — for the report, not for conflict-breaking. */
  at: string;
  /** What wrote it, e.g. 'migrate-bookshelf-ids'. */
  by: string;
}

export interface AliasFile {
  version: 1;
  entries: Record<string, AliasEntry>;
}

export function aliasesDir(bookshelfDir: string): string {
  return path.join(bookshelfDir, 'aliases');
}

export function aliasFilePath(bookshelfDir: string, deviceId: string): string {
  return path.join(aliasesDir(bookshelfDir), `${deviceId}.json`);
}

/**
 * Every device's aliases, unioned into old-key → new-key.
 *
 * Two devices mapping the SAME old key to DIFFERENT new keys is not something
 * normal operation can produce — it would mean the same file resolved to two
 * variants on two machines — so it throws with both answers named rather than
 * picking one. A guess here silently sends a reader's position to the wrong book.
 */
export function readAliasMap(bookshelfDir: string): Map<string, string> {
  const dir = aliasesDir(bookshelfDir);
  const merged = new Map<string, string>();
  let names: string[];
  try {
    names = fsSync.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    // Absent IS "no aliases recorded yet" — it is made by the migration.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return merged;
    throw new Error(
      `The bookshelf alias map could not be read (${err instanceof Error ? err.message : String(err)}). `
      + 'Old book ids would resolve to nothing, which reads as "this reader never opened that book".');
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let parsed: AliasFile;
    try {
      parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8')) as AliasFile;
    } catch (err) {
      throw new Error(
        `${name} in the bookshelf alias map could not be read `
        + `(${err instanceof Error ? err.message : String(err)}). The old ids it maps would silently `
        + 'stop resolving.');
    }
    for (const [oldKey, entry] of Object.entries(parsed?.entries || {})) {
      const already = merged.get(oldKey);
      if (already && already !== entry.to) {
        throw new Error(
          `The bookshelf alias map disagrees with itself about "${oldKey}": ${name} says it is now `
          + `"${entry.to}", another device says "${already}". One of those readers' positions would go `
          + 'to the wrong book, so nothing is chosen here.');
      }
      merged.set(oldKey, entry.to);
    }
  }
  return merged;
}

/** new-key → the old keys that alias onto it (for folding old stores on read). */
export function invertAliasMap(map: Map<string, string>): Map<string, string[]> {
  const back = new Map<string, string[]>();
  for (const [oldKey, newKey] of map) {
    const list = back.get(newKey);
    if (list) list.push(oldKey);
    else back.set(newKey, [oldKey]);
  }
  return back;
}

/** Merge entries into THIS device's alias file (atomic stage + rename). */
export function writeAliasEntries(
  bookshelfDir: string,
  deviceId: string,
  entries: Record<string, AliasEntry>,
): void {
  const file = aliasFilePath(bookshelfDir, deviceId);
  let current: AliasFile = { version: 1, entries: {} };
  try {
    current = JSON.parse(fsSync.readFileSync(file, 'utf-8')) as AliasFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `This device's alias file (${file}) exists and could not be read `
        + `(${err instanceof Error ? err.message : String(err)}). Overwriting it would drop the aliases `
        + 'already in it.');
    }
  }
  const next: AliasFile = { version: 1, entries: { ...(current.entries || {}), ...entries } };
  fsSync.mkdirSync(aliasesDir(bookshelfDir), { recursive: true });
  const tmp = `${file}.tmp`;
  fsSync.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fsSync.renameSync(tmp, file);
}

// ─────────────────────────────────────────────────────────────────────────────
// Merging records
//
// Lives here because the server merges them on read and the migration merges
// them when two old book folders rekey onto one new id — and those two must
// agree exactly, or a migration would change what a reader sees.
// ─────────────────────────────────────────────────────────────────────────────

/** Overlapping/adjacent intervals → a minimal sorted set (joins gaps ≤ 1s, the
 *  client's addHeard semantics). */
export function mergeIntervals(intervals: number[][]): number[][] {
  const list = (intervals || [])
    .filter((iv): iv is [number, number] =>
      Array.isArray(iv) && iv.length === 2 &&
      Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
    .map((iv) => [iv[0], iv[1]] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [s, e] of list) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * Fold several devices' records for one reader+book into one.
 *
 *   position     newest `at` wins
 *   heard        UNIONED across every snapshot at/after the newest reset
 *                tombstone (so two devices' concurrent coverage accumulates,
 *                and a reset still erases everything older, from any device)
 *   heardResetAt the maximum
 *   bookmarks    latest op per bookmark id (a 'del' is kept as a tombstone)
 */
export function mergeBookRecords(records: Array<BookRecord | undefined>): BookRecord {
  let position: BookPosition | undefined;
  const heardSnaps: BookHeard[] = [];
  let heardResetAt = '';
  const bmLatest = new Map<string, BookmarkOp>();

  for (const rec of records) {
    if (!rec) continue;
    const p = rec.position;
    if (p && p.at && (!position || p.at > position.at)) position = p;
    if (rec.heard && rec.heard.at) heardSnaps.push(rec.heard);
    if (rec.heardResetAt && rec.heardResetAt > heardResetAt) heardResetAt = rec.heardResetAt;
    for (const op of rec.bookmarks || []) {
      const id = op?.bm?.id;
      if (!id) continue;
      const cur = bmLatest.get(id);
      if (!cur || op.at > cur.at) bmLatest.set(id, op);
    }
  }

  const kept = heardSnaps.filter((h) => h.at >= heardResetAt);
  const out: BookRecord = {};
  if (position) out.position = position;
  if (kept.length > 0) {
    out.heard = {
      intervals: mergeIntervals(kept.flatMap((h) => h.intervals)),
      // The newest snapshot's stamp: a later merge must not tombstone this fold.
      at: kept.reduce((max, h) => (h.at > max ? h.at : max), kept[0].at),
    };
  }
  if (heardResetAt) out.heardResetAt = heardResetAt;
  const bookmarks = [...bmLatest.values()].sort((a, b) => (a.at < b.at ? -1 : 1));
  if (bookmarks.length > 0) out.bookmarks = bookmarks;
  return out;
}

/** Fold two `{ [readerId]: BookRecord }` device files into one. */
export function mergeBookStores(
  stores: Array<Record<string, BookRecord>>,
): Record<string, BookRecord> {
  const readerIds = new Set<string>();
  for (const s of stores) for (const id of Object.keys(s || {})) readerIds.add(id);
  const out: Record<string, BookRecord> = {};
  for (const id of readerIds) out[id] = mergeBookRecords(stores.map((s) => s?.[id]));
  return out;
}
