/**
 * Watch the corpus file an open labelling session was loaded from.
 *
 * The corpus is not the app's private state. Training tooling rewrites
 * labels.json in place — a block-merge pass swallows several block ids into one
 * merged unit — and it does that whether or not a book is open in the editor.
 * An editor holding the pre-merge snapshot then labels blocks that no longer
 * exist, and every one of those labels is refused by `saveCorpusLabels`'s id
 * guard. The guard is right; the loss is that the session was allowed to go on
 * being wrong for hours. On Jul 2026 that cost 8 hand labels on one book and 14
 * on another.
 *
 * So MAIN watches the file, not the renderer: main is where the corpus lives,
 * and a renderer reload (ng serve, a crash, a devtools refresh) must not be able
 * to drop the watch on a book that is still open.
 *
 * STAT POLLING, NOT fs.watch. The corpus master sits on an ExFAT volume, where
 * the change-notification path is not something to stake unsaved work on, and
 * where an external tool's write may arrive as a rename over the top rather than
 * a modification. One stat every five seconds per open book is free — this
 * watches at most as many files as there are open editor windows.
 *
 * A detected change FIRES ONCE and then stops that watch. The renderer's answer
 * to the event is to reload, which re-registers with the new fingerprint; a
 * watch that kept firing would stack dialogs on top of the reload it already
 * asked for.
 */

import * as fsPromises from 'fs/promises';
import type { WebContents } from 'electron';
import { fingerprintCorpusFile, type CorpusFingerprint } from './corpus-book';

/** What the renderer is told when the file under a session changes. */
export interface CorpusFileChanged {
  /** The corpus book's directory — the renderer matches this against its own. */
  dir: string;
  slug: string;
  /** Absolute path of the file that changed. */
  file: string;
  expected: { mtimeMs: number; size: number };
  /** Null when the file is gone (moved aside or deleted). */
  actual: { mtimeMs: number; size: number } | null;
  /** One sentence naming what happened, for the dialog. */
  detail: string;
}

const POLL_MS = 5000;

interface CorpusWatch {
  sender: WebContents;
  dir: string;
  slug: string;
  fingerprint: CorpusFingerprint;
  /**
   * True while THIS APP is rewriting the book — an OCR run. The point of the
   * watch is "somebody else changed this file", and a run that rebuilds
   * blocks.json after every page would otherwise report the app to itself, once
   * every five seconds, for the length of a 500-page book.
   */
  paused: boolean;
}

/**
 * Keyed by `WebContents.id`, so a window that opens a second corpus book
 * REPLACES its own watch rather than accumulating one per book it has ever
 * shown, and two editor windows watch independently.
 */
const watches = new Map<number, CorpusWatch>();
let timer: NodeJS.Timeout | null = null;

/**
 * Start (or retarget) the watch for the window that just loaded a corpus book.
 *
 * `fingerprint` null means the book has no snapshot file yet — a book that has
 * been added and not OCR'd. There is nothing for an external tool to rewrite, so
 * the watch is dropped rather than pointed at a path that does not exist.
 */
export function watchCorpusBook(
  sender: WebContents,
  book: { dir: string; slug: string; fingerprint: CorpusFingerprint | null },
): void {
  if (!book.fingerprint) {
    stopWatchingCorpusBook(sender.id);
    return;
  }

  watches.set(sender.id, {
    sender,
    dir: book.dir,
    slug: book.slug,
    fingerprint: book.fingerprint,
    paused: false,
  });

  // A window that goes away takes its watch with it. Without this the map would
  // hold a destroyed WebContents forever and the poll would keep statting for a
  // book nobody is looking at.
  sender.once('destroyed', () => stopWatchingCorpusBook(sender.id));

  ensureTimer();
}

/**
 * Accept a new revision for a window's watch — used after the app's OWN write.
 *
 * Without this every save would trip the watcher on the next tick and tell the
 * user their file had been rewritten by an external tool, which it had not.
 */
export function retargetCorpusWatch(senderId: number, fingerprint: CorpusFingerprint): void {
  const watch = watches.get(senderId);
  if (!watch) return;
  watch.fingerprint = fingerprint;
}

/**
 * Hold off while this app rewrites a book itself — an OCR run.
 *
 * By book directory, not by window: a run is started from one window and the
 * book may be open in another, and both are looking at the same file.
 */
export function pauseCorpusWatchesFor(dir: string): void {
  for (const watch of watches.values()) {
    if (watch.dir === dir) watch.paused = true;
  }
}

/**
 * Our own rewrite is finished: adopt what it produced and start watching again.
 *
 * A watch whose file no longer exists is DROPPED rather than fired, because
 * this app is what removed it — `claimBookForOcr` moves labels.json aside to
 * labels.orphaned-<stamp>.json at the start of every run, by design, since
 * re-OCR mints block ids none of those labels point at. The window is told the
 * run finished through its own channel and re-opens the book, which re-arms the
 * watch on whatever file the book now reads from.
 *
 * The one gap that leaves: a run that ERRORS does not make the picker re-read
 * the book (see `corpusOcrWatcher` there), so a book that was loaded from
 * labels.json and then failed mid-OCR ends up unwatched until it is reopened.
 * Its labels have already been orphaned by the run, so there is nothing left
 * for the watch to protect — but it is a gap, and it is here rather than
 * anywhere less obvious.
 */
export async function resumeCorpusWatchesFor(dir: string): Promise<void> {
  for (const [senderId, watch] of [...watches.entries()]) {
    if (watch.dir !== dir) continue;
    try {
      watch.fingerprint = await fingerprintCorpusFile(watch.fingerprint.file);
      watch.paused = false;
    } catch {
      console.warn(
        `[corpus-watch] ${watch.slug}: ${watch.fingerprint.file} did not survive this app's own ` +
        'run (labels are orphaned by re-OCR, by design). Watch dropped until the book is reopened.'
      );
      stopWatchingCorpusBook(senderId);
    }
  }
}

/** Stop watching for one window: the book closed, or the window did. */
export function stopWatchingCorpusBook(senderId: number): void {
  watches.delete(senderId);
  if (watches.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Open watches, for tests and for asserting nothing leaked. */
export function corpusWatchCount(): number {
  return watches.size;
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, POLL_MS);
  // Nothing about a labelling session should be the reason the process lives.
  timer.unref?.();
}

async function tick(): Promise<void> {
  for (const [senderId, watch] of [...watches.entries()]) {
    if (watch.sender.isDestroyed()) {
      stopWatchingCorpusBook(senderId);
      continue;
    }
    if (watch.paused) continue;

    let actual: CorpusFingerprint | null = null;
    try {
      actual = await fingerprintCorpusFile(watch.fingerprint.file);
    } catch {
      // Distinguish gone from unreadable: a tool that renames labels.json aside
      // (labels.orphaned-*.json) leaves no file, and that is a change like any
      // other. A transient read error would also land here, and reporting it
      // costs a reload the user can see the reason for — which beats guessing
      // it was nothing.
      try {
        await fsPromises.access(watch.fingerprint.file);
        continue;   // it is there and statted fine on the retry — not a change
      } catch { /* really gone */ }
    }

    const { fingerprint } = watch;
    if (actual && actual.mtimeMs === fingerprint.mtimeMs && actual.size === fingerprint.size) {
      continue;
    }

    stopWatchingCorpusBook(senderId);   // fires once; the reload re-registers
    const payload: CorpusFileChanged = {
      dir: watch.dir,
      slug: watch.slug,
      file: fingerprint.file,
      expected: { mtimeMs: fingerprint.mtimeMs, size: fingerprint.size },
      actual: actual ? { mtimeMs: actual.mtimeMs, size: actual.size } : null,
      detail: actual
        ? `It was ${fingerprint.size} bytes at ${new Date(fingerprint.mtimeMs).toLocaleString()} ` +
          `and is now ${actual.size} bytes at ${new Date(actual.mtimeMs).toLocaleString()}.`
        : 'The file is gone — it was moved aside or deleted.',
    };
    console.warn(`[corpus-watch] ${watch.slug}: ${fingerprint.file} changed. ${payload.detail}`);
    watch.sender.send('corpus:file-changed', payload);
  }
}
