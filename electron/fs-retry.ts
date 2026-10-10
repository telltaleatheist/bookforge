// Replacing a file on Windows can fail for reasons that have nothing to do with
// this app: any OTHER process holding a handle without FILE_SHARE_DELETE blocks
// the replace, and `unlink` is "delete-pending" (the name stays reserved until
// the last handle closes). The library lives on E:\Shared, which is watched by
// Syncthing (fsWatcher on, so a freshly written file is opened for hashing within
// seconds), by OneDrive, by Windows Defender's real-time scanner and by the search
// indexer — every one of them opens a new file the moment it appears.
//
// The behaviour is TRANSIENT: the right response is to retry, not to fail on the
// first try. This module is the single home for that retry so every place that
// replaces a file uses the same policy (reassembly's promotion had grown its own
// private copy of it; the transcript embed had none at all, which is how the
// Nuremberg audiobook shipped with no transcript on 2026-08-14).

import * as fs from 'fs';

/** EBUSY/EPERM/EACCES on Windows mean "someone else has it open right now". */
export function isTransientFsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

/**
 * A rename's refusal that NOTHING will let go of: Windows answers EPERM both for a
 * holder and for a directory renamed onto one that already exists. Only the first
 * is weather; the second is an answer, thrown at once (bounded-copy.ts drew the
 * same line first).
 */
function isAnAnswer(dest: string): boolean {
  try { return fs.statSync(dest).isDirectory(); } catch { return false; }
}

/** ~7 s total. For small files, where a holder is a momentary indexer read. */
export const SHORT_RETRY_DELAYS_MS = [100, 200, 400, 800, 1200, 1800, 2500];

/**
 * ~56 s total. For replacing a MULTI-GIGABYTE file: a sync client or virus
 * scanner reading a 1.4 GB audiobook end-to-end holds its handle for a minute or
 * more, so the short schedule expires long before the file is free (measured:
 * two independent 1.4 GB replaces of the same Nuremberg m4b, 84 s apart, both hit
 * EBUSY).
 */
export const LARGE_FILE_RETRY_DELAYS_MS = [
  250, 500, 1000, 2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000,
];

/**
 * `fs.renameSync`, retried while the failure looks like a transient Windows
 * sharing violation. Rethrows the LAST error when the schedule is exhausted or
 * the error is not transient — a caller must still be able to fail loudly.
 */
export async function renameWithRetry(
  src: string,
  dest: string,
  delaysMs: readonly number[] = SHORT_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(src, dest); return; }
    catch (e) {
      if (!isTransientFsError(e) || attempt >= delaysMs.length || isAnAnswer(dest)) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

/**
 * `fs.unlinkSync`, retried the same way. A file that is already gone is the
 * intended end state, so ENOENT returns cleanly; every other failure is rethrown.
 */
export async function unlinkWithRetry(
  target: string,
  delaysMs: readonly number[] = SHORT_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { fs.unlinkSync(target); return; }
    catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; // already gone
      if (!isTransientFsError(e) || attempt >= delaysMs.length) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

/**
 * `fs.renameSync`, retried the same way, for a SYNCHRONOUS writer — the wait holds
 * the thread (Atomics.wait), so it is for the writers that cannot await.
 *
 * MEASURED on the library's share, 2026-10-10: 300 replaces of a just-written file
 * on `\TITAN\iO` — 18 refused EPERM, each free again within 70–115 ms; the same
 * loop on the local disk, 0 of 300. A rename anywhere in this app goes through
 * this module (Owen: *"can we make it less fragile so a temporary error like that
 * doesnt kill the whole thing?"*), because which paths sit on the share is a fact
 * about one person's library and not about the code.
 */
export function renameSyncWithRetry(
  src: string,
  dest: string,
  delaysMs: readonly number[] = SHORT_RETRY_DELAYS_MS,
): void {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(src, dest); return; }
    catch (e) {
      if (!isTransientFsError(e) || attempt >= delaysMs.length || isAnAnswer(dest)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delaysMs[attempt]!);
    }
  }
}
