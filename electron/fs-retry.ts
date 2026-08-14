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
      if (!isTransientFsError(e) || attempt >= delaysMs.length) throw e;
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
