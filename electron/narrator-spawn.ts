/**
 * WHAT IS LEFT OF THE NARRATOR SPAWN, and it spawns nothing.
 *
 * This file built every command line BookForge sent to `python/narrator`. Step 8 (2026-11-05) deleted
 * that: prep, assembly and alignment are TypeScript (`electron/narrator/`), and Higgs serving is
 * Crucible's. Two facts outlived the spawn, because other code asks them: how narrator's engine ids are
 * spelled, and how a narrator process looks in a process list.
 */

import { shouldUseWsl2ForHiggs } from './tool-paths';

/**
 * The engine ids a session or a Crucible can name. `orpheus` is retired and nothing renders it, but old
 * sessions record it, so it still has a spelling. `xtts` is retired and is not one.
 */
export type NarratorEngineId = 'orpheus' | 'higgs';

/**
 * It is NOT the same string as BookForge's engine id for Higgs: BookForge says `higgs`, narrator says
 * `higgs-v3`, because narrator names a model generation and BookForge names a picker entry.
 */
const NARRATOR_ENGINE_ENV: Record<NarratorEngineId, string> = {
  orpheus: 'orpheus',
  higgs: 'higgs-v3',
};

/** BookForge's engine id as narrator spells it: the `tts_engine` a session records. */
export function narratorEngineId(engine: NarratorEngineId): string {
  return NARRATOR_ENGINE_ENV[engine];
}

/**
 * THE SAME TABLE READ BACKWARDS — narrator's engine id as BOOKFORGE spells it.
 *
 * A Crucible's `/v1/voices` names `narratorEngine` on every row, and that is the ONLY per-server
 * statement of which engines a machine can actually run. The narration modal's engine strip is built
 * from it (`voice-picker.ts`).
 *
 * DERIVED FROM `NARRATOR_ENGINE_ENV`, never a second literal. An id narrator names and BookForge has no
 * word for answers `null`: a new narrator engine is not silently read as one of ours.
 */
export function bookforgeEngineForNarrator(narratorEngine: string): NarratorEngineId | null {
  const id = narratorEngine.trim();
  for (const [ours, theirs] of Object.entries(NARRATOR_ENGINE_ENV) as [NarratorEngineId, string][]) {
    if (theirs === id) return ours;
  }
  return null;
}

/**
 * How the resident Listen/extension server is recognised in a process list, as a regex SOURCE string (it
 * goes into `pgrep -f` inside the WSL guest and into a PowerShell `-match` on Windows). The orphan reapers
 * EXCLUDE it, so a sweep can never kill a server a user is listening to. Crucible runs that server now,
 * which is why this outlived the spawn.
 */
export const SERVE_PROCESS_RE = 'narrator\\.serve';

/**
 * The batch doors as they appear in a process list. BookForge starts neither now; the reapers still hunt
 * one left by an older build. The dot is escaped because these go into `pgrep -f` and PowerShell `-match`.
 */
export const NARRATOR_WORKER_RE = 'narrator\\.compat\\.worker';
export const NARRATOR_APP_RE = 'narrator\\.compat\\.app';

/** Either batch door. Used where a sweep does not care which it caught. */
export const NARRATOR_BATCH_RE = 'narrator\\.compat\\.(worker|app)';

/** Is this engine's WSL toggle on, on this machine? */
export function narratorRunsInWsl(engine: NarratorEngineId | undefined): boolean {
  return process.platform === 'win32' && engine === 'higgs' && shouldUseWsl2ForHiggs();
}
