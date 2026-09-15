/**
 * THE INSTALL STORY'S MAIN-PROCESS HALF — a measured machine, the driven
 * install, and the one line a Windows box runs before either is possible.
 *
 * ── WHAT THIS IS, STATED PLAINLY ───────────────────────────────────────────
 *
 *   1. MEASURES what this app can measure on its own — the WSL2 distros,
 *      whether the guest sees an NVIDIA card, whether a `config.toml` or a
 *      pairing file is already there ({@link crucibleHostFacts}).
 *   2. COMPOSES the plan the setup page and the settings door both draw
 *      ({@link crucibleInstallPlan}): the machine, the verdict, the sequence
 *      that will run, and the commands this app cannot run for anybody.
 *   3. RUNS IT ({@link driveCrucibleInstall}) through `@crucible/bootstrap`,
 *      streaming every step, every line and every WSL state to the caller.
 *
 * ── THE SEAM IS GONE (2026-09-15) ──────────────────────────────────────────
 *
 * This file used to transcribe `@crucible/bootstrap`'s surface by hand and
 * refuse `bootstrap_not_installed` from a `DRIVEN_INSTALL_AVAILABLE = false`
 * that no machine could flip, because no Crucible release carried the package.
 * `vendor/crucible-bootstrap-0.6.0.tgz` — `npm pack` of the crucible checkout's
 * `sdk/bootstrap` at the commit the v0.6.0 release will be cut from, exactly as
 * `vendor/crucible-client-0.6.0.tgz` already is — ends that. The types below
 * are now IMPORTED, so a shape that changes in the package is a compile error
 * here rather than a transcription that drifted.
 *
 * ── WHO ACTUALLY INSTALLS, PER PLATFORM (crucible PHASE15-HOST.md §4.3) ────
 *
 * **Windows installs one way and it is not this app.** `install()` on win32 is
 * two branches and no third: no `%LOCALAPPDATA%\Crucible\host\` → refuse
 * `host_not_installed` and hand over the one `install.ps1` line, because a
 * library that downloads and elevates an installer from a background call is a
 * dialog nobody asked for; a host that IS there → `POST /install` on its
 * loopback door and relay its events. The HOST walks the WSL state table,
 * raises the UAC prompts, survives the reboot and imports the distro. BookForge
 * runs none of that and must never grow a second copy of it (PHASE14 §4a: two
 * descriptions of one install "cannot differ").
 *
 * **macOS and Linux** are the machine itself, and the package walks the step
 * list there directly — a server pack with its own interpreter, `crucible
 * init`, `crucible service install`, linger.
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

import type {
  HostEvent,
  InstallOptions,
  InstallResult,
  InstallStep,
  JobTypeRequest,
  Runner,
} from '@crucible/bootstrap';

import {
  CrucibleDiscoveryError,
  discoverCrucible,
  processDiscoveryHost,
} from './discovery';
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
  CrucibleDiscoveredFacts,
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

/** The package name, spelled once so every sentence about it agrees. */
export const BOOTSTRAP_PACKAGE = '@crucible/bootstrap';

/** Crucible's own README — the argument behind the sequence. */
export const CRUCIBLE_README = 'https://github.com/telltaleatheist/crucible';

/*
 * `CRUCIBLE_WHEEL` AND `CRUCIBLE_BOOTSTRAP_TARBALL` ARE GONE (2026-09-15).
 *
 * The wheel is not how a Crucible is installed any more and has not been since
 * PHASE14: the server arrives as an ENV PACK with its own interpreter inside
 * it (`crucible-env-server-<backend>-<version>.tar.zst`), which is what
 * `@crucible/bootstrap`'s `server-pack` step fetches and verifies. A constant
 * naming a `.whl` was a second, wrong answer to "what gets installed", and the
 * plan's `wheel` field went with it.
 *
 * The bootstrap tarball URL was the `command` of a refusal this app can no
 * longer reach: the package IS installed (`vendor/crucible-bootstrap-0.6.0.tgz`,
 * pinned in package.json). The one line a person still types is Windows's
 * `install.ps1`, and that line has exactly one owner — the package's own
 * `hostInstallCommand()`, carried on the `host_not_installed` refusal — so this
 * file does not compose a second copy of it.
 */

/**
 * WHETHER THE DRIVEN INSTALL CAN RUN ON THIS MACHINE.
 *
 * Not a build-time switch any more: `@crucible/bootstrap` is vendored, so the
 * only thing that can make the button wrong is the MACHINE. Crucible has a
 * `cuda-linux` backend, an `mlx-darwin` one and a `llama-windows` one, and a
 * platform that is none of those three has nothing to install — the package
 * refuses `unsupported_platform` and the button must not be live over it.
 *
 * One function, read by the door that refuses AND by the button that is
 * disabled, so the two can never disagree.
 */
export function drivenInstallAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

/**
 * WHY NOT, when {@link drivenInstallAvailable} says no. Never shown otherwise:
 * a reason beside a live button is a sentence that contradicts what it sits on.
 */
export function drivenInstallUnavailableWhy(platform: NodeJS.Platform = process.platform): string {
  return `Crucible has a cuda-linux backend, an mlx-darwin one and a llama-windows one, and `
    + `${platform} is none of them. There is nothing this app could install here. Connect to an `
    + 'engine on another machine instead — it is the same code path, because the client speaks '
    + 'HTTP either way.';
}

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
// The surface of `@crucible/bootstrap`, IMPORTED (2026-09-15)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * THE TRANSCRIPTION IS GONE, AND THAT IS THE POINT.
 *
 * `BootstrapJobTypeRequest`, `BootstrapInstallOptions`, `BootstrapInstallStep`
 * and `BootstrapInstallResult` were hand-copies of the package's `.d.ts`, kept
 * in step by reading. They are re-exported aliases of the real types now, so a
 * field the package adds, renames or drops is a COMPILE ERROR here instead of a
 * copy that quietly says something else. Two of them had already drifted:
 * `install()` grew `release`, `home`, `bind`, `onHostEvent` and `fetchImpl`,
 * and LOST `wheel` and `condaRoots` when PHASE14 replaced the wheel with env
 * packs — so the options this app composed would not have compiled against the
 * package it was written for.
 *
 * `MAC_CONDA_ROOTS` went with `condaRoots`. A server pack carries its own
 * interpreter (PHASE14 §2), so there is no conda to find on a Mac and no
 * ruling left owed about where Homebrew put one.
 */

/** One job type to enable. `tts` must name its narrator engine (one env each). */
export type BootstrapJobTypeRequest = JobTypeRequest;

/** `install()`'s options, in full — including the two win32-only callbacks. */
export type BootstrapInstallOptions = InstallOptions;

/** One step of the driven install, as the package reports it. */
export type BootstrapInstallStep = InstallStep;

/** What `install()` answers with. The token is NOT in it — `readLocalConfig()` is. */
export type BootstrapInstallResult = InstallResult;

/** One event off the Windows host's door, verbatim (PHASE15 §4.3). */
export type BootstrapHostEvent = HostEvent;

/**
 * The module surface this app imports. Nothing else of the package is used.
 *
 * `runner` is second and optional because that is the package's own signature,
 * and because it is the ONLY way a keeper drives the win32 branch without a
 * `%LOCALAPPDATA%\Crucible\host\` and a socket on 7101.
 */
export interface BootstrapModule {
  install(options: BootstrapInstallOptions, runner?: Runner): Promise<BootstrapInstallResult>;
}


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
// The package, loaded
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LOAD `@crucible/bootstrap`.
 *
 * THE DYNAMIC IMPORT IS DELIBERATE: the package publishes an ESM build and a
 * CJS one behind an exports map, and `await import` is the spelling that works
 * from this app's CommonJS main process either way. It is also why this is a
 * function rather than a top-level import — loading an installer at app start
 * to draw a settings row nobody opened is work for nothing.
 *
 * There is no `require.resolve` probe and no try/catch around the import. A
 * missing package is a BUILD that is wrong, not a state to report at runtime:
 * `package.json` pins `vendor/crucible-bootstrap-0.6.0.tgz` and
 * `tools/test-crucible-install-seam.js` fails the day it is not there.
 */
export async function loadBootstrap(): Promise<BootstrapModule> {
  const bootstrap = await import('@crucible/bootstrap');
  return {
    install: (options, runner) => (runner === undefined
      ? bootstrap.install(options)
      : bootstrap.install(options, runner)),
  };
}

/**
 * RUN THE SEQUENCE.
 *
 * On win32 this is the host's door and nothing else (PHASE15 §4.3): a machine
 * with no host refuses `host_not_installed` and carries the one `install.ps1`
 * line to type. On darwin and linux the package walks the step list here.
 *
 * `runner` is passed through for ONE caller — the keeper, which scripts a
 * Windows machine and a fake host door without touching either. An app never
 * passes it; the package's own `processRunner()` is the default.
 *
 * A `BootstrapStepFailed` carries `step`, `exitCode`, `tail` and `stepsDone`,
 * and {@link installRefusalOf} puts all four on the wire: partial work survives
 * a failure (crucible ARCHITECTURE.md R6), and telling somebody WHICH step did
 * not finish is the difference between resuming and starting again.
 */
export async function driveCrucibleInstall(
  options: BootstrapInstallOptions,
  runner?: Runner,
): Promise<BootstrapInstallResult> {
  const bootstrap = await loadBootstrap();
  return bootstrap.install(options, runner);
}

/**
 * ANY failure of the driven install, as the renderer's one refusal shape.
 *
 * The package's `BootstrapRefusal` already carries `{code, message, command,
 * detail}` and this app's `CrucibleHostRefusal` is the same four fields, so a
 * refusal crosses the wire VERBATIM — the code the package chose, the command
 * it handed over, its own evidence. Nothing is renamed on the way through:
 * renaming another owner's refusal is the defect this whole phase is against.
 *
 * `BootstrapStepFailed` extends `BootstrapRefusal` with `step`, `exitCode` and
 * `tail`, so it arrives here as `step_failed` with the tail as its detail —
 * which is what the package already puts there.
 *
 * Something that is NOT a refusal is not given a name it did not earn: it
 * becomes `install_failed`, whose message is the error's own, so a reader sees
 * the words the thing that broke actually said.
 */
export function installRefusalOf(err: unknown): CrucibleHostRefusal {
  if (err instanceof CrucibleInstallError) return err.toRefusal();
  const carried = err as { code?: unknown; message?: unknown; command?: unknown; detail?: unknown };
  if (typeof carried?.code === 'string' && typeof carried.message === 'string') {
    return {
      code: carried.code as CrucibleHostRefusalCode,
      message: `${carried.code}: ${carried.message}`,
      command: typeof carried.command === 'string' ? carried.command : null,
      detail: typeof carried.detail === 'string' ? carried.detail : null,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'install_failed',
    message: `install_failed: ${message}`,
    command: null,
    detail: null,
  };
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
 * THE JOB TYPES BOOKFORGE ASKS AN ENGINE FOR, from the vendored module.
 *
 * `shared/crucible/bookforge.module.json` is the one place this app states
 * what it needs (PHASE13-OPERATOR.md §5.4), so the driven install and the
 * coordination that follows it ask for exactly the same things — one file,
 * generated from the crucible manifests, read by both.
 */
export function bookforgeJobTypes(): BootstrapJobTypeRequest[] {
  return BOOKFORGE_MODULE.job_types.map((entry) =>
    (entry.type === 'tts'
      ? { type: 'tts' as const, narratorEngine: requireNarratorEngine(entry) }
      : entry.type as Exclude<BootstrapJobTypeRequest, { type: 'tts' }>));
}

/**
 * The options BookForge hands the package on THIS machine.
 *
 * SHORTER THAN IT WAS, AND EVERY FIELD THAT WENT WAS A DECISION THIS APP DOES
 * NOT OWN. `distro` went because the HOST owns the distro on Windows and
 * imports `crucible` itself; `wheel` and `condaRoots` went with the wheel, in
 * PHASE14, when the server started arriving as an env pack with its own
 * interpreter. What is left is what an app genuinely says: which job types it
 * needs, which release, and where to send the output.
 *
 * `release` is passed rather than defaulted so the install, the client pin and
 * the plan all name ONE Crucible. The package would default to its own
 * version, which is the same number today and is not the same FACT.
 */
export function bookforgeInstallOptions(
  onLine: BootstrapInstallOptions['onLine'],
  handlers: {
    onStep?: BootstrapInstallOptions['onStep'];
    onHostEvent?: BootstrapInstallOptions['onHostEvent'];
  } = {},
): BootstrapInstallOptions {
  return {
    jobTypes: bookforgeJobTypes(),
    release: CRUCIBLE_RELEASE,
    onLine,
    ...(handlers.onStep === undefined ? {} : { onStep: handlers.onStep }),
    ...(handlers.onHostEvent === undefined ? {} : { onHostEvent: handlers.onHostEvent }),
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
 * Injectable for the reason `discovery.ts`, `generation-venue.ts` and `pages.ts`
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
  /** A Crucible already on this computer, or the named reason there is none. */
  discovered(): CrucibleDiscoveredFacts;
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
    discovered: () => {
      try {
        const server = discoverCrucible(processDiscoveryHost(getWslDistro()));
        return {
          present: true,
          serverName: server.name,
          url: server.url,
          configPath: server.configPath,
          via: server.via,
        };
      } catch (err) {
        if (err instanceof CrucibleDiscoveryError) {
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
      discovered: host.discovered(),
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
        // which one, and `discovery.ts`'s rule is that there is no default here on
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
  const discovered = host.discovered();
  if (!discovered.present && discovered.code !== 'no_local_config') {
    // `no_local_config` is the ordinary state of a machine that has not
    // installed one yet and is the whole reason this screen exists. Anything
    // ELSE — an unreadable config, a missing key — is a real refusal with a fix.
    refuse(discovered.code, discovered.reason);
  }

  return {
    platform, platformName: host.platform, arch: host.arch, wsl, gpu, discovered, refusals,
  };
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
export async function crucibleInstallPlan(
  host: InstallHost = processInstallHost(),
): Promise<CrucibleInstallPlan> {
  const facts = crucibleHostFacts(host);
  const verdict = hostabilityOf(facts);
  const driven = drivenInstallAvailable(host.platform);
  return {
    platform: facts.platform,
    host: facts,
    machine: describeMachine(facts),
    hostable: verdict.hostable,
    hostableWhy: verdict.why,
    steps: await stepsFor(facts),
    elevated: await elevatedFor(facts),
    readme: CRUCIBLE_README,
    driven,
    drivenWhy: driven ? null : drivenInstallUnavailableWhy(host.platform),
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
  parts.push(facts.discovered.present
    ? `a Crucible config is already here (${facts.discovered.serverName})`
    : 'no Crucible config here yet');
  return `${parts.join(' · ')}.`;
}

/**
 * WHAT THE BUTTON WILL DO, IN ORDER — the package's own step list, rendered.
 *
 * THESE ARE NOT LINES TO TYPE ANY MORE, and that is the correction. This
 * function used to compose eleven copyable commands — `conda create`, `pip
 * install <wheel>`, `crucible init` — which was a SECOND description of an
 * install that `@crucible/bootstrap` already owns. PHASE14 §4a: two
 * descriptions of one install "cannot differ", and these two had: the wheel
 * became an env pack, and conda stopped being involved at all, and nothing
 * here noticed.
 *
 * So the sequence is read from `installSteps()` — the same data the installer
 * walks — and shown with NO commands. The one line a person still types is
 * Windows's, and it is in {@link elevatedFor}, from the package's own
 * `hostInstallCommand()`.
 */
async function stepsFor(facts: CrucibleHostFacts): Promise<CrucibleInstallStep[]> {
  if (facts.platform === 'other') {
    return [{
      title: 'There is no Crucible for this machine',
      detail:
        `Crucible has a cuda-linux backend, an mlx-darwin one and a llama-windows one, and `
        + `${facts.platformName} is none of them. Point BookForge at a Crucible on another `
        + 'machine instead — the first door above — which is the same code path: the client '
        + 'speaks HTTP either way.',
      commands: [],
      done: false,
    }];
  }

  const bootstrap = await import('@crucible/bootstrap');

  /*
   * ON WINDOWS THE SEQUENCE IS THE HOST'S, NOT THIS LIST'S (PHASE15 §4.3).
   *
   * A Windows machine gets a host, the host starts the `llama-windows` server
   * within seconds, and the WSL2 engine is then a TASK on the engine's own
   * page (§4.7) — the state table, the UAC prompts, the distro import, the
   * reboot. None of that is a step BookForge walks, so none of it is listed
   * as one. What IS listed is what the host will do once it is there.
   */
  if (facts.platform === 'win32') {
    return [
      {
        title: 'Install the Crucible host',
        detail:
          'One line in PowerShell, listed below. It downloads the host, writes a Startup item so '
          + 'the engine comes back after a reboot, and starts it. BookForge does not run it: a '
          + 'library that downloads and elevates an installer from a background call is a dialog '
          + 'nobody asked for.',
        commands: [],
        done: false,
      },
      {
        title: 'The host starts the Windows engine',
        detail:
          'Within seconds, and it opens its own console. That engine is `llama-windows` — '
          + 'llama.cpp over GGUF — and it serves the text classes and page reading on this '
          + "machine's card with no WSL at all.",
        commands: [],
        done: false,
      },
      {
        title: 'Move it to WSL2, from the engine console',
        detail:
          'What WSL2 adds is vLLM/SGLang and the five Python job types — narration, '
          + 'transcription, alignment, voice matching, noise removal. It is a task on the '
          + "console, not a step here: only the host can run wsl.exe, raise the two UAC prompts "
          + 'and survive the reboot.',
        commands: [],
        done: (facts.wsl?.distros ?? []).some((d) => d.version === 2),
      },
    ];
  }

  const plan = bootstrap.planJobTypes(bookforgeJobTypes());
  return bootstrap.installSteps({
    enableFlags: plan.enableFlags,
    installs: plan.installs,
    bind: [],
    linger: false,
  }).map((step) => ({
    title: step.name,
    detail: step.what,
    commands: [],
    /*
     * `done` IS TRUE FOR EXACTLY ONE STEP, and only where this app measured
     * it. `init` writes config.toml, and `discovery.ts` has already read
     * whether one is there. Every other step is something only the machine it
     * runs on knows the outcome of, and a checkbox that guessed would be worse
     * than no checkbox.
     */
    done: step.name === 'init' && facts.discovered.present,
  }));
}

/**
 * THE COMMANDS BOOKFORGE CANNOT RUN FOR YOU.
 *
 * Each needs a privilege this app does not have and must not ask for
 * silently. `@crucible/bootstrap` draws the same line — it refuses by name and
 * hands the command over — and this list is that refusal's `command` field, in
 * advance, taken from the package rather than spelled a second time.
 */
async function elevatedFor(facts: CrucibleHostFacts): Promise<CrucibleInstallStep[]> {
  if (facts.platform === 'win32') {
    const bootstrap = await import('@crucible/bootstrap');
    return [{
      title: 'The one line: install the Crucible host',
      detail:
        'Run this in PowerShell. Everything else on Windows happens through the host — the WSL '
        + 'state table, the UAC prompts, the distro, the reboot — because there is one install '
        + 'sequence on a machine and it is the host\'s. `wsl --install` is NOT listed here any '
        + 'more: the host raises it itself, by name, with the sentence that explains why.',
      commands: [bootstrap.hostInstallCommand(CRUCIBLE_RELEASE)],
      done: false,
    }];
  }
  if (facts.platform === 'linux') {
    return [{
      title: 'To keep the server up when you are logged out',
      detail:
        'systemd stops a user service at the end of the last session unless lingering is on. '
        + 'Without it the Crucible is up only while a shell is open — which is fine for a desktop '
        + 'and wrong for a machine other people render on.',
      commands: ['sudo loginctl enable-linger "$USER"'],
      done: false,
    }];
  }
  // macOS needs none: its service is a launchd agent, which starts at login
  // and needs no privilege to install.
  return [];
}
