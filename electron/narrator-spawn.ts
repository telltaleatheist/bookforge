/**
 * THE narrator launcher. One module builds every python command line BookForge
 * sends to `python/narrator`, for every engine, every phase and every platform.
 *
 * ── Why one module ──────────────────────────────────────────────────────────
 *
 * Before narrator there were four places that assembled a python command line
 * (the prep spawn, the worker spawn, assembly, and the Listen server), each with
 * its own env resolution, its own WSL handling and its own idea of what a path
 * is. The WSL half of that was `buildWslBashCommand`, which rewrites argv BY
 * PATTERN: any argument containing the string `orpheus` becomes `-n <orpheusEnv>`,
 * any path under the e2a root is remapped onto the WSL e2a checkout, and a fixed
 * `forwardKeys` allowlist of `ORPHEUS_*` variables is exported. Every one of those
 * rules is wrong for narrator — there is no e2a root, the environment is chosen by
 * NAME rather than by string-matching, and the variables that must cross are
 * whatever the caller says they are.
 *
 * So this module builds its own `bash -c`, and `buildWslBashCommand` is left
 * untouched — which is exactly what makes the Orpheus BATCH argv provably
 * identical across this work (tools/test-orpheus-argv-snapshot.js), because
 * nothing in the batch bridge has been re-pointed yet. Phase 3 does that.
 *
 * `higgs-spawn.ts` was the first draft of this file, written for one engine. It
 * is now a thin caller: it still owns the Higgs voice document, the served-model
 * launch script and the catalog refusals — the things that are ABOUT Higgs — and
 * hands the result here as `envExtras`.
 *
 * ── The environment matrix (docs/E2A_REMOVAL_PLAN.md, "Design spine") ────────
 *
 * | engine  | Windows                     | macOS            | Linux           |
 * |---------|-----------------------------|------------------|-----------------|
 * | orpheus | WSL `orpheus_tts`           | `narrator-mlx`   | managed orpheus |
 * | higgs   | WSL `higgs3`                | refused by name  | refused by name |
 * | (none)  | native tools env — assembly / resume / list, every platform      |
 *
 * A phase with no engine is not a phase with a default engine. Assembly, resume
 * and list are engine-AGNOSTIC doors: they read a session that already records
 * which engine rendered it, they need numpy/soundfile/mutagen and nothing else,
 * and they run natively on every platform including Windows-with-WSL. Naming an
 * engine on one of those is a caller mistake and is refused rather than ignored,
 * because "ignored" would silently route an assembly into a 6 GB vLLM env.
 *
 * ── What crosses into the process, and what does not ────────────────────────
 *
 * THE TWO ARMS ARE NOT THE SAME, and the difference is load-bearing rather than
 * incidental.
 *
 * **WSL**: exactly `envExtras`, plus the four this module owns
 * (`PYTHONUNBUFFERED`, `PYTHONIOENCODING`, `PYTHONPATH`, and `NARRATOR_ENGINE`
 * when an engine is named). Nothing else crosses, because nothing crosses a
 * `wsl.exe bash -c` boundary unless it is written into the `export` line. Never
 * `process.env` wholesale, and never the old `forwardKeys` allowlist — an
 * allowlist is a list of variables somebody remembered, and the ones that matter
 * are the ones nobody did.
 *
 * **Native**: the same four and `envExtras`, ON TOP OF `buildToolsSpawnEnv`,
 * which spreads `process.env` and then adds three things of its own:
 *
 *   `NARRATOR_SESSIONS_ROOT`
 *                   the sessions root, from the stated scratch — OMITTED, never
 *                   substituted, when its volume is not mounted.
 *                   `narrator.render.session_store.sessions_root()` READS IT, and
 *                   `--list_sessions` and a `--resume_session` given a bare id
 *                   have nothing else to go on — every other door passes
 *                   `--session_dir` explicitly and never reaches it. So this is
 *                   not inherited clutter; it is the whole interface for two of
 *                   the six doors. (It was `E2A_TMP_DIR` until Phase 6, and
 *                   narrator refuses that name BY NAME if anything still sets it.)
 *   `CONDA_PREFIX`  set when the managed tools env is in play, replicating
 *                   what `conda activate` would have done.
 *   `PATH`          prepended with the resolved ffmpeg directory and the env's
 *                   own bin dirs, because a packaged app launched from Finder or
 *                   Explorer inherits a minimal PATH and narrator's assembly
 *                   shells out to ffmpeg/ffprobe.
 *
 * A native child is on the same machine and filesystem as its parent, so
 * inheritance there is the normal thing rather than a leak. Saying so explicitly
 * matters because an earlier version of this header claimed "exactly envExtras
 * plus four" for BOTH arms, which would make `--list_sessions` inexplicable: it
 * passes no session path and would have no way to find one.
 *
 * ── PYTHONPATH, not `pip install -e` ────────────────────────────────────────
 *
 * `python -m narrator.serve` cannot bootstrap its own `sys.path` the way
 * `orpheus_stream.py` did with `sys.path.insert(0, EBOOK2AUDIOBOOK_PATH)`: `-m`
 * resolves the module BEFORE any of its code runs. PORT_NOTES section 9.2 gives
 * two ways to supply it. `pip install -e` is cleaner and cwd-independent, but it
 * is a step per environment that a user has to have run and is invisible when
 * they have not — the failure is `No module named narrator` with no hint about
 * which env. PYTHONPATH is zero-install and carried by the spawn itself, so the
 * wiring and the thing it wires arrive together. It loses to a `.pth` already on
 * the path, which is only a problem for someone who ALSO pip-installed narrator,
 * and then the two are the same package anyway.
 */

import { app } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  shouldUseWsl2ForOrpheus,
  shouldUseWsl2ForHiggs,
  getWslDistro,
  getWslCondaPath,
  getWslOrpheusCondaEnv,
  getWslHiggsCondaEnv,
} from './tool-paths';
import {
  getPythonInvocation,
  getCondaPath,
  getNarratorMlxEnv,
  windowsToWslPath,
  toUnpackedPath,
  buildToolsSpawnEnv,
  type PythonInvocation,
} from './narrator-paths';

/** The engines narrator can actually RUN. `xtts` is retired and is not one. */
export type NarratorEngineId = 'orpheus' | 'higgs';

/**
 * Which door of narrator this spawn opens.
 *
 * `serve` is the resident streaming server (Listen, the TTS API, the browser
 * extension). `prep`, `worker` and the three tools phases are the audiobook
 * pipeline; Phase 3 of the e2a removal re-points them, and they are declared here
 * so the module selection lives in ONE table rather than being invented twice.
 */
export type NarratorPhase =
  'serve' | 'prep' | 'worker' | 'align' | 'assembly' | 'resume' | 'list';

export interface NarratorSpawnRequest {
  /**
   * The engine to serve or render with. REQUIRED for `serve`/`prep`/`worker`,
   * and REFUSED for the tools phases — see the header.
   */
  engine?: NarratorEngineId;
  phase: NarratorPhase;
  /** narrator's flags for this phase, in narrator's own spelling. */
  args: string[];
  /**
   * The complete set of extra environment variables for this spawn. On the WSL
   * arm this is the ONLY thing that crosses the boundary, so a variable absent
   * here is absent in the guest.
   */
  envExtras: Record<string, string>;
  /**
   * RUN THIS PHASE INSIDE THE WSL GUEST, in the conda env NAMED here — for a
   * phase that is otherwise native.
   *
   * ── Why an engine-agnostic phase ever crosses into the guest ──────────────
   *
   * `align` is 'refused' in `PHASE_ENGINE` and native everywhere, because on
   * Windows the session it reads has normally been copied OUT of WSL first. The
   * qwen3 aligner broke that assumption in one place and only one: the
   * post-render alignment runs BEFORE that copy (the session is still on ext4,
   * the render just wrote it there) and the env that holds `qwen-asr` on this PC
   * is a WSL env — `electron/qwen-aligner.ts`, `viaWsl: true`. The guest cannot
   * see the Z: network drive the session is copied to afterwards, and a Windows
   * spawn cannot run a `/home/...` interpreter, so the alignment has to happen
   * where the audio and the model already are.
   *
   * ── Why a NAME here rather than an engine ────────────────────────────────
   *
   * Naming an engine would have worked on Windows and been wrong on the Mac:
   * `narratorNativePython('higgs')` there resolves the `narrator-mlx` env, which
   * is the render's environment and has no business running an alignment. And
   * the standalone Align row has no engine to name at all. So the caller states
   * the guest env, which is a fact about where the aligner is, not about what
   * rendered the book.
   *
   * REFUSED off Windows and refused together with `engine`: there is no guest to
   * cross into, and two sources for one answer is how they come to disagree.
   */
  wslCondaEnv?: string;
  /**
   * RUN THIS PHASE ON THIS MACHINE, IN THE TOOLS ENV, whatever the engine's WSL
   * toggle says — because the ENGINE is not running here at all.
   *
   * ── The one caller: a prep whose render goes to a Crucible server ────────
   *
   * When the generation step runs on a Crucible (`generation-venue.ts`), the
   * only work narrator does on this machine is TEXT work: extract the EPUB,
   * split it, pack the chunks, write `session-state.json`. That is `prep`, and
   * it loads no model. Until 2026-09-14 a Crucible-bound render on Windows
   * still sent that prep into the WSL guest — because `narratorRunsInWsl`
   * answers for the ENGINE, and the engine's env is a guest env — so the
   * session was written to ext4, the render's artifacts were downloaded over
   * HTTP into a `\\wsl$` path, and `normalizeWslSessionToWindows` then had to
   * copy the whole session back out. The copy is where it died: the library is
   * on a network drive, and the guest's `/mnt/z` was a stale, root-owned mount
   * point (measured that night: `test -d` yes, `mountpoint -q` no).
   *
   * With this set the phase never enters the guest: the interpreter is the
   * tools env (`narratorNativePython(undefined)` — the same bundled python that
   * already runs assembly, resume and list natively on every platform), every
   * path stays a host path, and the session lives where the caller put it.
   *
   * ── Why the TOOLS env and not "the engine's native env" ─────────────────
   *
   * On Windows there is no native engine env to name: Orpheus's is the guest
   * (`orpheus_wsl_env` marker) and Higgs's is refused by name
   * (`getEnvPathForEngine`: "Higgs runs on vLLM-Omni, which has no Windows
   * build") — both correct answers about RENDERING, and both wrong for a prep
   * whose render is on another machine. The tools env is the one environment
   * this app guarantees on every platform, and narrator's `pyproject.toml`
   * declares the text-prep dependencies as BASE dependencies for exactly the
   * "machine that only assembles" case. `hostPrepRefusal` measures that the
   * env actually has them before anything is spawned, and refuses by name.
   *
   * RULING OWED: on macOS this moves a Crucible-venue prep out of `narrator-mlx`
   * (which has the text deps) into the tools env (which is the adopted legacy
   * e2a env there, unmeasured for `regex` / `iso639-lang`). The probe refuses by
   * name with the fix if it lacks one; the alternative — "tools env on Windows,
   * engine env elsewhere" — is a platform-conditional rule that says nothing
   * about WHY, so it was not taken.
   *
   * REFUSED for any phase but `prep` (the worker and serve load the model, and
   * the tools phases already run here) and refused together with `wslCondaEnv`
   * (one says "never the guest", the other names a guest env).
   */
  onHost?: boolean;
  /**
   * Working directory for the NATIVE arm. narrator reads cwd for nothing
   * (PORT_NOTES section 9.3), so this only decides where relative paths a caller
   * passes would resolve and where a crash dump would land. Omitted means the
   * app's userData directory, which always exists and is always writable — not a
   * fallback for a missing value, a deliberate default for a value that does not
   * matter. The WSL arm ignores it and uses the guest's home.
   */
  cwdHint?: string;
}

export interface NarratorSpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  viaWsl: boolean;
  /** Always false. Present so a caller can spread the plan into `spawn()`. */
  shell: boolean;
  /** One line for a log, so a failed spawn is reproducible by hand. */
  describe(): string;
}

/**
 * `NARRATOR_ENGINE`, which selects the backend inside narrator's engine registry
 * (`serve/worker.py:engine_id()`). It is NOT the same string as BookForge's
 * engine id for Higgs: BookForge says `higgs`, narrator says `higgs-v3`, because
 * narrator names a model generation and BookForge names a picker entry.
 */
const NARRATOR_ENGINE_ENV: Record<NarratorEngineId, string> = {
  orpheus: 'orpheus',
  higgs: 'higgs-v3',
};

/**
 * BookForge's engine id as NARRATOR spells it.
 *
 * ONE function for two uses, because they are the same string and drifting them
 * apart is a class of bug rather than a typo: it is the value of `NARRATOR_ENGINE`
 * (which selects the backend inside `serve/worker.py`) AND the value of
 * `--tts_engine` (which `compat/flags.py:check_engine` resolves through
 * `engine/registry.py` on the prep, worker and retake routes).
 *
 * `higgs` is not a narrator id. `compat/FLAGS.md` lists it under
 * ENGINE_NEAR_MISSES beside `higgs-v2`, `higgs-v2-scaffold` and `higgs_v3`, all
 * four refused BY NAME rather than helpfully resolved — guessing which Higgs a
 * caller meant is how a whole book gets rendered by the wrong model. So no spawn
 * site may pass `settings.ttsEngine` straight through; it passes this.
 */
export function narratorEngineId(engine: NarratorEngineId): string {
  return NARRATOR_ENGINE_ENV[engine];
}

/** @deprecated Same value, older name. Kept for `higgs-spawn.ts`'s constant. */
export function narratorEngineEnvId(engine: NarratorEngineId): string {
  return narratorEngineId(engine);
}

/**
 * The python module each phase invokes with `-m`.
 *
 * prep and the three tools phases are all `compat.app` doors, told apart by their
 * flags (`--prep_only`, `--assemble_only`, `--resume_session`, `--list_sessions`);
 * the worker is `compat.worker`, which is the same routing with `--worker_mode`
 * implied. See narrator's compat/FLAGS.md, "The two doors".
 *
 * `align` IS THE ONE PHASE THAT IS NOT A COMPAT DOOR. There is nothing to be
 * compatible with: e2a never had a forced aligner, so `compat/app.py` has no flag
 * that would reach one, and inventing an `--align_only` to route through a
 * translation layer written for ebook2audiobook's spelling would be a compat
 * door for a command e2a never had. It goes to narrator's own CLI, in narrator's
 * own dashes-and-words spelling (`narrator align --session-dir …`), which is the
 * interface `align/README.md` documents and the one an operator pastes by hand
 * out of the assembly's refusal.
 */
const PHASE_MODULE: Record<NarratorPhase, string> = {
  serve: 'narrator.serve',
  worker: 'narrator.compat.worker',
  prep: 'narrator.compat.app',
  align: 'narrator.cli',
  assembly: 'narrator.compat.app',
  resume: 'narrator.compat.app',
  list: 'narrator.compat.app',
};

/**
 * What each phase does with an engine.
 *
 *   'required'  the phase IS an engine (serve, prep, worker)
 *   'refused'   the phase reads a session and needs no TTS environment at all
 *   'optional'  assembly, and only assembly
 *
 * ── Why assembly is the one 'optional' ──────────────────────────────────────
 *
 * An Orpheus assembly is engine-agnostic and runs in the tools env: the session
 * already records which engine rendered it, and joining WAVs needs
 * numpy/soundfile/mutagen, not a 6 GB vLLM env. A HIGGS assembly, today, still
 * routes to the Higgs env because that is where the Higgs pipeline puts it — a
 * fact of Phase 1, not a design, and Phase 3 of the e2a removal moves both to the
 * tools env unconditionally. Modelling that as 'optional' says the truth now and
 * makes the Phase 3 edit one call site rather than a rule change.
 *
 * `resume` and `list` are 'refused' rather than 'optional' for the same reason
 * ignoring the engine would be wrong: naming one would silently route a session
 * listing into a multi-gigabyte TTS environment that may not even be installed.
 *
 * ── `align` is 'refused' too, and it is worth saying why ────────────────────
 *
 * It is ABOUT an engine — which engine rendered the session is what decides
 * whether it runs at all — but it does not RUN one. The alignment happens in the
 * aligner's own env, named on the command line as `--python`, and narrator's own
 * half of it (manifest, spans, sentence cues, the report) is pure stdlib plus the
 * tools env. Naming an engine here would route the alignment into a 6 GB vLLM
 * environment, or into the Mac's `narrator-mlx` env, neither of which has an
 * aligner in it.
 *
 * IT CAN STILL CROSS INTO THE GUEST, and `wslCondaEnv` is how (2026-09-08). The
 * post-render alignment runs BEFORE `normalizeWslSessionToWindows` copies the
 * session out — that is the whole point of where it sits — so on this PC the
 * audio is on ext4 and the qwen3 env is a WSL env. The caller states that env by
 * NAME; the phase still names no engine.
 */
const PHASE_ENGINE: Record<NarratorPhase, 'required' | 'refused' | 'optional'> = {
  serve: 'required',
  prep: 'required',
  worker: 'required',
  align: 'refused',
  assembly: 'optional',
  resume: 'refused',
  list: 'refused',
};

/**
 * How the resident Listen/extension server is recognised in a process list, as a
 * regex SOURCE string (it goes into `pgrep -f` inside the WSL guest and into a
 * PowerShell `-match` on Windows).
 *
 * It lives HERE, with the thing that builds the command line, because two files
 * have to agree about it and they agree in OPPOSITE directions:
 * `orpheus-worker-pool.ts` matches it to tear its own worker down, and
 * `parallel-tts-bridge.ts`'s orphan reaper EXCLUDES it so a batch sweep can never
 * kill the server a user is listening to. A stale copy on the exclusion side does
 * not fail loudly — it silently stops excluding anything, and the first sweep
 * during playback kills playback.
 *
 * The dot is the module separator: `narrator\.serve` matches
 * `python -u -m narrator.serve` and nothing else narrator runs, because the batch
 * doors are `narrator.compat.worker` and `narrator.compat.app`.
 */
export const SERVE_PROCESS_RE = 'narrator\\.serve';

/**
 * The BATCH doors, as they appear in a process list. Regex SOURCE strings.
 *
 * `narrator.compat.worker` is every render worker and every retake;
 * `narrator.compat.app` is prep, assembly, resume and list. Together they are
 * what the orphan reapers hunt, and `SERVE_PROCESS_RE` is what those reapers must
 * never touch - killing the resident Listen server because a batch job ended is a
 * user's playback stopping for no reason they can see.
 *
 * These replace e2a's `worker\.py` / `app\.py` / `ebook2audiobook.*\.py`. Nothing
 * FAILS when a kill pattern goes stale: the sweep reports success, matches
 * nothing, and leaves a vLLM process holding the GPU - which is the shape that
 * wedges the WSL VM and the shape that makes the next job refuse to start.
 *
 * The dot is escaped because these go into `pgrep -f` and PowerShell `-match`.
 */
export const NARRATOR_WORKER_RE = 'narrator\\.compat\\.worker';
export const NARRATOR_APP_RE = 'narrator\\.compat\\.app';

/** Either batch door. Used where a sweep does not care which phase it caught. */
export const NARRATOR_BATCH_RE = 'narrator\\.compat\\.(worker|app)';

/**
 * Where the `narrator` package lives, as a HOST path.
 *
 * The three candidates are the app path (dev and packaged), the dist-relative
 * walk-up, and a co-located copy; `toUnpackedPath` handles the packaged case,
 * where a spawned Python cannot read inside app.asar.
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
    'The narrator package is not in this checkout. BookForge renders through narrator ' +
      '(python/narrator), which lands with or before this branch — it is NOT vendored ' +
      'or copied here. Looked for narrator/__init__.py under: ' + candidates.join(', ') +
      '. Merge feat/narrator.',
  );
}

/**
 * HAS narrator's MLX HIGGS BACKEND LANDED IN THIS CHECKOUT?
 *
 * Higgs v3 ships ONE backend today: `engine/higgs/v3_served.py`, a vLLM-Omni
 * server. vLLM-Omni has no macOS build, so on a Mac `NARRATOR_ENGINE=higgs-v3`
 * resolves to an engine that cannot start — which is why the Listen picker must
 * not offer Higgs there, however present the `narrator-mlx` environment is.
 *
 * An in-process MLX backend for darwin is being written on
 * `feat/narrator-higgs-mlx`. This detects it by CONTENT rather than by filename,
 * because the filename is the other builder's to choose: any module under
 * `engine/higgs/` that mentions mlx means the backend is here.
 *
 * IT IS A LANDING DETECTOR, NOT A CAPABILITY QUERY, and the difference matters
 * enough to say: it answers "is the code present", not "will it load on this
 * machine". When the branch lands, the honest replacement is to ask narrator
 * itself — a `--probe` on the registry, or an engine attribute the serve worker
 * reports — and this function goes. Until then it is what keeps the picker from
 * promising a Mac feature that does not exist yet, without hard-coding `false`
 * that somebody then has to remember to flip.
 */
let higgsMlxBackendCache: boolean | null = null;

export function higgsMlxBackendPresent(): boolean {
  if (higgsMlxBackendCache !== null) return higgsMlxBackendCache;
  try {
    const dir = path.join(narratorPythonRoot(), 'narrator', 'engine', 'higgs');
    higgsMlxBackendCache = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.py'))
      .some((f) => /\bmlx\b/i.test(fs.readFileSync(path.join(dir, f), 'utf-8')));
  } catch {
    // No narrator package, or no higgs engine directory. Either way the backend
    // is not here, which is the same answer.
    higgsMlxBackendCache = false;
  }
  return higgsMlxBackendCache;
}

/** Does a spawn for this engine cross into WSL on this machine? */
export function narratorRunsInWsl(engine: NarratorEngineId | undefined, phase: NarratorPhase): boolean {
  if (process.platform !== 'win32') return false;
  // No engine means the tools env, which is native everywhere, deliberately: an
  // assembly on Windows reads a session that generation already normalised onto a
  // Windows path, and the \\wsl$ 9p mount is slow enough to dominate the job.
  if (!engine || PHASE_ENGINE[phase] === 'refused') return false;
  return engine === 'higgs' ? shouldUseWsl2ForHiggs() : shouldUseWsl2ForOrpheus();
}

/**
 * THE ARM ONE SPAWN TAKES — guest or host — as ONE computation.
 *
 * `narratorRunsInWsl` answers for the engine; `onHost` (see the request field)
 * overrides it for a text-only phase whose render is elsewhere. Both
 * `buildNarratorSpawn` and `higgs-spawn.ts`'s voice document ask THIS, so the
 * filesystem the document is written for is provably the one the command line
 * is built for — which was the whole point of asking narrator-spawn rather than
 * recomputing, and would be lost the moment the override lived in one of them.
 */
export function narratorSpawnCrossesIntoWsl(
  engine: NarratorEngineId | undefined,
  phase: NarratorPhase,
  onHost: boolean,
): boolean {
  return !onHost && narratorRunsInWsl(engine, phase);
}

/**
 * Can THIS machine run narrator's prep in the tools env? The refusal text, or null.
 *
 * MEASURED, not inferred from a package list: the tools env is asked to import
 * the modules `compat/app.py:route_prep` imports — `narrator.compat.app`,
 * `narrator.text.prep`, and for Higgs `narrator.engine.higgs.v3_engine` (the
 * prep budget lives there; the module is numpy + urllib, no server) — with the
 * same PYTHONPATH the spawn will carry. An ImportError here is the same
 * ImportError the prep would have died with, said BEFORE the job holds a GPU
 * lease and a session directory, and naming the interpreter and the module.
 *
 * Asked once per job by `prepareSession`, only on the `onHost` arm; the legacy
 * arm keeps the Higgs doctor it always had.
 */
export async function hostPrepRefusal(engine: NarratorEngineId): Promise<string | null> {
  const py = narratorNativePython(undefined);
  const pythonRoot = narratorPythonRoot();
  const modules = [
    'narrator.compat.app',
    'narrator.text.prep',
    ...(engine === 'higgs' ? ['narrator.engine.higgs.v3_engine'] : []),
  ];
  const probe = `import importlib\n${modules.map((m) => `importlib.import_module(${JSON.stringify(m)})`).join('\n')}\n`;
  const args = [...py.args, '-c', probe];
  const env = buildToolsSpawnEnv({ PYTHONPATH: pythonRoot, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' });

  const outcome = await new Promise<{ code: number | null; stderr: string; spawnError?: string }>((resolve) => {
    let stderr = '';
    let settled = false;
    const done = (v: { code: number | null; stderr: string; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child: ChildProcess;
    try {
      child = spawn(py.command, args, { env, cwd: app.getPath('userData'), shell: false, windowsHide: true });
    } catch (err) {
      done({ code: null, stderr: '', spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ code: null, stderr, spawnError: 'the probe did not answer within 60 s' });
    }, 60_000);
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); done({ code: null, stderr, spawnError: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stderr }); });
  });

  if (outcome.code === 0) return null;
  const lines = outcome.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const reason = outcome.spawnError
    ?? (lines.length ? lines[lines.length - 1] : `exit code ${outcome.code}`);
  return (
    `This render's generation step runs on a Crucible server, so the book is prepped on this ` +
    `machine in the tools environment — and that environment cannot run narrator's prep: ` +
    `${reason}. Interpreter: ${py.command}${py.args.length ? ' ' + py.args.join(' ') : ''}; ` +
    `narrator at ${pythonRoot}. Install narrator's text dependencies into it ` +
    `(\`<that python> -m pip install -e ${pythonRoot}\`). There is no local narrator to prep with ` +
    `instead (docs/LEGACY-REMOVAL.md), and nothing preps inside WSL for a render that does not ` +
    `run there.`
  );
}

/**
 * Build the spawn for one narrator phase.
 *
 * Every path in `args` and every VALUE in `envExtras` is translated for the WSL
 * guest on the WSL arm, and left alone on the native one. Translating both with
 * the same function is the point: a Windows path is exactly as unusable to the
 * guest inside `NARRATOR_HIGGS_VOICES` as it is inside `--session_dir`, and when
 * the two were translated by different code (one correct, one not) the broken
 * one stayed invisible in a log for weeks.
 */
export function buildNarratorSpawn(req: NarratorSpawnRequest): NarratorSpawnPlan {
  const { engine, phase, args, envExtras } = req;
  const rule = PHASE_ENGINE[phase];

  if (rule === 'refused' && engine) {
    throw new Error(
      `buildNarratorSpawn: phase '${phase}' is engine-agnostic and runs in the tools ` +
        `environment on every platform, but engine '${engine}' was named. A session ` +
        'already records which engine rendered it; resume and list read that and need ' +
        'no TTS environment. Drop the engine.',
    );
  }
  if (rule === 'required' && !engine) {
    throw new Error(
      `buildNarratorSpawn: phase '${phase}' needs an engine — it decides which ` +
        'environment the spawn runs in and what NARRATOR_ENGINE says. Pass ' +
        "'orpheus' or 'higgs'.",
    );
  }

  if (req.onHost) {
    if (phase !== 'prep') {
      throw new Error(
        `buildNarratorSpawn: onHost was set on phase '${phase}'. Only prep is text-only work ` +
          'that can run in the tools env while the engine renders elsewhere; the worker and ' +
          'serve load the model, and the tools phases already run on the host.',
      );
    }
    if (req.wslCondaEnv !== undefined) {
      throw new Error(
        `buildNarratorSpawn: onHost and wslCondaEnv '${req.wslCondaEnv}' were both given. One ` +
          'says this phase never enters the guest, the other names the guest env to run it in.',
      );
    }
  }

  if (req.wslCondaEnv !== undefined) {
    if (process.platform !== 'win32') {
      throw new Error(
        `buildNarratorSpawn: wslCondaEnv '${req.wslCondaEnv}' was named on ${process.platform}, ` +
          'where there is no WSL guest to run it in. Only a Windows caller may cross that ' +
          'boundary; everywhere else the same phase runs natively.',
      );
    }
    if (engine) {
      throw new Error(
        `buildNarratorSpawn: phase '${phase}' was given BOTH engine '${engine}' and ` +
          `wslCondaEnv '${req.wslCondaEnv}'. Each names the guest environment on its own, and ` +
          'two sources for one answer disagree the day one of them is changed. Pass one.',
      );
    }
  }

  const module = PHASE_MODULE[phase];
  const pythonRoot = narratorPythonRoot();
  const viaWsl = req.wslCondaEnv !== undefined
    || narratorSpawnCrossesIntoWsl(engine, phase, req.onHost === true);

  const baseEnv: Record<string, string> = {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    ...(engine ? { NARRATOR_ENGINE: NARRATOR_ENGINE_ENV[engine] } : {}),
    ...envExtras,
  };

  if (viaWsl) {
    const conda = getWslCondaPath();
    // The caller's stated guest env wins when there is one (see `wslCondaEnv`);
    // otherwise the engine decides, which is every render spawn.
    const envName = req.wslCondaEnv !== undefined
      ? req.wslCondaEnv
      : (engine === 'higgs' ? getWslHiggsCondaEnv() : getWslOrpheusCondaEnv());
    const distro = getWslDistro();

    const guestArgs = args.map(toGuestPath);
    const exports = Object.entries({ ...baseEnv, PYTHONPATH: windowsToWslPath(pythonRoot) })
      .map(([k, v]) => `${k}=${shellQuote(toGuestPath(v))}`)
      .join(' ');
    const run =
      `${shellQuote(conda)} run --no-capture-output -n ${shellQuote(envName)} ` +
      `python -u -m ${module}` +
      (guestArgs.length ? ` ${guestArgs.map(shellQuote).join(' ')}` : '');
    // cwd is not load-bearing for narrator, but it must EXIST inside the guest,
    // so it is the WSL home rather than a translated Windows path that may not be
    // mounted.
    const bash = `export ${exports} && cd ~ && ${run}`;
    const wslArgv = distro ? ['-d', distro, 'bash', '-c', bash] : ['bash', '-c', bash];
    return {
      command: 'wsl.exe',
      args: wslArgv,
      // wsl.exe itself is a normal Windows child; its environment is irrelevant
      // to the guest (nothing is in WSLENV) and is inherited for the launcher's
      // own sake.
      env: process.env,
      cwd: process.cwd(),
      viaWsl: true,
      shell: false,
      describe: () => `wsl.exe ${wslArgv.slice(0, -1).join(' ')} '${bash}'`,
    };
  }

  // `onHost`: the tools env, on purpose — see the request field. The engine's
  // own native env is either the guest (Windows) or the render's env, and this
  // phase's render is on another machine.
  const py = narratorNativePython(req.onHost ? undefined : engine);
  const nativeArgs = [...py.args, '-u', '-m', module, ...args];
  return {
    command: py.command,
    args: nativeArgs,
    env: buildToolsSpawnEnv({ ...baseEnv, PYTHONPATH: pythonRoot }),
    cwd: req.cwdHint ?? app.getPath('userData'),
    viaWsl: false,
    shell: false,
    describe: () => `${py.command} ${nativeArgs.join(' ')}`,
  };
}

/**
 * The python that runs a native narrator spawn, and the refusal when there isn't
 * one.
 *
 * Exported because `streaming-engine.ts` asks the same question for a different
 * purpose: whether to offer Orpheus in the Listen picker at all. Asking it here
 * rather than re-deriving it there is what stops the picker from reporting
 * "Orpheus: available" on a Mac with no narrator-mlx environment — a promise
 * every spawn would then break, one refusal at a time.
 *
 * `undefined` — the tools phases — resolves the GENERIC bundled environment, the
 * same one `parallel-tts-bridge.ts` already uses for a native Orpheus assembly
 * (`pythonInvocation(undefined)`): `getPythonInvocation` with no engine returns
 * the relocatable env a packaged build ships, or `<e2a>/python_env`. That env is
 * the tools env — whisper, metadata tools, ffmpeg/ffprobe/sox, and the
 * numpy/soundfile/mutagen `narrator.assemble` needs — and Phase 6 renames it to
 * say so.
 */
export function narratorNativePython(engine: NarratorEngineId | undefined): PythonInvocation {
  // ONE MLX ENVIRONMENT, BOTH ENGINES, on the Mac.
  //
  // Orpheus has always resolved here: MLX is in neither the bundled env nor any
  // vLLM env. Higgs joins it because its darwin backend is the same kind of
  // thing — `engine/higgs/mlx_backend.py` is IN-PROCESS mlx-audio, not a server,
  // so it needs mlx/mlx-lm/mlx-audio and nothing that a vLLM-Omni env would have.
  //
  // Higgs must NOT go to `getEnvPathForEngine('higgs')` here: that resolves the
  // `higgs-env` component, which is the SERVED stack's environment and has no
  // macOS build at all. It would refuse a Mac that is perfectly able to render.
  if ((engine === 'orpheus' || engine === 'higgs') && process.platform === 'darwin') {
    return {
      command: getCondaPath(),
      args: ['run', '--no-capture-output', '-p', getNarratorMlxEnv(), 'python'],
    };
  }
  // Everything else keeps today's resolution exactly: the component seam for
  // Orpheus (managed env on Windows-without-WSL and on Linux), the Higgs seam
  // (which refuses on Windows without the WSL toggle, by name), and the bundled
  // env for the tools phases.
  return getPythonInvocation(engine);
}

/**
 * A HOST-NATIVE path, as the WSL guest must see it. Anything else verbatim.
 *
 * THREE INPUT FORMS, because a Windows host has three ways of naming a file the
 * guest can open:
 *
 *   C:\x  /  C:/x            a drive path       -> /mnt/c/x
 *   \\wsl$\Ubuntu\home\x     the UNC form of a  -> /home/x
 *   \\wsl.localhost\...      guest-resident path
 *   /home/x  /  /mnt/c/x     already guest form -> unchanged
 *
 * The UNC form is not hypothetical: `tool-paths.ts` documents it for
 * `orpheusModelsDir` on a Windows+WSL machine, so a models directory that lives
 * on ext4 is NAMED on the Windows side as `\\wsl$\<distro>\...`. Handling only
 * drive letters would translate a session dir correctly and leave a models path
 * as a UNC string the guest cannot open.
 *
 * Passing an already-guest-form path through unchanged is what makes this safe to
 * apply to argv, to every environment value and to catalog paths without knowing
 * which of them were already translated.
 */
export function toGuestPath(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) return windowsToWslPath(value);
  const unc = value.replace(/\\/g, '/')
    .match(/^\/\/wsl[$.](?:localhost)?\/[^/]+(\/.*)?$/i);
  if (unc) return unc[1] || '/';
  return value;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
