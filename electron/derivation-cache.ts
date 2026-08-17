/**
 * Facts that cost seconds to derive from a file, remembered until the file changes.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Opening a book's Versions page took 5–10 seconds on Owen's library, and the
 * measurement (2026-08-17, ten real projects at E:\Bookforge) said where every
 * millisecond of it went:
 *
 *   analysis:list-audiobooks   4.0 – 9.6 s   on any project with an audiobook
 *   everything else combined   < 30 ms
 *
 * and inside that, per m4b:
 *
 *   sha256 of the whole file   3.7 – 8.3 s   (3.04 GB Kershaw: 8326 ms)
 *   ffmpeg transcript extract  0.5 – 1.3 s
 *   strict VTT parse           6 – 33 ms
 *
 * None of that changes between two visits to the same page. The audiobook is a
 * multi-gigabyte file nothing writes to; the question asked of it — "does this
 * have an authoritative transcript" — has the same answer every time until the
 * bytes change. So the answer is kept, and the file's own (mtime, size) is what
 * says whether it is still the answer.
 *
 * ── The key, and what it is honestly worth ──────────────────────────────────
 *
 * An entry is (namespace, absolute path) → { mtimeMs, size, value }. A read
 * stats the file and hands back `value` ONLY when both mtimeMs and size still
 * match. Anything else — a different mtime, a different size, a file that is no
 * longer there, a store that would not parse — is a MISS, and a miss re-derives.
 * There is no third answer: this module never returns a value it is not sure
 * about, and it never substitutes one (see CLAUDE.md, "Avoid Fallbacks").
 *
 * What that key cannot catch is a file rewritten to the same byte length within
 * the same millisecond. That is the standing limitation of every mtime-keyed
 * cache, and it is stated here rather than papered over. It is acceptable for
 * exactly the facts this holds: they are derived from audiobooks and analysis
 * reports, both written by BookForge itself through atomic replaces that move
 * mtime by whole seconds, and the one place where being wrong would matter —
 * committing an analysis report — re-derives from the real bytes at commit time
 * regardless of what is cached here (see audiobook-analysis-protocol.ts).
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 *
 * `<userData>/derivation-cache.json`, following duration-cache.json next door in
 * bookshelf-server.ts: a plain JSON object, loaded once, written back debounced.
 * It is a CACHE and nothing reads it as a record — deleting the file costs one
 * slow page and nothing else.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** What the store holds for one file, beside the fact derived from it. */
interface CacheEntry {
  /** The file's mtime when the value was derived. */
  mtimeMs: number;
  /** The file's size when the value was derived. */
  size: number;
  /** When this entry was last written or hit, for the eviction below. */
  at: number;
  /** The derived fact. Opaque here — the deriving module owns its shape. */
  value: unknown;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const STORE_VERSION = 1 as const;

/**
 * How many entries the store keeps. Owen's library is 386 projects with ~107
 * audiobooks between them, so two namespaces over every file in it is a few
 * hundred entries — this is headroom, not a limit anyone reaches. When it IS
 * reached the least-recently-touched entries go, because the fact a page has
 * not asked for in months is the one worth re-deriving.
 */
const MAX_ENTRIES = 4000;

/** How long a write waits for its neighbours before it hits the disk. */
const SAVE_DEBOUNCE_MS = 750;

let store: CacheFile | null = null;
let dirty = false;
let saveTimer: NodeJS.Timeout | null = null;
let storePathOverride: string | null = null;

/**
 * Point the store somewhere other than userData.
 *
 * For the keeper, which must not scribble on the real user's cache, and for any
 * headless tool that wants its own. Passing null puts it back on userData.
 * Resetting the path DROPS the loaded store — the entries in memory belong to
 * the file they came from.
 */
export function setDerivationCachePath(storePath: string | null): void {
  storePathOverride = storePath;
  store = null;
  dirty = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

function storePath(): string {
  if (storePathOverride) return storePathOverride;
  return path.join(app.getPath('userData'), 'derivation-cache.json');
}

/**
 * The store, loaded once.
 *
 * A store that will not read is SAID and then started empty. That is not a
 * fallback: an unreadable cache has no answers in it, so every question against
 * it misses and re-derives from the real file — the slow, correct path. The one
 * thing that must never happen here is a wrong answer, and an empty store cannot
 * give one.
 */
function loaded(): CacheFile {
  if (store) return store;
  const file = storePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    // ENOENT is the ordinary first run and says nothing worth printing. Anything
    // else (a permission, a locked file on a synced drive) is a real failure to
    // read a real file, and the slow pages that follow deserve their reason.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[derivation-cache] ${file} could not be read (${(err as Error).message}); every derived `
        + 'fact will be computed from its file again this session.');
    }
    store = { version: STORE_VERSION, entries: {} };
    return store;
  }
  try {
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed?.version !== STORE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new Error(`store is version ${String(parsed?.version)}, not ${STORE_VERSION}`);
    }
    store = { version: STORE_VERSION, entries: parsed.entries };
  } catch (err) {
    console.warn(
      `[derivation-cache] ${file} is not a cache this build can read (${(err as Error).message}); `
      + 'it is being started over, and every derived fact will be computed from its file again.');
    store = { version: STORE_VERSION, entries: {} };
    dirty = true;
  }
  return store;
}

/**
 * The identity of a file, as this cache keys on it: its mtime and its size.
 *
 * Null for a file that is not there or cannot be stat'd — which is not an error
 * here, it is the answer "there is nothing to remember a fact about".
 */
export interface FileIdentity {
  mtimeMs: number;
  size: number;
}

export async function readFileIdentity(absPath: string): Promise<FileIdentity | null> {
  try {
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * The key for one fact about one file.
 *
 * The namespace is part of it so two derivations over the same audiobook — is
 * there a transcript, and does its analysis report still verify — cannot read
 * each other's answers. Paths are compared case-insensitively because Windows
 * hands the same file back under either case and two entries for one file would
 * mean one of them is always stale.
 */
function key(namespace: string, absPath: string): string {
  return `${namespace}\u0000${path.resolve(absPath).toLowerCase()}`;
}

/**
 * The remembered fact, or null when there is not one for THESE bytes.
 *
 * `identity` is the caller's own stat of the file — passed in rather than taken
 * here, because a caller that is about to derive has already stat'd it and a
 * second stat could see a different file than the one it derives from.
 */
export function getDerived<T>(namespace: string, absPath: string, identity: FileIdentity): T | null {
  const entry = loaded().entries[key(namespace, absPath)];
  if (!entry) return null;
  if (entry.mtimeMs !== identity.mtimeMs || entry.size !== identity.size) return null;
  entry.at = Date.now();
  dirty = true;
  return entry.value as T;
}

/** Remember a fact against the bytes it was derived from. */
export function putDerived<T>(
  namespace: string,
  absPath: string,
  identity: FileIdentity,
  value: T,
): void {
  loaded().entries[key(namespace, absPath)] = {
    mtimeMs: identity.mtimeMs,
    size: identity.size,
    at: Date.now(),
    value,
  };
  dirty = true;
  scheduleSave();
}

/** Forget one fact — for a file this session is about to rewrite. */
export function forgetDerived(namespace: string, absPath: string): void {
  const entries = loaded().entries;
  const k = key(namespace, absPath);
  if (!(k in entries)) return;
  delete entries[k];
  dirty = true;
  scheduleSave();
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushDerivationCache();
  }, SAVE_DEBOUNCE_MS);
  // A cache write must never be the reason the app stays alive.
  saveTimer.unref?.();
}

/**
 * Write the store back, now.
 *
 * A failure to write is SAID and then let go: the facts are still in memory for
 * this session, and the only cost of never landing them is a slow page after the
 * next restart. Refusing to continue over a cache write would be the tail
 * wagging the dog.
 */
export async function flushDerivationCache(): Promise<void> {
  if (!dirty || !store) return;
  const entries = store.entries;
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) {
    // Least-recently-touched first. `at` is bumped on every hit, so what goes is
    // what no page has asked about.
    keys.sort((a, b) => entries[a].at - entries[b].at);
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[k];
  }
  const file = storePath();
  const temp = `${file}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // Written beside and renamed on: a half-written cache is the one shape that
    // would cost a startup for every project rather than one.
    await fs.promises.writeFile(temp, JSON.stringify(store), 'utf-8');
    await fs.promises.rename(temp, file);
    dirty = false;
  } catch (err) {
    console.warn(
      `[derivation-cache] ${file} could not be written (${(err as Error).message}); this session's `
      + 'derived facts are kept in memory and will be computed again after a restart.');
    try { await fs.promises.unlink(temp); } catch { /* nothing to clean up */ }
  }
}
