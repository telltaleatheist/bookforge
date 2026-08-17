/**
 * backend-setup — build the WSL environment vLLM is served from, out loud.
 *
 * This is the "dependency downloader" idea from BookForge's component-manager,
 * kept and stripped to its bones: a named target, a plan of commands, every
 * line of output forwarded to the screen while it runs, a cancel that actually
 * kills the tree, and a result that is either a path or a sentence.
 *
 * What is NOT kept from there: a catalog, versions, hashes, mirrors, an update
 * check. Nothing here is OURS to version. `pip install vllm` resolves whatever
 * CUDA wheels that distro's Python takes, and the model weights are pulled by
 * vLLM into the guest's own HuggingFace cache on first serve.
 *
 * ── Three rules ──────────────────────────────────────────────────────────────
 *
 * **It talks the whole time.** A vLLM install is ~2 GB of torch and CUDA wheels
 * and several minutes on a good line. A spinner that says nothing for five
 * minutes is indistinguishable from a hang, and a user who cannot tell the
 * difference kills it — so every stdout and stderr line goes to the renderer as
 * it arrives (electron/wsl.ts `streamInDistro`).
 *
 * **It never falls back.** A user who picked conda and whose conda failed is
 * told that conda failed. Quietly building a venv instead would leave them with
 * an environment they did not ask for, in a place they will not look, the next
 * time they debug this.
 *
 * **It is idempotent.** An env that already exists is not recreated, and a vllm
 * that already imports is not reinstalled. Re-running after a network drop
 * resumes at the step that failed rather than starting two gigabytes again.
 */
import { writeSettings } from './settings';
import { VLLM_URL } from './vllm-server';
import { checkVllm, runInDistro, streamInDistro, type EnvTooling, type StreamHandle } from './wsl';
import type { SetupLogEvent, SetupRequest, SetupResult, SetupRoute } from '../shared/types';

/**
 * The environment's name, everywhere.
 *
 * Distinct from the engine's default probe candidates (`vllm`, `dots`,
 * `vlmtest`) ON PURPOSE: an env this app built is an env this app may later
 * decide to rebuild, and it must never be able to do that to one the user made
 * by hand. The path is written into `backend.vllmPython`, so the engine finds
 * it by name rather than by guessing.
 */
const ENV_NAME = 'foundry-vllm';

/** Where the venv route puts its environment. Tilde-form; bash expands it. */
const VENV_HOME = '~/.venvs';

/** The Python a fresh conda env is created with. vLLM's supported range today. */
const PYTHON_VERSION = '3.12';

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

export interface SetupTarget {
  route: SetupRoute;
  /** The interpreter that will exist when this is done. Tilde-form. */
  pythonPath: string;
  /** Tested for existence to decide whether creation is needed at all. */
  envPath: string;
  /** Run only when `envPath` has no interpreter in it yet. */
  createCommand: string;
  /** Run between creation and the install, when the route wants one. */
  prepareCommand: string | null;
  /** Run only when vllm does not already import. */
  installCommand: string;
}

/**
 * Route + what the distro has -> exactly what will be run. Pure, so the shape
 * of these command lines is checkable without spending two gigabytes.
 *
 * Throws when the route the user picked is not available. That refusal is the
 * whole no-fallback rule in one line: the caller reports it and stops.
 */
export function planSetup(route: SetupRoute, tooling: EnvTooling): SetupTarget {
  if (route === 'conda') {
    if (!tooling.conda) {
      throw new Error(
        'conda was chosen, but no conda was found in that distro '
        + '(~/anaconda3, ~/miniconda3, ~/miniforge3). Install one inside WSL, or choose venv.',
      );
    }
    // `<root>/bin/conda` -> `<root>`. The env lands in that install's own envs/
    // directory, which is the one whose interpreter path we are about to write
    // into settings — derived, never assumed.
    const root = tooling.conda.replace(/\/bin\/conda$/, '');
    const envPath = `${root}/envs/${ENV_NAME}`;
    return {
      route,
      pythonPath: `${envPath}/bin/python`,
      envPath,
      createCommand: `${tooling.conda} create -n ${ENV_NAME} python=${PYTHON_VERSION} -y`,
      prepareCommand: null,
      // `--no-capture-output` so pip's progress reaches this process WHILE it
      // runs rather than in one lump at exit — the same flag, for the same
      // reason, that BookForge's vLLM serve command carries.
      installCommand: `${tooling.conda} run -n ${ENV_NAME} --no-capture-output pip install vllm`,
    };
  }

  if (!tooling.venv) {
    throw new Error(
      'venv was chosen, but that distro\'s python3 cannot import venv. '
      + 'Install the python3-venv package inside WSL, or choose conda.',
    );
  }
  const envPath = `${VENV_HOME}/${ENV_NAME}`;
  return {
    route,
    pythonPath: `${envPath}/bin/python`,
    envPath,
    createCommand: `python3 -m venv ${envPath}`,
    // A venv ships whatever pip its interpreter was built with, and an old pip
    // is the usual reason a CUDA wheel "has no matching distribution".
    prepareCommand: `${envPath}/bin/pip install --upgrade pip`,
    installCommand: `${envPath}/bin/pip install vllm`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Running it
// ─────────────────────────────────────────────────────────────────────────────

/** The one run in flight, so a second Run button press cannot start a rival. */
let active: { handle: StreamHandle | null; cancelled: boolean } | null = null;

export function setupIsRunning(): boolean {
  return active !== null;
}

/**
 * Cancel the run: the current step's wsl.exe tree goes, and the runner stops
 * before the next one.
 *
 * Safe against a half-installed env, because the next run is idempotent — a
 * `conda create` that was killed leaves either nothing or a usable env, and a
 * killed `pip install` leaves a vllm that does not import, which is exactly the
 * condition the install step already tests for.
 */
export function cancelSetup(): void {
  if (!active) return;
  active.cancelled = true;
  active.handle?.cancel();
}

/**
 * Build the environment, streaming as it goes. Never throws — a failure is a
 * `SetupResult` with `ok: false` and the reason, because every way this can go
 * wrong is a sentence the user has to read.
 */
export async function setupWslEnv(
  request: SetupRequest,
  tooling: EnvTooling,
  onEvent: (event: SetupLogEvent) => void,
): Promise<SetupResult> {
  if (active) {
    return { ok: false, pythonPath: null, detail: 'A setup run is already going.' };
  }

  const run = { handle: null as StreamHandle | null, cancelled: false };
  active = run;

  const say = (line: string): void => onEvent({ stream: 'step', line });
  const forward = (line: string, stream: 'stdout' | 'stderr'): void => onEvent({ stream, line });

  /** One step, streamed. Resolves to null on success or a sentence on failure. */
  const step = async (label: string, command: string): Promise<string | null> => {
    say(`$ ${command}`);
    const handle = streamInDistro(request.distro, command, forward);
    run.handle = handle;
    const result = await handle.done;
    run.handle = null;
    if (run.cancelled) return 'Cancelled.';
    if (result.failure) return `${label} could not be run: ${result.failure}`;
    if (result.code !== 0) return `${label} exited ${result.code}.`;
    return null;
  };

  try {
    let target: SetupTarget;
    try {
      target = planSetup(request.route, tooling);
    } catch (err) {
      const detail = (err as Error).message;
      say(detail);
      return { ok: false, pythonPath: null, detail };
    }

    say(`Building ${ENV_NAME} in ${request.distro} (${target.route}) → ${target.pythonPath}`);

    // ── Create, unless it is already there ──────────────────────────────────
    const exists = await runInDistro(request.distro, `test -x ${target.pythonPath}`, 30_000);
    if (run.cancelled) return { ok: false, pythonPath: null, detail: 'Cancelled.' };
    if (exists.code === 0) {
      say(`${target.envPath} already exists — skipping creation.`);
    } else {
      const failure = await step('Creating the environment', target.createCommand);
      if (failure) return { ok: false, pythonPath: null, detail: failure };
      if (target.prepareCommand) {
        const prepared = await step('Preparing the environment', target.prepareCommand);
        if (prepared) return { ok: false, pythonPath: null, detail: prepared };
      }
    }

    // ── Install vllm, unless it already imports ─────────────────────────────
    const already = await checkVllm(request.distro, target.pythonPath);
    if (run.cancelled) return { ok: false, pythonPath: null, detail: 'Cancelled.' };
    if (already.ok) {
      say('vllm is already installed in it — skipping the install.');
    } else {
      say('Installing vLLM. This pulls roughly 2 GB of CUDA wheels and takes a few minutes.');
      const failure = await step('Installing vllm', target.installCommand);
      if (failure) return { ok: false, pythonPath: null, detail: failure };
    }

    // ── Verify, then write it down ──────────────────────────────────────────
    const verified = await checkVllm(request.distro, target.pythonPath);
    if (run.cancelled) return { ok: false, pythonPath: null, detail: 'Cancelled.' };
    if (!verified.ok) {
      say(verified.detail);
      return {
        ok: false,
        pythonPath: null,
        detail: `The environment was built, but ${verified.detail}`,
      };
    }
    say(verified.detail);

    /*
     * WHERE THE ENVIRONMENT IS, AND THAT IT IS THE ONE TO USE.
     *
     * The first two keys let the engine find the env by name rather than by
     * guessing at candidates. THE OTHER TWO ARE THE FIX for a fresh install that
     * could not read a page: nothing in this app had ever written `backend.mode`,
     * so a machine whose vLLM had just been built successfully still had the
     * engine looking for the Apple-silicon MLX path and refusing by name. Having
     * built the server is the user's statement about which backend reads their
     * pages; making them repeat it in a drop-down is asking twice.
     *
     * `writeSettings` preserves every other key in the file.
     */
    try {
      writeSettings({
        wslDistro: request.distro,
        vllmPython: target.pythonPath,
        mode: 'endpoint',
        endpointUrl: VLLM_URL,
      });
      say(`Wrote backend.wslDistro, backend.vllmPython, backend.mode=endpoint and `
        + `backend.endpointUrl=${VLLM_URL} to the engine's settings.`);
    } catch (err) {
      const detail = `vLLM is installed, but the settings file could not be written: ${(err as Error).message}`;
      say(detail);
      return { ok: false, pythonPath: target.pythonPath, detail };
    }

    return {
      ok: true,
      pythonPath: target.pythonPath,
      detail: `${ENV_NAME} is ready in ${request.distro}: ${target.pythonPath} can import vllm.`,
    };
  } finally {
    active = null;
  }
}
