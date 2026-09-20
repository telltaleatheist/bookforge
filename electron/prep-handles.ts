/**
 * WHAT A STOP CAN REACH WHILE A BOOK IS BEING PACKED.
 *
 * ── The gap this closes (bug hunt 2026-09-19 §H, "A Prepare row cannot be
 *    cancelled") ───────────────────────────────────────────────────────────
 *
 * `prepareSession` spawns narrator's prep and waits on it, and until this file
 * existed the spawn was registered NOWHERE a stop could reach: `activeSessions`
 * — the map `stopParallelConversion` walks — is written by the RENDER door,
 * after prep has already returned. So `stopParallelConversion` answered `false`
 * for the whole of prep, and `prepare.cancel()` was deliberately empty and said
 * so. Pressing Stop on a prepare row aborted the STEP and left the python
 * running, writing into a scratch session nothing would ever read.
 *
 * That last part is the half that is not merely untidy. narrator's prep writes
 * `<scratch>/ebook-<uuid>/<process>/session-state.json`, and a session-state
 * file IS what a resume and the clean-session sweep key on
 * (`deleteSessionsForEpub`, `prepInfoForPreparedSession`). A prep killed
 * half-way can leave one describing chapters whose chunk texts were never
 * finished — a session a later run could mistake for a resumable one. So the
 * stop is not done until the directory is gone, and if it cannot be removed the
 * log says so BY NAME rather than leaving a plausible-looking ruin behind.
 *
 * ── Why the registry is here and not in the bridge ─────────────────────────
 *
 * `parallel-tts-bridge.ts` owns the SPAWN — how to kill a native child, how to
 * tear a WSL guest process down — and that knowledge is not moving. What lives
 * here is the bookkeeping: which job is preparing, what stops it, which
 * directory it is writing, and whether a stop has been asked for. The bridge
 * hands in a `stop` callback at the moment it spawns, so neither side has to
 * know the other's business and a keeper can drive the whole door with a real
 * child process and a real directory, no narrator involved
 * (`tools/test-queue-narration-plan.js` §6).
 *
 * ── One handle per JOB ID, opened by whoever gets there first ──────────────
 *
 * The queue's `prepare` row opens the handle for its whole run — including the
 * park cool-off it waits out before it asks anything, which a stop must also
 * break — and the bridge door underneath it opens the same one again. Rather
 * than making one of the two the owner (and the other remember not to close
 * it), {@link beginPrepare} hands back the SAME handle and counts the openers:
 * the entry is dropped when the last one releases it. An inline prep — the CLI,
 * the language-learning chain, a restored row with no prepare step — opens the
 * only one there is.
 */
import { promises as fs } from 'fs';
import path from 'path';

/**
 * A prep that was stopped, as the doors above it read it.
 *
 * Its own class so the bridge's `catch` can tell "the user stopped this" from
 * "narrator died": the engine already knows the step was stopped (it set
 * `stopRequested` before calling `cancel`), but the MESSAGE it files is this
 * one, and "Prep failed with code null" on a row the user stopped is a sentence
 * that sends somebody looking for a bug.
 */
export class PrepCancelled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepCancelled';
  }
}

/** The one thing a keeper and the bridge both need to name a scratch session. */
const SESSION_DIR_PREFIX = 'ebook-';

interface PrepEntry {
  readonly jobId: string;
  /** How many doors have opened this handle. The entry drops at zero. */
  openers: number;
  cancelled: boolean;
  readonly abort: AbortController;
  /** How to stop the spawn, handed in by whoever spawned it. */
  stop: (() => void | Promise<void>) | null;
  /** Settles when that spawn is gone — awaited before the directory is removed. */
  gone: Promise<unknown> | null;
  /** The scratch session being written, as THIS process reads it. */
  sessionDir: string | null;
}

const preparing = new Map<string, PrepEntry>();

/** What one prep run exposes to the code that is running it. */
export interface PrepHandle {
  readonly jobId: string;
  /** True once a stop has been asked for. */
  readonly cancelled: boolean;
  /** Aborts when a stop is asked for, so a wait inside prep can honour it. */
  readonly signal: AbortSignal;
  /**
   * HOW TO STOP THE SPAWN, and the promise that settles when it is gone.
   *
   * Both halves are required. Killing without waiting would have the directory
   * removed under a process that is still writing into it, which is how a
   * "cancelled" prep leaves a session behind anyway.
   */
  noteSpawn(stop: () => void | Promise<void>, gone: Promise<unknown>): void;
  /** The spawn has settled; there is nothing left to kill. */
  noteSpawnGone(): void;
  /**
   * The scratch session this prep is writing — the readable path, which for a
   * WSL prep is the UNC one, because this process is the one that must delete it.
   */
  noteSession(sessionDir: string): void;
  /**
   * Refuse here if a stop has landed. Called at the phase boundaries, because a
   * kill that arrives between two awaits has no process to interrupt and the
   * run would otherwise walk on into the next phase.
   */
  throwIfCancelled(what: string): void;
  /** This door is done with the handle. Idempotent. */
  release(): void;
}

/**
 * Open the handle for a prep, or take a second reference on the one that is
 * already open for this job. See the header for why both doors may ask.
 */
export function beginPrepare(jobId: string): PrepHandle {
  let entry = preparing.get(jobId);
  if (entry === undefined) {
    entry = {
      jobId,
      openers: 0,
      cancelled: false,
      abort: new AbortController(),
      stop: null,
      gone: null,
      sessionDir: null,
    };
    preparing.set(jobId, entry);
  }
  // Bound to a const so the closures below hold the ENTRY rather than a
  // possibly-reassigned local — the map is the registry, this is one row of it.
  const open = entry;
  open.openers += 1;
  let released = false;
  return {
    jobId,
    get cancelled() { return open.cancelled; },
    get signal() { return open.abort.signal; },
    noteSpawn(stop, gone) { open.stop = stop; open.gone = gone; },
    noteSpawnGone() { open.stop = null; open.gone = null; },
    noteSession(sessionDir) { open.sessionDir = sessionDir; },
    throwIfCancelled(what) {
      if (!open.cancelled) return;
      throw new PrepCancelled(`The book was not packed: preparing it was stopped ${what}.`);
    },
    release() {
      if (released) return;
      released = true;
      open.openers -= 1;
      if (open.openers <= 0) preparing.delete(jobId);
    },
  };
}

/** Is a prep in flight for this job? */
export function isPreparing(jobId: string): boolean {
  return preparing.has(jobId);
}

/**
 * STOP THE PREP THIS JOB IS RUNNING, and leave no session behind that a later
 * run could mistake for a resumable one.
 *
 * `false` when there is nothing to stop — which is the honest answer for a job
 * that has already moved on to the render, whose stop is
 * `stopParallelConversion`'s. Never throws: a stop that fails half-way must
 * still say what it managed, so every failure here is logged by name and the
 * next step is attempted anyway.
 */
export async function cancelPrepare(jobId: string): Promise<boolean> {
  const entry = preparing.get(jobId);
  if (entry === undefined) return false;
  if (entry.cancelled) return true;
  entry.cancelled = true;
  entry.abort.abort();

  const stop = entry.stop;
  const gone = entry.gone;
  if (stop !== null) {
    console.log(`[PREP] ${jobId}: stopping the prep spawn`);
    try {
      await stop();
    } catch (err) {
      console.error(`[PREP] ${jobId}: the prep spawn did not stop cleanly: ${String(err)}`);
    }
  }
  if (gone !== null) {
    /*
     * THE DIRECTORY IS NOT TOUCHED UNTIL THE WRITER IS GONE. A 15 s ceiling so
     * a wedged process cannot hold a Stop press open forever; when it expires
     * the removal is attempted anyway and both facts are logged, because a
     * half-removed session named in the log is recoverable and a silent wait is
     * not.
     */
    const timedOut = await Promise.race([
      gone.then(() => false, () => false),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), 15_000);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    if (timedOut) {
      console.error(
        `[PREP] ${jobId}: the prep spawn did not exit within 15s of being stopped — removing its `
        + 'session anyway; if the removal fails, the directory named below is the one to delete.');
    }
  }
  await discardPreparedSession(entry.sessionDir, jobId);
  return true;
}

/**
 * THE HALF-WRITTEN SESSION, REMOVED — or named in the log if it cannot be.
 *
 * Exported because it is the rule, not a detail: a cancelled prep may not leave
 * a `session-state.json` on disk, since that file is exactly what a resume and
 * the clean-session sweep read a session back from.
 *
 * The `ebook-` guard is a rail, not a check on the caller: every scratch session
 * narrator writes is `<root>/ebook-<uuid>` (`sessionHomeFor`), so a path that is
 * not one of those is a bug in the caller and removing it recursively would be
 * the kind of mistake nothing gives back.
 */
export async function discardPreparedSession(
  sessionDir: string | null,
  jobId: string,
): Promise<void> {
  if (sessionDir === null || sessionDir === '') return;
  if (!path.basename(sessionDir).startsWith(SESSION_DIR_PREFIX)) {
    console.error(
      `[PREP] ${jobId}: refusing to remove "${sessionDir}" — a narrator scratch session is `
      + `"${SESSION_DIR_PREFIX}<uuid>" and this is not one. Nothing was deleted.`);
    return;
  }
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
    console.log(
      `[PREP] ${jobId}: discarded the half-written session ${sessionDir} — a stopped prep must `
      + 'not leave one a later run could take for a resumable session.');
  } catch (err) {
    console.error(
      `[PREP] ${jobId}: the half-written session ${sessionDir} could NOT be removed `
      + `(${err instanceof Error ? err.message : String(err)}). It holds a partial `
      + 'session-state.json, which a resume or the clean-session sweep can read as a session '
      + 'that was packed. Delete it by hand.');
  }
}

/**
 * Wait, unless the prep is stopped first.
 *
 * The one waiting primitive a prep may use, and it exists because of where the
 * waiting happens: the `prepare` row cools off between parks (see
 * `queue-steps/prepare.ts`), and a Stop pressed during that wait has no process
 * to kill — only this to interrupt. Resolves on the timeout; throws
 * {@link PrepCancelled} the instant a stop lands.
 */
export function waitUnlessStopped(handle: PrepHandle, ms: number, what: string): Promise<void> {
  handle.throwIfCancelled(what);
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      handle.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(new PrepCancelled(`The book was not packed: preparing it was stopped ${what}.`));
    };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    handle.signal.addEventListener('abort', onAbort, { once: true });
  });
}
