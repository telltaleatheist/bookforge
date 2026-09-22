/**
 * COPYING A RENDERED SESSION ACROSS THE WIRE, A FEW FILES AT A TIME.
 *
 * ── Why this is not `fs.cp(..., {recursive: true})` ─────────────────────────
 *
 * Since 2026-09-21 the render's scratch is machine-local and the project cache
 * is on the shared library (`narrator-paths.ts` header), so a publish ALWAYS
 * crosses a volume boundary: `rename` answers `EXDEV` and every one of the
 * session's files has to travel. A 1,700-chunk book is ~3,400 files
 * (`<index>.flac` + `<index>.flac.provenance.json`), and `fs.cp` does them one
 * at a time. Measured on the live share on 2026-09-20: one 20 MB file copies at
 * 27.9 MB/s, but 100 chunk-sized files copy at 4.7 files/s — 0.21 s each, and
 * essentially all of that is the round trip, not the bytes.
 *
 * So the fix is overlap, and the ceiling is LOW ON PURPOSE. The same evening a
 * burst of ~2,700 metadata operations on that share wedged the Mac's SMB client
 * and with it the whole machine. Four in flight keeps the pipe busy without
 * turning a publish into that burst; it is a number, stated once, not a dial.
 *
 * ── Weather, not misconfiguration ───────────────────────────────────────────
 *
 * The share is mounted soft: an unanswered request fails with `EIO` after ~30 s
 * instead of hanging the process. That is a TRANSIENT FAULT — the boundary in
 * CLAUDE.md's rule 2 — so a file that fails that way is retried within a stated
 * budget ({@link WEATHER_BACKOFF_MS}, three retries at 2/5/10 s) and only then
 * given up on. What is never retried is a real answer: `ENOENT`, `EACCES`,
 * `ENOSPC` are facts about this copy that another attempt cannot change.
 *
 * Nothing here decides what a failed publish MEANS. It reports which file gave
 * up and why; the caller (`cacheSessionToProject`) is what owns the sentence
 * that names the share, the file and where the rendered session is still intact.
 */
import { constants as fsConstants, promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';

/**
 * HOW MANY FILES MAY BE IN FLIGHT AT ONCE.
 *
 * Four: enough to hide the per-file round trip on SMB, few enough that a
 * publish is not the metadata burst that wedged the client. One number, one
 * place — a per-caller override would be a dial nobody could measure.
 */
export const COPY_CONCURRENCY = 4;

/**
 * THE RETRY BUDGET FOR A TRANSIENT FAULT, in the order it is spent.
 *
 * Three retries after the first attempt — 17 s in all for one file — then the
 * copy is given up and the caller says so. Stated as a list rather than a
 * formula because the budget is the contract: a reader must be able to say how
 * long a publish can sit on one bad file.
 */
export const WEATHER_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * ERRNOs THAT MEAN "THE SHARE DID NOT ANSWER", not "this cannot be done".
 *
 * `EIO` is what a soft mount answers when a request times out, which is the
 * live case; the rest are the ordinary ways a network filesystem goes away and
 * comes back. Everything not on this list is a real answer and fails at once —
 * retrying `ENOENT` just spends the budget before saying the same thing.
 */
export const WEATHER_CODES: readonly string[] = [
  'EIO', 'ETIMEDOUT', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN', 'ENETRESET',
  'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'EAGAIN', 'EBUSY', 'ESTALE',
];

/** Is this failure weather — worth waiting out — or an answer? */
export function isWeather(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && WEATHER_CODES.includes(code);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `op`, waiting out weather within {@link WEATHER_BACKOFF_MS}.
 *
 * The last error is thrown when the budget is spent, so the caller's sentence
 * names what actually went wrong rather than "gave up". `onRetry` exists so a
 * long publish can say it is waiting instead of looking hung.
 */
export async function retryWeather<T>(
  op: () => Promise<T>,
  opts: { readonly onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
    readonly backoffMs?: readonly number[] } = {},
): Promise<T> {
  const backoff = opts.backoffMs ?? WEATHER_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= backoff.length || !isWeather(err)) throw err;
      const waitMs = backoff[attempt]!;
      opts.onRetry?.(attempt + 1, waitMs, err);
      await sleep(waitMs);
    }
  }
}

/**
 * HOW LONG A DIRECTORY RENAME WAITS FOR WHATEVER IS HOLDING THE TREE — about
 * five minutes in all, then the caller says so.
 *
 * Measured 2026-09-22 on *Pursuit of Power*: the publish copied 8,364 files
 * (13 GB) into `.tmp-<session>` on the NAS and the rename into place answered
 * `EPERM` — twice, fourteen minutes apart, each time straight after a copy — and
 * the same rename by hand a few minutes later took 212 ms. On an SMB share a
 * directory rename is refused while any handle is open anywhere inside it, and
 * a NAS indexing thousands of files it has just been handed holds them for a
 * while. That is weather for THIS operation, so it waits; five minutes because
 * the holder outlasted a 17-second budget and did not outlast six minutes.
 */
export const RENAME_HOLDER_BACKOFF_MS: readonly number[] = [
  2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000, 60_000,
];

/**
 * THE ANSWERS A RENAME GIVES WHILE SOMETHING HOLDS THE TREE — on top of the
 * ordinary {@link WEATHER_CODES}. Only for a rename: from `copyFile`, `EPERM` is
 * a real answer about permissions and waiting on it would only delay it.
 */
const RENAME_HOLDER_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY'];

/**
 * Rename a directory into place, waiting out a holder within
 * {@link RENAME_HOLDER_BACKOFF_MS}. The last error is thrown when the budget is
 * spent; `onWait` is told each wait so a row can SAY it is waiting.
 */
export async function renameWaitingForHolders(
  from: string,
  to: string,
  onWait?: (attempt: number, waitMs: number, err: unknown) => void,
): Promise<void> {
  const backoff = RENAME_HOLDER_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      // Windows answers EPERM for TWO things: a handle open inside the tree
      // (weather — it lets go) and a destination that already exists (an
      // answer — nothing lets go of that). Only the first is waited on.
      const occupied = await fs.stat(to).then(() => true, () => false);
      const held = !occupied && typeof code === 'string' && RENAME_HOLDER_CODES.includes(code);
      if (attempt >= backoff.length || !(held || isWeather(err))) throw err;
      const waitMs = backoff[attempt]!;
      onWait?.(attempt + 1, waitMs, err);
      await sleep(waitMs);
    }
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight, IN ORDER.
 *
 * Results land at their item's index, so a caller can report what was copied in
 * the order it planned it — an overlapped copy whose report came back shuffled
 * would make two runs of the same publish impossible to compare.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

/** One file to move, as {@link copyTreeBounded} planned it. */
export interface CopyPlanEntry {
  /** Path relative to the source root, so a report names the chunk. */
  readonly rel: string;
  readonly from: string;
  readonly to: string;
}

/** What went wrong with one file, after its retries were spent. */
export interface CopyFailure {
  readonly rel: string;
  readonly error: string;
}

export interface CopyTreeReport {
  readonly copied: readonly string[];
  readonly failures: readonly CopyFailure[];
}

/**
 * Every FILE under `sourceDir`, depth first, as a copy plan.
 *
 * Dot files are skipped for the same reason the merge skips them: `.tmp-` is
 * another publish's half-written file and a dot file in a session is never part
 * of the render. A directory that cannot be read is a failure with a name, not
 * a silently shorter plan.
 */
export async function planCopyTree(
  sourceDir: string,
  destDir: string,
): Promise<{ entries: CopyPlanEntry[]; dirs: string[]; failures: CopyFailure[] }> {
  const entries: CopyPlanEntry[] = [];
  const dirs: string[] = [];
  const failures: CopyFailure[] = [];

  const walk = async (rel: string): Promise<void> => {
    dirs.push(rel);
    let found: Dirent[];
    try {
      found = await fs.readdir(path.join(sourceDir, rel), { withFileTypes: true });
    } catch (err) {
      failures.push({ rel: rel || '.', error: (err as Error).message });
      return;
    }
    for (const entry of found) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) { await walk(childRel); continue; }
      if (!entry.isFile()) continue;
      entries.push({
        rel: childRel,
        from: path.join(sourceDir, childRel),
        to: path.join(destDir, childRel),
      });
    }
  };

  await walk('');
  return { entries, dirs, failures };
}

export interface CopyTreeOptions {
  readonly concurrency?: number;
  /** How one file travels. Defaults to a clone-where-possible `copyFile`. */
  readonly copyFile?: (from: string, to: string) => Promise<void>;
  /** Told when a file is waiting out weather, so a long publish can say so. */
  readonly onRetry?: (rel: string, attempt: number, waitMs: number, err: unknown) => void;
  /**
   * Files the destination MAY already hold from an earlier attempt of this
   * same copy. One of these is skipped when the destination has it at the
   * source's exact size; a short one (the copy that was interrupted mid-file)
   * or a missing one is copied. Only for files that never change once written —
   * a rendered chunk — never for a file the caller rewrites afterwards.
   */
  readonly reusable?: (rel: string) => boolean;
}

/** Does `to` already hold `from`'s bytes, as far as size can say? False when either is unreadable. */
async function alreadyLanded(from: string, to: string): Promise<boolean> {
  const [src, dst] = await Promise.all([
    fs.stat(from).catch(() => null),
    fs.stat(to).catch(() => null),
  ]);
  return src !== null && dst !== null && dst.isFile() && dst.size === src.size;
}

/**
 * The default traveller: clone-on-write where the filesystem supports it
 * (APFS/ReFS, which is the case when somebody has pointed the scratch back at
 * the library volume), an ordinary copy everywhere else. No `.tmp-` dance —
 * {@link copyTreeBounded}'s callers write into a temp directory that is renamed
 * into place as a whole, which is the atomicity the library needs.
 */
async function cloneOrCopy(from: string, to: string): Promise<void> {
  await fs.copyFile(from, to, fsConstants.COPYFILE_FICLONE);
}

/**
 * COPY A WHOLE TREE, {@link COPY_CONCURRENCY} FILES AT A TIME, EACH RETRIED.
 *
 * Directories are created first, all of them, so the copies do not race each
 * other into `mkdir`. One file's failure does not stop the rest: the caller
 * verifies the RESULT — the publish's rule is `cache ⊇ source` by chunk index —
 * and it should hear about every hole, not the first.
 */
export async function copyTreeBounded(
  sourceDir: string,
  destDir: string,
  options: CopyTreeOptions = {},
): Promise<CopyTreeReport> {
  const copyFile = options.copyFile ?? cloneOrCopy;
  const { entries, dirs, failures } = await planCopyTree(sourceDir, destDir);
  const allFailures: CopyFailure[] = [...failures];

  for (const rel of dirs) {
    try {
      await retryWeather(() => fs.mkdir(path.join(destDir, rel), { recursive: true }));
    } catch (err) {
      allFailures.push({ rel: rel || '.', error: (err as Error).message });
    }
  }

  const copied: string[] = [];
  const outcomes = await runBounded(
    entries,
    options.concurrency ?? COPY_CONCURRENCY,
    async (entry) => {
      try {
        if (options.reusable?.(entry.rel) && await alreadyLanded(entry.from, entry.to)) {
          return null;
        }
        await retryWeather(() => copyFile(entry.from, entry.to), {
          onRetry: (attempt, waitMs, err) => options.onRetry?.(entry.rel, attempt, waitMs, err),
        });
        return null;
      } catch (err) {
        return { rel: entry.rel, error: (err as Error).message };
      }
    },
  );
  for (let i = 0; i < entries.length; i++) {
    const outcome = outcomes[i];
    if (outcome === null) copied.push(entries[i]!.rel);
    else if (outcome !== undefined) allFailures.push(outcome);
  }

  return { copied, failures: allFailures };
}
