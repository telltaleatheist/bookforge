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

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {
  getWslDistro,
  getWslCondaPath,
  getWslHiggsCondaEnv,
  shouldUseWsl2ForHiggs,
  checkWslHiggsSetupAsync,
} from './tool-paths';
import {
  getPythonInvocation,
  getDefaultE2aPath,
  windowsToWslPath,
  toUnpackedPath,
  buildCondaSpawnEnv,
} from './e2a-paths';
import {
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
export const HIGGS_NARRATOR_ENGINE_ENV = 'higgs-v3';

export type HiggsSpawnKind = 'prep' | 'worker' | 'assembly' | 'serve';

export interface HiggsSpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  viaWsl: boolean;
  /** A single line for a log, so a failed spawn is reproducible by hand. */
  describe(): string;
}

/**
 * Where the `narrator` package lives, as a Windows path.
 *
 * `python -m narrator.compat.worker` cannot bootstrap its own `sys.path` the way
 * `orpheus_stream.py` did with `sys.path.insert(0, EBOOK2AUDIOBOOK_PATH)` — `-m`
 * resolves the module BEFORE any of its code runs. PORT_NOTES section 9.2 gives
 * two ways to supply it and this takes the second: `PYTHONPATH=<repo>/python`.
 *
 * WHY PYTHONPATH AND NOT `pip install -e`. The install is cleaner and works from
 * any cwd, but it is a step per environment that a user has to have run, and it
 * is invisible when it has not been — a machine that skipped it fails with
 * `No module named narrator` and no hint about which env. PYTHONPATH is
 * zero-install and carried by the spawn itself, so the wiring and the thing it
 * wires arrive together. The note in PORT_NOTES stands: it loses to a `.pth`
 * already on the path, which is only a problem for someone who ALSO pip-installed
 * narrator, and then the two are the same package anyway.
 *
 * The three candidates mirror `resolveScriptPath()` in orpheus-worker-pool.ts —
 * app path (dev + packaged), the dist-relative walk-up, and the co-located copy —
 * and `toUnpackedPath` handles the packaged case, where a spawned Python cannot
 * read inside app.asar.
 */
export function narratorPythonRoot(): string {
  const candidates = [
    path.join(app.getAppPath(), 'python'),
    path.join(__dirname, '..', '..', 'python'),
    path.join(__dirname, 'python'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'narrator', '__init__.py'))) return toUnpackedPath(c);
  }
  // NOT "a packaging bug". On a dev machine nothing is packaged, and the real
  // reason is almost always the same one: `python/narrator` lives on the
  // `feat/narrator` branch, which lands FIRST (Owen's merge-order ruling). Say
  // that, because "packaging bug" sends the reader to electron-builder config
  // for a checkout problem.
  throw new Error(
    'The narrator package is not in this checkout. Higgs renders through narrator ' +
      '(python/narrator), which lands with or before this branch — it is NOT vendored ' +
      'or copied here. Looked for narrator/__init__.py under: ' + candidates.join(', ') +
      '. Merge feat/narrator, or render on Orpheus until it lands.',
  );
}

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
 * The WSL arm is written out rather than reusing `spawnWithWslSupport`'s
 * `buildWslBashCommand`, and that is worth saying plainly: that function rewrites
 * argv by PATTERN — any arg containing `orpheus` becomes `-n <orpheusEnv>`, any
 * path under the e2a root is remapped onto the WSL e2a checkout, and it exports a
 * fixed `forwardKeys` list of `ORPHEUS_*` variables. Every one of those rules is
 * wrong for a narrator spawn: there is no e2a root involved, the env is chosen by
 * name not by string-matching, and the variables that must cross are `NARRATOR_*`.
 * Passing a Higgs command through it would silently produce an Orpheus command.
 *
 * So this arm builds its own `bash -c`, and — the point of the whole design —
 * `buildWslBashCommand` is left untouched, which is what makes the Orpheus argv
 * provably identical before and after (see tools/test-orpheus-argv-snapshot.js).
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
  },
): HiggsSpawnPlan {
  // prep and assembly are both `compat.app` doors (--prep_only / --assemble_only);
  // the worker is `compat.worker`, which is the same routing with --worker_mode
  // implied. See narrator's compat/FLAGS.md, "The two doors".
  const module =
    kind === 'worker' ? 'narrator.compat.worker'
      : kind === 'serve' ? 'narrator.serve'
        : 'narrator.compat.app';

  const pythonRoot = narratorPythonRoot();
  const serving = higgsServingFor(opts.model);
  const viaWsl = process.platform === 'win32' && shouldUseWsl2ForHiggs();

  // The voice document is written on the WINDOWS side (that is the filesystem
  // this process can write) and NAMED in whichever filesystem the spawn will read
  // it from. Under WSL that is /mnt/c — the 9p mount is slow, and it does not
  // matter here: this is a few hundred bytes read once at load, not the model
  // weights, which is exactly why the models dir is WSL-native and this is not.
  // The document is written on the WINDOWS side (that is the filesystem this
  // process can write) and its CONTENTS are translated for the arm that will read
  // them: guest translation under WSL, identity on macOS/Linux where there is no
  // guest for a path to be native to. An earlier draft stored WSL-native paths in
  // the catalog and handed them to every arm untranslated — right on the WSL arm
  // by accident, meaningless everywhere else.
  const translate = viaWsl ? toGuestPath : (p: string) => p;
  const voicesHostPath = writeHiggsVoicesDocument(opts.model, opts.jobId, translate);
  const distro = getWslDistro();

  // The launch script the installer deployed INTO the env. narrator invokes the
  // operator's script rather than writing its own — the CUDA_HOME and FlashInfer
  // workarounds live there and a second copy would drift — so what it needs is
  // the path, in the guest's filesystem.
  const serveScriptGuestPath = `${wslCondaBase(getWslCondaPath())}/envs/${getWslHiggsCondaEnv()}/bin/${serving.launchScript}`;

  const voiceEnv = higgsSpawnEnv(opts.model, {
    voicesPath: viaWsl ? windowsToWslPath(voicesHostPath) : voicesHostPath,
    serveScriptPath: viaWsl ? serveScriptGuestPath : undefined,
    wslDistro: viaWsl ? distro : undefined,
  });

  const baseEnv: Record<string, string> = {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // Selects the backend inside narrator's engine registry.
    NARRATOR_ENGINE: HIGGS_NARRATOR_ENGINE_ENV,
    ...voiceEnv,
  };

  if (viaWsl) {
    const conda = getWslCondaPath();
    const envName = getWslHiggsCondaEnv();
    const wslPythonRoot = windowsToWslPath(pythonRoot);

    // Paths in argv are translated here, explicitly and only where they are
    // paths — the opposite of buildWslBashCommand's pattern matching. An arg that
    // is not a drive-letter path crosses verbatim.
    //
    // THE GUARD USED TO BE a character class holding ONLY an escaped forward
    // slash — so it matched
    // 'C:/x' and MISSED 'C:\\x', and path.join on win32 emits backslashes. Every
    // --session_dir and --sentences_dir therefore crossed into the guest as a
    // literal Windows path, single-quoted so bash preserved it exactly, and
    // narrator refused it as a directory that does not exist — potentially after
    // the 297 s cold start had already been paid.
    const wslArgs = opts.args.map(toGuestPath);

    // EVERY env value goes through the same translation as argv. A Windows path
    // is exactly as unusable to the guest inside NARRATOR_HIGGS_VOICES as it is
    // inside --session_dir, and the two used to be translated by different code
    // (one correct, one not) — which is how the argv guard's bug stayed
    // invisible while the voices path looked right in a log.
    const exports = Object.entries({ ...baseEnv, PYTHONPATH: wslPythonRoot })
      .map(([k, v]) => `${k}=${shellQuote(toGuestPath(v))}`)
      .join(' ');
    const run =
      `${shellQuote(conda)} run --no-capture-output -n ${shellQuote(envName)} ` +
      `python -u -m ${module} ${wslArgs.map(shellQuote).join(' ')}`;
    // cwd is NOT load-bearing for narrator (PORT_NOTES s9.3: it reads cwd for
    // nothing), but it must EXIST inside the guest, so it is the WSL home rather
    // than a translated Windows path that may not be mounted.
    const bash = `export ${exports} && cd ~ && ${run}`;
    const wslArgv = distro ? ['-d', distro, 'bash', '-c', bash] : ['bash', '-c', bash];
    return {
      command: 'wsl.exe',
      args: wslArgv,
      env: process.env,
      cwd: process.cwd(),
      viaWsl: true,
      describe: () => `wsl.exe ${wslArgv.slice(0, -1).join(' ')} '${bash}'`,
    };
  }

  // Native (macOS / Linux): the Higgs env resolved through the component seam.
  const py = getPythonInvocation(getDefaultE2aPath(), 'higgs');
  const args = [...py.args, '-u', '-m', module, ...opts.args];
  return {
    command: py.command,
    args,
    env: buildCondaSpawnEnv({ ...baseEnv, PYTHONPATH: pythonRoot }),
    cwd: opts.cwd,
    viaWsl: false,
    describe: () => `${py.command} ${args.join(' ')}`,
  };
}

/** `<base>/bin/conda` -> `<base>`. The same derivation the doctor makes. */
function wslCondaBase(condaPath: string): string {
  return condaPath.replace(/\/bin\/conda$/, '');
}

/**
 * A HOST-NATIVE path, as the WSL guest must see it. Anything else verbatim.
 *
 * THREE INPUT FORMS, because a Windows host has three ways of naming a file the
 * guest can open:
 *
 *   C:\\x  /  C:/x         a drive path      -> /mnt/c/x
 *   \\\\wsl$\\Ubuntu\\home\\x     the UNC form of a  -> /home/x
 *   \\\\wsl.localhost\\...   guest-resident path
 *   /home/x  /  /mnt/c/x    already guest form -> unchanged
 *
 * The UNC form is not hypothetical: it is what `tool-paths.ts` documents for
 * `orpheusModelsDir` on a Windows+WSL machine, so a models directory that lives
 * on ext4 is NAMED on the Windows side as `\\\\wsl$\\<distro>\\...`. Handling
 * only drive letters would translate a session dir correctly and leave a models
 * path as a UNC string the guest cannot open.
 *
 * Passing an already-guest-form path through unchanged is what makes this safe to
 * apply to argv, to every environment value, and to catalog paths, without
 * knowing which of them were already translated.
 */
function toGuestPath(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) return windowsToWslPath(value);
  const unc = value.replace(/\\/g, '/')
    .match(/^\/\/wsl[$.](?:localhost)?\/[^/]+(\/.*)?$/i);
  if (unc) return unc[1] || '/';
  return value;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
