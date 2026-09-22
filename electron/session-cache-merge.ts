/**
 * WHAT "THE SESSION IS CACHED" MEANS, AND IT IS A SET COMPARISON.
 *
 * The durable project cache (`stages/03-tts/sessions/<lang>/ebook-<uuid>/`) is
 * the UNION of everything ever rendered for that session, and a publish may not
 * report success while the source still holds a chunk the cache lacks.
 *
 * MEASURED, 2026-09-20 (*Hitler's People*): the app quit mid-render at 02:39 and
 * the interrupt path published a FIVE-chunk cache. The render resumed at 13:06
 * and wrote all 2267 chunks to scratch. At 13:39 `cacheSessionToProject` reached
 * its idempotency shortcut — *"if the destination already has a valid cached
 * session, return early"* — saw a directory with a `chapters/sentences` in it,
 * returned `success: true`, and logged "Session cached to project on
 * completion". 2262 chunks never left scratch; the alignment and the assembly
 * read the five-chunk cache and failed with "chapter 1 is missing chunk audio".
 * Nothing was lost on disk and nothing said why.
 *
 * The shortcut compared NOTHING. The two comparisons that did exist — the
 * interrupt-cache's *"cache already at least as complete"* and the startup
 * rescue's *"project cache is already at least as complete"* — compared COUNTS,
 * and a count cannot tell 2267 chunks from 2267 different chunks: a cache
 * holding {0,1,2} is not "at least as complete" as a source holding {1,2,3}.
 *
 * So all three ask this module, and they ask it the same question:
 *
 *   cacheIsAtLeastAsComplete(cacheChunks, sourceChunks)   ← superset, by INDEX
 *
 * and when it is false they MERGE through `mergeSessionTree` rather than
 * skipping (losing the source) or replacing (losing the cache). Nothing here
 * ever deletes anything in the cache.
 *
 * Pure but for `fs`: no electron, no queue, no bridge state — which is what lets
 * `tools/test-session-cache-merge.js` drive Owen's exact case on a temp dir.
 */
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';

import { COPY_CONCURRENCY, retryWeather, runBounded } from './bounded-copy';

/**
 * The extensions a rendered chunk can have. `.flac` is what every engine writes
 * today; `.wav` is what older sessions in the library have, and the counters
 * this module replaces accepted both — so it still does, or a re-publish of an
 * old session would read as "nothing rendered".
 */
export const CHUNK_AUDIO_EXTENSIONS = ['.flac', '.wav'] as const;

/**
 * How much newer a source file must be before it overwrites the cache's copy.
 *
 * The cache is a shared SMB tree written by two machines whose clocks agree to
 * about a second, and SMB/FAT timestamp granularity is 1–2 s. Without the slack
 * every publish would re-copy every file it already published, forever.
 */
export const NEWER_BY_MS = 1000;

/**
 * The chunk index a file name carries, or `null` when the file is not a rendered
 * chunk. `0007.flac` → 7. The index is the identity — NOT the file name — so a
 * session that ever changes its zero-padding still compares correctly.
 */
export function chunkIndexOf(fileName: string): number | null {
  if (fileName.startsWith('.')) return null; // `.tmp-0007.flac`, `._0007.flac`
  const ext = path.extname(fileName).toLowerCase();
  if (!(CHUNK_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return null;
  const stem = fileName.slice(0, -ext.length);
  if (!/^\d+$/.test(stem)) return null;
  return Number.parseInt(stem, 10);
}

/**
 * Every rendered chunk in `sentencesDir`, as index → file name.
 *
 * `isFile()`, deliberately: a DIRECTORY called `0007.flac` (which is what a
 * half-finished copy over SMB can leave behind) holds no audio, and counting it
 * as a rendered chunk is how a publish would call itself complete over a hole.
 * A missing directory is an empty set, never an error — "nothing rendered yet"
 * is an ordinary answer here.
 */
export async function renderedChunkFiles(sentencesDir: string): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sentencesDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const index = chunkIndexOf(entry.name);
    if (index === null) continue;
    found.set(index, entry.name);
  }
  return found;
}

/** The set of chunk indices rendered into `sentencesDir`. */
export async function renderedChunkSet(sentencesDir: string): Promise<Set<number>> {
  return new Set((await renderedChunkFiles(sentencesDir)).keys());
}

/** The indices `source` has that `cache` does not, in order. */
export function missingFrom(cache: ReadonlySet<number>, source: ReadonlySet<number>): number[] {
  const missing: number[] = [];
  for (const index of source) if (!cache.has(index)) missing.push(index);
  return missing.sort((a, b) => a - b);
}

/**
 * THE ONE COMPARISON. "At least as complete" is `cache ⊇ source` by index — never
 * `cache.size >= source.size`, which is the reading that let a five-chunk cache
 * stand in for a 2267-chunk render.
 */
export function cacheIsAtLeastAsComplete(
  cache: ReadonlySet<number>,
  source: ReadonlySet<number>,
): boolean {
  for (const index of source) if (!cache.has(index)) return false;
  return true;
}

export interface PublishPlan {
  /** How many chunks the cache holds now. */
  readonly cached: number;
  /** How many chunks the source holds. */
  readonly source: number;
  /** Indices the source has and the cache lacks — what a publish must copy. */
  readonly missing: number[];
  /**
   * Indices both hold where the source's file is newer by more than
   * `NEWER_BY_MS` — a re-render (Correct Sentences) the cache has not seen.
   * Copied too: the union is of RENDERS, and the newer render of an index is the
   * one the book should carry.
   */
  readonly newerInSource: number[];
}

/** What publishing `sourceSentencesDir` onto `destSentencesDir` still owes. */
export async function publishPlan(
  sourceSentencesDir: string,
  destSentencesDir: string,
): Promise<PublishPlan> {
  const source = await renderedChunkFiles(sourceSentencesDir);
  const dest = await renderedChunkFiles(destSentencesDir);
  const missing: number[] = [];
  const newerInSource: number[] = [];
  for (const [index, name] of source) {
    const cachedName = dest.get(index);
    if (cachedName === undefined) { missing.push(index); continue; }
    const [srcStat, dstStat] = await Promise.all([
      fs.stat(path.join(sourceSentencesDir, name)).catch(() => null),
      fs.stat(path.join(destSentencesDir, cachedName)).catch(() => null),
    ]);
    if (srcStat && dstStat && srcStat.mtimeMs > dstStat.mtimeMs + NEWER_BY_MS) {
      newerInSource.push(index);
    }
  }
  return {
    cached: dest.size,
    source: source.size,
    missing: missing.sort((a, b) => a - b),
    newerInSource: newerInSource.sort((a, b) => a - b),
  };
}

/**
 * Copy one file through a `.tmp-` sibling and rename it into place.
 *
 * The library is a Syncthing-synced SMB tree: a reader must never see a
 * half-written chunk, and the app's rule is that every write into the library is
 * atomic. The temp name is removed on failure so a retry does not inherit it.
 */
export async function copyFileAtomic(sourcePath: string, destPath: string): Promise<void> {
  const dir = path.dirname(destPath);
  const temp = path.join(dir, `.tmp-${path.basename(destPath)}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.copyFile(sourcePath, temp);
    await fs.rename(temp, destPath);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface MergeFailure {
  /** Path relative to the session dir, so a log line names the chunk. */
  readonly relPath: string;
  readonly error: string;
}

export interface MergeReport {
  /** True when source and destination are the same directory (a resume job). */
  readonly samePath: boolean;
  /** Files copied into the cache (new or newer). */
  readonly copied: string[];
  /** Files the cache already had, unchanged. */
  readonly kept: number;
  readonly failures: MergeFailure[];
}

/**
 * MOVE one file into the cache, or copy it when a move cannot reach.
 *
 * ── Why this exists (measured, 2026-09-20) ────────────────────────────────
 *
 * The scratch session and the project cache were the SAME FILESYSTEM whenever
 * the scratch root was derived from the library root, which was every ordinary
 * install until 2026-09-21 — and that has nothing to do with which machine
 * rendered the book: a Crucible's artifacts are downloaded into this machine's
 * scratch wherever they were generated. So publishing *Shift* dragged 2.5 GB
 * across SMB to land it a few directories away. Measured on the live share that
 * evening:
 *
 *   one 20 MB file, copied          27.9 MB/s
 *   100 chunk-sized files, copied    4.7 files/s   (0.21 s each — round trips)
 *   a directory of 100, renamed      0.05 s
 *
 * The cost is the per-file round trip, so the fix is not to copy faster; it is
 * not to copy. `rename` either succeeds — the two paths are one filesystem — or
 * fails `EXDEV`, which is the operating system stating a fact rather than this
 * code guessing one. No probe, no configuration, and no branch on which server
 * rendered the book.
 *
 * ── AND SINCE 2026-09-21 THE `EXDEV` ARM IS THE ORDINARY ONE ───────────────
 *
 * The scratch root is machine-local now (`narrator-paths.ts` header: a burst of
 * ~2,700 metadata ops on the share wedged the Mac's SMB client, twice in two
 * days), so a publish always crosses a volume and always lands in the copy
 * below. That is the trade taken deliberately: the share is written ONCE, with
 * finished files, instead of carrying every chunk of the render as it is made.
 * The copy is bounded and retried — `bounded-copy.ts` — and the rename arm
 * stays for whoever points "Narrator scratch folder" back at the library.
 *
 * `rename` is atomic by itself, so unlike {@link copyFileAtomic} there is no
 * `.tmp-` dance: a reader either sees the old file or the new one.
 */
export async function moveFileAtomic(sourcePath: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  try {
    await fs.rename(sourcePath, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Different filesystems: the only way across is through this process.
    await copyFileAtomic(sourcePath, destPath);
  }
}

export interface MergeOptions {
  /**
   * How one file gets into the cache. Defaults to the atomic COPY, which leaves
   * the source where it is — the right answer for a caller that still needs it.
   * The render's own publish passes {@link moveFileAtomic}: it is handing the
   * session over, not lending it. Also the keeper's seam for making one file
   * fail.
   */
  readonly copyFile?: (sourcePath: string, destPath: string) => Promise<void>;
  /**
   * How many files may be in flight. Defaults to `COPY_CONCURRENCY` (4) —
   * `bounded-copy.ts` carries the measurement and the reason the ceiling is
   * low. The walk used to copy strictly one at a time, which was free while the
   * scratch and the cache were one volume and is 0.21 s per file now that the
   * scratch is machine-local and every file crosses SMB.
   */
  readonly concurrency?: number;
  /** Told when one file is waiting out weather, so a long publish can say so. */
  readonly onRetry?: (relPath: string, attempt: number, waitMs: number, err: unknown) => void;
}

/**
 * ADD, NEVER REMOVE. Walk `sourceDir` and give the cache every file it lacks,
 * plus every file the source has a newer version of (`NEWER_BY_MS`). Nothing in
 * the destination is ever deleted or truncated, and a file the cache has and the
 * source does not is left exactly where it is — which is what makes this safe to
 * run against a cache published by an interrupted earlier run of the same book.
 *
 * Relative paths are preserved, so the `<hash>/chapters/sentences` level, the
 * per-chunk `.provenance.json` sidecars, `gaps.json` and `session-state.json`
 * all land where the session expects them without any of them being named here.
 *
 * One file's failure does not stop the walk: the caller's verification decides
 * whether the publish succeeded, and it should hear about every hole, not the
 * first.
 */
export async function mergeSessionTree(
  sourceDir: string,
  destDir: string,
  options: MergeOptions = {},
): Promise<MergeReport> {
  const copyFile = options.copyFile ?? copyFileAtomic;
  const copied: string[] = [];
  const failures: MergeFailure[] = [];
  let kept = 0;

  if (path.resolve(sourceDir).toLowerCase() === path.resolve(destDir).toLowerCase()) {
    /*
     * SOURCE IS DESTINATION. There is nothing to copy, and copying a file onto
     * itself would truncate it.
     *
     * THE QUEUE NO LONGER REACHES THIS ARM. It was the resume's ordinary state
     * — a resume rendered straight into the project cache — until 2026-09-21,
     * when the render's workplace moved onto the machine doing the work
     * (`resume-materialize.ts`). What still reaches it is a caller that hands a
     * CACHE directory as the session: the `session-cache:save-to-project` IPC
     * door (whatever path the renderer passes it) and anything that regenerates
     * into an already-published session — Correct Sentences, the CLI's partial
     * cache on Ctrl-C. So the arm stays, and it stays correct: publishing a
     * directory onto itself is a no-op, not a hole.
     */
    return { samePath: true, copied, kept, failures };
  }

  /*
   * THE WALK IS THE PLAN; THE COPYING IS BOUNDED AND OVERLAPPED.
   *
   * Reading the directories is cheap and ordered; deciding and moving each file
   * is a round trip, and since 2026-09-21 every one of those round trips is
   * across SMB (the scratch is machine-local now, so the cache is always the far
   * side). Four at a time, each retried through `retryWeather` — see
   * `bounded-copy.ts` for both numbers and why the ceiling is deliberately low.
   *
   * The report stays in PLAN ORDER, so two runs of the same publish can be
   * compared line by line.
   */
  const planned: string[] = [];
  const walk = async (relDir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(sourceDir, relDir), { withFileTypes: true });
    } catch (err) {
      failures.push({ relPath: relDir || '.', error: (err as Error).message });
      return;
    }
    for (const entry of entries) {
      // `.tmp-` names are another publish's half-written file, and a dot file in
      // a session is never part of the render.
      if (entry.name.startsWith('.')) continue;
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) { await walk(rel); continue; }
      if (!entry.isFile()) continue;
      planned.push(rel);
    }
  };

  await walk('');

  type Outcome = 'kept' | 'copied' | MergeFailure;
  const outcomes = await runBounded<string, Outcome>(
    planned, options.concurrency ?? COPY_CONCURRENCY, async (rel) => {
      const from = path.join(sourceDir, rel);
      const to = path.join(destDir, rel);
      let needed = true;
      const dstStat = await fs.stat(to).catch(() => null);
      if (dstStat) {
        const srcStat = await fs.stat(from).catch(() => null);
        needed = !!srcStat && srcStat.mtimeMs > dstStat.mtimeMs + NEWER_BY_MS;
      }
      if (!needed) return 'kept';
      try {
        await retryWeather(() => copyFile(from, to), {
          onRetry: (attempt, waitMs, err) => options.onRetry?.(rel, attempt, waitMs, err),
        });
        return 'copied';
      } catch (err) {
        return { relPath: rel, error: (err as Error).message };
      }
    });

  for (let i = 0; i < planned.length; i++) {
    const outcome = outcomes[i];
    if (outcome === 'kept') kept += 1;
    else if (outcome === 'copied') copied.push(planned[i]!);
    else if (outcome !== undefined) failures.push(outcome);
  }

  return { samePath: false, copied, kept, failures };
}

/** How many indices a refusal spells out before it says "…". */
const NAMED_MISSING = 5;

/**
 * The sentence a failed publish carries. It names the COUNT and the first few
 * INDICES, because "the cache is incomplete" is what the old log line already
 * failed to say: an operator reading this must be able to go and look at
 * `<sentencesDir>/<index>.flac` and see for themselves.
 */
export function missingChunksSentence(
  missing: readonly number[],
  counts: { cached: number; source: number },
  where: { source: string; cache: string },
): string {
  const head = missing.slice(0, NAMED_MISSING).join(', ');
  const tail = missing.length > NAMED_MISSING ? `, … (+${missing.length - NAMED_MISSING} more)` : '';
  return (
    `the project cache is missing ${missing.length} of the ${counts.source} rendered chunk(s) `
    + `after the merge — it holds ${counts.cached}. Missing: ${head}${tail}. `
    + `The audio is still in ${where.source}; the cache is ${where.cache}. `
    + `Nothing was deleted: the chunks can be published again once the cause is cleared.`
  );
}
