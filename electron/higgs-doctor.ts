/**
 * IS HIGGS READY ON *THIS* MACHINE? — the two doctors and the dispatcher.
 *
 * Higgs v3 is one engine with two backends (PORT_NOTES 13): a vLLM-Omni SERVER,
 * reached through WSL on Windows, and an IN-PROCESS mlx-audio backend on macOS.
 * They share an id, a voice document and a geometry, and they share nothing at
 * all about what "installed" means — one is a conda env with two site-packages
 * patches and a launch script, the other is a conda env with three python
 * packages and 8.5 GB of weights in Application Support.
 *
 * Until 2026-09-05 there was one doctor, the WSL one, and it answered every
 * question on every platform. On the Mac that produced the defect this module
 * exists for: the narration modal reported
 *
 *     "The Higgs environment is not ready … : WSL distribution.
 *      Set it up in Settings → Higgs, or pick Orpheus on the Reading tab."
 *
 * on a Mac that renders Higgs perfectly well — the doctor's non-Windows early
 * return, displayed as a diagnosis. The mirror-image bug sat in
 * `higgsEnvironmentRefusal`, which returned `null` on darwin having checked
 * NOTHING: an unchecked pass, which lets a job start and fail an hour in.
 *
 * ── The rules both doctors keep ─────────────────────────────────────────────
 *
 *  1. ONE ROUND TRIP. Each spawn of `wsl.exe`, or of `conda run`, costs the
 *     better part of a second, and a doctor that takes five seconds is a doctor
 *     nobody runs. The probe prints one `key=value` line per question.
 *  2. EVERY CHECK IS REPORTED, PASS OR FAIL. The probe never short-circuits, and
 *     a MISSING line is a failure rather than a pass — "mlx-audio is at the
 *     wrong version" and "there is no environment" are different problems, and a
 *     doctor that stopped at the first would make them look the same.
 *  3. THE REMEDY TRAVELS WITH THE RESULT. See `HiggsSetupResult.remedy`.
 *  4. THE SPAWN'S OWN RESOLUTION, NOT A SECOND DESCRIPTION OF IT. The MLX doctor
 *     asks `narratorNativePython('higgs')` and `narratorPythonRoot()` — the two
 *     functions the real spawn asks — so a doctor that says "ready" cannot be
 *     talking about a different environment from the one the render will use.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  checkWslHiggsSetupAsync,
  shouldUseWsl2ForHiggs,
  WSL_HIGGS_REMEDY,
  type HiggsCheck,
  type HiggsSetupResult,
} from './tool-paths';
import { buildCondaSpawnEnv } from './e2a-paths';
import { narratorNativePython, narratorPythonRoot } from './narrator-spawn';
import { higgsMlxBaseDir, listHiggsModels } from './higgs-models';

/**
 * The mlx-audio release BOTH MLX engines are written against.
 *
 * MIRRORED from `python/narrator/engine/higgs/mlx_backend.py`'s
 * `MLX_AUDIO_VERSION` for the same reason `HIGGS_PATCHES` is mirrored from the
 * catalog: this module must be readable without a python interpreter, and the
 * doctor has to state the expected version even when the backend module is the
 * thing that failed to import. `tools/test-higgs-doctor-arms.js` asserts the two
 * copies agree, so they cannot drift.
 *
 * The pin is EXACT and measured (packaging/env/narrator-mlx.yml): 0.5.1 cannot
 * render Orpheus at all, 0.3.x drags mlx-lm below the batched fast path, and
 * 0.4.8 is the one release that renders both engines.
 */
export const HIGGS_MLX_AUDIO_VERSION = '0.4.8';

/**
 * The files `mlx_audio.tts.utils.load_model` and its `post_load_hook` OPEN in
 * the base weights directory. Not a guess and not "what HuggingFace usually
 * ships" — read out of mlx-audio 0.4.8 on the Mac, 2026-09-05:
 *
 *   config.json      `load_config` → the architecture and the model args
 *   tokenizer.json   `Tokenizer.from_file(model_path/'tokenizer.json')` in
 *                    `higgs_audio_v3.Model.post_load_hook`
 *   *.safetensors    the weights; `load_model` raises FileNotFoundError with
 *                    none, and the CODEC comes out of these same shards
 *                    (`HiggsAudioTokenizer.from_higgs_tts_checkpoint`)
 *
 * `tokenizer_config.json` and `chat_template.jinja` ship with the repo and are
 * NOT read on this path (the tokenizer is built from the `tokenizer_object`),
 * so they are not required here — checking them would refuse a directory that
 * loads. `generation_config.json` is likewise absent from the BASE weights by
 * design; it is a fine-tune's sampling and lives in a checkpoint voice's own
 * directory.
 */
const MLX_BASE_REQUIRED_FILES = ['config.json', 'tokenizer.json'] as const;

/** How long either probe may take before it is reported as no answer. */
const PROBE_TIMEOUT_MS = 30000;

/**
 * The MLX probe, as one python program.
 *
 * Every question is answered on its own line and every failure is CAUGHT, so a
 * missing mlx does not stop the mlx-audio line from being printed. The values
 * are flattened to one line each: a traceback's newlines would otherwise be
 * parsed as further keys.
 *
 * IT IMPORTS, IT DOES NOT LOAD. `import mlx_audio` and
 * `import narrator.engine.higgs.mlx_backend` are cheap and touch no weights —
 * the backend module imports mlx lazily, deliberately
 * (`tests/test_engine_lazy_imports.py`), so this probe answers "could this
 * machine start the engine" in about a second rather than loading 8.5 GB to
 * find out.
 */
const MLX_PROBE = `
import sys

def emit(key, value):
    print('%s=%s' % (key, ' '.join(str(value).split())), flush=True)

emit('python', sys.version.split()[0])

try:
    import mlx.core
    emit('mlx', getattr(mlx.core, '__version__', 'present'))
except Exception as err:
    emit('mlx', 'error: %s: %s' % (type(err).__name__, err))

try:
    import mlx_audio
    from importlib.metadata import version
    emit('mlx-audio', version('mlx-audio'))
except Exception as err:
    emit('mlx-audio', 'error: %s: %s' % (type(err).__name__, err))

try:
    import narrator.engine.higgs.mlx_backend as backend
    emit('narrator', backend.MLX_AUDIO_VERSION)
except Exception as err:
    emit('narrator', 'error: %s: %s' % (type(err).__name__, err))
`.trim();

/**
 * Run something that refuses BY THROWING and keep the refusal as text.
 *
 * The two resolutions this doctor reuses (`narratorNativePython`,
 * `narratorPythonRoot`) state what is wrong in the exception they raise, and the
 * doctor's job is to REPORT that rather than to let it escape — a doctor that
 * throws is a modal with no rows in it.
 */
function attempt<T>(fn: () => T): { value: T } | { error: string } {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse `key=value` lines. A key printed twice keeps the FIRST answer. */
function probeLines(out: string): Map<string, string> {
  const seen = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = line.replace(/\0/g, '').trim().match(/^([^=]+)=(.*)$/);
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return seen;
}

/**
 * WHICH CATALOG VOICES THIS ARM COULD LOAD — informational, never a check.
 *
 * A green environment with no fine-tune installed is a working installation, so
 * this cannot make `valid` false. It is here because the difference between
 * "Higgs is broken" and "Higgs works and the voice you want is on the other
 * machine" is invisible from the environment rows alone: a `checkpoint` voice
 * loads from ITS OWN directory (`checkpointDir`), which on the Mac is a
 * host-native path that a WSL-shaped catalog entry simply does not have.
 */
function mlxVoiceNotes(baseDirOk: boolean): string[] {
  return listHiggsModels().map((m) => {
    if (m._pendingNote) return `${m.id}: not installed yet — ${m._pendingNote.split('.')[0]}.`;
    if (m.kind === 'checkpoint') {
      const dir = m.voice.checkpointDir;
      if (!dir) return `${m.id}: a checkpoint voice with no checkpointDir — the catalog entry is malformed.`;
      return fs.existsSync(dir)
        ? `${m.id}: loadable — fine-tuned weights at ${dir}.`
        : `${m.id}: NOT loadable on this Mac — its weights are named at ${dir}, which is not on this machine.`;
    }
    return baseDirOk
      ? `${m.id}: loadable — renders from the base weights.`
      : `${m.id}: not loadable until the base weights are in place.`;
  });
}

/**
 * THE MACOS HIGGS DOCTOR. One `conda run … python -c` round trip.
 *
 * Six checks, in the order a failure cascades:
 *
 *   env          the `narrator-mlx` prefix, resolved EXACTLY as the spawn
 *                resolves it (`narratorNativePython('higgs')`)
 *   python       the interpreter in that env answered at all
 *   mlx          `import mlx.core`
 *   mlx-audio    installed AND at the pinned version
 *   narrator     `narrator.engine.higgs.mlx_backend` imports off the repo's
 *                python/ (PYTHONPATH as the spawn sets it)
 *   weights      the base checkpoint directory, with the files the MLX backend
 *                actually opens
 *
 * The `env` and `weights` rows are answered on the HOST rather than inside the
 * probe, and that is not an inconsistency: on darwin there is no guest, so the
 * probe's filesystem IS this process's filesystem. Answering them here means
 * they are still reported when the probe itself cannot run — which is exactly
 * the case where "and by the way, there are no weights either" is worth having.
 */
export function checkDarwinHiggsSetupAsync(): Promise<HiggsSetupResult> {
  const baseDir = higgsMlxBaseDir(app.getPath('userData'));
  const remedy =
    'Create or repair the narrator-mlx environment — '
    + '`conda env create -f packaging/env/narrator-mlx.yml` then '
    + '`conda run -p <prefix> pip install -e python/` — and put the Higgs v3 base weights '
    + `(bosonai/higgs-audio-v3-tts-4b, ~8.5 GB) at ${baseDir}.`;

  // THE SPAWN'S OWN RESOLUTION. It throws by name when the env is missing, and
  // that message is the check's detail — there is nothing better to say, and
  // re-describing the search here would let the doctor and the launcher look in
  // different places.
  const resolved = attempt(() => narratorNativePython('higgs'));
  if ('error' in resolved) {
    return Promise.resolve(mlxResult(
      [
        { id: 'env', label: 'Conda env "narrator-mlx"', ok: false, detail: resolved.error },
        ...mlxProbeChecks(new Map(), 'the environment could not be resolved, so nothing was probed'),
        weightsCheck(baseDir),
      ],
      remedy,
      mlxVoiceNotes(baseWeightsOk(baseDir)),
      undefined,
    ));
  }
  const invocation = resolved.value;
  const envCheck: HiggsCheck = { id: 'env', label: 'Conda env "narrator-mlx"', ok: true };

  // PYTHONPATH is the repo's python/, exactly as `buildNarratorSpawn`'s native
  // branch sets it — the narrator package is not pip-installed into the env in a
  // dev checkout, and a probe that imported a DIFFERENT narrator than the render
  // would be worse than no probe.
  const root = attempt(() => narratorPythonRoot());
  if ('error' in root) {
    return Promise.resolve(mlxResult(
      [envCheck, ...mlxProbeChecks(new Map(), root.error), weightsCheck(baseDir)],
      remedy,
      mlxVoiceNotes(baseWeightsOk(baseDir)),
      envPrefixOf(invocation),
    ));
  }
  const pythonRoot = root.value;

  const spawnEnv = buildCondaSpawnEnv({
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: pythonRoot,
  });
  // `conda run … python` — the invocation ends with the interpreter, so the
  // program goes on the end.
  const args = [...invocation.args, '-c', MLX_PROBE];

  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (probeError: string | null) => {
      if (done) return;
      done = true;
      const checks = [envCheck, ...mlxProbeChecks(probeLines(out), probeError), weightsCheck(baseDir)];
      resolve(mlxResult(checks, remedy, mlxVoiceNotes(baseWeightsOk(baseDir)), envPrefixOf(invocation)));
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(invocation.command, args, { env: spawnEnv, windowsHide: true });
    } catch (err) {
      finish(err instanceof Error ? err.message : String(err));
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(`the narrator-mlx probe did not answer within ${PROBE_TIMEOUT_MS / 1000} s`);
    }, PROBE_TIMEOUT_MS);
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    proc.on('error', (err) => { clearTimeout(timer); finish(err.message); });
    proc.on('close', () => { clearTimeout(timer); finish(null); });
  });
}

/** `conda run --no-capture-output -p <prefix> python` → `<prefix>`. */
function envPrefixOf(invocation: { args: string[] }): string | undefined {
  const i = invocation.args.indexOf('-p');
  return i >= 0 ? invocation.args[i + 1] : undefined;
}

function mlxResult(
  checks: HiggsCheck[], remedy: string, notes: string[], envPrefix: string | undefined,
): HiggsSetupResult {
  return { valid: checks.every((c) => c.ok), arm: 'mlx', remedy, checks, notes, envPrefix };
}

/**
 * The four rows the probe answers.
 *
 * `probeError` non-null means the probe never ran (or never finished): every row
 * fails, carrying that reason. A MISSING LINE with no probe error is also a
 * failure — the program prints all four unconditionally, so an absent one means
 * the interpreter died partway, which is not a pass.
 */
function mlxProbeChecks(seen: Map<string, string>, probeError: string | null): HiggsCheck[] {
  const value = (key: string): string | undefined => seen.get(key);
  const failed = (key: string): string => {
    if (probeError) return `The probe did not run: ${probeError}`;
    const answer = value(key);
    if (answer === undefined) {
      return 'The probe printed no answer for this, which means the interpreter died partway '
        + 'through — the environment is not usable as it stands.';
    }
    return answer;
  };

  const python = value('python');
  const mlx = value('mlx');
  const mlxAudio = value('mlx-audio');
  const narrator = value('narrator');

  const ok = (v: string | undefined) => !probeError && v !== undefined && !v.startsWith('error:');

  const checks: HiggsCheck[] = [];
  checks.push({
    id: 'python',
    label: 'Python in the environment',
    ok: ok(python),
    ...(ok(python) ? {} : { detail: failed('python') }),
  });
  checks.push({
    id: 'mlx',
    label: 'mlx importable',
    ok: ok(mlx),
    ...(ok(mlx) ? {} : { detail: failed('mlx') }),
  });

  // TWO WAYS TO FAIL, said differently: not installed, and installed at a
  // version the backend is not written against. The second renders — badly or
  // not at all — and would otherwise look like a working machine.
  const audioOk = ok(mlxAudio) && mlxAudio === HIGGS_MLX_AUDIO_VERSION;
  checks.push({
    id: 'mlx-audio',
    label: `mlx-audio ${HIGGS_MLX_AUDIO_VERSION}`,
    ok: audioOk,
    ...(audioOk ? {} : {
      detail: ok(mlxAudio)
        ? `The environment has mlx-audio ${mlxAudio}; narrator's MLX backend is written against `
          + `${HIGGS_MLX_AUDIO_VERSION} and no other release renders both engines. `
          + 'Re-create the env from packaging/env/narrator-mlx.yml.'
        : failed('mlx-audio'),
    }),
  });

  // The pin the BACKEND declares, checked against this module's copy. They are
  // two files that must agree, and the machine in front of the user is the one
  // place the disagreement can actually be observed.
  const narratorOk = ok(narrator) && narrator === HIGGS_MLX_AUDIO_VERSION;
  checks.push({
    id: 'narrator',
    label: 'narrator.engine.higgs.mlx_backend importable',
    ok: narratorOk,
    ...(narratorOk ? {} : {
      detail: ok(narrator)
        ? `The backend module pins mlx-audio ${narrator} while BookForge expects `
          + `${HIGGS_MLX_AUDIO_VERSION}. The python/ package and this build are out of step — `
          + 'pull the narrator branch, or rebuild BookForge.'
        : failed('narrator'),
    }),
  });
  return checks;
}

/** Does the base weights directory hold everything the MLX backend opens? */
function baseWeightsOk(baseDir: string): boolean {
  return missingWeightFiles(baseDir).length === 0;
}

/** What the base weights directory is missing, named file by file. */
function missingWeightFiles(baseDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return ['the directory itself'];
  }
  const missing: string[] = MLX_BASE_REQUIRED_FILES
    .filter((f) => !fs.existsSync(path.join(baseDir, f)));
  if (!entries.some((e) => e.endsWith('.safetensors'))) missing.push('*.safetensors (the weights)');
  return missing;
}

function weightsCheck(baseDir: string): HiggsCheck {
  const missing = missingWeightFiles(baseDir);
  return {
    id: 'weights',
    label: 'Higgs v3 base weights',
    ok: missing.length === 0,
    ...(missing.length === 0 ? {} : {
      detail: `${baseDir} is missing ${missing.join(', ')}. The MLX backend loads the merged `
        + 'weights from that directory and has no default and no search — download '
        + 'bosonai/higgs-audio-v3-tts-4b (~8.5 GB) into it.',
    }),
  };
}

/**
 * THE DOCTOR, chosen by platform. The one door for "is Higgs ready".
 *
 * win32   the WSL doctor, unchanged — with the "WSL2 for Higgs" toggle reported
 *         as its own row IN FRONT of it. The toggle is not part of the WSL
 *         environment's health (the env can be perfect with the toggle off, and
 *         the Settings panel must still show those rows so a person can see
 *         what an install achieved), but it IS part of whether a render can
 *         start, so it is a check rather than an early return.
 * darwin  the MLX doctor above.
 * else    a refusal that NAMES THE PLATFORM. Linux has neither route: vLLM-Omni
 *         installs natively there in principle, but BookForge has never built or
 *         measured that arm, and claiming a green doctor for it would be a
 *         promise every render breaks.
 */
export async function higgsDoctor(): Promise<HiggsSetupResult> {
  if (process.platform === 'win32') {
    const toggleOn = shouldUseWsl2ForHiggs();
    const wsl = await checkWslHiggsSetupAsync();
    const toggle: HiggsCheck = {
      id: 'toggle',
      label: '"WSL2 for Higgs" enabled',
      ok: toggleOn,
      ...(toggleOn ? {} : {
        detail: 'Higgs runs on vLLM-Omni, which has no Windows build. Turn on "WSL2 for Higgs" '
          + 'in Settings → Higgs so jobs are routed into the WSL environment.',
      }),
    };
    const checks = [toggle, ...wsl.checks];
    return { ...wsl, valid: checks.every((c) => c.ok), checks, remedy: WSL_HIGGS_REMEDY };
  }
  if (process.platform === 'darwin') return checkDarwinHiggsSetupAsync();
  return {
    valid: false,
    arm: 'none',
    // NO "or pick Orpheus" here: the narration modal appends that itself, and the
    // remedy is quoted verbatim into it.
    remedy: 'Render Higgs on a Mac (the in-process MLX backend) or on Windows with the '
      + '"WSL2 for Higgs" environment.',
    checks: [{
      id: 'platform',
      label: `Higgs backend for ${process.platform}`,
      ok: false,
      detail: `Higgs v3 has two backends — a vLLM-Omni server reached through WSL on Windows, and `
        + `an in-process mlx-audio backend on macOS. BookForge builds neither on ${process.platform}.`,
    }],
  };
}
