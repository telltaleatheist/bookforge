/**
 * THE INSTALL STORY'S MAIN-PROCESS HALF — a document, a measured machine, and
 * one function that will one day run the sequence.
 *
 * ── WHAT THIS IS TODAY, STATED PLAINLY ─────────────────────────────────────
 *
 * Nothing in this file installs anything. It does three things:
 *
 *   1. MEASURES what this app can measure without the package — the WSL2
 *      distros, whether the guest sees an NVIDIA card, whether a `config.toml`
 *      is already there ({@link crucibleHostFacts}).
 *   2. COMPOSES the exact sequence a person runs by hand, every command
 *      complete and copyable, with the ones that need elevation listed apart
 *      because BookForge cannot obtain elevation on anybody's behalf
 *      ({@link crucibleInstallPlan}).
 *   3. EXPOSES {@link driveCrucibleInstall}, the driven install, which refuses
 *      by name.
 *
 * ── WHY IT IS NOT WIRED, AND WHAT WIRING IT COSTS ──────────────────────────
 *
 * `@crucible/bootstrap` 0.5.0 is written (crucible `sdk/bootstrap`, docs/
 * PHASE12-BOOTSTRAP.md) and is released as the FOURTH ASSET of every Crucible
 * release, beside the client tarball this app already pins. **No release
 * carries it.** Crucible's tags stop at `v0.4.0` while its `pyproject.toml`
 * says `0.5.0`, so neither `crucible-bootstrap-0.5.0.tgz` nor the wheel below
 * exists to install. A dependency on a tarball that does not exist is a build
 * that does not run, so it is deliberately NOT in `package.json`.
 *
 * The seam is therefore typed against the package's REAL surface, transcribed
 * below from `sdk/bootstrap/dist/esm/*.d.ts` rather than invented, and turning
 * it on is four steps and no redesign:
 *
 *   1. `npm i @crucible/bootstrap@<release tarball URL>` beside the client (its
 *      peer dependency is `@crucible/client` 0.5.0 EXACTLY);
 *   2. replace this file's local `Bootstrap*` types with
 *      `import type { … } from '@crucible/bootstrap'` — the names and the
 *      shapes are already right;
 *   3. replace {@link loadBootstrap}'s one `throw` with the `await import`
 *      written directly underneath it, in a comment, in full;
 *   4. flip {@link DRIVEN_INSTALL_AVAILABLE} — which is what the disabled
 *      button and the refusing door BOTH read, so neither can be forgotten.
 *
 * Nothing above `loadBootstrap` changes, and no caller changes. That is what
 * makes it a seam rather than a placeholder.
 *
 * ── THE DIVISION OF LABOUR, WHICH IS THE PACKAGE'S OWN RULE ────────────────
 *
 * From its README: *"A missing prerequisite is a named refusal carrying the
 * exact command the host must run. Elevation, a reboot, a sudo password — those
 * are the app's to obtain. This package never attempts them, never falls back
 * past them, and never guesses a value it could not read."*
 *
 * So there are exactly two commands BookForge owns on Windows and one on Linux,
 * and they are listed apart from the sequence rather than buried in it:
 * `wsl --install -d Ubuntu` (elevated PowerShell, then a reboot) and
 * `sudo loginctl enable-linger "$USER"` (so the server survives logout and
 * comes up at boot — PHASE12 §6 ruling 4 leaves *when* an app shows that to the
 * app; this one shows it once, in the plan, beside the step that creates the
 * service).
 *
 * ── WHAT THIS FILE NO LONGER SAYS, AND WHO SAYS IT NOW ─────────────────────
 *
 * It used to end with three steps and eleven copyable commands: install the
 * five job environments, measure the card, pull six named weights. All of that
 * is DELETED (2026-09-14, PHASE13-OPERATOR.md §0 and §5.4). It was a second
 * copy of two things that already have owners — `shared/crucible/
 * bookforge.module.json`, generated in the crucible repo from its manifests,
 * for WHAT this app needs; and Crucible's own operator page, for the doing of
 * it. Two copies of one fact kept in step by hand is R1's shape, in the one
 * file whose job is to be correct about ids.
 *
 * So the sequence here is exactly the PRE-SERVER MINUTE, the chicken-and-egg a
 * page cannot do for itself: a guest, a Python, the wheel, `crucible init`, the
 * service. Its last step is "Open Crucible", and everything after that happens
 * there or through the **Set up for BookForge** button beside the server's row
 * (`electron/crucible/module-setup.ts`).
 */

import { spawnSync } from 'child_process';

import {
  CrucibleLocalError,
  processHost as processLocalHost,
  readLocalServer,
} from './local';
import { getWslDistro } from '../tool-paths';
import { BOOKFORGE_MODULE } from './module-setup';
import type {
  CrucibleGpuFacts,
  CrucibleHostability,
  CrucibleHostFacts,
  CrucibleHostRefusal,
  CrucibleHostRefusalCode,
  CrucibleInstallPlan,
  CrucibleInstallStep,
  CrucibleLocalConfigFacts,
  CrucibleWslDistro,
  CrucibleWslFacts,
  InstallPlatform,
} from '../../shared/crucible/install-wire';

// ─────────────────────────────────────────────────────────────────────────────
// The release this build's sequence installs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Crucible version this app's client pin and this plan both name.
 *
 * `0.6.0` since 2026-09-14: the operator door (PHASE13-OPERATOR.md §3.6) landed
 * in that version's SDK and this app is built against it. The pin itself is a
 * LABELLED STOPGAP — a tarball in `vendor/`, packed from the same commit the
 * release will be cut from — see `package.json`'s `//crucible-client` key.
 */
export const CRUCIBLE_RELEASE = '0.6.0';

/**
 * THE RELEASE WHEEL. It does not exist yet — see the header — and that is not a
 * reason to print a different version: the sequence installs the Crucible this
 * app was built against, and a plan naming `v0.4.0` would stand somebody up a
 * server whose wire this build does not speak.
 */
export const CRUCIBLE_WHEEL =
  `https://github.com/telltaleatheist/crucible/releases/download/v${CRUCIBLE_RELEASE}`
  + `/crucible-${CRUCIBLE_RELEASE}-py3-none-any.whl`;

/** The bootstrapper tarball, the fourth asset of the same release. */
export const CRUCIBLE_BOOTSTRAP_TARBALL =
  `https://github.com/telltaleatheist/crucible/releases/download/v${CRUCIBLE_RELEASE}`
  + `/crucible-bootstrap-${CRUCIBLE_RELEASE}.tgz`;

/** The package name, spelled once so the refusal and the install line agree. */
export const BOOTSTRAP_PACKAGE = '@crucible/bootstrap';

/** Crucible's own README — the argument behind the sequence. */
export const CRUCIBLE_README = 'https://github.com/telltaleatheist/crucible';

/**
 * WHETHER THE DRIVEN INSTALL CAN RUN. One boolean, read by the door that
 * refuses AND by the button that is disabled, so the two can never disagree.
 *
 * Flipping this without doing steps 1-3 of the header would make the button
 * live over a loader that still throws — which is why `loadBootstrap` reads it
 * too and says so.
 */
export const DRIVEN_INSTALL_AVAILABLE = false;

/**
 * THE ONE SENTENCE the disabled button wears and the door refuses with. Spelled
 * once: a button saying "not yet" over a door that threw something else would
 * be a bug report about a different app.
 */
export const DRIVEN_INSTALL_UNAVAILABLE =
  `The guided install ships as an asset of Crucible v${CRUCIBLE_RELEASE}, which is written and `
  + `not yet published — ${BOOTSTRAP_PACKAGE} ${CRUCIBLE_RELEASE} exists in the crucible tree `
  + '(sdk/bootstrap) and there is no release to install it from. Until then the steps below are '
  + 'run by hand: they are the same steps, in the same order, and this app will read the server '
  + 'back out of its own config.toml when you are done. Everything after that — the job '
  + 'environments and the weights — is one press of "Set up for BookForge" beside its row.';

/*
 * `BOOKFORGE_JOB_TYPES` AND `BOOKFORGE_NARRATOR_ENGINE` ARE GONE (2026-09-14).
 *
 * PHASE13-OPERATOR.md §5.4, in as many words: the vendored
 * `shared/crucible/bookforge.module.json` "is the ONLY place BookForge says
 * what it needs from a server, replacing `BOOKFORGE_JOB_TYPES` and the pull
 * list in `electron/crucible/install.ts`, which are deleted."
 *
 * They were a hand-kept restatement of ids the crucible manifests own, with
 * nothing comparing them — the day a manifest is renamed, the generator is
 * re-run and this constant is not. The narrator engine went with them for the
 * same reason: `higgs-v3` is spelled in the module file, generated from the
 * voice manifests, and the RULING that used to be recorded here ("does a
 * machine that still renders Orpheus books need both envs?") was answered by
 * Owen on 2026-09-14 — Orpheus is DEPRECATED, Higgs is the one narration
 * engine, and Orpheus lives only on the legacy local path until that layer is
 * deleted after the in-app pass.
 *
 * What reads the module is `electron/crucible/module-setup.ts`, and
 * `tools/test-crucible-module-file.js` is what keeps the copy honest.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The surface of `@crucible/bootstrap`, transcribed — see the header, step 2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One job type to enable, as the package types it.
 *
 * NOT a plain string union: `tts` must say which narrator engine, because
 * cuda-linux has one env per engine and a bare `'tts'` is refused by name
 * (`planJobTypes`). Transcribed rather than narrowed, because BookForge DOES
 * meet that arm.
 */
export type BootstrapJobTypeRequest =
  | 'echo' | 'llm' | 'asr' | 'align' | 'rvc' | 'denoise'
  | { type: 'tts'; narratorEngine: string };

/** `install()`'s options. Only the fields BookForge passes are named. */
export interface BootstrapInstallOptions {
  /** Required on win32, and there is no default distro — see `local.ts`. */
  distro?: string;
  jobTypes: readonly BootstrapJobTypeRequest[];
  /** An absolute path on this machine, or an `http(s)://` URL to the release wheel. */
  wheel: string;
  /** Every line every step prints, as it prints it. REQUIRED by the package. */
  onLine: (line: string, stream: 'stdout' | 'stderr', step: string) => void;
  /** Optional: a step beginning, finishing, or being skipped. */
  onStep?: (step: BootstrapInstallStep) => void;
  /** Where conda is looked for, in order. See {@link MAC_CONDA_ROOTS}. */
  condaRoots?: readonly string[];
}

/** One step of the driven install, as the package reports it. */
export interface BootstrapInstallStep {
  name: string;
  /** What ran, with the token spelled `<redacted>`. Empty for a skipped step. */
  argv: readonly string[];
  status: 'running' | 'ok' | 'skipped';
  detail: string;
}

/** What `install()` answers with. The token is NOT in it — `readLocalConfig()` is. */
export interface BootstrapInstallResult {
  steps: BootstrapInstallStep[];
  server: { name: string; url: string; configPath: string };
}

/** The module surface this app would import. Nothing else of the package is used. */
export interface BootstrapModule {
  install(options: BootstrapInstallOptions): Promise<BootstrapInstallResult>;
}

/**
 * WHERE CONDA LIVES ON A MAC THAT INSTALLED IT THROUGH HOMEBREW.
 *
 * The package's `DEFAULT_CONDA_ROOTS` is `~/anaconda3`, `~/miniconda3`,
 * `~/miniforge3` — the three the official installers produce. Owen's Mac Studio
 * has it from the Homebrew cask, which is none of those three, and PHASE12 §4
 * measured exactly that: `detectHost()` there would answer `no_python` and hand
 * over a `conda create` line that built a SECOND server interpreter beside the
 * one the launchd agent already runs.
 *
 * RULING OWED (PHASE12 §6 ruling 1): either the cask root joins the darwin
 * defaults, or that env moves. Until then an app on that Mac passes this, which
 * is a fact about how the machine was set up rather than about conda.
 */
export const MAC_CONDA_ROOTS: readonly string[] = ['/opt/homebrew/Caskroom/miniconda/base'];

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A refusal from this half of the install story.
 *
 * Shaped on the package's `BootstrapRefusal` — `{code, message, command,
 * detail}` — so that the day the import lands, the UI that already renders
 * these renders those. The code is PREFIXED onto the message for the reason
 * every other Crucible door in this app prefixes it: a CLI and a settings row
 * show `err.message` and nothing else, so "refused by name" is only true where
 * the name is in the sentence.
 */
export class CrucibleInstallError extends Error {
  readonly code: CrucibleHostRefusalCode;
  readonly command: string | null;
  readonly detail: string | null;

  constructor(
    code: CrucibleHostRefusalCode,
    message: string,
    options: { command?: string; detail?: string } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleInstallError';
    this.code = code;
    this.command = options.command ?? null;
    this.detail = options.detail ?? null;
  }

  /** The wire shape the renderer draws. Identical to `CrucibleHostRefusal`. */
  toRefusal(): CrucibleHostRefusal {
    return { code: this.code, message: this.message, command: this.command, detail: this.detail };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LOAD `@crucible/bootstrap`, or refuse by name.
 *
 * The body that replaces the throw is written out here rather than described,
 * because a seam whose replacement has to be reinvented is a seam that gets
 * reinvented differently:
 *
 * ```ts
 * // THE DYNAMIC IMPORT IS DELIBERATE: the package is ESM-only with a CJS build
 * // beside it, and `await import` is the spelling that works from this app's
 * // CommonJS main process either way.
 * const bootstrap = await import('@crucible/bootstrap');
 * return { install: (options) => bootstrap.install(options, bootstrap.processRunner()) };
 * ```
 *
 * It refuses rather than probing `require.resolve` on purpose. A resolve that
 * happened to succeed — a stray copy hoisted in by something else, a version
 * that is not 0.5.0 — would turn a disabled button into a live one against a
 * package nobody chose, and the peer pin (`@crucible/client` 0.5.0 EXACTLY) is
 * not something a resolve can check. {@link DRIVEN_INSTALL_AVAILABLE} is the
 * one switch, and it is a build-time fact by design.
 */
export async function loadBootstrap(): Promise<BootstrapModule> {
  if (!DRIVEN_INSTALL_AVAILABLE) {
    throw new CrucibleInstallError('bootstrap_not_installed', DRIVEN_INSTALL_UNAVAILABLE, {
      command: `npm i ${BOOTSTRAP_PACKAGE}@${CRUCIBLE_BOOTSTRAP_TARBALL}`,
      detail:
        `${BOOTSTRAP_PACKAGE} ${CRUCIBLE_RELEASE} is written (crucible sdk/bootstrap, `
        + 'docs/PHASE12-BOOTSTRAP.md) and is published as the fourth asset of a Crucible release. '
        + `The newest tag is v0.4.0 and the tree says ${CRUCIBLE_RELEASE}, so the asset does not `
        + 'exist and this app pins no dependency on it.',
    });
  }
  // Unreachable until step 3 of the module header. Kept as a throw rather than
  // a cast: a seam that silently answered `undefined` would be worse than one
  // that says the switch was flipped without the import being written.
  throw new CrucibleInstallError(
    'bootstrap_not_installed',
    `DRIVEN_INSTALL_AVAILABLE is true and the ${BOOTSTRAP_PACKAGE} import in loadBootstrap() has `
    + 'not been written. See the four steps in electron/crucible/install.ts\'s header.',
  );
}

/**
 * RUN THE SEQUENCE. Refuses today, through {@link loadBootstrap}.
 *
 * A `BootstrapStepFailed` — once this is live — carries `step`, `exitCode`,
 * `tail` and `stepsDone`, and the renderer should print all four: partial work
 * survives a failure (ARCHITECTURE.md R6), and telling somebody which of seven
 * steps did not finish is the difference between resuming and starting again.
 */
export async function driveCrucibleInstall(
  options: BootstrapInstallOptions,
): Promise<BootstrapInstallResult> {
  const bootstrap = await loadBootstrap();
  return bootstrap.install(options);
}

/**
 * A `tts` entry's narrator engine, or a refusal naming the file.
 *
 * `crucible install tts` refuses without one (`narrator_engine_required`):
 * cuda-linux has one venv per narrator engine. The generator cannot emit a
 * `tts` entry without it, so this can only fire on a module file somebody
 * edited by hand — which is exactly the thing that must not pass silently.
 */
function requireNarratorEngine(entry: { type: string; narrator_engine?: string }): string {
  if (entry.narrator_engine === undefined || entry.narrator_engine.trim() === '') {
    throw new Error(
      'shared/crucible/bookforge.module.json has a `tts` job type with no `narrator_engine`. '
      + 'cuda-linux builds one venv per narrator engine and the server refuses a bare `tts` by '
      + 'name. That file is GENERATED in the crucible repo (scripts/gen-modules.py) and vendored '
      + 'byte for byte — re-copy it rather than editing it.',
    );
  }
  return entry.narrator_engine;
}

/**
 * The options BookForge would hand the package on THIS machine.
 *
 * Composed here, beside the hand sequence, so the two say the same thing: the
 * same job types, the same narrator engine, the same wheel. The day the driven
 * install turns on, a person who read the plan and a person who pressed the
 * button get the same server.
 */
export function bookforgeInstallOptions(
  onLine: BootstrapInstallOptions['onLine'],
  platform: NodeJS.Platform = process.platform,
  distro: string | undefined = getWslDistro(),
): BootstrapInstallOptions {
  /*
   * THE JOB TYPES COME FROM THE VENDORED MODULE, which is the one place this
   * app states what it needs. The driven install and the **Set up for
   * BookForge** button therefore ask for exactly the same things: one file,
   * generated from the manifests, read by both.
   */
  const jobTypes: BootstrapJobTypeRequest[] = BOOKFORGE_MODULE.job_types.map((entry) =>
    (entry.type === 'tts'
      ? { type: 'tts' as const, narratorEngine: requireNarratorEngine(entry) }
      : entry.type as Exclude<BootstrapJobTypeRequest, { type: 'tts' }>));
  return {
    ...(platform === 'win32' && distro !== undefined ? { distro } : {}),
    jobTypes,
    wheel: CRUCIBLE_WHEEL,
    onLine,
    ...(platform === 'darwin' ? { condaRoots: MAC_CONDA_ROOTS } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The world this reads, named so a keeper can drive every branch
// ─────────────────────────────────────────────────────────────────────────────

/** One spawn's answer, in the shape `spawnSync` gives it. */
export interface HostRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Everything {@link crucibleHostFacts} reads from the world.
 *
 * Injectable for the reason `local.ts`, `generation-venue.ts` and `pages.ts`
 * all are: a keeper must be able to drive "no WSL", "WSL1 only", "no card",
 * "config already there" without a guest, a driver or a disk.
 */
export interface InstallHost {
  platform: NodeJS.Platform;
  arch: string;
  /** The app's OWN WSL distro setting. Never wsl.exe's default — see the wire. */
  wslDistro: string | undefined;
  /** `wsl.exe -l -v`. */
  listWsl(): HostRunResult;
  /** `nvidia-smi --query-gpu=name,memory.total`, inside `distro` when one is named. */
  queryGpu(distro: string | undefined): HostRunResult;
  /** The local server, or the named reason there is none. */
  localConfig(): CrucibleLocalConfigFacts;
}

/**
 * The real machine.
 *
 * `wsl.exe -l -v` prints UTF-16LE: `spawnSync` with `encoding: 'utf-8'` would
 * hand back a string with a NUL between every character and the parse would
 * find nothing at all — which is a listing that "succeeds" and reports no
 * distros, the exact silent-failure shape the package's `decodeWslBytes` exists
 * for. So the buffer is read raw and decoded by what is in it.
 *
 * Always `--exec` for the guest probe: `wsl.exe`'s implicit shell pre-expands
 * `$var` on the WINDOWS side (memory `wsl-exe-implicit-shell-trap`), so
 * `$(...)` and `$PATH` in a guest script are read by the wrong shell.
 */
export function processInstallHost(): InstallHost {
  return {
    platform: process.platform,
    arch: process.arch,
    wslDistro: getWslDistro(),
    listWsl: () => runDecoded('wsl.exe', ['-l', '-v']),
    queryGpu: (distro) => {
      if (distro !== undefined && distro.trim() !== '') {
        return runDecoded('wsl.exe', ['-d', distro, '--exec', 'bash', '-c', NVIDIA_SMI_SCRIPT]);
      }
      return runDecoded('bash', ['-c', NVIDIA_SMI_SCRIPT]);
    },
    localConfig: () => {
      try {
        const server = readLocalServer(processLocalHost(getWslDistro()));
        return {
          present: true,
          serverName: server.name,
          url: server.url,
          configPath: server.configPath,
          via: server.via,
        };
      } catch (err) {
        if (err instanceof CrucibleLocalError) {
          return { present: false, code: err.code, reason: err.message };
        }
        throw err;
      }
    },
  };
}

/**
 * WHERE WSL2 PUTS THE DRIVER'S nvidia-smi, after PATH.
 *
 * `/usr/lib/wsl/lib/nvidia-smi` — the package's `WSL_NVIDIA_SMI`, and
 * `crucible/backend.py`'s own location. PATH first because a guest that has it
 * on PATH has it properly; the WSL path second because a bare `conda activate`
 * shell often does not. Exit 3 means "no nvidia-smi anywhere it was looked
 * for", told apart from nvidia-smi's own non-zero exits, which is the package's
 * `NVIDIA_SMI_SCRIPT` convention kept verbatim.
 */
const NVIDIA_SMI_SCRIPT =
  'if command -v nvidia-smi >/dev/null 2>&1; then '
  + 'exec nvidia-smi --query-gpu=name,memory.total --format=csv,noheader; fi; '
  + 'if [ -x /usr/lib/wsl/lib/nvidia-smi ]; then '
  + 'exec /usr/lib/wsl/lib/nvidia-smi --query-gpu=name,memory.total --format=csv,noheader; fi; '
  + 'exit 3';

function runDecoded(command: string, args: string[]): HostRunResult {
  const result = spawnSync(command, args, { windowsHide: true, timeout: 30_000 });
  return {
    status: result.status,
    stdout: decodeWslBytes(result.stdout),
    stderr: decodeWslBytes(result.stderr),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Bytes from a wsl.exe handle → text, whichever of the two encodings it is.
 *
 * The package's own `decodeWslBytes`, transcribed with its reasoning: wsl.exe's
 * OWN output is UTF-16LE with a BOM and the GUEST's is UTF-8, on the same
 * handles, so the test has to be structural rather than per-command. UTF-16LE
 * ASCII has a NUL after every character; UTF-8 text never contains a NUL at
 * all. The BOM is stripped either way, because `wsl -l -v`'s first line would
 * otherwise begin with one and never match.
 */
export function decodeWslBytes(buffer: Buffer | null | undefined): string {
  if (buffer === null || buffer === undefined || buffer.length === 0) return '';
  const looksUtf16 = buffer.length >= 2 && buffer.includes(0);
  const text = looksUtf16 ? buffer.toString('utf16le') : buffer.toString('utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// `detectHost()`-shaped facts, measured without the package
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse `wsl.exe -l -v`'s table. A row is `[*] NAME  STATE  VERSION`.
 *
 * The header row is skipped BY CONTENT — its third column is not a number —
 * rather than by position, because some builds print a blank line first and
 * because the column titles are LOCALISED: matching them would break on a
 * German Windows. The package's `parseWslList` does the same and for the same
 * reason.
 */
export function parseWslList(text: string): { distros: CrucibleWslDistro[]; default: string | null } {
  const distros: CrucibleWslDistro[] = [];
  let fallback: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const starred = line.startsWith('*');
    const columns = (starred ? line.slice(1) : line).trim().split(/\s{2,}|\t+/);
    const name = (columns[0] ?? '').trim();
    const state = (columns[1] ?? '').trim();
    const version = Number.parseInt((columns[2] ?? '').trim(), 10);
    if (name.length === 0 || !Number.isFinite(version)) continue;
    distros.push({ name, version, default: starred, state });
    if (starred) fallback = name;
  }
  return { distros, default: fallback };
}

/** `name, 24576 MiB` — the first GPU, exactly as `crucible/backend.py` reads it. */
export function parseNvidiaSmi(stdout: string): CrucibleGpuFacts | null {
  const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return null;
  const comma = first.lastIndexOf(',');
  if (comma < 0) return null;
  const name = first.slice(0, comma).trim();
  const mib = Number.parseInt(first.slice(comma + 1).replace(/MiB/i, '').trim(), 10);
  if (name.length === 0 || !Number.isFinite(mib)) return null;
  return { vendor: 'nvidia', name, vramBytes: mib * 1024 * 1024 };
}

/** `process.platform`, narrowed to the three the sequence differs by. */
export function installPlatformOf(platform: NodeJS.Platform): InstallPlatform {
  switch (platform) {
    case 'win32': return 'win32';
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    default: return 'other';
  }
}

/**
 * WHAT THIS MACHINE CAN RUN A CRUCIBLE WITH, as far as this app can measure it.
 *
 * `detectHost()`'s shape and `detectHost()`'s discipline: **every null carries a
 * named refusal beside it, with the command that clears it.** Nothing is
 * inferred from a null, and a probe that could not RUN is never reported as an
 * answer about the thing probed — "wsl.exe could not be spawned" is
 * `wsl_read_failed`, not "there are no distros".
 *
 * What it does NOT answer is conda and the server interpreter. Those are
 * `probeInterpreter`'s one guest-side script, and a second copy of it here
 * would be exactly the duplication the seam exists to avoid — so they are STEPS
 * of the plan instead, which is what a person runs to make them go away.
 */
export function crucibleHostFacts(host: InstallHost = processInstallHost()): CrucibleHostFacts {
  const platform = installPlatformOf(host.platform);
  const refusals: CrucibleHostRefusal[] = [];
  const refuse = (
    code: CrucibleHostRefusalCode,
    message: string,
    options: { command?: string; detail?: string } = {},
  ): void => {
    refusals.push({
      code,
      message,
      command: options.command ?? null,
      detail: options.detail ?? null,
    });
  };

  if (platform === 'other') {
    refuse(
      'unsupported_platform',
      `there is no Crucible backend for ${host.platform}: cuda-linux (Linux, or WSL2 on Windows) `
      + 'and mlx-darwin are the two.',
    );
    return {
      platform,
      platformName: host.platform,
      arch: host.arch,
      wsl: null,
      gpu: null,
      local: host.localConfig(),
      refusals,
    };
  }

  // ── WSL, on Windows only ───────────────────────────────────────────────────
  let wsl: CrucibleWslFacts | null = null;
  let probed: string | null = null;
  if (platform === 'win32') {
    const listed = host.listWsl();
    if (listed.error !== undefined) {
      wsl = {
        distros: [],
        default: null,
        probed: null,
        detail: `wsl.exe could not be run: ${listed.error.message}`,
      };
      refuse(
        'wsl_missing',
        'wsl.exe could not be run on this machine, so there is no guest to install a Crucible '
        + 'into. Crucible\'s backend is Linux — Windows is never one.',
        { command: 'wsl --install -d Ubuntu', detail: listed.error.message },
      );
    } else if (listed.status !== 0) {
      wsl = {
        distros: [],
        default: null,
        probed: null,
        detail: `wsl.exe -l -v exited ${listed.status ?? 'without a code'}`,
      };
      refuse(
        'wsl_read_failed',
        `wsl.exe answered but could not list distributions (exit ${listed.status ?? 'none'}). `
        + 'That is a fact about the listing, not about whether a distro is there.',
        { detail: (listed.stderr || listed.stdout).trim() },
      );
    } else {
      const parsed = parseWslList(listed.stdout);
      const two = parsed.distros.filter((d) => d.version === 2);
      probed = host.wslDistro !== undefined && host.wslDistro.trim() !== '' ? host.wslDistro : null;
      wsl = {
        distros: parsed.distros,
        default: parsed.default,
        probed,
        detail: parsed.distros.length === 0
          ? 'wsl.exe answered, and no WSL distribution is installed.'
          : `${two.length} WSL2 ${two.length === 1 ? 'distribution' : 'distributions'}`
            + `${two.length === parsed.distros.length ? '' : ` of ${parsed.distros.length} listed`}.`,
      };
      if (two.length === 0) {
        refuse(
          'wsl_missing',
          parsed.distros.length === 0
            ? 'there is no WSL distribution on this machine. Crucible\'s backend is Linux — Windows '
              + 'is never one — so this comes first, and it needs elevation and a reboot.'
            : 'every WSL distribution here is version 1, and only WSL2 has the GPU passthrough a '
              + 'Crucible needs.',
          { command: 'wsl --install -d Ubuntu' },
        );
      } else if (probed === null) {
        // NOT the same refusal as "no distro". There is a guest; nobody has said
        // which one, and `local.ts`'s rule is that there is no default here on
        // purpose — a server read from the wrong guest is a wrong server.
        refuse(
          'no_wsl_distro',
          'this machine has WSL2 but BookForge has not been told which distro the Crucible lives '
          + `in (${two.map((d) => d.name).join(', ')}). Settings → Add-ons → WSL distro. There is `
          + 'no default here on purpose: a server read from the wrong guest is a wrong server.',
        );
      }
    }
  }

  // ── The card ───────────────────────────────────────────────────────────────
  let gpu: CrucibleGpuFacts | null = null;
  if (platform === 'darwin') {
    if (host.arch !== 'arm64') {
      refuse(
        'not_apple_silicon',
        `mlx-darwin is Apple Silicon only and this Mac is ${host.arch}. There is no Crucible `
        + 'backend for an Intel Mac.',
      );
    } else {
      /*
       * NOT MEASURED, AND SAID SO. The card's name and the machine's unified
       * memory are readable here (`system_profiler`), and a number this app
       * printed would be a SECOND owner of a fact `detectHost()` already owns —
       * it reads the same thing through its own probe. On Apple silicon the
       * accelerator is never absent, so there is nothing to refuse about; the
       * plan simply does not claim a size it did not measure.
       */
      gpu = null;
    }
  } else if (platform === 'win32' && (wsl === null || wsl.probed === null)) {
    // No guest named: the card question cannot be asked, and MUST NOT be
    // answered from the Windows-side nvidia-smi. What matters is whether the
    // GUEST sees a card, and a Windows driver that answers says nothing about
    // whether the passthrough works.
    gpu = null;
  } else {
    const queried = host.queryGpu(platform === 'win32' ? (wsl?.probed ?? undefined) : undefined);
    if (queried.error !== undefined) {
      refuse(
        'no_nvidia_driver',
        `the NVIDIA probe could not be run${platform === 'win32' ? ` inside "${wsl?.probed}"` : ''}: `
        + `${queried.error.message}`,
        { detail: queried.error.message },
      );
    } else if (queried.status === 3) {
      refuse(
        'no_nvidia_driver',
        `no nvidia-smi${platform === 'win32' ? ` inside WSL distro "${wsl?.probed}"` : ' on this machine'}`
        + ', on PATH or at /usr/lib/wsl/lib. A cuda-linux Crucible needs the driver to see the card.',
        {
          command: platform === 'win32'
            ? 'Install the NVIDIA Windows driver with WSL support, then: wsl --shutdown'
            : 'Install the NVIDIA driver for this machine',
        },
      );
    } else if (queried.status !== 0) {
      refuse(
        'no_nvidia_driver',
        `nvidia-smi exited ${queried.status ?? 'without a code'}, so this machine's card could not `
        + 'be read. That is the driver answering, not a missing card.',
        { detail: (queried.stderr || queried.stdout).trim() },
      );
    } else {
      gpu = parseNvidiaSmi(queried.stdout);
      if (gpu === null) {
        refuse(
          'no_nvidia_driver',
          'nvidia-smi answered and printed nothing this build could read as a card.',
          { detail: queried.stdout.trim() },
        );
      }
    }
  }

  // ── Is one already here? A STATE, not a fault ──────────────────────────────
  const local = host.localConfig();
  if (!local.present && local.code !== 'no_local_config') {
    // `no_local_config` is the ordinary state of a machine that has not
    // installed one yet and is the whole reason this screen exists. Anything
    // ELSE — an unreadable config, a missing key — is a real refusal with a fix.
    refuse(local.code, local.reason);
  }

  return { platform, platformName: host.platform, arch: host.arch, wsl, gpu, local, refusals };
}

// ─────────────────────────────────────────────────────────────────────────────
// The sequence, as a person runs it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE STEPS, AND THE MACHINE THEY WERE COMPOSED FOR.
 *
 * NOTHING HERE CHANGES THE MACHINE. Every command in the returned plan is a
 * string for a person to read and run; the only processes this spawns are the
 * two probes above, which list and query.
 */
export function crucibleInstallPlan(host: InstallHost = processInstallHost()): CrucibleInstallPlan {
  const facts = crucibleHostFacts(host);
  const verdict = hostabilityOf(facts);
  return {
    platform: facts.platform,
    host: facts,
    machine: describeMachine(facts),
    hostable: verdict.hostable,
    hostableWhy: verdict.why,
    steps: stepsFor(facts),
    elevated: elevatedFor(facts),
    readme: CRUCIBLE_README,
    wheel: CRUCIBLE_WHEEL,
    driven: DRIVEN_INSTALL_AVAILABLE,
    drivenWhy: DRIVEN_INSTALL_UNAVAILABLE,
  };
}

/**
 * COULD A CRUCIBLE LIVE HERE — yes, no, or a question that cannot be asked yet.
 *
 * Composed in MAIN so the wizard's three-faced step (PHASE13-OPERATOR.md §5.5)
 * reads a decision instead of making a second one out of the same nulls. Every
 * branch answers from something measured; none of them infers from a null.
 *
 * THE THIRD VALUE IS THE HONEST ONE ON WINDOWS. What decides hostability there
 * is whether the GUEST sees a card, and `crucibleHostFacts` refuses to answer
 * that from the Windows-side `nvidia-smi` — a Windows driver that answers says
 * nothing about whether the passthrough works. So a machine with no WSL2, or
 * one where nobody has named the distro, is `unknown` rather than `no`: the
 * install door is the document whose first step is the thing that would settle
 * it, and telling somebody with a 4090 "this machine cannot host one" because
 * they have not installed Ubuntu yet would be a wrong answer stated
 * confidently.
 */
export function hostabilityOf(
  facts: CrucibleHostFacts,
): { hostable: CrucibleHostability; why: string } {
  if (facts.platform === 'other') {
    return {
      hostable: 'no',
      why: `Crucible has a cuda-linux backend and an mlx-darwin one, and ${facts.platformName} is `
        + 'neither. Point BookForge at a Crucible on another machine — it is the same code path, '
        + 'because the client speaks HTTP either way.',
    };
  }

  if (facts.platform === 'darwin') {
    if (facts.arch !== 'arm64') {
      return {
        hostable: 'no',
        why: `mlx-darwin is Apple Silicon only and this Mac is ${facts.arch}. There is no Crucible `
          + 'backend for an Intel Mac, so this one connects to a server rather than holding one.',
      };
    }
    return {
      hostable: 'yes',
      why: 'Apple Silicon: the mlx-darwin backend runs on this machine\'s own unified memory, and '
        + 'there is no card to be absent.',
    };
  }

  // Linux and Windows both end at cuda-linux, and both are decided by whether
  // the thing that would run the server can see an NVIDIA card.
  if (facts.gpu !== null) {
    return {
      hostable: 'yes',
      why: `${facts.gpu.name}, ${(facts.gpu.vramBytes / 1024 ** 3).toFixed(1)} GB, visible to the `
        + `${facts.platform === 'win32' ? `WSL2 guest "${facts.wsl?.probed}"` : 'machine'} that `
        + 'would run the server.',
    };
  }

  if (facts.platform === 'win32') {
    const two = facts.wsl?.distros.filter((d) => d.version === 2) ?? [];
    if (two.length === 0) {
      return {
        hostable: 'unknown',
        why: 'there is no WSL2 guest here yet, so nobody can ask whether the card is visible to '
          + 'one — and BookForge will not answer that from the Windows-side nvidia-smi, because a '
          + 'Windows driver that answers says nothing about whether the passthrough works. The '
          + 'first step below is what settles it.',
      };
    }
    if ((facts.wsl?.probed ?? null) === null) {
      return {
        hostable: 'unknown',
        why: `this machine has WSL2 (${two.map((d) => d.name).join(', ')}) but BookForge has not `
          + 'been told which guest the Crucible lives in, so the card question was not asked. '
          + 'There is no default here on purpose: a server read from the wrong guest is a wrong '
          + 'server.',
      };
    }
    return {
      hostable: 'no',
      why: `the WSL2 guest "${facts.wsl?.probed}" does not see an NVIDIA card, and a cuda-linux `
        + 'Crucible needs one. The refusals above name what would change that.',
    };
  }

  return {
    hostable: 'no',
    why: 'no NVIDIA card was readable on this machine, and cuda-linux is the only backend for it. '
      + 'The refusals above name what would change that.',
  };
}

/** One sentence about this machine, from what was measured and nothing else. */
export function describeMachine(facts: CrucibleHostFacts): string {
  const parts: string[] = [`${facts.platformName}/${facts.arch}`];
  if (facts.wsl !== null) parts.push(facts.wsl.detail);
  if (facts.gpu !== null) {
    parts.push(`${facts.gpu.name}, ${(facts.gpu.vramBytes / 1024 ** 3).toFixed(1)} GB`);
  } else if (facts.platform === 'darwin' && facts.arch === 'arm64') {
    parts.push('Apple silicon — the MLX backend runs on the machine\'s own unified memory');
  } else {
    parts.push('no card measured');
  }
  parts.push(facts.local.present
    ? `a Crucible config is already here (${facts.local.serverName})`
    : 'no Crucible config here yet');
  return `${parts.join(' · ')}.`;
}

/**
 * The numbered sequence. Windows runs it inside the guest; macOS and Linux in a
 * terminal on the machine itself.
 *
 * EVERY COMMAND IS COMPLETE AND COPYABLE. A step reading "install the wheel"
 * would send somebody to a README to find the line; the line is here, and the
 * README link is there for the argument behind it.
 *
 * The conda-run prefix is how each line is made runnable from a shell that has
 * not activated anything — `conda run -n crucible <cmd>` — which is the form
 * that works whether or not the person's shell was initialised for conda. The
 * package does it differently and deliberately so: it runs the console script
 * BESIDE the interpreter it found (`consoleScriptBeside`), which needs no conda
 * on PATH at all. Two spellings of one sequence, each right for its caller.
 */
function stepsFor(facts: CrucibleHostFacts): CrucibleInstallStep[] {
  const guest = facts.platform === 'win32';
  const distro = facts.wsl?.probed ?? facts.wsl?.distros.find((d) => d.version === 2)?.name ?? null;
  const prefix = guest
    ? `wsl.exe -d ${distro ?? '<distro>'} --exec bash -lc `
    : '';
  const line = (command: string): string => (guest ? `${prefix}${JSON.stringify(command)}` : command);
  const run = (command: string): string => line(`conda run -n crucible ${command}`);
  const steps: CrucibleInstallStep[] = [];

  if (facts.platform === 'other') {
    return [{
      title: 'There is no Crucible for this machine',
      detail:
        `Crucible has a cuda-linux backend and an mlx-darwin one, and ${facts.platformName} is `
        + 'neither. Point BookForge at a Crucible on another machine instead — the first door '
        + 'above — which is the same code path: the client speaks HTTP either way.',
      commands: [],
      done: false,
    }];
  }

  if (guest) {
    const two = facts.wsl?.distros.filter((d) => d.version === 2) ?? [];
    steps.push({
      title: 'A WSL2 distribution',
      /*
       * ANSWERED, NOT ASKED. This is the one step of the sequence this app can
       * check for itself, and checking it is most of what makes the list worth
       * reading on Windows: somebody who already has Ubuntu should be told so
       * rather than sent to an elevated PowerShell for nothing.
       */
      detail: two.length === 0
        ? 'There is no WSL2 distribution on this machine. Crucible\'s backend is Linux — Windows '
          + 'is never one — so this comes first, and it needs elevation and a reboot (below).'
        : `Present: ${two.map((d) => d.name).join(', ')}`
          + `${distro === null ? '. Set which one in Settings → Add-ons → WSL distro' : ''}. `
          + 'Everything below runs inside it.',
      commands: [],
      done: two.length > 0,
    });
  }

  steps.push(
    {
      title: 'A Python 3.11 environment called "crucible"',
      detail:
        'Crucible\'s server runs on 3.11 exactly, and its installer FINDS that interpreter rather '
        + 'than making one — `<conda root>/envs/crucible/bin/python`. Miniforge is the smallest way '
        + 'to get a conda that does not disturb a system Python.',
      commands: [line('conda create -n crucible python=3.11 -y')],
      done: false,
    },
    {
      title: 'The Crucible wheel',
      detail: 'From the GitHub release, into that environment. Nothing is built from source.',
      commands: [run(`pip install ${CRUCIBLE_WHEEL}`)],
      done: false,
    },
    {
      title: 'Initialise it',
      detail:
        'Writes ~/.crucible/config.toml with permissions 0600 and mints the bearer token. '
        + 'BookForge never copies that token: it reads the file every time, so a later '
        + '`crucible init --force` is fixed by doing nothing at all. NO `--enable-*` flags: '
        + '`crucible install <type>` merges each one in and reloads the registry, so the job '
        + 'types are turned on by "Set up for BookForge" rather than guessed at here.',
      commands: [run('crucible init')],
      done: facts.local.present,
    },
    {
      title: 'Install the service',
      detail: facts.platform === 'darwin'
        ? 'A launchd agent, so the server is up when you log in. A local Crucible is a SERVICE and '
          + 'no app owns it — it must not die because somebody closed a window while a 19 GB model '
          + 'was resident.'
        : 'A systemd user unit, so the server is up when you log in. A local Crucible is a SERVICE '
          + 'and no app owns it. See the linger command below if you want it up at boot as well.',
      commands: [run('crucible service install')],
      done: false,
    },
    /*
     * THE LAST STEP IS A BUTTON, AND THE THREE STEPS THAT USED TO BE HERE ARE
     * GONE (2026-09-14, PHASE13-OPERATOR.md §0 and §5.2).
     *
     * "Install the job environments", "Measure the card" and "Pull the weights"
     * were eleven copyable commands naming six weights and five envs — a second
     * copy of what `shared/crucible/bookforge.module.json` states and what
     * Crucible's own page installs with a button and a progress bar. Two copies
     * of one fact, kept in step by hand, which is exactly R1's shape. They are
     * replaced by the one door that does all of it: the page, and the **Set up
     * for BookForge** button beside the server's row.
     *
     * What is left above is genuinely the PRE-SERVER MINUTE — the
     * chicken-and-egg a page cannot do for itself, because until `crucible
     * init` has run there is no page.
     */
    {
      title: 'Open Crucible',
      detail:
        'Come back here: once that config.toml exists, BookForge reads the server out of it — '
        + 'name, address and token — and this door becomes one button. Everything else about a '
        + 'server happens on the server\'s OWN page: install a job type, pull weights, watch the '
        + 'progress, read the token. "Set up for BookForge" beside its row posts this app\'s '
        + 'module and does the whole stocking in one task.',
      commands: [],
      done: false,
    },
  );
  return steps;
}

/**
 * The commands BOOKFORGE CANNOT RUN FOR YOU, listed apart from the sequence.
 *
 * Each needs a privilege this app does not have and must not ask for silently.
 * `@crucible/bootstrap` draws the same line — it refuses by name and hands the
 * command over — and this list is that refusal's `command` field, in advance.
 */
function elevatedFor(facts: CrucibleHostFacts): CrucibleInstallStep[] {
  if (facts.platform === 'win32') {
    const two = facts.wsl?.distros.filter((d) => d.version === 2) ?? [];
    return [{
      title: 'If there is no WSL2 distribution yet',
      detail:
        'Run this in an ELEVATED PowerShell, then reboot Windows. The first launch of the distro '
        + 'asks you to choose a username and password.',
      commands: ['wsl --install -d Ubuntu'],
      done: two.length > 0,
    }, {
      title: 'To keep the server up when you are logged out',
      detail:
        'systemd stops a user service at the end of the last session unless lingering is on. '
        + 'Without it the Crucible is up only while a shell is open — which is fine for a desktop '
        + 'and wrong for a machine other people render on. Run it INSIDE the distro.',
      commands: ['sudo loginctl enable-linger "$USER"'],
      done: false,
    }];
  }
  if (facts.platform === 'linux') {
    return [{
      title: 'To keep the server up when you are logged out',
      detail:
        'systemd stops a user service at the end of the last session unless lingering is on.',
      commands: ['sudo loginctl enable-linger "$USER"'],
      done: false,
    }];
  }
  // macOS needs neither: its service is a launchd agent, which starts at login
  // and needs no privilege to install.
  return [];
}
