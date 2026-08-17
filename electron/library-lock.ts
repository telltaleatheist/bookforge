/**
 * library-lock — the CROSS-MACHINE half of the manifest lock.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Owen's library is moving onto titan (the NAS), mounted over Samba by BOTH the
 * PC and the Mac, with both machines' BookForge instances reading and writing
 * it (ruling 2026-08-17: "i just want them to share a library and both to be
 * able to read/write to it"). Artifact writes are safe by nature — new files,
 * atomically renamed into place. The ONE dangerous operation is two machines
 * doing read-modify-write on the same `manifest.json` at the same moment: the
 * last writer silently discards the other's registration, which is how a
 * finished nine-hour narration disappears from a book's page.
 *
 * `manifest-service.acquireLock` already serializes writers WITHIN a process.
 * This module serializes them ACROSS machines, with the only primitive a plain
 * filesystem gives us that is atomic over SMB: exclusive create (`wx`). The
 * holder writes `.manifest.lock` beside the manifest, does its read-modify-
 * write, and unlinks. A second machine's create fails with EEXIST and waits.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 *  - WAITING has a deadline. A manifest write takes milliseconds; a lock that
 *    cannot be taken within `timeoutMs` means something is wrong, and the
 *    write REFUSES with the holder's name in the error (NO FALLBACKS — a
 *    write that "just goes ahead" is the lost-update bug with extra steps).
 *  - STALE locks are taken over. A crash between create and unlink leaves the
 *    file behind forever; a lock older than `staleMs` (measured from its
 *    mtime — the file is touched once, at creation) belongs to nobody living.
 *    A manifest write that legitimately holds the lock for a minute does not
 *    exist. Takeover unlinks and retries create, so if two waiters race the
 *    takeover, exclusive create still elects exactly one.
 *  - Release failure is survivable. If the unlink itself fails (a network
 *    hiccup at exactly the wrong moment), the lock goes stale and the next
 *    writer takes it over `staleMs` later. Logged, never thrown — the write
 *    it protected has already landed.
 *  - ENOENT on create propagates. The lock lives IN the project directory; a
 *    directory that is not there means the caller is writing a manifest into
 *    a project that does not exist, and the write itself would fail one step
 *    later anyway. Refusing here is the same refusal, earlier and clearer.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const MANIFEST_LOCK_FILENAME = '.manifest.lock';

interface LockTimings {
  /** How long a waiter keeps retrying before refusing the write. */
  timeoutMs: number;
  /** Age past which a lock belongs to a crashed process and is taken over. */
  staleMs: number;
  /** Pause between create attempts while waiting. */
  retryMs: number;
}

const timings: LockTimings = { timeoutMs: 20_000, staleMs: 60_000, retryMs: 150 };

/** Tests shorten these; production never calls this. */
export function configureLibraryLock(overrides: Partial<LockTimings>): void {
  Object.assign(timings, overrides);
}

/** What the holder writes into the lock file — for the human reading a refusal. */
function holderStamp(): string {
  return JSON.stringify({ host: os.hostname(), pid: process.pid, at: new Date().toISOString() });
}

async function describeHolder(lockPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const { host, pid, at } = JSON.parse(raw);
    return `${host} (pid ${pid}, since ${at})`;
  } catch {
    // Unreadable or already gone — the refusal still names the file.
    return 'an unidentified process';
  }
}

/**
 * Run `fn` while holding `<dir>/.manifest.lock` exclusively across machines.
 *
 * Always released on the way out, success or throw. Reentry is NOT supported —
 * the in-process lock in manifest-service is what keeps one process from
 * meeting its own lock, and every cross-machine caller goes through it first.
 */
export async function withManifestFileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(dir, MANIFEST_LOCK_FILENAME);
  const deadline = Date.now() + timings.timeoutMs;

  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(holderStamp(), 'utf-8');
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      let age: number | null = null;
      try {
        age = Date.now() - (await fs.stat(lockPath)).mtimeMs;
      } catch {
        // Stat lost a race with the holder's unlink — the lock is gone; retry
        // the create immediately.
        continue;
      }
      if (age !== null && age > timings.staleMs) {
        // Nobody living holds a manifest lock this long. Unlink and re-race
        // the create; if another waiter takes it over first, EEXIST comes
        // around again and the loop carries on.
        try {
          await fs.unlink(lockPath);
        } catch { /* someone else's takeover won — fine */ }
        continue;
      }
      if (Date.now() >= deadline) {
        const holder = await describeHolder(lockPath);
        throw new Error(
          `The manifest in ${path.basename(dir)} is locked by ${holder} and was not released `
          + `within ${Math.round(timings.timeoutMs / 1000)}s. Nothing was written.`,
        );
      }
      await new Promise((r) => setTimeout(r, timings.retryMs));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await fs.unlink(lockPath);
    } catch (err) {
      // The write inside already landed; a failed unlink only delays the next
      // writer until the stale takeover. Say it, don't throw it.
      console.error(`[LIBRARY-LOCK] could not release ${lockPath}:`, err);
    }
  }
}
