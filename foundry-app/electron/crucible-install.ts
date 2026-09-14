/**
 * crucible-install — "Install Crucible here": the sequence, spelled out, and the
 * one function that will one day run it.
 *
 * ── WHAT THIS IS TODAY, STATED PLAINLY ──────────────────────────────────────
 *
 * A DOCUMENT AND A DISABLED BUTTON. Nothing in this file installs anything. It
 * composes the exact sequence a person runs by hand — every command, in order,
 * with the two that need elevation separated out because Foundry cannot obtain
 * elevation on their behalf — and it exposes `driveCrucibleInstall`, which
 * refuses by name. That is the whole of it, and the reason is not caution: the
 * thing that would do the work does not exist on this machine yet.
 *
 * ── WHY IT IS NOT WIRED, AND WHAT WIRING IT COSTS ───────────────────────────
 *
 * `@crucible/bootstrap` 0.5.0 is written (crucible, `sdk/bootstrap`) and is
 * released beside `@crucible/client`, which this app already pins by tarball
 * URL. It is not installable until Owen cuts the next Crucible release, so it is
 * deliberately NOT in `app/package.json` — a dependency on a tarball that does
 * not exist is a build that does not run.
 *
 * The seam is therefore typed against the package's real surface, transcribed
 * below from its `.d.ts` rather than invented, and turning it on is:
 *
 *   1. `npm i @crucible/bootstrap@<release tarball URL>` beside the client
 *      (its peer dependency is `@crucible/client` 0.5.0 EXACTLY, which is the
 *      version pinned here);
 *   2. replace this file's local `Bootstrap*` types with
 *      `import type { … } from '@crucible/bootstrap'` — the names and shapes are
 *      already right;
 *   3. replace the one `throw` in `driveCrucibleInstall` with the `install(…)`
 *      call written directly underneath it, in a comment, in full;
 *   4. drop `DRIVEN_INSTALL_UNAVAILABLE` from the renderer's disabled state.
 *
 * Nothing above `driveCrucibleInstall` changes, and no caller changes. That is
 * what makes it a seam rather than a placeholder.
 *
 * ── THE DIVISION OF LABOUR, WHICH IS THE PACKAGE'S OWN RULE ─────────────────
 *
 * From its README: *"A missing prerequisite is a named refusal carrying the
 * exact command the host must run. Elevation, a reboot, a sudo password — those
 * are the app's to obtain. This package never attempts them, never falls back
 * past them, and never guesses a value it could not read."*
 *
 * So there are exactly two commands Foundry owns on Windows and one on Linux,
 * and they are listed apart from the sequence rather than buried in it:
 * `wsl --install -d Ubuntu` (elevated PowerShell, then a reboot) and
 * `sudo loginctl enable-linger "$USER"` (so the server survives logout and comes
 * up at boot). The Mac needs neither: its service is a launchd agent.
 *
 * ── AND WHY FOUNDRY ONLY EVER ASKS FOR `llm` ────────────────────────────────
 *
 * Crucible installs one environment per job type, and they are large. Foundry
 * does two things with a model — text acts and page reading — and both are the
 * `llm` job type. `tts`, `asr`, `align`, `rvc` and `denoise` belong to
 * BookForge's pipeline; a Foundry that installed them would be downloading
 * several gigabytes for acts it has no button for.
 */
import { runCommand } from './crucible-registry';
import { probeSystem } from './system-probe';
import {
  CRUCIBLE_WHEEL,
  type CrucibleInstallPlan,
  type CrucibleInstallStep,
  type InstallPlatform,
  type WslDistroFacts,
} from '../shared/slots';

// ─────────────────────────────────────────────────────────────────────────────
// The surface of `@crucible/bootstrap`, transcribed — see the header, step 2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `install()`'s options, as the package declares them (`sdk/bootstrap/src/
 * install.ts`). Only the fields Foundry would pass are named; the rest
 * (`bind`, `timeouts`, `onStep`) take the package's own defaults.
 *
 * `jobTypes` IS NOT A STRING UNION IN THE PACKAGE: it is
 * `Exclude<JobType, 'tts'> | { type: 'tts'; narratorEngine: string }`, because
 * `crucible install tts` refuses without an engine. Foundry passes `['llm']` and
 * never meets that arm, and the type is written narrowly here to say so.
 */
interface BootstrapInstallOptions {
  /** Required on win32, and there is no default distro — see the header. */
  distro?: string;
  jobTypes: readonly 'llm'[];
  /** An absolute path on this machine, or an `http(s)://` URL to the release wheel. */
  wheel: string;
  /** Every line every step prints, as it prints it. REQUIRED by the package. */
  onLine: (line: string, stream: 'stdout' | 'stderr', step: string) => void;
  /** Where conda is looked for, in order. The Mac's Homebrew cask is not a default. */
  condaRoots?: readonly string[];
}

/** What `install()` answers with. The token is NOT in it — `readLocalConfig()` is. */
interface BootstrapInstallResult {
  steps: { name: string; argv: readonly string[]; status: 'running' | 'ok' | 'skipped'; detail: string }[];
  server: { name: string; url: string; configPath: string };
}

/**
 * WHERE CONDA LIVES ON A MAC THAT INSTALLED IT THROUGH HOMEBREW.
 *
 * `DEFAULT_CONDA_ROOTS` in the package is `~/anaconda3`, `~/miniconda3`,
 * `~/miniforge3` — the three a person gets from the official installers. Owen's
 * Mac Studio has it from the Homebrew cask, which puts it somewhere none of
 * those three name, and a `no_conda` refusal on a machine that plainly has conda
 * is the kind of thing that gets read as the installer being broken. So the cask
 * root is passed as an extra root rather than added to the package's defaults:
 * it is a fact about how this machine was set up, not about conda.
 */
const MAC_CONDA_ROOTS: readonly string[] = ['/opt/homebrew/Caskroom/miniconda/base'];

/**
 * THE ONE SENTENCE the disabled button wears, and the message the door refuses
 * with. Spelled once so the two cannot drift — a button saying "not yet" over a
 * door that threw something else would be a bug report about a different app.
 */
export const DRIVEN_INSTALL_UNAVAILABLE =
  'The installer ships with Crucible\'s next release. Until then the steps below are run by hand — '
  + 'they are the same steps, in the same order.';

// ─────────────────────────────────────────────────────────────────────────────
// The sequence, as a person runs it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT IS ON THIS MACHINE, and the numbered steps that follow from it.
 *
 * Composed in MAIN rather than in the renderer, and the reason is the first
 * step: "is WSL2 here, and which distros" is a question only a process that can
 * spawn `wsl.exe` may answer, and a step list that asked it in the renderer
 * would have a hole in it exactly where the platform-specific part begins.
 *
 * NOTHING HERE CHANGES THE MACHINE. Every command in the returned plan is a
 * string for a person to read and run; the only thing this function executes is
 * `wsl.exe -l -v`, which lists.
 */
export async function crucibleInstallPlan(): Promise<CrucibleInstallPlan> {
  const platform = installPlatform();
  const wsl = platform === 'win32' ? await listWslDistros() : null;
  const profile = await probeSystem();

  return {
    platform,
    wsl,
    /*
     * THE MACHINE'S OWN SENTENCE, borrowed from the hardware probe the wizard's
     * first step already shows. A person deciding whether to install a Crucible
     * is deciding whether this computer is worth pointing one at, and repeating
     * the probe's own words is better than inventing a second description of the
     * same card two screens apart.
     */
    machine: profile.detail,
    steps: stepsFor(platform, wsl),
    elevated: elevatedFor(platform),
    readme: 'https://github.com/telltaleatheist/crucible',
    wheel: CRUCIBLE_WHEEL,
    driven: false,
    drivenWhy: DRIVEN_INSTALL_UNAVAILABLE,
  };
}

/**
 * The numbered sequence. Windows runs it inside the guest; macOS and Linux run
 * it in a terminal on the machine itself.
 *
 * EVERY COMMAND IS COMPLETE AND COPYABLE. A step reading "install the wheel"
 * would send somebody to a README to find the line; the line is here, and the
 * README link is there for the argument behind it. The wheel's version is
 * `CRUCIBLE_WHEEL` (shared/slots.ts), beside the client version this app already
 * pins, so the two cannot say different things about which Crucible this is.
 */
function stepsFor(platform: InstallPlatform, wsl: WslDistroFacts | null): CrucibleInstallStep[] {
  const guest = platform === 'win32';
  const prefix = guest ? 'In the WSL shell: ' : 'In a terminal: ';
  const steps: CrucibleInstallStep[] = [];

  if (guest) {
    steps.push({
      title: 'A WSL2 distribution',
      /*
       * ANSWERED, NOT ASKED. This is the one step of the sequence this app can
       * check for itself, and checking it is most of what makes the list worth
       * reading on Windows: somebody who already has Ubuntu should be told so
       * rather than sent to an elevated PowerShell for nothing.
       */
      detail: wsl === null || wsl.distros.length === 0
        ? 'There is no WSL distribution on this machine. Crucible\'s backend is Linux — Windows is '
          + 'never one — so this comes first, and it needs elevation and a reboot (below).'
        : `Present: ${wsl.distros.join(', ')}. Everything below runs inside one of them.`,
      command: null,
      done: wsl !== null && wsl.distros.length > 0,
    });
  }

  steps.push(
    {
      title: 'A Python 3.11 environment called "crucible"',
      detail: 'Crucible\'s server runs on 3.11 exactly. Miniforge is the smallest way to get one '
        + 'that does not disturb a system Python.',
      command: `${prefix}conda create -n crucible python=3.11 -y`,
      done: false,
    },
    {
      title: 'The Crucible wheel',
      detail: 'From the GitHub release, into that environment. Nothing is built from source.',
      command: `${prefix}conda run -n crucible pip install ${CRUCIBLE_WHEEL}`,
      done: false,
    },
    {
      title: 'Initialise it',
      detail: 'Writes ~/.crucible/config.toml with permissions 0600 and mints the token this app '
        + 'will read back. Foundry asks for the llm job type and nothing else — that is both text '
        + 'acts and page reading.',
      command: `${prefix}conda run -n crucible crucible init --enable-llm`,
      done: false,
    },
    {
      title: 'Install the llm environment',
      detail: 'Several gigabytes, once. This is the step that takes the time.',
      command: `${prefix}conda run -n crucible crucible install llm`,
      done: false,
    },
    {
      title: 'Install the service',
      detail: platform === 'darwin'
        ? 'A launchd agent, so the server is up when you log in.'
        : 'A systemd user unit, so the server is up when you log in. See the linger command below '
          + 'if you want it up at boot as well.',
      command: `${prefix}conda run -n crucible crucible service install`,
      done: false,
    },
    {
      title: 'Measure the card',
      detail: 'Writes the capability record — which classes this machine can serve and with which '
        + 'model. Until this runs, a client asking what it can do is told "undecided" rather than '
        + '"nothing", which is deliberately different news.',
      command: `${prefix}conda run -n crucible crucible capability --write`,
      done: false,
    },
    {
      title: 'Pull the models',
      detail: 'The three Foundry asks for. Each is fetched from its own published home and '
        + 'verified; nothing is bundled.',
      command: `${prefix}conda run -n crucible crucible models pull qwen3.5-9b qwen3.8-27b-4bit dots-ocr`,
      done: false,
    },
    {
      title: 'Come back here and press "Use the Crucible on this machine"',
      detail: 'That reads the token out of config.toml rather than asking you to copy it — the file '
        + 'stays its single owner, so a later `crucible init --force` is fixed by pressing the '
        + 'button again.',
      command: null,
      done: false,
    },
  );
  return steps;
}

/**
 * The commands FOUNDRY CANNOT RUN FOR YOU, listed apart from the sequence.
 *
 * They are separated because they are a different kind of thing: each needs a
 * privilege this app does not have and must not ask for silently. `@crucible/
 * bootstrap` draws the same line — it refuses by name and hands the command
 * over — and the list here is that refusal's `command` field, in advance.
 */
function elevatedFor(platform: InstallPlatform): CrucibleInstallStep[] {
  if (platform === 'win32') {
    return [{
      title: 'If there is no WSL distribution yet',
      detail: 'Run this in an ELEVATED PowerShell, then reboot Windows. The first launch of the '
        + 'distro asks you to choose a username and password.',
      command: 'wsl --install -d Ubuntu',
      done: false,
    }];
  }
  if (platform === 'darwin' || platform === 'other') return [];
  return [{
    title: 'To keep the server up when you are logged out',
    detail: 'systemd stops a user service at the end of the last session unless lingering is on. '
      + 'Without it the Crucible is up only while somebody is logged in — which is fine for a '
      + 'desktop and wrong for a machine other people render on.',
    command: 'sudo loginctl enable-linger "$USER"',
    done: false,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RUN THE SEQUENCE. Refuses today; see the module header for the four-step
 * change that makes it run.
 *
 * The body that replaces the throw is written out here rather than described,
 * because a seam whose replacement has to be reinvented is a seam that gets
 * reinvented differently:
 *
 * ```ts
 * const { install, processRunner } = await import('@crucible/bootstrap');
 * const result = await install({
 *   distro: process.platform === 'win32' ? readAppSettings().wslDistro : undefined,
 *   jobTypes: ['llm'],
 *   wheel: CRUCIBLE_WHEEL,
 *   onLine: (line, _stream, step) => say(`${step}: ${line}`),
 *   condaRoots: process.platform === 'darwin' ? [...MAC_CONDA_ROOTS] : undefined,
 * }, processRunner());
 * // then: ensureRunning(), readLocalConfig(), addCrucibleServer(name, url, token).
 * ```
 *
 * A `BootstrapStepFailed` carries `step`, `exitCode`, `tail` and `stepsDone`,
 * and the renderer should print all four: partial work survives a failure, and
 * telling somebody which of seven steps did not finish is the difference between
 * resuming and starting again. A `BootstrapRefusal` carries `command`, which is
 * a line for the person to run — pass it through verbatim, exactly as the
 * Servers card passes the SDK's own sentences through.
 *
 * THE DYNAMIC IMPORT IS DELIBERATE in that sketch: the package is ESM-only with
 * a CJS build beside it, and an `await import` is the spelling that works from
 * this app's CommonJS main process either way.
 */
export function driveCrucibleInstall(
  options: BootstrapInstallOptions,
): Promise<BootstrapInstallResult> {
  void options;
  void MAC_CONDA_ROOTS;
  return Promise.reject(new Error(DRIVEN_INSTALL_UNAVAILABLE));
}

// ─────────────────────────────────────────────────────────────────────────────
// wsl.exe -l -v
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every WSL distribution on this machine, and which is default.
 *
 * `-l -v` rather than `-l -q`, because the VERSION matters: only WSL2 has the
 * GPU passthrough a Crucible needs, and a WSL1 distro in the list would be
 * offered as a place to install a server that cannot see the card. The parse is
 * deliberately loose about the header row and the `*` marker and strict about
 * nothing else — `wsl.exe`'s table is localised, so matching its column titles
 * would break on a German Windows.
 *
 * A FAILURE IS AN EMPTY LIST WITH A SENTENCE, never a throw: "there is no WSL
 * here" is the ordinary state of a laptop that has never needed one, and it is
 * the first step of the plan rather than an error in composing it.
 */
export async function listWslDistros(): Promise<WslDistroFacts> {
  const result = await runCommand('wsl.exe', ['-l', '-v']);
  if (result.failure !== null || result.code !== 0) {
    return {
      distros: [],
      default: null,
      detail: result.failure
        ?? (result.stderr.trim() || `wsl.exe exited ${result.code ?? 'without a code'}`),
    };
  }
  const distros: string[] = [];
  let fallback: string | null = null;
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const starred = line.startsWith('*');
    const columns = (starred ? line.slice(1) : line).trim().split(/\s{2,}|\t+/);
    const name = (columns[0] ?? '').trim();
    const version = Number.parseInt((columns[2] ?? '').trim(), 10);
    // The header row's first column is the localised word for NAME, and it has
    // no numeric version beside it — which is what tells it apart without
    // knowing what that word is in this Windows's language.
    if (name.length === 0 || !Number.isFinite(version)) continue;
    if (version !== 2) continue;
    distros.push(name);
    if (starred) fallback = name;
  }
  return {
    distros,
    default: fallback,
    detail: distros.length === 0
      ? 'wsl.exe answered, and no WSL2 distribution is installed.'
      : `${distros.length} WSL2 ${distros.length === 1 ? 'distribution' : 'distributions'}.`,
  };
}

/**
 * `process.platform`, narrowed to the three the sequence differs by.
 *
 * `other` is not a fallback that hides a problem: Crucible has a CUDA-Linux
 * backend and an MLX-Darwin one and nothing else, so a machine that is neither
 * is a machine with no Crucible to install, and the plan says so rather than
 * printing a Linux sequence at a FreeBSD.
 */
function installPlatform(): InstallPlatform {
  switch (process.platform) {
    case 'win32': return 'win32';
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    default: return 'other';
  }
}
