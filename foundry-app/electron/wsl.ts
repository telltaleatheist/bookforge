/**
 * wsl — what this Windows machine's WSL can actually do, measured.
 *
 * Everything above this file (the setup runner, the server manager, the
 * settings screen) asks questions in these terms: which distros exist, what
 * environment tooling lives inside one, whether an interpreter in there can
 * import vllm. Nothing above it spawns `wsl.exe` itself, so there is one place
 * that knows the two things that make WSL awkward to drive from Node:
 *
 *   1. **wsl.exe speaks UTF-16LE.** `wsl -l -q` and every error message wsl.exe
 *      writes ITSELF are UTF-16 with a BOM; a naive `chunk.toString()` yields
 *      `U\0b\0u\0n\0t\0u\0` and a distro list of one unusable name. Output that
 *      came from INSIDE the distro (a bash pipeline's stdout) is plain UTF-8.
 *      Both arrive on the same handles, so the decode is decided per chunk by
 *      looking for the interleaved NULs rather than by which call it was.
 *
 *   2. **A `wsl.exe` that never returns is normal.** A distro that is still
 *      booting, or a `bash -lc` whose profile blocks on something, will sit
 *      there. Every one-shot call here carries its own timeout and reports the
 *      timeout as a failure rather than hanging the main process.
 *
 * Argument arrays, never shell strings, and `windowsHide` on every spawn — the
 * same rule engine.ts states: a path with a space interpolated into a command
 * line becomes a different program.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

/** The conda installs we look for, in the order the engine's own probe uses. */
const CONDA_ROOTS = ['~/anaconda3', '~/miniconda3', '~/miniforge3'] as const;

/** One python -c line: exit 0 if the module resolves, 3 if not. No heavy import. */
function findSpecProgram(module: string): string {
  return `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('${module}') else 3)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bytes from a wsl.exe handle -> text, whichever of the two encodings it is.
 *
 * The test is structural, not a guess about the caller: UTF-16LE ASCII has a
 * NUL after every character, and UTF-8 text never contains a NUL at all. A BOM
 * is stripped either way, because `wsl -l -q`'s first line would otherwise be
 * `<BOM>Ubuntu` and never match a distro name the user typed.
 */
export function decodeWslBytes(buffer: Buffer): string {
  const probe = buffer.subarray(0, Math.min(buffer.length, 256));
  const utf16 = probe.includes(0);
  return buffer.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Running things
// ─────────────────────────────────────────────────────────────────────────────

export interface WslRun {
  /** Null when the process never started or was killed by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when there is no exit code to report — a spawn error, or the timeout. */
  failure?: string;
}

/** One wsl.exe call, collected. Never throws; a failure is a field. */
export function runWsl(args: string[], timeoutMs: number): Promise<WslRun> {
  return new Promise<WslRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('wsl.exe', args, { windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', failure: (err as Error).message });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (result: WslRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({
        code: null,
        stdout: decodeWslBytes(Buffer.concat(out)),
        stderr: decodeWslBytes(Buffer.concat(err)),
        failure: `wsl.exe did not answer within ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) => finish({ code: null, stdout: '', stderr: '', failure: e.message }));
    child.on('close', (code) => finish({
      code,
      stdout: decodeWslBytes(Buffer.concat(out)),
      stderr: decodeWslBytes(Buffer.concat(err)),
    }));
  });
}

/** `wsl.exe -d <distro> -e bash -lc '<command>'`, as an argument array. */
export function bashArgs(distro: string, command: string): string[] {
  return ['-d', distro, '-e', 'bash', '-lc', command];
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths and quoting, across the boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Windows path as the distro sees it: `C:\a\b` -> `/mnt/c/a/b`.
 *
 * Done here rather than by shelling out to `wslpath`, for two reasons. It is one
 * substitution and the rule has not changed since WSL1; and `wslpath` would have
 * to be run INSIDE a distro, which means the answer would depend on that
 * distro's `automount.root` — a setting that, when it is not `/mnt`, breaks the
 * hardcoded `/mnt/c` in every other guide too. A UNC path (`\\server\share`) has
 * no such mapping at all and is refused rather than mangled into something that
 * would silently resolve to nothing.
 *
 * That refusal is not the whole guard, and reading it as one is the mistake this
 * note exists to prevent: a MAPPED drive is a network path wearing a letter, and
 * `Z:\x` passes every test here on its way to a `/mnt/z` that does not exist.
 * Only the filesystem can tell the two apart — `networkPathBehind` below — and
 * this function stays pure rather than asking it.
 *
 * Pure, so the conversion is checkable without a distro.
 */
export function toWslPath(windowsPath: string): string {
  const normalised = windowsPath.replace(/\\/g, '/');
  if (normalised.startsWith('//')) {
    throw new Error(
      `${windowsPath} is a network path, which has no /mnt mapping inside WSL. `
      + 'Use a location on a local drive.',
    );
  }
  const drive = /^([A-Za-z]):\//.exec(normalised);
  if (!drive || !drive[1]) {
    throw new Error(`${windowsPath} is not an absolute Windows path, so it has no WSL spelling.`);
  }
  return `/mnt/${drive[1].toLowerCase()}${normalised.slice(2)}`;
}

/**
 * The UNC path a Windows path really lives on, or null if it is on a local disk.
 *
 * WSL2 auto-mounts FIXED drives only. A drive letter mapped to a share — `Z:`
 * for `\\TITAN\iO` — gets no mount at all, so a guest handed `/mnt/z/…` is sent
 * somewhere that cannot exist while the file sits there perfectly readable on
 * the host. Nothing about the spelling distinguishes it from `C:`, which is why
 * `toWslPath`'s string rules cannot catch it, and why this asks the OS instead:
 * `realpath.native` answers `\\TITAN\iO` for the mapped drive and `C:\` for the
 * real one.
 *
 * A path that cannot be resolved answers null — "I could not tell" must not read
 * as "it is a network drive" and refuse an install over a missing directory.
 * Not pure, unlike the rest of this section: call it once, before the work.
 */
export function networkPathBehind(windowsPath: string): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(windowsPath);
  } catch {
    return null;
  }
  return resolved.replace(/\\/g, '/').startsWith('//') ? resolved : null;
}

/**
 * One argument, safe inside the `bash -lc` string.
 *
 * Single quotes, with the only character they cannot contain spliced back in the
 * standard way (`'\''`). Everything that crosses into a distro goes through
 * here: a destination under `/mnt/c/Users/Some One/…` is the ordinary case, and
 * an unquoted space there is two arguments and a tar that writes half its
 * contents somewhere unexpected.
 *
 * WHAT THIS GUARDS AND WHAT IT CANNOT (measured on the other side of the
 * vendoring, bookforge-sync seq 111, 2026-08-19): this function guards
 * WORD-SPLITTING in the guest bash. It cannot guard the TRANSPORT --
 * wsl.exe applies exactly ONE pass of backslash-halving to its argv
 * before any bash exists, deterministic and quote-blind, so a UNC
 * device string loses a backslash from each pair however it is quoted.
 * Every current caller crosses forward-slash guest paths (toWslPath
 * output), which is why this is a latent rule and not a live bug -- but
 * a future caller sending anything with backslashes must DOUBLE them
 * before argv, or send the command on stdin (bash -s), which the pass
 * does not touch. A quoting function that claimed to make the crossing
 * safe would be the false-safety-comment shape; this one names its
 * boundary instead.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A single command inside a distro, collected. */
export function runInDistro(distro: string, command: string, timeoutMs: number): Promise<WslRun> {
  return runWsl(bashArgs(distro, command), timeoutMs);
}

export interface StreamHandle {
  /** Resolves when the child exits, however it exits. Never rejects. */
  done: Promise<{ code: number | null; failure?: string }>;
  /** Take the whole tree down — the wsl.exe process and what it started. */
  cancel(): void;
}

/**
 * A long command inside a distro, LINE BY LINE as it runs.
 *
 * This is what makes a `pip install vllm` bearable: it is ~2 GB of CUDA wheels
 * and several minutes, and a spinner that says nothing for five minutes is
 * indistinguishable from a hang. Both handles are forwarded because pip writes
 * its progress to stdout and its warnings to stderr, and the user needs both.
 *
 * Line-buffered for the same reason engine.ts is: a callback fired on half a
 * line paints half a percentage into the log pane.
 */
export function streamInDistro(
  distro: string,
  command: string,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
): StreamHandle {
  let child: ChildProcess | null = null;
  let cancelled = false;

  const done = new Promise<{ code: number | null; failure?: string }>((resolve) => {
    try {
      child = spawn('wsl.exe', bashArgs(distro, command), { windowsHide: true });
    } catch (err) {
      resolve({ code: null, failure: (err as Error).message });
      return;
    }

    const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    const feed = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      // pip repaints its progress bar with \r and no newline; splitting on both
      // turns that into successive lines rather than one line that never ends.
      pending[stream] += decodeWslBytes(chunk);
      const lines = pending[stream].split(/\r?\n|\r/);
      pending[stream] = lines.pop() ?? '';
      for (const line of lines) if (line.trim().length > 0) onLine(line, stream);
    };
    child.stdout?.on('data', feed('stdout'));
    child.stderr?.on('data', feed('stderr'));

    child.on('error', (err) => resolve({ code: null, failure: err.message }));
    child.on('close', (code) => {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (pending[stream].trim().length > 0) onLine(pending[stream], stream);
      }
      resolve(cancelled ? { code: null, failure: 'cancelled' } : { code });
    });
  });

  return {
    done,
    cancel(): void {
      cancelled = true;
      killTree(child);
    },
  };
}

/**
 * Kill a wsl.exe and everything under it on the Windows side.
 *
 * `child.kill()` reaches wsl.exe alone and leaves the guest-side process it is
 * relaying for; taskkill's tree flag is the only thing on Windows that gets the
 * rest. Used for the SETUP runner and for timed-out probes — never as the first
 * move against a running vLLM, which holds the CUDA device and is stopped from
 * inside the distro instead (see vllm-server.ts).
 */
export function killTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      return;
    } catch {
      // fall through to the signal
    }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// The facts
// ─────────────────────────────────────────────────────────────────────────────

export interface WslFacts {
  /** True only when wsl.exe ran AND named at least one distro. */
  available: boolean;
  distros: string[];
  /** Why not, when `available` is false. Kept verbatim — it names the fix. */
  reason: string | null;
}

/**
 * The distros wsl.exe lists, or why it could not be asked.
 *
 * An empty list counts as unavailable: WSL being installed with nothing in it
 * is, for our purposes, the same as WSL not being there — there is no distro to
 * build an environment in. The reason is kept rather than flattened to a
 * boolean, because "wsl.exe is not on PATH" and "WSL is installed but empty"
 * have completely different fixes and the settings screen prints the sentence.
 */
export async function listDistros(): Promise<WslFacts> {
  if (process.platform !== 'win32') {
    return { available: false, distros: [], reason: `WSL is a Windows feature; this machine is ${process.platform}.` };
  }
  const run = await runWsl(['-l', '-q'], 15_000);
  if (run.failure) {
    return { available: false, distros: [], reason: `wsl.exe could not be run: ${run.failure}` };
  }
  if (run.code !== 0) {
    const said = run.stderr.trim() || run.stdout.trim();
    return {
      available: false,
      distros: [],
      reason: said || `wsl.exe -l -q exited ${run.code}.`,
    };
  }
  const distros = run.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (distros.length === 0) {
    return { available: false, distros: [], reason: 'wsl.exe runs but lists no installed distributions.' };
  }
  return { available: true, distros, reason: null };
}

export interface EnvTooling {
  /** Path to a conda binary inside the distro, tilde-form, or null. */
  conda: string | null;
  /** True when `python3 -m venv` is actually importable in there. */
  venv: boolean;
  /** Sentence for the screen, naming what was found and what was not. */
  detail: string;
}

/**
 * What a distro can build an environment WITH.
 *
 * Conda first and in a fixed order, then venv, because that is the order the
 * routes are offered in — but BOTH are reported whatever is found. The caller
 * picks the route; this file does not choose one, and nothing here falls back
 * from a conda the user asked for to a venv they did not.
 *
 * Existence is `test -x`, not `which`: a conda on PATH is whichever conda that
 * distro's login shell decided on, and the path we hand to `conda create` has
 * to be the same one whose `envs/` directory the interpreter will land in.
 */
export async function detectEnvTooling(distro: string): Promise<EnvTooling> {
  let conda: string | null = null;
  for (const root of CONDA_ROOTS) {
    const path = `${root}/bin/conda`;
    const probe = await runInDistro(distro, `test -x ${path}`, 20_000);
    if (probe.code === 0) { conda = path; break; }
  }

  const venvProbe = await runInDistro(distro, 'python3 -c "import venv"', 20_000);
  const venv = venvProbe.code === 0;

  const found: string[] = [];
  if (conda) found.push(`conda at ${conda}`);
  if (venv) found.push('python3 -m venv');
  const detail = found.length > 0
    ? `${distro}: ${found.join(', ')}.`
    : `${distro}: no conda under ${CONDA_ROOTS.join(', ')} and python3 cannot import venv. `
      + 'Install one of them inside the distro first.';

  return { conda, venv, detail };
}

export interface VllmCheck {
  ok: boolean;
  detail: string;
}

/**
 * Can this interpreter import vllm?
 *
 * `find_spec` rather than `import vllm`: the real import pulls torch and CUDA
 * and takes tens of seconds, and the question is whether the package is
 * installed, not whether the GPU is happy today.
 */
export async function checkVllm(distro: string, python: string): Promise<VllmCheck> {
  const probe = await runInDistro(
    distro,
    `${python} -c "${findSpecProgram('vllm')}"`,
    60_000,
  );
  if (probe.code === 0) return { ok: true, detail: `${python} can import vllm.` };
  if (probe.code === 3) return { ok: false, detail: `${python} exists but vllm is not installed in it.` };
  const said = probe.failure ?? probe.stderr.trim() ?? '';
  return {
    ok: false,
    detail: said
      ? `${python} could not be asked about vllm: ${said}`
      : `${python} could not be asked about vllm (exit ${probe.code}).`,
  };
}
