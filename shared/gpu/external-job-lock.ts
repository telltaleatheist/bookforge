/**
 * THE EXTERNAL-GPU-JOB LOCK, read in one place.
 *
 * Any process outside this Electron instance — a training chain, a headless CLI
 * render, a hand-run experiment — may create
 * `%APPDATA%\BookForge\external-gpu-job.lock` (content: a free-text description of
 * what it is doing) to say it is using the card.
 *
 * While it exists, every GLOBAL pattern-based sweep is skipped, loudly. That rule
 * is not theoretical: on 2026-07-20 a global orphan sweep nearly killed an active
 * training chain, because a training run and an audiobook worker are the same
 * process pattern on the same WSL VM and a pattern cannot tell them apart.
 * Session-scoped kills — this app's own tracked workers — are unaffected, and the
 * scheduler reads the same lock so it holds politely instead of queueing work onto
 * a busy card.
 *
 * ── Why it lives in shared/ ─────────────────────────────────────────────────
 *
 * It had two byte-identical implementations: `parallel-tts-bridge.ts` (which the
 * sweeps call) and `queue-engine.ts` (which the scheduler calls). Two copies of a
 * safety interlock is one copy that can be fixed while the other is not — and the
 * failure mode of the stale one is silent, since a lock it fails to notice just
 * means the sweep proceeds. `shared/` because `queue-engine.ts` deliberately
 * imports no Electron and no bridges; this needs only node builtins.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** The lock's description, or null when no external job holds the GPU. */
export function externalGpuJobLock(): string | null {
  // Windows-only: the lock is a convention between this app and the Windows-side
  // training tooling that shares its GPU. A Mac has no second claimant.
  if (os.platform() !== 'win32') return null;
  const appData = process.env['APPDATA'];
  if (!appData) return null;
  const p = path.join(appData, 'BookForge', 'external-gpu-job.lock');
  if (!fs.existsSync(p)) return null;
  try {
    // An unreadable or empty lock still COUNTS. The question is "is someone
    // holding the card", and a file that exists answers yes however badly it
    // reads; returning null on a read error would turn a permissions problem into
    // a green light for a sweep.
    return fs.readFileSync(p, 'utf-8').trim() || '(empty lock file)';
  } catch {
    return '(unreadable lock file)';
  }
}
