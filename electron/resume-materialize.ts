/**
 * A RESUME RENDERS ON THIS MACHINE, NOT INTO THE LIBRARY.
 *
 * ── The finding (2026-09-21) ────────────────────────────────────────────────
 *
 * The durable project cache — `stages/03-tts/sessions/<lang>/ebook-<uuid>/` — is
 * on the shared library, which is a NAS tree reached over SMB by both machines.
 * `resumeParallelConversion` BOUND the resume to it: `prepInfo.sessionDir` and
 * `prepInfo.processDir` were the cache's own directories, so the worker's
 * `--sentences_dir` pointed at the share and every chunk the render made — plus
 * every `session-state.json` rewrite and, for a Crucible render, every
 * downloaded `<index>.flac` and `<index>.flac.provenance.json` — was written
 * straight onto it, thousands of files over the run. That is the traffic that
 * wedged the Mac's SMB client twice in two days.
 *
 * It was not a mistake when it was written: the cache was "always readable
 * Windows NTFS" and the alternative at the time was a `\\wsl$` path that could
 * be gone. What changed is the scratch root (`narrator-paths.ts`, 2026-09-21):
 * it is machine-local now, so there is somewhere better to render.
 *
 * ── What this module does ───────────────────────────────────────────────────
 *
 * Copies the part of the cached session a resume actually needs — its
 * `session-state.json` and the rendered chunks that form the SKIP SET — down
 * into local scratch under the SAME `ebook-<uuid>` name, so the render's own ids
 * and the publish's destination are unchanged. The render then fills in the
 * missing chunks locally and the ordinary publish merges the whole session back
 * by the union rule (`session-cache-merge.ts`): one bounded copy up, then the
 * atomic rename.
 *
 * WHAT IT DELIBERATELY DOES NOT BRING DOWN: the per-chunk `.provenance.json`
 * sidecars of chunks that are already published (they are already in the cache,
 * and the merge never removes anything), and `chapters/<n>.flac` — the chapter
 * closer's pre-encoded chapters, which are a second copy of the same audio. Half
 * the files and about half the bytes, for nothing the render reads.
 *
 * WHAT MAKES THE SKIP SET THE SKIP SET: narrator is handed `--sentences_dir` and
 * skips every index whose FLAC is already on disk and larger than
 * `RESUME_MIN_BYTES`. So a chunk that does not arrive here is simply rendered
 * again — correct, but paid for twice — and a chunk that arrives TRUNCATED would
 * be re-rendered anyway. Nothing about the resume's correctness rests on this
 * copy being complete; the publish's set comparison is what judges the result.
 */
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';

import { COPY_CONCURRENCY, retryWeather, runBounded, type CopyFailure } from './bounded-copy';
import { NEWER_BY_MS } from './session-cache-merge';
import { RESUME_MIN_BYTES } from './render-carryover';

export interface MaterializeReport {
  /** The local `ebook-<uuid>` the render will work in. */
  readonly sessionDir: string;
  /** The local directory holding `session-state.json`. */
  readonly processDir: string;
  /** The local `chapters/sentences`. */
  readonly sentencesDir: string;
  /** Files brought down, relative to the session dir. */
  readonly copied: readonly string[];
  /** Files local scratch already had, unchanged. */
  readonly kept: number;
  /** Files that could not be brought down, after their retries were spent. */
  readonly failures: readonly CopyFailure[];
}

export interface MaterializeOptions {
  readonly concurrency?: number;
  /** The keeper's seam, and the place a clone would go on a same-volume scratch. */
  readonly copyFile?: (from: string, to: string) => Promise<void>;
  readonly onRetry?: (rel: string, attempt: number, waitMs: number, err: unknown) => void;
}

/** Is this the name of a rendered chunk — `0007.flac` — rather than a sidecar? */
function isChunkAudio(name: string): boolean {
  return /^\d+\.(flac|wav)$/i.test(name);
}

/** Copy `from` onto `to` only if `to` is absent or older. Answers what it did. */
async function placeIfNeeded(
  from: string,
  to: string,
  copyFile: (from: string, to: string) => Promise<void>,
): Promise<'copied' | 'kept'> {
  const dstStat = await fs.stat(to).catch(() => null);
  if (dstStat) {
    const srcStat = await fs.stat(from).catch(() => null);
    if (!srcStat || srcStat.mtimeMs <= dstStat.mtimeMs + NEWER_BY_MS) return 'kept';
  }
  await copyFile(from, to);
  return 'copied';
}

/**
 * BRING A CACHED SESSION DOWN TO LOCAL SCRATCH so a resume can render into it.
 *
 * `cachedProcessDir` must lie under `cachedSessionDir` — that relative shape is
 * what the publish preserves, so the local copy keeps it and the merge back
 * lands file for file.
 *
 * The local session is ADDED TO, never replaced: a second resume of the same
 * book finds its own earlier chunks already there and brings down only what the
 * cache has gained since. One file's failure does not stop the rest; the caller
 * decides what an incomplete skip set means (it means the render reads those
 * chunks again, or — when the share is simply not answering — that the run
 * should stop before it starts).
 */
export async function materializeSessionLocally(
  cachedSessionDir: string,
  cachedProcessDir: string,
  scratchRoot: string,
  options: MaterializeOptions = {},
): Promise<MaterializeReport> {
  const processRel = path.relative(cachedSessionDir, cachedProcessDir);
  if (processRel.startsWith('..') || path.isAbsolute(processRel)) {
    throw new Error(
      `The session's process dir ${cachedProcessDir} is not inside its session dir `
      + `${cachedSessionDir}, so there is no shape to reproduce locally.`);
  }

  const sessionDir = path.join(scratchRoot, path.basename(cachedSessionDir));
  const processDir = path.join(sessionDir, processRel);
  const sentencesDir = path.join(processDir, 'chapters', 'sentences');

  /*
   * IT IS ALREADY HERE — and the test is REALPATH, not the string.
   *
   * `/var` is a symlink to `/private/var` on macOS and a library can be reached
   * through a mount alias, so two spellings of one directory are ordinary. A
   * caller that has not noticed would hand us the same directory twice, and
   * `copyFile(x, x)` TRUNCATES: the skip set would be destroyed by the act meant
   * to preserve it. Resolved both ways, once, before anything is created.
   */
  const sameDir = await (async () => {
    try {
      const [from, to] = await Promise.all([
        fs.realpath(cachedSessionDir),
        fs.realpath(sessionDir).catch(() => sessionDir),
      ]);
      return path.resolve(from) === path.resolve(to);
    } catch {
      return path.resolve(cachedSessionDir) === path.resolve(sessionDir);
    }
  })();
  if (sameDir) {
    return { sessionDir: cachedSessionDir, processDir: cachedProcessDir,
      sentencesDir: path.join(cachedProcessDir, 'chapters', 'sentences'),
      copied: [], kept: 0, failures: [] };
  }

  await fs.mkdir(sentencesDir, { recursive: true });

  const copyFile = options.copyFile ?? ((from, to) => fs.copyFile(from, to));
  const plan: { rel: string; from: string; to: string }[] = [];
  const failures: CopyFailure[] = [];

  // 1. The session's own state and whatever else sits beside it: the pack, the
  //    book, the persistent run state. Files only — the directories below it are
  //    handled by name, and `chapters/` in particular must NOT come whole.
  let processEntries: Dirent[] = [];
  try {
    processEntries = await fs.readdir(cachedProcessDir, { withFileTypes: true });
  } catch (err) {
    failures.push({ rel: processRel || '.', error: (err as Error).message });
  }
  for (const entry of processEntries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    plan.push({
      rel: path.join(processRel, entry.name),
      from: path.join(cachedProcessDir, entry.name),
      to: path.join(processDir, entry.name),
    });
  }

  // 2. The skip set: rendered chunk audio, and nothing else in that directory.
  const cachedSentencesDir = path.join(cachedProcessDir, 'chapters', 'sentences');
  let chunkEntries: Dirent[] = [];
  try {
    chunkEntries = await fs.readdir(cachedSentencesDir, { withFileTypes: true });
  } catch {
    /* nothing rendered in the cache — an ordinary answer, not a failure */
  }
  for (const entry of chunkEntries) {
    if (!entry.isFile() || !isChunkAudio(entry.name)) continue;
    plan.push({
      rel: path.join(processRel, 'chapters', 'sentences', entry.name),
      from: path.join(cachedSentencesDir, entry.name),
      to: path.join(sentencesDir, entry.name),
    });
  }

  const outcomes = await runBounded(
    plan, options.concurrency ?? COPY_CONCURRENCY, async (item) => {
      try {
        // A truncated chunk is one narrator re-renders anyway, so it is not
        // worth a round trip — and copying it would put a file in the skip set
        // that is not a rendered chunk.
        const srcStat = await fs.stat(item.from).catch(() => null);
        if (srcStat && isChunkAudio(path.basename(item.from)) && srcStat.size <= RESUME_MIN_BYTES) {
          return 'kept' as const;
        }
        return await retryWeather(() => placeIfNeeded(item.from, item.to, copyFile), {
          onRetry: (attempt, waitMs, err) => options.onRetry?.(item.rel, attempt, waitMs, err),
        });
      } catch (err) {
        return { rel: item.rel, error: (err as Error).message };
      }
    });

  const copied: string[] = [];
  let kept = 0;
  for (let i = 0; i < plan.length; i++) {
    const outcome = outcomes[i];
    if (outcome === 'copied') copied.push(plan[i]!.rel);
    else if (outcome === 'kept') kept += 1;
    else if (outcome !== undefined) failures.push(outcome);
  }

  return { sessionDir, processDir, sentencesDir, copied, kept, failures };
}
