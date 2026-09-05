/**
 * How a Higgs narration job is actually launched.
 *
 * Orpheus renders through ebook2audiobook. Higgs renders through **narrator**
 * (`python/narrator`, branch `feat/narrator`), which is the extracted engine
 * layer e2a is being migrated onto — so this file is where the two routes part,
 * and it exists as its own module precisely so that the parting is ONE import in
 * `parallel-tts-bridge.ts` rather than a fifth `if` inside four spawn sites.
 *
 * ── All three phases go to narrator ────────────────────────────────────────
 *
 * | phase    | door                                | why                      |
 * |----------|-------------------------------------|--------------------------|
 * | prep     | `compat.app --prep_only`            | its paragraph packer IS  |
 * |          |                                     | the Higgs chunking rule  |
 * | worker   | `compat.worker`                     | e2a has no Higgs engine  |
 * | assembly | `compat.app --assemble_only`        | engine-agnostic door     |
 *
 * PREP MOVED HERE FROM e2a (2026-09-05, review finding 5). The first draft
 * routed it to ebook2audiobook as `--tts_engine orpheus` in the bundled env, with
 * `ORPHEUS_MAX_CHARS` carrying the Higgs cap — a mechanism that was verified in
 * e2a's source and did work, on a PREMISE that expired hours later: narrator's
 * `text/paragraph_packer.py` landed, `compat/app.py` now forces
 * `chunking = 'paragraph'` for `higgs-v3`, and `text/prep.py` refuses `higgs-v3`
 * with e2a chunking by name.
 *
 * The old route was wrong in three ways beyond the chunk shape, and all three
 * are silent: the session it wrote recorded `tts_engine: "orpheus"`, carried no
 * `higgs_voice`, and carried no `bookforge_chunking`. So any door that does not
 * pass the voice explicitly — resume, retake — would read the state back, find
 * `higgs_voice` absent, and either refuse or (worse) let `resolve_engine_id` fall
 * through to `tts_engine == 'orpheus'` and build the ORPHEUS engine for a Higgs
 * book.
 *
 * Owen's rule is that the paragraph is the chunk (v3's 8,192-token window fits
 * ~4,000 characters). Coverage was measured at 600-char sentence groups, so
 * re-measuring at the new chunk sizes is owed — that is the training side's job
 * and it is recorded in docs/HIGGS_ENGINE.md, not papered over here.
 *
 * `--session_dir` IS MANDATORY ON EVERY NARRATOR SPAWN, prep included.
 * `session_store.sessions_root()` reads `$E2A_TMP_DIR`; e2a survived without the
 * flag because `lib/conf.py` fell back to `<e2a_root>/tmp`, which happened to be
 * the path the bridge had computed. narrator has no e2a root and refuses to
 * guess. Forwarding `E2A_TMP_DIR` is NOT an alternative: it holds a WINDOWS path
 * while a WSL prep derives its session dir from the WSL e2a root.
 *
 * ── Reconciled against narrator's real contract ─────────────────────────────
 *
 * This module was first written against a narrator branch that had no
 * `engine/higgs` directory at all, so its environment and its voice flag were
 * BookForge's best guess. RECONCILED 2026-09-04, LATER THE SAME DAY. Both landed while this was being
 * written, and this module was corrected to them rather than left as a guess:
 * the engine id is `higgs-v3`, the worker route takes `--higgs_voice <catalog
 * id>` (a catalog id, NOT an Orpheus-style `--fine_tuned` voice token — the two
 * are not interchangeable), and the environment is narrator's `NARRATOR_*` set.
 * The `HIGGS_*` names an earlier draft invented are gone. See
 * docs/HIGGS_ENGINE.md for the reconciliation.
 */

import {
  getWslCondaPath,
  getWslDistro,
  getWslHiggsCondaEnv,
  shouldUseWsl2ForHiggs,
  checkWslHiggsSetupAsync,
} from './tool-paths';
import { windowsToWslPath } from './e2a-paths';
import {
  buildNarratorSpawn,
  narratorEngineEnvId,
  narratorPythonRoot,
  narratorRunsInWsl,
  toGuestPath,
  type NarratorPhase,
  type NarratorSpawnPlan,
} from './narrator-spawn';
import { app } from 'electron';
import {
  higgsMlxBaseDir,
  resolveHiggsModel,
  higgsSpawnEnv,
  higgsVoiceCapsForModel,
  higgsServingFor,
  writeHiggsVoicesDocument,
  type HiggsModel,
} from './higgs-models';

/**
 * Does this Higgs job run inside WSL?
 *
 * Exported because `prepareSession` needs it for a decision that is NOT about
 * the spawn: where the session directory lives and whether the EPUB has to be
 * staged. `shouldUseWslForSpawn` cannot answer it — that function is keyed to
 * Orpheus and deliberately returns false for Higgs, because a Higgs command must
 * never go through `spawnWithWslSupport` (see buildHiggsSpawn).
 */
export function higgsRunsInWsl(): boolean {
  return process.platform === 'win32' && shouldUseWsl2ForHiggs();
}

/**
 * Re-exported so the ONE narrator-package refusal has one caller-visible name.
 * `tools/test-higgs-engine.js` asserts its wording; it now lives in
 * `narrator-spawn.ts` because every engine's spawn needs it, not just Higgs.
 */
export { narratorPythonRoot };

/** `--tts_engine` on narrator's prep, worker and retake routes. */
export const HIGGS_NARRATOR_ENGINE = 'higgs-v3';

/**
 * The flag that names the voice. NOT `--fine_tuned`.
 *
 * narrator's `compat/flags.py` accepts both and they are not interchangeable:
 * `--fine_tuned` is an Orpheus voice TOKEN that rides in the prompt, while
 * `--higgs_voice` is a CATALOG ID that indexes the voice document named by
 * `NARRATOR_HIGGS_VOICES`. Passing an Orpheus-shaped voice arg to a Higgs worker
 * would name a token the engine has no use for and leave the real voice unsaid.
 */
export const HIGGS_VOICE_FLAG = '--higgs_voice';

/** `NARRATOR_ENGINE`, which selects the backend inside `serve/worker.py`. */
export const HIGGS_NARRATOR_ENGINE_ENV = narratorEngineEnvId('higgs');

/**
 * Every phase a Higgs job can reach. WIDENED to narrator's own phase union at the
 * Phase 3 cut-over: `resume` and `list` are engine-agnostic tools-env doors that
 * a Higgs session reaches like any other, and a separate narrower union here
 * would have had to be kept in step by hand.
 */
export type HiggsSpawnKind = NarratorPhase;

/** The plan every narrator spawn produces; Higgs adds nothing to its shape. */
export type HiggsSpawnPlan = NarratorSpawnPlan;

/**
 * Is the Higgs ENVIRONMENT usable? Asked ONCE PER JOB, asynchronously.
 *
 * Returns the refusal text, or null.
 *
 * ── Why this is separate from the voice check, and why it is async ──────────
 *
 * It used to live inside `higgsPreflight`, which is called from four places: the
 * prep spawn, EVERY worker start, assembly and retake. That made a ~1 s
 * `execSync` WSL round trip a PER-RANGE health check — on the main thread, which
 * the bookshelf server shares — for a resource that cannot change between the
 * workers of one job.
 *
 * So the environment is checked once, in `prepareSession`, which is already an
 * async context, through the spawn-based doctor. The per-worker calls keep the
 * VOICE check, which is pure and touches no filesystem. A worker starting after
 * the environment broke mid-job is caught by the spawn itself failing — which is
 * the honest place for it, since no amount of pre-checking closes that window.
 */
export async function higgsEnvironmentRefusal(): Promise<string | null> {
  if (process.platform === 'win32' && !shouldUseWsl2ForHiggs()) {
    return 'Higgs runs on vLLM-Omni, which has no Windows build. Turn on "WSL2 for Higgs" in '
      + 'Settings → Higgs and install the environment there.';
  }
  if (process.platform !== 'win32') return null;

  const doctor = await checkWslHiggsSetupAsync();
  if (doctor.valid) return null;
  const failed = doctor.checks.filter((c) => !c.ok);
  return `The Higgs environment is not ready (${failed.length} of ${doctor.checks.length} checks failed):\n`
    + failed.map((c) => `  • ${c.label}: ${c.detail ?? 'failed'}`).join('\n')
    + '\nRun Install/Repair on Settings → Higgs.';
}

/**
 * The voice this job will render in, or a throw naming what is wrong with it.
 *
 * PURE: catalog lookup and validation only, no filesystem and no WSL, so it is
 * free to call at every spawn site. The ENVIRONMENT half moved to
 * `higgsEnvironmentRefusal` — see its header.
 *
 * Refuses an unknown voice, a voice whose artifact has not landed, a reference
 * clip with no transcript or no declared duration, more than one clip, a
 * reference over the 30 s cap, and a fine-tune with no measured `maxChars`.
 */
export function higgsPreflight(voiceId: string | undefined | null): HiggsModel {
  return resolveHiggsModel(voiceId);
}

/**
 * Build the spawn for one phase of a Higgs job.
 *
 * ── What is left here, now that narrator-spawn.ts owns the command line ─────
 *
 * Everything ABOUT HIGGS, and nothing about spawning:
 *
 *  - the voice document, written on the Windows side and named in whichever
 *    filesystem the spawn will read it from;
 *  - the launch script the Higgs installer deployed INTO the WSL env (narrator
 *    invokes the operator's script rather than writing its own — the CUDA_HOME
 *    and FlashInfer workarounds live there and a second copy would drift), which
 *    has to be named as a GUEST path;
 *  - the catalog's own refusals, via `higgsSpawnEnv`.
 *
 * All three produce environment VALUES, which is why this function's whole job
 * is now to compute `envExtras` and hand them over. `buildNarratorSpawn` decides
 * the env, the module, the translation and the guest boundary — the same
 * decisions, for every engine, in one place.
 *
 * The one thing that has to be decided HERE is `viaWsl`, because the voice
 * document's CONTENTS are translated before the document is written: guest
 * translation under WSL, identity on macOS/Linux where there is no guest for a
 * path to be native to. An earlier draft stored WSL-native paths in the catalog
 * and handed them to every arm untranslated — right on the WSL arm by accident,
 * meaningless everywhere else.
 *
 * ── Why it takes `envExtras` now ────────────────────────────────────────────
 *
 * At the Phase 3 cut-over the batch bridge builds ONE argv per door for both
 * engines and one env per door, and passes the env through. The Higgs voice
 * variables are MERGED UNDER it, not over it: a caller may not override
 * NARRATOR_HIGGS_VOICES by accident, because the document this function just
 * wrote is the only one that describes this run's voice.
 */
export function buildHiggsSpawn(
  kind: HiggsSpawnKind,
  opts: {
    model: HiggsModel;
    /** e2a-shaped flags for this phase, already in narrator's `compat` spelling. */
    args: string[];
    cwd: string;
    /** Names the voice document written for this run. */
    jobId: string;
    /** The door's own environment. Never overrides the Higgs voice variables. */
    envExtras?: Record<string, string>;
  },
): HiggsSpawnPlan {
  return buildNarratorSpawn({
    engine: 'higgs',
    phase: kind,
    args: opts.args,
    envExtras: { ...opts.envExtras, ...higgsEnvExtras(opts.model, opts.jobId, kind) },
    cwdHint: opts.cwd,
  });
}

/**
 * The environment a Higgs spawn needs, and the catalog refusals that produce it.
 *
 * Split out of `buildHiggsSpawn` at the Phase 3 cut-over so the batch bridge can
 * build ONE plan per door for both engines and still hand the Higgs half its
 * voice. Writing the voice document is a SIDE EFFECT of calling this — it lands
 * on the Windows filesystem, named for `jobId`, with its contents translated for
 * the arm `kind` will take.
 */
export function higgsEnvExtras(
  model: HiggsModel,
  jobId: string,
  kind: HiggsSpawnKind,
): Record<string, string> {
  const serving = higgsServingFor(model);
  // Asked of narrator-spawn rather than recomputed, so the arm the voice document
  // is written FOR is provably the arm the spawn will take.
  const viaWsl = narratorRunsInWsl('higgs', kind);

  // Under WSL the document is read over /mnt/c. The 9p mount is slow and it does
  // not matter here: this is a few hundred bytes read once at load, not the model
  // weights — which is exactly why the models dir is WSL-native and this is not.
  const translate = viaWsl ? toGuestPath : (p: string) => p;
  const voicesHostPath = writeHiggsVoicesDocument(model, jobId, translate);
  const serveScriptGuestPath =
    `${wslCondaBase(getWslCondaPath())}/envs/${getWslHiggsCondaEnv()}/bin/${serving.launchScript}`;

  return higgsSpawnEnv(model, {
    voicesPath: viaWsl ? windowsToWslPath(voicesHostPath) : voicesHostPath,
    serveScriptPath: viaWsl ? serveScriptGuestPath : undefined,
    wslDistro: viaWsl ? getWslDistro() : undefined,
    // darwin ONLY: the in-process MLX backend loads its weights from a directory
    // this variable names, and refuses BY NAME when it is unset ("no default and
    // no search"). Host-native — there is no guest on a Mac, so nothing is
    // translated. The served arm (Windows/WSL) never reads it: there the weights
    // are the launch script's argument.
    mlxModelDir: process.platform === 'darwin'
      ? higgsMlxBaseDir(app.getPath('userData'))
      : undefined,
  });
}

/** `<base>/bin/conda` -> `<base>`. The same derivation the doctor makes. */
function wslCondaBase(condaPath: string): string {
  return condaPath.replace(/\/bin\/conda$/, '');
}
