/**
 * THE UNINSTALL DOOR'S WIRE — what `crucible uninstall --json` says, as the
 * renderer draws it.
 *
 * A sibling of `install-wire.ts` for the same reason that file is a sibling of
 * `settings-wire.ts`: one shape, one owner, no merge over a contract neither
 * change knows about (crucible `docs/ARCHITECTURE.md` R1).
 *
 * ── WHY THE FIELD NAMES CHANGE CASE AND NOTHING ELSE ──────────────────────
 *
 * Crucible's CLI prints snake_case, this app's renderer reads camelCase, and
 * `electron/crucible/uninstall.ts` is the ONE place that turns one into the
 * other. Nothing is renamed, nothing is folded, nothing is computed: `steps`
 * is the CLI's `steps`, `kept.weights_bytes` is `keptWeightsBytes`, and a
 * field the CLI omits is `null` here rather than a number somebody chose.
 */

/**
 * WHY THIS APP CAN REFUSE TO UNINSTALL. Every name is BookForge's own, because
 * every one of them is a fact about this app's reach rather than about
 * Crucible: the CLI's refusals arrive inside the plan, per step, in the CLI's
 * own words.
 */
export type CrucibleUninstallRefusalCode =
  /**
   * The engine named is not this machine's. An engine is uninstalled on the
   * machine it is on (ruling 2026-09-15, taken with Foundry so both apps draw
   * the same door) — this one deletes a service, a home directory and possibly
   * tens of gigabytes, and is deliberately not reachable across a network.
   */
  | 'uninstall_not_local'
  /**
   * There is a Crucible here and no Crucible CLI to take it apart with: no
   * host pack on Windows, or a config with no server pack beside it.
   * Also the answer when the CLI that IS here predates the verb.
   */
  | 'uninstall_not_available'
  /** win32, and `LOCALAPPDATA` is not in the environment. Never assembled from a username. */
  | 'uninstall_no_localappdata'
  /** win32, the config was read through WSL, and no distro is named in this app's settings. */
  | 'uninstall_no_distro'
  /** A config path with no directory in it, so the Crucible home cannot be read out of it. */
  | 'uninstall_home_unreadable'
  /** "Also remove the WSL2 engine" was asked for somewhere it does not exist. */
  | 'uninstall_wsl_too_needs_host'
  /** The CLI could not be spawned at all, or the run timed out. */
  | 'uninstall_unrun'
  /** It ran and answered something that is not the `--json` document. */
  | 'uninstall_unreadable'
  /** Anything that is not one of the above. The error's own words are the message. */
  | 'uninstall_failed';

/** Which Crucible CLI is being used, and how it was reached. */
export interface CrucibleUninstallTarget {
  /** `host` = the Windows host pack; `guest` = inside WSL; `native` = this machine's own. */
  kind: 'host' | 'guest' | 'native';
  /** The full argv prefix, `crucible uninstall` excluded. */
  argv: string[];
  /** One line naming it, for the screen. */
  describe: string;
  /** How `local.ts` found the server this belongs to: `pairing`, `file` or `wsl`. */
  via: string;
}

/**
 * One act of an uninstall, against exactly one target.
 *
 * `action` is `remove`, `stop` or `keep`, and **`keep` is a RESULT, not the
 * absence of one** — a weights directory left on disk is a decision the
 * command made and reports, with its size. That is the CLI's own rule and it
 * is why the door can honestly say what it is keeping.
 */
export interface CrucibleUninstallStep {
  name: string;
  what: string;
  action: string;
  target: string;
  /** Did THIS run perform it. Always false after a dry run. */
  done: boolean;
  /** Bytes on disk for a path. NULL where the target is not a path — not zero. */
  bytes: number | null;
  /** The CLI's own refusal for this step, verbatim. `fatal` decides the exit code. */
  refused: { code: string; message: string; fatal: boolean } | null;
  /** Lines the act produced, for the transcript. */
  detail: string[];
}

/** The whole document, dry or real. */
export interface CrucibleUninstallPlan {
  /** The CLI this went through, named. */
  ranThrough: string;
  through: CrucibleUninstallTarget['kind'];
  dryRun: boolean;
  home: string;
  platform: string;
  /** How the service is installed on this machine — systemd, launchd, the host. */
  mechanism: string;
  /** The backend the config RECORDED. Never probed: an uninstall does not ask a card. */
  backendKind: string | null;
  purgeWeights: boolean;
  wslToo: boolean;
  /** False when a step refused fatally. The CLI prints its plan either way. */
  ok: boolean;
  removedBytes: number;
  keptWeightsBytes: number;
  keptPaths: string[];
  steps: CrucibleUninstallStep[];
}
