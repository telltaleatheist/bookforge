/** Crucible owns installation. Windows installs its native engine first;
 * the operator may later choose the WSL upgrade through its authenticated task API. */
import { spawnSync } from 'child_process';
// `path` and the pairing reader went with the bespoke win32 sequence (PHASE19):
// the package's own install() reads the guest's config path out of its `done`
// event, and nothing here joins a Windows path any more.
import { CrucibleClient } from '@crucible/client';

import { BOOTSTRAP_VERSION, RELEASE_REPO } from '@crucible/bootstrap';
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
import { compare as compareVersions } from '../update/semver';
import { readCruciblePairingFile } from './pairing-file';
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
// WHICH Crucible gets installed: the channel, and never an older one
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The version of the `@crucible/bootstrap` LIBRARY this build carries.
 *
 * It was called `CRUCIBLE_RELEASE` and it meant "the release this app installs",
 * which is the defect crucible `docs/INSTALL-UNINSTALL.md` §6.5 is about: the
 * vendored tarball was cut at 1.0.1 and this machine's server was already 1.0.2,
 * so pressing Set up installed an OLDER Crucible over a newer one and said
 * nothing. What the vendored bytes are is one fact; which release should be
 * installed is a different fact and its owner is the release channel.
 *
 * So this number is the LIBRARY's, kept because
 * `tools/test-crucible-install-seam.js` holds the pin, the tarball on disk and
 * the version inside it to each other — a question a hand-typed literal could
 * not be asked. It is not passed to `install()` any more.
 */
export const BOOTSTRAP_LIBRARY_VERSION: string = BOOTSTRAP_VERSION;

/** The package name, spelled once so every sentence about it agrees. */
export const BOOTSTRAP_PACKAGE = '@crucible/bootstrap';

/**
 * THE RELEASE CHANNEL — GitHub's pointer at the PROMOTED release.
 *
 * crucible `docs/INSTALL-UNINSTALL.md` §6.5.1. Every Crucible is cut
 * `--prerelease --latest=false` and becomes `releases/latest` only when
 * `promote_release.py --publish` says so, after its packs and a fresh-install
 * smoke have been verified — so this URL is the one place that answers "which
 * Crucible should a machine have", and `releases?per_page=1` (the newest tag)
 * would be an unverified candidate.
 *
 * ASSEMBLED FROM THE PACKAGE'S `RELEASE_REPO` rather than typed, because the
 * repository slug already has an owner. The URL SHAPE is the one thing spelled
 * twice today: crucible's `sdk/bootstrap/src/channel.ts` owns it as
 * `LATEST_RELEASE_URL`, and this app cannot import it until a release carrying
 * that module is cut and re-vendored. When it is, this constant becomes that
 * import and this paragraph goes.
 */
export const CRUCIBLE_CHANNEL_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

/**
 * The two facts the never-older gate compares, each read from its own source.
 *
 * An interface rather than two direct calls so a keeper can put a channel at
 * 1.0.1 in front of a `/v1/info` at 1.0.2 and watch nothing spawn. That is the
 * whole of why it exists; there is no second implementation behind it.
 */
export interface CrucibleReleaseSources {
  /** What the channel calls latest. Refuses `release_channel_unreadable`. */
  latest(): Promise<string>;
  /** The version of the engine answering on THIS machine, or null when there is none. */
  running(): Promise<string | null>;
}

/**
 * The channel's latest, read with this process's own `fetch`.
 *
 * NO CACHE AND NO FALLBACK (§6.5.2). A channel that will not answer is a
 * refusal by name; installing the vendored library's version instead is exactly
 * the silent downgrade being removed.
 */
export async function crucibleChannelLatest(fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(CRUCIBLE_CHANNEL_URL, { headers: { accept: 'application/vnd.github+json' } });
  } catch (err) {
    throw new CrucibleInstallError(
      'release_channel_unreadable',
      `could not read the release channel at ${CRUCIBLE_CHANNEL_URL}: ${(err as Error).message}`,
    );
  }
  const body = await response.text();
  if (!response.ok) {
    throw new CrucibleInstallError(
      'release_channel_unreadable',
      `could not read the release channel at ${CRUCIBLE_CHANNEL_URL}: HTTP ${response.status}`,
      { detail: body.trim().slice(0, 200) },
    );
  }
  let tag: unknown;
  try {
    tag = (JSON.parse(body) as Record<string, unknown>)['tag_name'];
  } catch (err) {
    throw new CrucibleInstallError(
      'release_channel_unreadable',
      `could not read the release channel at ${CRUCIBLE_CHANNEL_URL}: it is not JSON (${(err as Error).message})`,
      { detail: body.trim().slice(0, 200) },
    );
  }
  if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+/.test(tag)) {
    throw new CrucibleInstallError(
      'release_channel_unreadable',
      `could not read the release channel at ${CRUCIBLE_CHANNEL_URL}: its tag_name is `
      + `${JSON.stringify(tag)}, which is not a Crucible version`,
    );
  }
  return tag.replace(/^v/, '');
}

/**
 * WHAT IS RUNNING ON THIS MACHINE, asked of the engine itself.
 *
 * `GET /v1/info`'s `server.version` — the call this app already made to REPORT
 * a finished install (§6.5.3 is about making the same call before one). The
 * connection comes from `discoverCrucible`, which reads the connect code
 * Crucible left here; a machine with no Crucible has no connect code, and
 * `no_local_config` is that state rather than a failure, so it answers null.
 *
 * An engine that IS configured here and will not answer is NOT null: it is the
 * error, raised. "There is no server" and "the server would not say what it is"
 * are different facts, and installing over the second one blind is the thing
 * this gate exists to stop.
 */
export async function runningCrucibleVersion(): Promise<string | null> {
  let discovered: ReturnType<typeof discoverCrucible>;
  try {
    discovered = discoverCrucible(processDiscoveryHost(getWslDistro()));
  } catch (err) {
    if (err instanceof CrucibleDiscoveryError && err.code === 'no_local_config') return null;
    throw err;
  }
  const info = await new CrucibleClient({
    url: discovered.url, token: discovered.token, clientName: 'bookforge-installer',
  }).info();
  return info.server.version;
}

/** The real pair. Injected in keepers; nothing else switches on it. */
export function processReleaseSources(): CrucibleReleaseSources {
  return { latest: () => crucibleChannelLatest(), running: () => runningCrucibleVersion() };
}

/**
 * Order two Crucible versions. Negative when `a` is older.
 *
 * `electron/update/semver.ts` already owns this arithmetic for the component
 * updater, so it is imported rather than written again — the numbers are the
 * same three numbers and a second comparator would be a second answer to
 * "which of these is newer".
 */
function olderThan(a: string, b: string): boolean {
  return compareVersions(a, b) < 0;
}

/**
 * WHICH RELEASE TO INSTALL, or the refusal that says not to.
 *
 * crucible `docs/INSTALL-UNINSTALL.md` §6.5.3, and it runs BEFORE anything is
 * spawned. Three answers and no fourth:
 *
 *   nothing running          → the channel's latest
 *   channel newer            → the channel's latest
 *   channel the same         → `crucible_already_latest`
 *   channel older            → `install_older_than_running`
 *
 * There is no `--force`. A machine whose engine is newer than the channel is a
 * machine somebody installed something onto deliberately, and the way back is
 * the bootstrapper's own exact-version rollback, never a button in an app.
 */
export async function releaseToInstall(
  sources: CrucibleReleaseSources = processReleaseSources(),
): Promise<string> {
  const latest = await sources.latest();
  const running = await sources.running();
  if (running === null) return latest;
  if (olderThan(latest, running)) {
    throw new CrucibleInstallError(
      'install_older_than_running',
      `the release channel's latest is ${latest} and crucible ${running} is running on this computer; `
      + 'refusing to install an older engine over it. There is one Crucible per machine, and nothing '
      + 'here is allowed to take another app\'s engine backwards.',
    );
  }
  if (!olderThan(running, latest)) {
    throw new CrucibleInstallError(
      'crucible_already_latest',
      `crucible ${running} is running on this computer and the release channel's latest is ${latest} — `
      + 'there is nothing to install.',
    );
  }
  return latest;
}

/** Crucible's own README — the argument behind the sequence. */
export const CRUCIBLE_README = 'https://github.com/telltaleatheist/crucible';

// Runtime packs and installer command spelling belong to @crucible/bootstrap.

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
 * `package.json` pins the versioned bootstrap tarball and
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

/** Run Crucible's own installer, then verify the local engine. WSL upgrades are separate. */
export async function driveCrucibleInstall(
  options: BootstrapInstallOptions,
  runner?: Runner,
  sources: CrucibleReleaseSources = processReleaseSources(),
): Promise<BootstrapInstallResult> {
  /*
   * THE GATE IS THE FIRST THING, AND THAT IS THE POINT (§6.5.3).
   *
   * Before the package is even imported: the channel says which release, the
   * engine on this machine says which release it already is, and a channel
   * older than the engine refuses by name. Every process this function would
   * otherwise start is downstream of this line, so a refused install is one
   * where nothing was spawned rather than one that is unwound.
   *
   * `options.release` is OVERWRITTEN rather than respected. The options this app
   * composes no longer name a release (`bookforgeInstallOptions`), and a caller
   * that put one there would be a second answer to a question the channel owns.
   */
  const release = await releaseToInstall(sources);
  const bootstrap = await import('@crucible/bootstrap');
  const host = runner ?? bootstrap.processRunner();
  if (host.platform !== 'win32') {
    const installed = await bootstrap.install({ ...options, release }, host);
    // Service registration can return before launchd/systemd has a healthy
    // engine. Let its owner wait for authenticated readiness before adoption.
    const step: InstallStep = { name: 'local-readiness', argv: [], status: 'running', detail: 'Waiting for Crucible to start' };
    options.onStep?.(step);
    const status = await bootstrap.startLocal(options.home === undefined ? {} : { home: options.home }, host);
    if (status.state !== 'running') throw new CrucibleInstallError('install_failed', status.detail);
    if (status.name !== installed.server.name || status.url !== installed.server.url) {
      throw new CrucibleInstallError('install_failed', 'The running engine differs from the installed configuration.');
    }
    const done: InstallStep = { ...step, status: 'ok', detail: 'Crucible is running' };
    options.onStep?.(done);
    return { ...installed, steps: [...installed.steps, done] };
  }

  /*
   * ── WINDOWS IS THE PACKAGE'S OWN SEQUENCE NOW (PHASE19 §2.3, §2.6) ────────
   *
   * This used to be twenty lines of its own: spawn `install.ps1` through
   * PowerShell, `startLocal`, `readLocalInstallation`, read the pairing file,
   * `GET /v1/info`, compare three identities. Every one of those was about the
   * NATIVE Windows engine, because that was the whole of what a Windows
   * install produced.
   *
   * It is not any more. `install()` on win32 runs `install.ps1` when the host
   * pack is absent and then `watchInstall()`s the move the TRAY has already
   * started — it never posts one (§2.3: the tray is the process that is there
   * at login and the only one that can resume across the reboot
   * `wsl --install` demands) — and it follows that move until the outcome is
   * terminal. So the sequence this app would otherwise write is the sequence
   * the package now performs, and a second copy of it here would be two owners
   * of an install.
   *
   * WHAT THE FOUR NON-`done` ENDINGS DO. The package raises the OUTCOME's own
   * code and sentence as a refusal — `virtualization_disabled`,
   * `reboot-pending`, `declined`, a task failure code — which is exactly what
   * `installRefusalOf` carries verbatim to the screen, and what the progress
   * list then draws beside **Restart now** or **Try again**. Nothing is
   * renamed and nothing is flattened into "the install failed".
   *
   * WHAT IS LOST, AND WHERE IT WENT. The identity check against `/v1/info` is
   * not gone: `autoConnectLocal` makes the same one, on the engine that is
   * actually left standing, and refuses when the name it answers with is not
   * the one in its pairing file. Making it here as well would be this app
   * asking a machine mid-handover which engine it is.
   */
  const installed = await bootstrap.install({ ...options, release }, host);
  const backend = installed.backend;
  if (backend !== 'llama-windows' && backend !== 'cuda-linux' && backend !== 'mlx-darwin') {
    throw new CrucibleInstallError('install_failed', `The installed engine reported an unsupported backend: ${backend}`);
  }
  return installed;
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
 * what it needs. These requirements are prepared by module coordination after
 * the first-run AI choices; the service installer itself remains lightweight.
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
 * `release` IS NOT HERE ANY MORE, and its absence is the fix (crucible
 * `docs/INSTALL-UNINSTALL.md` §6.5). It used to be `CRUCIBLE_RELEASE`, which is
 * the version of the VENDORED LIBRARY — 1.0.1 against a machine already running
 * 1.0.2 — so composing it here made this build's tarball the answer to "which
 * Crucible should this computer have". That question has one owner and it is
 * the release channel, read at install time by `driveCrucibleInstall`, which
 * fills the field from `releaseToInstall()` after the never-older gate has
 * passed. An options object that named one would be a second answer.
 */
export function bookforgeInstallOptions(
  onLine: BootstrapInstallOptions['onLine'],
  handlers: {
    onStep?: BootstrapInstallOptions['onStep'];
    onHostEvent?: BootstrapInstallOptions['onHostEvent'];
  } = {},
): BootstrapInstallOptions {
  return {
    // A bare service first; app modules prepare runtimes/models after AI choices.
    jobTypes: ['echo'],
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

/** Machine reads are injectable; Windows setup never needs a WSL or GPU probe. */
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
        if (process.platform === 'win32') {
          const paired = readCruciblePairingFile();
          if (paired === null) return { present: false, code: 'no_local_config', reason: 'No local Crucible connection has been published. Install Crucible to create one.' };
          return { present: true, serverName: paired.pairing.name, url: paired.pairing.url, configPath: paired.file, via: 'pairing' };
        }
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

/** Native Windows installation is available independently of WSL and NVIDIA. */
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
      `there is no Crucible backend for ${host.platform}: cuda-linux, mlx-darwin and llama-windows are supported.`,
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

  const wsl: CrucibleWslFacts | null = null;
  if (platform === 'win32') {
    const discovered = host.discovered();
    if (!discovered.present && discovered.code !== 'no_local_config') refuse(discovered.code, discovered.reason);
    return { platform, platformName: host.platform, arch: host.arch, wsl, gpu: null, discovered, refusals };
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
  } else {
    const queried = host.queryGpu(undefined);
    if (queried.error !== undefined) {
      refuse(
        'no_nvidia_driver',
        `the NVIDIA probe could not be run: `
        + `${queried.error.message}`,
        { detail: queried.error.message },
      );
    } else if (queried.status === 3) {
      refuse(
        'no_nvidia_driver',
        'no nvidia-smi on this machine'
        + ', on PATH or at /usr/lib/wsl/lib. A cuda-linux Crucible needs the driver to see the card.',
        {
          command: 'Install the NVIDIA driver for this machine',
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
    readme: CRUCIBLE_README,
    driven,
    drivenWhy: driven ? null : drivenInstallUnavailableWhy(host.platform),
  };
}

/** Windows native setup is independent of an optional WSL/GPU probe. */
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

  if (facts.platform === 'win32') {
    /*
     * THE VERDICT SENTENCE, REWRITTEN FOR PHASE19 (§3.1, §4).
     *
     * It used to end *"BookForge can add optional WSL acceleration after
     * installation"*, which described a BUTTON that no longer exists and a
     * choice nobody is asked to make. On every Windows machine that can host
     * WSL2 the Linux engine now arrives by itself, as the last part of the
     * same install (§0), and a machine that cannot says so in one sentence
     * from the state table when it gets there. So this says what WILL happen,
     * not what could be opted into.
     */
    return {
      hostable: 'yes',
      why: 'Windows: the engine starts here within seconds, and the faster Linux engine is set up '
        + 'straight afterwards on its own. Windows may ask for permission, and once for a restart.',
    };
  }
  if (facts.gpu !== null) {
    return { hostable: 'yes', why: `${facts.gpu.name}, ${(facts.gpu.vramBytes / 1024 ** 3).toFixed(1)} GB, visible to this machine.` };
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

/** Show the native Windows installer or the SDK's platform step list. */
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

  if (facts.platform === 'win32') {
    /*
     * THE WINDOWS STEPS ARE §3.1's LIST, IN ITS ORDER.
     *
     * They used to be two rows ending *"Optional WSL acceleration is available
     * afterward in BookForge Settings"*, which was true of a build where WSL
     * was a button. PHASE19 makes the Linux engine part of the same install on
     * any machine that can host it, so the sequence a person is promised is
     * the sequence the progress list then shows them happening — one owner for
     * "what does this do", read by the list and by this plan.
     */
    return [
      { title: 'Installing Crucible',
        detail: 'The engine, its desktop controls and its login startup. Windows raises its own '
          + 'permission prompt; nothing here asks for one on your behalf.',
        commands: [], done: false },
      { title: 'Starting the Windows engine',
        detail: 'It answers within seconds, and BookForge connects to it. Everything below happens '
          + 'behind it.',
        commands: [], done: false },
      { title: 'Setting up the Linux engine',
        detail: 'The faster engine, set up automatically. Windows may ask once for a restart; '
          + 'a computer that cannot run it says so in one sentence and stays on the Windows engine.',
        commands: [], done: false },
      { title: 'Installing what BookForge needs',
        detail: 'Narration, transcription, alignment and text — one environment each, on whichever '
          + 'engine is left standing.',
        commands: [], done: false },
      { title: 'Downloading models',
        detail: 'Several gigabytes on a first setup. It keeps going while you work.',
        commands: [], done: false },
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

/*
 * ── `elevatedFor` IS DELETED (PHASE19 §3, §4, 2026-09-19) ───────────────────
 *
 * It returned one row on Linux — "To keep the server up when you are logged
 * out", with `sudo loginctl enable-linger "$USER"` under it — which the doors
 * component drew under the heading "Commands BookForge cannot run for you".
 * Owen, 2026-09-18: *"we should assume the user doesn't know how to do it and
 * it should do it automatically."* **Nobody is ever shown a command.** A
 * command a person could run is a step the app should be running, and linger
 * is one the installer takes itself (memory `wsl-distro-idles-out-kills-
 * crucible`: `loginctl enable-linger` as root, landed in Crucible 2026-09-14).
 *
 * The plan's `elevated` field went with it rather than being left as an
 * always-empty array: a field nothing writes and nothing draws is a place for
 * a future list to reappear without anybody deciding to add one.
 */
