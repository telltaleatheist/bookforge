/**
 * THE INSTALL STORY'S WIRE — what the three doors draw, shaped in main.
 *
 * A sibling of `settings-wire.ts` rather than an addition to it, and the reason
 * is ownership: that file is the Servers row's contract and is being edited by
 * the render/text/pages work at the same time as this. Two files, two owners,
 * no merge over a shape neither change knows about (crucible
 * `docs/ARCHITECTURE.md` R1).
 *
 * ── WHY THE RENDERER IS GIVEN FACTS AND NOT A PROBE ────────────────────────
 *
 * Main reads local installation facts and composes the plan; the renderer
 * draws it. Windows setup uses its native engine without probing WSL or a GPU.
 *
 * ── AND WHY THE CODES ARE `@crucible/bootstrap`'S OWN ──────────────────────
 *
 * `CrucibleHostRefusalCode` WAS a hand-copied subset of the package's
 * `BootstrapRefusalCode`, spelled identically so the UI would not move the day
 * the real import landed. It landed (2026-09-15), so the copy is gone and the
 * package's union IS the type. A refusal now crosses this wire verbatim — the
 * code its owner chose, with nothing renamed on the way through — and a code
 * the package adds appears here without anybody transcribing it.
 */

import type { BootstrapRefusalCode } from '@crucible/bootstrap';

import type { CrucibleDiscoveryVia } from './settings-wire';

/**
 * THE THREE PLATFORMS THE SEQUENCE DIFFERS BY, AND A WORD FOR THE REST.
 *
 * `NodeJS.Platform` would be exact and is deliberately not used: this file is
 * imported by the RENDERER, whose tsconfig carries no node types. `other` is a
 * platform Crucible has no backend for. Windows installs the native engine;
 * the optional WSL upgrade is managed separately by Crucible.
 */
export type InstallPlatform = 'win32' | 'darwin' | 'linux' | 'other';

/**
 * EVERY NAME THIS APP CAN SHOW FOR A FAILED INSTALL: the package's own union,
 * plus the one thing the package cannot name.
 *
 * `BootstrapRefusalCode` covers both halves of the story — the six this app's
 * own probes reach (`unsupported_platform`, `wsl_missing`, `no_wsl_distro`,
 * `wsl_read_failed`, `no_nvidia_driver`, `not_apple_silicon`), the three
 * `discovery.ts` answers (`no_local_config`, `config_unreadable`,
 * `config_missing_key`), and everything only the installer can meet
 * (`host_not_installed`, `host_unreachable`, `host_install_running`,
 * `pack_not_published`, `pack_sha_mismatch`, `step_failed`, …). They are not
 * transcribed here: one union, one owner.
 *
 * `bootstrap_not_installed` IS GONE (2026-09-15). It was this app's own word
 * for "the package is not in package.json", and the package is in package.json
 * — a name for a state that can no longer happen is a name somebody will one
 * day show for a different reason.
 *
 * `install_failed` is the only name added, and it is added rather than
 * borrowed: it means the installer threw something that is NOT a refusal, so
 * there is no owner's name to carry and the error's own words are the message.
 */
export type CrucibleHostRefusalCode =
  | BootstrapRefusalCode
  | 'install_failed'
  /**
   * THE NEVER-OLDER GATE, and it is THIS APP'S (crucible
   * `docs/INSTALL-UNINSTALL.md` §6.5.3). The package's own gate is about the
   * PACK on this disk; these two are about the ENGINE ANSWERING on this
   * machine, which is a different fact and one only a caller that can reach
   * `GET /v1/info` can read. So they are added here rather than borrowed.
   */
  | 'install_older_than_running'
  | 'crucible_already_latest'
  /**
   * The release channel would not say what its latest release is (§6.5.2).
   *
   * BORROWED IN ADVANCE: crucible's `sdk/bootstrap/src/channel.ts` owns this
   * name, and the vendored 1.0.1 tarball predates it, so the union cannot yet
   * get it from `BootstrapRefusalCode`. It comes off this list at the re-vendor
   * that brings the module in, and the spelling is the package's exactly so
   * that day is a deletion rather than a rename.
   */
  | 'release_channel_unreadable';

/**
 * A named refusal, in the package's own shape: `{code, message, command}`.
 *
 * `command` is WHAT THE HOST MUST RUN, and it is null whenever there is nothing
 * a person can type. The package's rule, kept verbatim: elevation, a reboot and
 * a sudo password are the app's to obtain, never the installer's to attempt —
 * so a refusal that needs one hands the line over instead.
 */
export interface CrucibleHostRefusal {
  code: CrucibleHostRefusalCode;
  message: string;
  /** The exact line to run, or null when nothing can be typed. Never a guess. */
  command: string | null;
  /** Verbatim evidence — a stderr tail, a status line — or null. */
  detail: string | null;
}

/** One WSL distribution, as `wsl.exe -l -v` listed it. */
export interface CrucibleWslDistro {
  name: string;
  /** 1 or 2. Only 2 has the GPU passthrough a Crucible needs. */
  version: number;
  default: boolean;
  /** `Running` / `Stopped`, as wsl.exe spelled it — not translated. */
  state: string;
}

/** What `wsl.exe -l -v` said, and which distro the other facts were read through. */
export interface CrucibleWslFacts {
  distros: CrucibleWslDistro[];
  /** The one wsl.exe marks `*`, or null. NEVER used as a default — see `probed`. */
  default: string | null;
  /**
   * The distro the GPU and config facts were actually read through: the app's
   * OWN WSL setting (Settings → Add-ons → WSL distro), never wsl.exe's default.
   * `discovery.ts`'s rule, kept: "the default distro" is whatever `wsl --set-default`
   * last said, and a server read from the wrong guest is a wrong server.
   */
  probed: string | null;
  /** One sentence about the listing itself, whether it worked or not. */
  detail: string;
}

/** The card, as the guest (or the machine) reports it. */
export interface CrucibleGpuFacts {
  vendor: 'nvidia' | 'apple';
  name: string;
  /** Total memory. On Apple silicon that is the machine's unified memory. */
  vramBytes: number;
}

/** Is there already a Crucible config on this machine, and what does it say? */
export type CrucibleDiscoveredFacts =
  | { present: true; serverName: string; url: string; configPath: string; via: CrucibleDiscoveryVia }
  | { present: false; code: CrucibleHostRefusalCode; reason: string };

/**
 * `detectHost()`-SHAPED, AND ONLY THE PARTS THIS APP CAN MEASURE ITSELF.
 *
 * Field for field a subset of the package's `HostFacts` — `platform`, `wsl`,
 * `gpu`, `refusals` — with `discovered` added because BookForge has
 * `discovery.ts` and the package would answer the same question with
 * `readLocalConfig()`. What is
 * missing is `python` and `conda`, deliberately: finding the server interpreter
 * is `probeInterpreter`'s one guest-side script, and inventing a second one here
 * would be the copy this seam exists to avoid.
 */
export interface CrucibleHostFacts {
  platform: InstallPlatform;
  /** The raw `process.platform`, for a machine Crucible has no backend for. */
  platformName: string;
  arch: string;
  /** win32 only; null elsewhere, where there is no guest. */
  wsl: CrucibleWslFacts | null;
  gpu: CrucibleGpuFacts | null;
  discovered: CrucibleDiscoveredFacts;
  /** One named refusal per null above, each with the command that clears it. */
  refusals: CrucibleHostRefusal[];
}

/**
 * One step of the sequence, or one of the elevated commands beside it.
 *
 * `commands` IS A LIST, not one string, and that is a correction rather than a
 * style choice: `crucible models pull` takes ONE positional id
 * (`crucible/cli.py`, `models_pull.add_argument("model", …)`), so a step that
 * pulls four things is four lines. An empty list is a step with nothing to type
 * — "come back here and press the button" is a step.
 *
 * `done` is true ONLY where this app has actually verified the step. Today that
 * is exactly two: whether a WSL2 distro exists, and whether a config is already
 * there. Every other step is something only the machine it runs on knows the
 * outcome of, and a checkbox that guessed would be worse than no checkbox.
 */
export interface CrucibleInstallStep {
  title: string;
  detail: string;
  commands: string[];
  done: boolean;
}

/** Whether this platform can host Crucible. Windows native setup requires no WSL probe. */
export type CrucibleHostability = 'yes' | 'no' | 'unknown';

/** EVERYTHING THE "INSTALL ONE HERE" DOOR DRAWS, in one read. */
export interface CrucibleInstallPlan {
  platform: InstallPlatform;
  /** The measured facts the steps were composed from. */
  host: CrucibleHostFacts;
  /** One sentence about this machine, from the facts above. */
  machine: string;
  /**
   * Could a Crucible live here. Composed in main from the facts, so the wizard
   * step that shows ONE of three faces (PHASE13-OPERATOR.md §5.5) reads a
   * decision rather than making a second one out of the same nulls.
   */
  hostable: CrucibleHostability;
  /** Why, whichever way it went. ALWAYS set — a verdict with no reason is a bug. */
  hostableWhy: string;
  /** The sequence, in order. */
  steps: CrucibleInstallStep[];
  /*
   * `elevated` IS GONE FROM THIS SHAPE (PHASE19 §3, §4, 2026-09-19).
   *
   * It carried "the commands that need a privilege this app does not have",
   * and the renderer drew them under "Commands BookForge cannot run for you".
   * **Nobody is ever shown a command** (§0): a command a person could run is a
   * step the app should be running, and where the app truly cannot, the state
   * table's sentence says what to change and where — which is the `cannot`
   * outcome's job, not a printed list's. The field is removed rather than left
   * empty so that a list cannot reappear in it without somebody deciding to.
   */
  /** Crucible's own README — the argument behind the sequence. */
  readme: string;
  /*
   * `wheel` IS GONE FROM THIS SHAPE (2026-09-15). A Crucible has not been
   * installed from a `.whl` since PHASE14: the server arrives as an ENV PACK
   * with its own interpreter inside it, which is what the installer's
   * `server-pack` step fetches and verifies. Nothing drew the field, and a
   * field naming the wrong artefact is a wrong answer waiting for a reader.
   */
  /*
   * `jobTypes` IS GONE FROM THIS SHAPE (2026-09-14, PHASE13-OPERATOR.md §5.4).
   *
   * It restated the six ids `shared/crucible/bookforge.module.json` now owns —
   * a second list, kept in step by hand, in the one file whose job is to be
   * correct about ids. The sequence no longer passes `--enable-*` to
   * `crucible init` either: `crucible install <type>` MERGES the flag into
   * config.toml and reloads the registry (§3.4), so the **Set up for
   * BookForge** button turning the job types on is not a convenience, it is
   * where they are decided. A screen that wants to name them asks
   * `crucible:module`.
   */
  /**
   * Whether the DRIVEN install can run ON THIS MACHINE.
   *
   * True on win32, darwin and linux since 2026-09-15, when
   * `@crucible/bootstrap` was vendored: the only thing that can make it false
   * now is a platform Crucible has no backend for.
   */
  driven: boolean;
  /**
   * Why not, when `driven` is false. NULL when it is true — a reason beside a
   * live button is a sentence that contradicts what it sits on, and the old
   * "always set" field made every caller draw one.
   */
  drivenWhy: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The driven install, as it happens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE EVENT OF A RUNNING INSTALL, pushed to the renderer on
 * `crucible:install-progress`.
 *
 * WHY THIS IS A STREAM AND NOT A RETURN VALUE. A Crucible install downloads
 * gigabytes, imports a distro, raises two UAC prompts and may cross a reboot
 * (crucible PHASE15-HOST.md §4.3). An `await` that answered at the end of all
 * that would leave a person watching a spinner for twenty minutes with no way
 * to tell a slow download from a wedged one — and the package already reports
 * every step, every line and every WSL state as it happens. So they are
 * forwarded, in the package's own shapes, and the awaited call answers only
 * the ending.
 *
 * FIVE KINDS AND NO SIXTH. `state` is the one a Windows machine turns on: it
 * is the 4c table's answer for THIS machine — `wsl_missing`,
 * `virtualization_disabled`, `wsl1_only`, `no_crucible_distro`, … — with the
 * sentence its owner wrote and the KIND of action it needs. It is not folded
 * into `line`, because a state is a fact about the machine and a line is
 * something a process printed, and a screen shows them differently.
 */
export type CrucibleInstallProgress =
  /** One step of the sequence began, finished, or was skipped. */
  | { kind: 'step'; step: string; index: number | null; total: number | null; status: string; detail: string }
  /** Bytes, while a step downloads. `total` is null until the size is known. */
  | { kind: 'progress'; file: string; done: number; total: number | null }
  /** The WSL state table's answer for this machine, verbatim (win32 only). */
  | { kind: 'state'; code: string; sentence: string; action: 'run' | 'run-elevated' | 'instruct' | 'link' }
  /** One line a step printed. */
  | { kind: 'line'; step: string; stream: 'stdout' | 'stderr'; text: string }
  /** The install finished. The token is NOT here; the pairing file is. */
  | { kind: 'done'; server: { name: string; url: string; configPath: string }; release: string; backend: string }
  /** It stopped, by name. Every field is the refusing owner's own. */
  | { kind: 'failed'; refusal: CrucibleHostRefusal };
