/**
 * How a Higgs narration job is actually launched.
 *
 * Orpheus renders through ebook2audiobook. Higgs renders through **narrator**
 * (`python/narrator`, branch `feat/narrator`), which is the extracted engine
 * layer e2a is being migrated onto — so this file is where the two routes part,
 * and it exists as its own module precisely so that the parting is ONE import in
 * `parallel-tts-bridge.ts` rather than a fifth `if` inside four spawn sites.
 *
 * ── The three phases go to three different places, and that is not a design
 *    choice ───────────────────────────────────────────────────────────────────
 *
 * | phase    | runs on   | why                                                  |
 * |----------|-----------|------------------------------------------------------|
 * | prep     | e2a       | narrator REFUSES `--prep_only` by name — the packer   |
 * |          |           | is migration step 4 and is not written yet.           |
 * | worker   | narrator  | this is the whole point; e2a has no Higgs engine.     |
 * | assembly | narrator  | `--assemble_only` is engine-agnostic and already ports|
 *
 * PREP ON e2a IS SOUND, AND IT WAS CHECKED RATHER THAN ASSUMED. e2a's prep phase
 * (`lib/core.py:prep_ebook_info`) parses the EPUB and packs sentences; it loads
 * NO TTS model. Its packing cap is chosen by a plain string comparison —
 * `elif tts_engine == 'orpheus': max_chars = int(os.environ['ORPHEUS_MAX_CHARS'])
 * or 350` (`lib/core.py:1553` and `:2437`) — so telling it `orpheus` and handing
 * it Higgs's measured cap packs to Higgs's cap. That is the SAME
 * engine-agnostic-scaffolding move the codebase already makes in the other
 * direction, where assembly is told `--tts_engine xtts` on every book including
 * Orpheus ones because assembly combines audio and never consults the name.
 *
 * The honest limitation: this is e2a's SENTENCE packer, and the chunking rule
 * Owen set for Higgs is PARAGRAPH-based (a chunk ends only at a paragraph end;
 * v3's 8,192-token window makes ~4,000 characters fit). That packer is
 * `narrator/text/paragraph_packer.py`, step 4, unwritten. Until it lands, a Higgs
 * book is packed to 600-char sentence groups, which is what every v3 measurement
 * was actually taken at — so it is the measured behaviour, not a guess, but it is
 * not yet the intended one. Recorded in docs/HIGGS_ENGINE.md.
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
  checkWslHiggsSetup,
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
 * The engine name e2a's PREP is told for a Higgs job.
 *
 * `orpheus`, and the reason is in this module's header: e2a's packer branches on
 * this exact string to reach the `ORPHEUS_MAX_CHARS` cap, which is the knob Higgs
 * needs. Prep loads no model, so nothing else about the name is consulted.
 *
 * A CONSTANT WITH A NAME rather than a bare `'orpheus'` at the call site, because
 * a reader who finds `--tts_engine orpheus` in a Higgs code path deserves to be
 * able to click through to why.
 */
export const HIGGS_PREP_ENGINE_ALIAS = 'orpheus';

/**
 * The env e2a's PREP for a Higgs job runs in: the generic bundled one.
 *
 * NOT the Orpheus env, even though the flag above says `orpheus`. Prep imports no
 * TTS backend, and routing it into the Orpheus env would drag it through the WSL
 * Orpheus spawn (`shouldUseWslForSpawn` keys on this name) for a text-parsing
 * pass — the exact mistake `asmEngineArg` exists to avoid on the assembly side.
 */
export const HIGGS_PREP_ENV_ENGINE = 'xtts';

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

export type HiggsSpawnKind = 'worker' | 'assembly' | 'serve';

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
  throw new Error(
    'The narrator package could not be found. Looked for narrator/__init__.py under: ' +
      candidates.join(', ') +
      '. Higgs renders through narrator, so this is a packaging bug, not a setting.',
  );
}

/**
 * Refuse a Higgs job that cannot possibly succeed, BEFORE it is queued.
 *
 * Called from the narration modal's queue path and again at spawn time. Twice on
 * purpose: the first call is what turns a doomed run into a sentence someone can
 * read while they still have the dialog open, and the second is what stops a job
 * that was queued when the environment was fine and started after a pip upgrade
 * reverted a patch.
 *
 * ORDER MATTERS. The environment is checked before the voice, because "there is
 * no Higgs environment" explains "this voice cannot render" and not the reverse,
 * and being told about the voice first sends people to the wrong page.
 */
export function higgsPreflight(voiceId: string | undefined | null): HiggsModel {
  if (process.platform === 'win32' && !shouldUseWsl2ForHiggs()) {
    throw new Error(
      'Higgs runs on vLLM-Omni, which has no Windows build. Turn on "WSL2 for Higgs" in ' +
        'Settings → Higgs and install the environment there.',
    );
  }

  if (process.platform === 'win32') {
    const doctor = checkWslHiggsSetup();
    if (!doctor.valid) {
      const failed = doctor.checks.filter((c) => !c.ok);
      throw new Error(
        `The Higgs environment is not ready (${failed.length} of ${doctor.checks.length} checks failed):\n` +
          failed.map((c) => `  • ${c.label}: ${c.detail ?? 'failed'}`).join('\n') +
          '\nRun Install/Repair on Settings → Higgs.',
      );
    }
  }

  // Throws by name for an unknown voice, a voice whose artifact has not landed,
  // and a reference clip with no transcript.
  const model = resolveHiggsModel(voiceId);

  return model;
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
  const module =
    kind === 'worker' ? 'narrator.compat.worker'
      : kind === 'assembly' ? 'narrator.compat.app'
        : 'narrator.serve';

  const pythonRoot = narratorPythonRoot();
  const serving = higgsServingFor(opts.model);
  const viaWsl = process.platform === 'win32' && shouldUseWsl2ForHiggs();

  // The voice document is written on the WINDOWS side (that is the filesystem
  // this process can write) and NAMED in whichever filesystem the spawn will read
  // it from. Under WSL that is /mnt/c — the 9p mount is slow, and it does not
  // matter here: this is a few hundred bytes read once at load, not the model
  // weights, which is exactly why the models dir is WSL-native and this is not.
  const voicesHostPath = writeHiggsVoicesDocument(opts.model, opts.jobId);
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
    const wslArgs = opts.args.map((a) => (/^[A-Za-z]:[\/]/.test(a) ? windowsToWslPath(a) : a));

    const exports = Object.entries({ ...baseEnv, PYTHONPATH: wslPythonRoot })
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
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
 * The packing cap e2a's prep must use for this Higgs voice.
 *
 * NOT OPTIONAL, and not `| undefined`. Every voice that can reach prep has
 * already been through `higgsPreflight` -> `resolveHiggsModel`, which refuses a
 * fine-tune with no measured cap outright; a zero-shot voice carries the engine
 * placeholder. So a missing number here is not "let the default apply" — e2a's
 * default is 350, an Orpheus number with no bearing on Higgs — it is a bug in
 * the chain above, and it throws rather than packing a book to a cap nobody
 * chose.
 */
export function higgsPrepMaxChars(model: HiggsModel): number {
  const cap = higgsVoiceCapsForModel(model).maxChars;
  if (typeof cap !== 'number' || !(cap > 0)) {
    throw new Error(
      `Higgs voice "${model.id}" reached prep with no packing cap (${JSON.stringify(cap ?? null)}). ` +
        `e2a's own default is 350, an Orpheus number that has no bearing on Higgs — refusing ` +
        `to pack a book to a cap nobody chose.`,
    );
  }
  return cap;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
