/**
 * DISCARDING A TREE IN THE LIBRARY IS A RENAME. THE UNLINKS COME LATER, SLOWLY.
 *
 * ── The measurement this module exists for ─────────────────────────────────
 *
 * The library is ONE shared tree on a NAS, reached over SMB by both machines.
 * On 2026-09-21 a project delete — `fs.promises.rm(projectDir, {recursive:true})`
 * in `manifest-service.deleteProject` — issued **2,694 unlinks in 28 s** (~96
 * metadata operations a second) and the Mac's SMB client stalled mid-burst:
 * every process touching the share went into uninterruptible wait until a
 * reboot. Twice in two days. The mount is soft now (EIO after ~30 s instead of
 * a hang) and the NAS's server-side recycle bin is off, but the thing that
 * provokes it is unchanged — a burst of thousands of metadata operations from
 * the client — and `fs.rm(..., {recursive:true})` is exactly that burst, as
 * fast as the kernel can issue it.
 *
 * So library code does not remove trees any more. It DISCARDS them:
 *
 *   1. {@link discardLibraryTree} renames the tree, in ONE operation, into
 *      `<libraryRoot>/.trash/<basename>-<ISO>-<6 hex>`. Same volume, so it is a
 *      rename on the share: instant, atomic, one metadata operation. The
 *      user-facing delete is DONE the moment it returns — the project is gone
 *      from `projects/`, no scan can see it, no consumer can reach it.
 *   2. {@link startLibraryTrashRemover} drains `.trash` in the background at
 *      {@link UNLINKS_PER_SECOND}, one entry at a time, oldest first, yielding
 *      between files. A 2,694-file project takes ~67 s instead of 28 s, and at
 *      no point is the share asked for more than it wedged at.
 *
 * ── Weather, not misconfiguration ──────────────────────────────────────────
 *
 * The remover runs against a network share that can go away. That is a
 * TRANSIENT FAULT — the boundary in CLAUDE.md's rule 2 — so `EIO`/`ETIMEDOUT`
 * and the rest of {@link isWeather} PAUSE the drain and it is retried on the
 * next pass. Never a red row, never a crash, never a sentence to the user: the
 * files are already unreachable, and an hour later is as good as now. What IS
 * named by throwing is misconfiguration: a path outside the library, the
 * library root itself, a path already in `.trash`.
 *
 * ── The folder that will not move ──────────────────────────────────────────
 *
 * Measured the same day: a project was deleted while macOS QuickLook had its
 * archive PDF memory-mapped from a Finder preview. Over SMB an open file cannot
 * be unlinked, so the client silly-renamed it to `archive/.smbdeleteAAA34f44.4`
 * and `fs.rm` failed `ENOTEMPTY` on the parent's rmdir; Samba refuses to RENAME
 * a directory with an open file below it the same way
 * (`NT_STATUS_ACCESS_DENIED` → `EACCES`/`EPERM`). That is a holder, not a
 * failure — it stops being true when the file is closed — so the tree is MARKED
 * in place with {@link DISCARD_MARKER_NAME} instead, every scan skips a marked
 * tree, the caller gets a `note` to show rather than an error, and the remover
 * retries it on its own schedule. See {@link isHeld}.
 *
 * ── Both machines drain the same `.trash` ──────────────────────────────────
 *
 * There is no lock, and none is wanted. Two removers deleting the same tree is
 * harmless: whoever loses a file gets `ENOENT`, which this module treats as
 * "already gone, keep going". The only thing the two must not do is race a
 * rename that is still SETTLING in the other machine's directory cache, so an
 * entry younger than {@link SETTLE_GRACE_MS} is left alone.
 *
 * ── Stopping ───────────────────────────────────────────────────────────────
 *
 * The stop flag is checked between every single file, so quit is prompt. A
 * half-removed tree left in `.trash` is a CORRECT state, not damage: it is
 * already unreachable from the library, and the next start picks it up and
 * finishes it. That is the whole reason the rename comes first.
 *
 * ── Emptying it by hand ────────────────────────────────────────────────────
 *
 * `rm -rf "<library>/.trash"` — from the NAS's own shell if possible, where the
 * unlinks are local and no SMB client is involved. Nothing in the app depends
 * on anything in there.
 */
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { isWeather } from './bounded-copy';

/** The one directory name. Everything that scans the library skips it. */
export const TRASH_DIR_NAME = '.trash';

/**
 * THE USER'S PRESS, RECORDED IN A TREE THAT COULD NOT BE MOVED.
 *
 * Over SMB a directory holding an open file cannot be renamed and a file held
 * open cannot be unlinked (the client silly-renames it to `.smbdelete*` and the
 * parent's rmdir then answers `ENOTEMPTY`). Rather than fail the delete, the
 * tree gets this marker: every scan skips a tree carrying it, and the paced
 * remover keeps retrying until the holder lets go. It is what makes removing
 * the tree LATER a continuation of the user's press rather than the app
 * deciding on its own to delete somebody's folder.
 */
export const DISCARD_MARKER_NAME = '.bookforge-discarded';

/** What the marker holds. Written once; never edited. */
export interface DiscardMarker {
  readonly reason: string;
  readonly discardedAt: string;
  readonly by: string;
}

/**
 * ERRNOs THAT MEAN "SOMETHING IS HOLDING THIS", not "this cannot be done".
 *
 * `EACCES`/`EPERM` are Samba refusing to rename a directory with an open file
 * below it (`NT_STATUS_ACCESS_DENIED`); `ENOTEMPTY`/`EEXIST` are the rmdir of a
 * directory still holding the client's `.smbdelete*` stand-in; `EBUSY` is the
 * local spelling of the same situation. Every one of them stops being true when
 * the holder closes the file, so every one of them is retried rather than
 * reported.
 */
export const HELD_CODES: readonly string[] = ['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EEXIST'];

/** Is this failure a holder — worth retrying later — rather than an answer? */
export function isHeld(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && HELD_CODES.includes(code);
}

/**
 * HOW MANY UNLINKS A SECOND THE SHARE IS ASKED FOR.
 *
 * Forty. The burst that wedged the Mac's SMB client was 2,694 unlinks in 28 s —
 * about 96 a second, issued as fast as `fs.rm` could pump them. Forty is well
 * under half of that with room for the other machine draining the same `.trash`
 * at the same time, and it costs nothing a person can feel: the delete the user
 * pressed finished at the rename, and this is bookkeeping behind it. One
 * number, stated once — a per-caller dial would be a number nobody measured.
 */
export const UNLINKS_PER_SECOND = 40;

/**
 * HOW LONG AN ENTRY IS LEFT ALONE AFTER IT LANDS.
 *
 * Sixty seconds. Both machines drain the same `.trash` over SMB, where a
 * directory listing is cached and a rename takes a moment to become visible
 * everywhere; a remover that pounced on a brand-new entry could be walking a
 * tree the other machine's rename has not finished publishing. A minute is far
 * longer than that takes and far shorter than anybody cares about.
 */
export const SETTLE_GRACE_MS = 60_000;

/** How long the drain waits after the share refuses to answer. */
export const WEATHER_PAUSE_MS = 60_000;

/** How long the background remover sleeps when `.trash` is empty. */
export const IDLE_POLL_MS = 30_000;

/** Errors from removing a tree that mean "already gone" rather than a failure. */
function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT';
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Where the library is
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The library root, from its ONE authority — `manifest-service`.
 *
 * Required lazily, on purpose. `deleteProject` lives in the manifest service and
 * calls in here, so a top-level import would be a cycle; and a keeper that only
 * wants to test the rename-aside should not have to load the manifest service
 * and everything under it. Every caller may hand in an explicit root instead,
 * which is what the keeper does.
 */
function resolveLibraryRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const manifestService = require('./manifest-service') as typeof import('./manifest-service');
  return path.resolve(manifestService.getLibraryBasePath());
}

/** `<libraryRoot>/.trash`. */
export function libraryTrashDir(libraryRoot?: string): string {
  return path.join(resolveLibraryRoot(libraryRoot), TRASH_DIR_NAME);
}

/**
 * Is `absPath` inside `<libraryRoot>/.trash`?
 *
 * Exported so a scan can skip what this module owns without spelling the name
 * a second time.
 */
export function isInLibraryTrash(absPath: string, libraryRoot?: string): boolean {
  const trash = libraryTrashDir(libraryRoot);
  const rel = path.relative(trash, path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ─────────────────────────────────────────────────────────────────────────────
// The rename
// ─────────────────────────────────────────────────────────────────────────────

/** A discard name that cannot collide, and that a person can read. */
function trashNameFor(absPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${path.basename(absPath)}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export interface DiscardOptions {
  /** The library root, when the caller already has it (and for the keeper). */
  readonly libraryRoot?: string;
  readonly log?: (line: string) => void;
}

/** What a discard did. `found: false` means there was nothing there. */
export interface DiscardResult {
  /** Where the tree went, when the rename landed. */
  readonly trashPath: string | null;
  /**
   * True when something below the tree was held open and it was MARKED in place
   * instead (see {@link DISCARD_MARKER_NAME}). The delete still happened as far
   * as the user is concerned: the tree is invisible and the remover finishes it.
   */
  readonly markedInPlace: boolean;
  /** A sentence for the user, when there is one to say. */
  readonly note: string | null;
  readonly found: boolean;
}

/**
 * TAKE `absPath` OUT OF THE LIBRARY, NOW; let the remover unlink it later.
 *
 * The ONLY way library code removes a directory tree.
 *
 * ── When the rename is refused, the delete still happens ────────────────────
 *
 * Measured 2026-09-21: a project was deleted while macOS QuickLook had its
 * archive PDF memory-mapped from a Finder preview. Over SMB an open file cannot
 * be unlinked, so the macOS client SILLY-RENAMED it to
 * `archive/.smbdeleteAAA34f44.4` (smbd holds a read lease on it), `fs.rm` then
 * failed `ENOTEMPTY: directory not empty, rmdir '…/archive'`, and the user was
 * told "Couldn't delete 1 item". Samba likewise refuses to rename a DIRECTORY
 * with an open file anywhere below it — `NT_STATUS_ACCESS_DENIED`, which reaches
 * the client as `EACCES`/`EPERM` — so the rename-aside hits the same wall.
 *
 * That is weather, not misconfiguration: the holder closes, the `.smbdelete*`
 * file disappears by itself, and the rename (or the rmdir) then succeeds. So the
 * tree is MARKED in place with {@link DISCARD_MARKER_NAME} — the user's own
 * press, recorded where it happened, which is what makes finishing the job later
 * a continuation rather than stray deletion — every scan skips a marked tree,
 * and the paced remover retries it on its own schedule. The caller gets a `note`
 * to show instead of an error.
 *
 * Refuses, by name, three paths that would be a catastrophe rather than a
 * delete: one outside the library root, the library root itself, and one
 * already inside `.trash`.
 */
export async function discardLibraryTree(
  absPath: string,
  reason: string,
  opts: DiscardOptions = {},
): Promise<DiscardResult> {
  const root = resolveLibraryRoot(opts.libraryRoot);
  const target = path.resolve(absPath);

  const rel = path.relative(root, target);
  if (rel === '') {
    throw new Error(
      `Refusing to discard the library folder itself (${target}) for ${reason}. `
      + 'Every book in it would go with it.'
    );
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to discard ${target} for ${reason}: it is not inside the library `
      + `(${root}). Only library trees go through the trash; anything else is removed `
      + 'where it lives.'
    );
  }
  if (isInLibraryTrash(target, root)) {
    throw new Error(
      `Refusing to discard ${target} for ${reason}: it is already in ${TRASH_DIR_NAME}/ `
      + 'and the remover owns it. Discarding it twice would race that remover.'
    );
  }

  const trash = path.join(root, TRASH_DIR_NAME);
  const dest = path.join(trash, trashNameFor(target));
  const log = opts.log ?? console.log;

  const attempt = async (): Promise<NodeJS.ErrnoException | null> => {
    try {
      await fs.rename(target, dest);
      return null;
    } catch (err) {
      return err as NodeJS.ErrnoException;
    }
  };

  let failure = await attempt();
  if (failure && (failure.code === 'EXDEV' || failure.code === 'ENOENT' || failure.code === 'ENOTDIR')) {
    // Either `.trash` does not exist yet, or the source is gone. Make the
    // directory and ask once more — the answer to the second attempt tells the
    // two apart without a stat race in between.
    await fs.mkdir(trash, { recursive: true });
    failure = await attempt();
    if (failure && isGone(failure)) {
      return { trashPath: null, markedInPlace: false, note: null, found: false };
    }
  }

  if (failure && isHeld(failure)) {
    const note = await markDiscardedInPlace(target, reason, failure, log);
    return { trashPath: null, markedInPlace: true, note, found: true };
  }
  if (failure) {
    throw new Error(
      `Discarding ${target} for ${reason} failed: ${failure.message}. Nothing was removed.`
    );
  }

  log(
    `[library-trash] discarded ${path.relative(root, target)} for ${reason} `
    + `→ ${TRASH_DIR_NAME}/${path.basename(dest)}`
  );
  return { trashPath: dest, markedInPlace: false, note: null, found: true };
}

/**
 * Record the user's press INSIDE the tree that could not be moved.
 *
 * Written through a temp name and a rename, like every library write: a
 * half-written marker would be a tree nothing can classify. The rename of a file
 * INSIDE the directory is allowed even while a sibling below is held open —
 * Samba only refuses to move the directory itself.
 */
async function markDiscardedInPlace(
  target: string,
  reason: string,
  failure: NodeJS.ErrnoException,
  log: (line: string) => void,
): Promise<string> {
  const marker: DiscardMarker = {
    reason,
    discardedAt: new Date().toISOString(),
    by: os.hostname(),
  };
  const finalPath = path.join(target, DISCARD_MARKER_NAME);
  const tmpPath = `${finalPath}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(marker, null, 2), 'utf-8');
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    throw new Error(
      `Discarding ${target} for ${reason} failed: the folder could not be moved `
      + `(${failure.code ?? failure.message}) and the record of your deletion could not be `
      + `written into it either (${(err as Error).message}). Nothing was removed.`
    );
  }
  const note =
    `"${path.basename(target)}" is deleted, but one file in it is still open in another `
    + 'program (a preview, Finder, or the other machine) — the folder finishes clearing when '
    + 'it is closed.';
  log(
    `[library-trash] ${target} could not be moved (${failure.code ?? failure.message}); `
    + `marked ${DISCARD_MARKER_NAME} in place for ${reason}. The remover retries it.`
  );
  return note;
}

// ─────────────────────────────────────────────────────────────────────────────
// The paced remover
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The filesystem and the clock, injectable so the pace and the weather can be
 * tested without a network share and without waiting in real time.
 */
export interface RemoverDeps {
  readonly libraryRoot?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly readdir?: (dir: string) => Promise<Dirent[]>;
  readonly lstat?: (p: string) => Promise<{ mtimeMs: number; isDirectory(): boolean }>;
  readonly unlink?: (p: string) => Promise<void>;
  readonly rmdir?: (p: string) => Promise<void>;
  readonly opsPerSecond?: number;
  readonly graceMs?: number;
  readonly log?: (line: string) => void;
  /** Asked between every file. `true` ends the pass where it stands. */
  readonly stopped?: () => boolean;
}

interface Resolved {
  readonly root: string;
  readonly trash: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly readdir: (dir: string) => Promise<Dirent[]>;
  readonly lstat: (p: string) => Promise<{ mtimeMs: number; isDirectory(): boolean }>;
  readonly unlink: (p: string) => Promise<void>;
  readonly rmdir: (p: string) => Promise<void>;
  readonly opsPerSecond: number;
  readonly graceMs: number;
  readonly log: (line: string) => void;
  readonly stopped: () => boolean;
}

function resolveDeps(deps: RemoverDeps): Resolved {
  const root = resolveLibraryRoot(deps.libraryRoot);
  return {
    root,
    trash: path.join(root, TRASH_DIR_NAME),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? realSleep,
    readdir: deps.readdir ?? ((dir) => fs.readdir(dir, { withFileTypes: true })),
    lstat: deps.lstat ?? ((p) => fs.lstat(p)),
    unlink: deps.unlink ?? ((p) => fs.unlink(p)),
    rmdir: deps.rmdir ?? ((p) => fs.rmdir(p)),
    opsPerSecond: deps.opsPerSecond ?? UNLINKS_PER_SECOND,
    graceMs: deps.graceMs ?? SETTLE_GRACE_MS,
    log: deps.log ?? console.log,
    stopped: deps.stopped ?? (() => false),
  };
}

/** Thrown inside the walk when the stop flag went up. Never leaves the module. */
class Stopped extends Error {}

/**
 * The metering. One operation is allowed every `1000 / opsPerSecond` ms, on a
 * schedule rather than a sleep-per-file, so a slow share (where the operation
 * itself already took longer than the interval) is never slowed down twice.
 */
class Pacer {
  private nextAt = 0;
  constructor(private readonly deps: Resolved) {}
  async take(): Promise<void> {
    const interval = 1000 / this.deps.opsPerSecond;
    const now = this.deps.now();
    if (now < this.nextAt) await this.deps.sleep(this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + interval;
  }
}

export interface RemovedTree {
  readonly name: string;
  readonly files: number;
  readonly dirs: number;
  readonly seconds: number;
}

export interface DrainReport {
  /** Trees removed whole on this pass. */
  readonly removed: readonly RemovedTree[];
  /** Entries left alone because they are younger than the grace. */
  readonly settling: number;
  /**
   * Trees that could not be finished because something is holding a file open —
   * the QuickLook/`.smbdelete*` case. Not a failure: they are retried next pass.
   */
  readonly held: readonly string[];
  /** Set when the share stopped answering; the drain is paused, not failed. */
  readonly weather: string | null;
  /** Set when the stop flag went up mid-tree. */
  readonly stopped: boolean;
}

interface Counts { files: number; dirs: number; held: number }

/**
 * Remove one tree, one file at a time, at the pace.
 *
 * Depth first, files before their directory, so a stop (or a share that goes
 * away) leaves a shallower tree rather than a directory whose parent is gone.
 *
 * TWO KINDS OF "NO", AND NEITHER IS A FAILURE. `ENOENT` is the other machine's
 * remover getting there first, and is skipped. {@link isHeld} is somebody's open
 * file — including the client's own `.smbdelete*` stand-in for one, which is
 * why the parent's rmdir answers `ENOTEMPTY` — and is COUNTED, so the tree is
 * left in place and asked again on the next pass instead of being reported as
 * broken.
 */
async function removeTreePaced(
  absPath: string,
  deps: Resolved,
  pacer: Pacer,
  counts: Counts,
  skipName?: string,
): Promise<void> {
  if (deps.stopped()) throw new Stopped();

  let stat: { isDirectory(): boolean };
  try {
    stat = await deps.lstat(absPath);
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }

  if (!stat.isDirectory()) {
    await pacer.take();
    if (deps.stopped()) throw new Stopped();
    try {
      await deps.unlink(absPath);
      counts.files++;
    } catch (err) {
      if (isHeld(err)) { counts.held++; return; }
      if (!isGone(err)) throw err;
    }
    return;
  }

  let entries: Dirent[];
  try {
    entries = await deps.readdir(absPath);
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }
  for (const entry of entries) {
    // The marker goes LAST, and only once everything else is gone: it is what
    // keeps a part-removed tree invisible and claimed by the user's press.
    if (skipName !== undefined && entry.name === skipName) { counts.held++; continue; }
    await removeTreePaced(path.join(absPath, entry.name), deps, pacer, counts);
  }

  await pacer.take();
  if (deps.stopped()) throw new Stopped();
  try {
    await deps.rmdir(absPath);
    counts.dirs++;
  } catch (err) {
    if (isHeld(err)) { counts.held++; return; }
    if (!isGone(err)) throw err;
  }
}

/**
 * ONE PASS over `.trash`: oldest eligible entry first, until it is empty, the
 * stop flag goes up, or the share stops answering.
 *
 * Separated from the loop so a keeper can drive it directly — the pace, the
 * grace, the ENOENT-under-foot skip and the weather pause are all decided here.
 */
export async function drainLibraryTrashOnce(deps: RemoverDeps = {}): Promise<DrainReport> {
  const d = resolveDeps(deps);
  const removed: RemovedTree[] = [];
  const held: string[] = [];
  let settling = 0;
  const pacer = new Pacer(d);
  const done = (weather: string | null, stopped: boolean): DrainReport =>
    ({ removed, settling, held, weather, stopped });

  /** One tree, wherever it lives. Answers what to do with the pass. */
  const drainTree = async (
    full: string,
    label: string,
    skipName?: string,
  ): Promise<{ ok: boolean; weather: string | null; stopped: boolean; counts: Counts }> => {
    const counts: Counts = { files: 0, dirs: 0, held: 0 };
    const startedAt = d.now();
    try {
      await removeTreePaced(full, d, pacer, counts, skipName);
    } catch (err) {
      if (err instanceof Stopped) return { ok: false, weather: null, stopped: true, counts };
      if (isWeather(err)) {
        d.log(
          `[library-trash] the share stopped answering while removing ${label} `
          + `(${(err as Error).message}); ${counts.files} file(s) went, the rest waits for the `
          + 'next pass.'
        );
        return { ok: false, weather: (err as Error).message, stopped: false, counts };
      }
      throw err;
    }
    if (counts.held > 0) {
      held.push(label);
      d.log(
        `[library-trash] ${label} is not finished: ${counts.files} file(s) went, but something `
        + 'is still holding a file open in it (a preview, Finder, or the other machine). '
        + 'Retrying on the next pass.'
      );
      return { ok: false, weather: null, stopped: false, counts };
    }
    const seconds = Math.round((d.now() - startedAt) / 100) / 10;
    removed.push({ name: label, files: counts.files, dirs: counts.dirs, seconds });
    d.log(
      `[library-trash] removed ${label}: ${counts.files} file(s), ${counts.dirs} `
      + `folder(s) in ${seconds}s`
    );
    return { ok: true, weather: null, stopped: false, counts };
  };

  // ── `.trash`, oldest first ───────────────────────────────────────────────
  let names: Dirent[] = [];
  try {
    names = await d.readdir(d.trash);
  } catch (err) {
    if (isWeather(err)) return done((err as Error).message, false);
    if (!isGone(err)) throw err;
  }

  // Oldest first, so a `.trash` that has been accumulating drains in the order
  // it filled and a tree is never half-removed for longer than it must be.
  const aged: { name: string; mtimeMs: number }[] = [];
  for (const entry of names) {
    try {
      const st = await d.lstat(path.join(d.trash, entry.name));
      aged.push({ name: entry.name, mtimeMs: st.mtimeMs });
    } catch (err) {
      if (isGone(err)) continue;
      if (isWeather(err)) return done((err as Error).message, false);
      throw err;
    }
  }
  aged.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name));

  for (const entry of aged) {
    if (d.stopped()) return done(null, true);
    // A grace of 0 means "none" — not "anything not from the future", which is
    // what a bare comparison says when the entry's mtime is ahead of this
    // machine's clock (two machines, one share, no shared clock).
    if (d.graceMs > 0 && d.now() - entry.mtimeMs < d.graceMs) { settling++; continue; }

    const outcome = await drainTree(path.join(d.trash, entry.name), entry.name);
    if (outcome.stopped) return done(null, true);
    if (outcome.weather !== null) return done(outcome.weather, false);
  }

  // ── Trees that could not be MOVED, marked in place ───────────────────────
  //
  // A project delete that landed on an open file is marked rather than moved
  // (see `discardLibraryTree`). One readdir of `projects/` plus one stat per
  // project finds them — nothing next to the burst this module exists to avoid
  // — and the marked tree is drained exactly like a `.trash` entry, the marker
  // itself left for last so a part-drained tree stays invisible and claimed.
  const marked = await listMarkedTrees(d);
  if (marked.weather !== null) return done(marked.weather, false);
  for (const dir of marked.dirs) {
    if (d.stopped()) return done(null, true);
    const label = path.relative(d.root, dir);

    // Ask for the rename again first: once the holder lets go this is one
    // operation instead of a walk, and the tree then drains like any other.
    try {
      const dest = path.join(d.trash, trashNameFor(dir));
      await fs.mkdir(d.trash, { recursive: true });
      await fs.rename(dir, dest);
      d.log(`[library-trash] ${label} was released; moved to ${TRASH_DIR_NAME}/${path.basename(dest)}`);
      continue;
    } catch (err) {
      if (isGone(err)) continue;
      if (isWeather(err)) return done((err as Error).message, false);
      if (!isHeld(err)) throw err;
    }

    const outcome = await drainTree(dir, label, DISCARD_MARKER_NAME);
    if (outcome.stopped) return done(null, true);
    if (outcome.weather !== null) return done(outcome.weather, false);
    // Everything but the marker went: take the marker and the folder together.
    // If the folder still will not go, the marker is put straight back — the
    // window is microseconds and the tree has no manifest by now, so nothing
    // can see it in between either way.
    if (outcome.counts.held === 1) await finishMarkedTree(dir, label, d, pacer);
  }

  return done(null, false);
}

/**
 * THE PLACES A MARKED TREE CAN BE, and they are the places a WHOLE PROJECT is
 * deleted from: `projects/` and the language-learning feature's own
 * `language-learning/projects/`.
 *
 * Not every routed delete — a stage directory, a cached session, a chapter cache
 * is never what macOS is previewing, and a scan for markers everywhere would be
 * the recursive walk this module exists to avoid. Adding a root here is the one
 * edit a new kind of whole-project delete needs.
 */
const MARKED_TREE_ROOTS: readonly string[][] = [
  ['projects'],
  ['language-learning', 'projects'],
];

/** Every project directory carrying the discard marker. */
async function listMarkedTrees(d: Resolved): Promise<{ dirs: string[]; weather: string | null }> {
  const dirs: string[] = [];
  for (const segments of MARKED_TREE_ROOTS) {
    const parent = path.join(d.root, ...segments);
    let entries: Dirent[];
    try {
      entries = await d.readdir(parent);
    } catch (err) {
      if (isGone(err)) continue;
      if (isWeather(err)) return { dirs, weather: (err as Error).message };
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parent, entry.name);
      try {
        await d.lstat(path.join(dir, DISCARD_MARKER_NAME));
        dirs.push(dir);
      } catch (err) {
        if (isGone(err)) continue;
        if (isWeather(err)) return { dirs, weather: (err as Error).message };
        throw err;
      }
    }
  }
  return { dirs, weather: null };
}

/** The last two operations on a marked tree: the marker, then the folder. */
async function finishMarkedTree(
  dir: string, label: string, d: Resolved, pacer: Pacer,
): Promise<void> {
  const markerPath = path.join(dir, DISCARD_MARKER_NAME);
  let marker: string;
  try {
    marker = await fs.readFile(markerPath, 'utf-8');
  } catch (err) {
    if (isGone(err)) return;
    return; // Another remover is finishing it; nothing here to do.
  }
  await pacer.take();
  try {
    await d.unlink(markerPath);
  } catch (err) {
    if (!isGone(err)) return;
  }
  await pacer.take();
  try {
    await d.rmdir(dir);
    d.log(`[library-trash] removed ${label}: the folder that was held open is gone`);
  } catch (err) {
    if (isGone(err)) return;
    // Still held. Put the user's press back where it was — a tree with no
    // marker and no manifest would be a stray nothing may ever delete.
    try { await fs.writeFile(markerPath, marker, 'utf-8'); } catch { /* next pass re-reads */ }
  }
}

export interface TrashRemoverHandle {
  /** Ends the loop. Resolves once the pass in flight has stopped. */
  stop(): Promise<void>;
}

/**
 * Start the background drain. Idempotent per call site: the handle is the only
 * way to stop it, and a second start makes a second loop, so there is exactly
 * one — started at app ready and after `library:set-root` (the old loop is
 * stopped first, because the root it closed over is no longer the library).
 */
export function startLibraryTrashRemover(deps: RemoverDeps = {}): TrashRemoverHandle {
  let stopping = false;
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? realSleep;

  const loop = (async () => {
    while (!stopping) {
      let report: DrainReport;
      try {
        report = await drainLibraryTrashOnce({ ...deps, stopped: () => stopping });
      } catch (err) {
        // Misconfiguration — no library root, a permissions wall. Say it once
        // and keep the loop alive: the next pass runs after the user fixes it.
        log(`[library-trash] drain failed: ${(err as Error).message}`);
        await sleep(IDLE_POLL_MS);
        continue;
      }
      if (stopping || report.stopped) return;
      if (report.weather !== null) { await sleep(WEATHER_PAUSE_MS); continue; }
      // Something went this pass: come straight back, there may be more.
      // Nothing went: the trash is empty, everything in it is still settling, or
      // a tree is held open — all three of which are answered by waiting.
      if (report.removed.length === 0) await sleep(IDLE_POLL_MS);
    }
  })();

  return {
    async stop(): Promise<void> {
      stopping = true;
      await loop;
    },
  };
}
