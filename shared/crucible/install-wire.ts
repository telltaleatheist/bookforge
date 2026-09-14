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
 * Every question the install story asks — is there a WSL2 distro, does the
 * guest see a card, is there already a `config.toml` — is answerable only by a
 * process that may spawn `wsl.exe`. So main composes the whole picture in one
 * read and the renderer draws it. A screen that asked for the platform branch,
 * the WSL probe and the step list separately would draw a Windows sequence
 * beside a "no WSL found" that had not arrived yet.
 *
 * ── AND WHY THE CODES ARE `@crucible/bootstrap`'S OWN ──────────────────────
 *
 * `CrucibleHostRefusalCode` is a SUBSET of the package's `BootstrapRefusalCode`,
 * spelled identically. The day `electron/crucible/install.ts` takes the real
 * import, the refusals it already shows keep their names and the UI does not
 * move — which is the whole point of typing the seam against the package rather
 * than inventing a vocabulary that would then have to be translated.
 */

/**
 * THE THREE PLATFORMS THE SEQUENCE DIFFERS BY, AND A WORD FOR THE REST.
 *
 * `NodeJS.Platform` would be exact and is deliberately not used: this file is
 * imported by the RENDERER, whose tsconfig carries no node types. `other` is a
 * platform Crucible has no backend for — Windows is never a backend either, but
 * Windows has a guest to install into and so is its own case.
 */
export type InstallPlatform = 'win32' | 'darwin' | 'linux' | 'other';

/**
 * A refusal code this app can reach WITHOUT the package, spelled exactly as
 * `@crucible/bootstrap`'s `BootstrapRefusalCode` spells it.
 *
 * The four the app can answer for itself, plus the two `local.ts` already
 * answers. Everything else the package names — `no_conda`, `no_python`,
 * `wheel_missing`, `step_failed`, … — is a question only the package's own
 * probes can ask, and this app does not guess at them: they appear as STEPS of
 * the plan instead, which is what a person runs to make them go away.
 */
export type CrucibleHostRefusalCode =
  | 'unsupported_platform'
  | 'wsl_missing'
  | 'no_wsl_distro'
  | 'wsl_read_failed'
  | 'no_nvidia_driver'
  | 'not_apple_silicon'
  | 'no_local_config'
  | 'config_unreadable'
  | 'config_missing_key'
  | 'bootstrap_not_installed';

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
   * `local.ts`'s rule, kept: "the default distro" is whatever `wsl --set-default`
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
export type CrucibleLocalConfigFacts =
  | { present: true; serverName: string; url: string; configPath: string; via: 'file' | 'wsl' }
  | { present: false; code: CrucibleHostRefusalCode; reason: string };

/**
 * `detectHost()`-SHAPED, AND ONLY THE PARTS THIS APP CAN MEASURE ITSELF.
 *
 * Field for field a subset of the package's `HostFacts` — `platform`, `wsl`,
 * `gpu`, `refusals` — with `local` added because BookForge has `local.ts` and
 * the package would answer the same question with `readLocalConfig()`. What is
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
  local: CrucibleLocalConfigFacts;
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

/** EVERYTHING THE "INSTALL ONE HERE" DOOR DRAWS, in one read. */
export interface CrucibleInstallPlan {
  platform: InstallPlatform;
  /** The measured facts the steps were composed from. */
  host: CrucibleHostFacts;
  /** One sentence about this machine, from the facts above. */
  machine: string;
  /** The sequence, in order. */
  steps: CrucibleInstallStep[];
  /**
   * The commands that need a privilege this app does not have — elevation, a
   * reboot, sudo. Listed APART from the sequence because `@crucible/bootstrap`
   * draws the same line: it refuses by name and hands the command over rather
   * than attempting it. Empty on macOS, which needs neither.
   */
  elevated: CrucibleInstallStep[];
  /** Crucible's own README — the argument behind the sequence. */
  readme: string;
  /** The release wheel the sequence installs. */
  wheel: string;
  /** The job types BookForge's pipeline asks a Crucible for, in `init` order. */
  jobTypes: string[];
  /**
   * Whether the DRIVEN install can run. FALSE ON EVERY MACHINE TODAY:
   * `@crucible/bootstrap` ships with a Crucible release that has not been cut.
   */
  driven: boolean;
  /** The sentence the disabled button wears. Always set, driven or not. */
  drivenWhy: string;
}
