/**
 * WHERE THE rvc-env IS, and what `--protect-rate` means.
 *
 * The conversion itself is a Crucible `rvc` job (`crucible/rvc.ts`,
 * `crucible/rvc-file.ts`). The urvc spawn that used to live here (convert-dir in a
 * recycled worker, whole-file chunking) is deleted (docs/REORG-PLAN.md, B2). The
 * env stays because it carries the ffmpeg/ffprobe the denoise blocks are built with
 * and the audio-separator ClipForge runs (`denoise-bridge.ts`).
 */

import { componentManager } from './components/component-manager';
import { RVC_ENV_ID } from './components/rvc-env';
import { relocatableBinaryPath } from './tools-env-bootstrap';

/**
 * The rvc-env root, or null when the engine isn't installed.
 *
 * BOOKFORGE_RVC_ENV overrides it so `electron:dev` can point at an already-built
 * env (e.g. the `bookforge-urvc` conda env) instead of installing the managed
 * component — mirrors the BOOKFORGE_E2A_ENV dev seam.
 */
export function getRvcEnvRoot(): string | null {
  const override = process.env.BOOKFORGE_RVC_ENV?.trim();
  if (override) return override;
  return componentManager.resolveEntry(RVC_ENV_ID);
}

/** The env's `python` executable, or null when unavailable. */
export function getRvcPython(): string | null {
  const root = getRvcEnvRoot();
  return root ? relocatableBinaryPath(root, 'python') : null;
}

/**
 * WHAT `--protect-rate` ACTUALLY DOES, read out of the installed engine.
 *
 * `ultimate_rvc/rvc/infer/pipeline.py` gates the entire protection block on
 * `if protect < 0.5:`. So the scale is INVERTED against urvc's own CLI help and
 * against every RVC doc on the internet: LOWER protects MORE, and 0.5 disables
 * protection outright rather than maximising it.
 *
 * It is also a NO-OP AT INDEX RATE 0. The unprotected features it blends back in
 * are cloned before feature retrieval, and retrieval only runs when the index
 * rate is above zero — so a voice converted with no index gets no protection
 * whatever this is set to. The tuned deathstalker→Sigma recipe pairs protect
 * 0.25 with index 0.5 for exactly that reason.
 */
export const PROTECT_RATE_NOTE =
  'protect-rate is inverted: lower protects more, and 0.5 disables protection. It does nothing '
  + 'at all when the index rate is 0.';
