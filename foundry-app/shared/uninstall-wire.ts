/**
 * uninstall-wire — `crucible uninstall --json`, mirrored as Foundry's wire.
 *
 * ── WHAT THIS IS, AND WHY IT IS A MIRROR RATHER THAN A SUMMARY ─────────────
 *
 * crucible `docs/INSTALL-UNINSTALL.md` §6.3 prints ONE JSON document, and
 * `--dry-run` produces the same document unperformed — *"it is literally the
 * same plan object, unperformed, which is why there is no second description of
 * the work to drift."* This file is Foundry's copy of that document and it
 * carries EVERY field the doc names, in camelCase, because a mirror that kept
 * only the fields today's card draws would be a second, narrower description of
 * the work — which is the exact thing §6.3 was written to prevent.
 *
 * So: no field is dropped, no field is renamed past snake→camel, and nothing
 * here is computed. `kept.weightsBytes` is the server's sum and not ours;
 * `removedBytes` is the server's and not ours. Main reads the document into
 * this shape (electron/crucible-uninstall.ts) and the renderer draws it.
 *
 * ── ABSENT IS NULL, AND MISSING IS A REFUSAL ───────────────────────────────
 *
 * The two are different and the difference is the doc's. `bytes` is OPTIONAL in
 * §6.3 — *"Absent when the target is not a path (a unit, a pid, a distro) —
 * which is not zero"* — so it arrives here as `number | null` and null means
 * exactly that. A field the doc says is ALWAYS there and is not there is
 * `uninstall_unreadable`: the reader refuses rather than defaulting, because a
 * plan with an invented `ok` is a plan that says the wrong thing about a machine
 * somebody is about to change. (This shape is BookForge's too, agreed
 * 2026-09-15, so one plan reads the same in both apps.)
 *
 * ── THE STEP NAME IS A STRING AND NOT A UNION, ON PURPOSE ──────────────────
 *
 * §6.3 lists the shapes a name takes — `stop-engine`, `wsl-guest`,
 * `remove-<state>`, `weights:<catalog kind>`, `pack:<server|host>`,
 * `keep-unknown:<name>`, `remove-home` — and two of those are open: the catalog
 * kinds are the SERVER's list and `keep-unknown:` names a file Crucible did not
 * write. A union here would make a new catalog kind an unreadable document, so
 * the name is a string, every row is DRAWN, and nothing in this app switches on
 * one. The same goes for `action`: three words today, and a fourth would be a
 * row that reads oddly rather than a plan that will not parse.
 *
 * ── NO TOKEN IS IN THIS SHAPE AND NONE EVER WILL BE ────────────────────────
 *
 * The verb prints no credential — `remove-config` deletes the file that holds
 * the bearer token and never echoes it — and the paths that ARE here (`home`,
 * `kept.paths`, each step's `target`) are directories, which is what a person
 * reading a plan needs to see. crucible-registry.ts's token rule is unchanged:
 * nothing that crosses this wire is a secret.
 */

/**
 * WHAT PROVED THE SERVER IS THIS MACHINE'S — §6.1, and Owen's ruling: *"the door
 * only for a server the app can prove is this machine's; never a registry
 * entry."*
 *
 * - `pairing-file` — this machine's pairing file (`$CRUCIBLE_HOME/pairing`, else
 *   the platform's home; §3.6's reader order, which is the SDK's) names a server
 *   whose url AND token are the ones a registry entry holds. The file is written
 *   BY a Crucible ON the machine it runs on, so a line in it is a statement about
 *   this computer.
 * - `windows-host` — `%LOCALAPPDATA%\Crucible\host\crucible.cmd` is here, which
 *   is what *"the host is installed"* MEANS (§6.2, quoting `crucible/host/
 *   paths.py`).
 * - `wsl-guest` — win32 with no host pack, where Foundry's own door 2 read a
 *   `config.toml` out of a named WSL distro. A guest on this machine is on this
 *   machine.
 *
 * §6.1's remaining proof — *"the server this app installed in this session
 * through `@crucible/bootstrap`'s `install()`"* — is NOT here and cannot be:
 * `driveCrucibleInstall` refuses on every machine until that package ships, so
 * no session of this app has ever installed a server.
 */
export type CrucibleUninstallProof = 'installation-record' | 'pairing-file' | 'windows-host' | 'wsl-guest';

/**
 * WHICH COMMAND WILL BE RUN — §6.2's three lines, chosen by what is on this
 * machine rather than by which proof answered first.
 *
 * The two questions are separate and both have to be asked. A win32 machine can
 * be proved by its pairing file and still need the HOST PACK's `crucible.cmd`
 * to do the work, which is exactly the case on Owen's PC.
 */
export type CrucibleUninstallVia = 'windows-host' | 'wsl-guest' | 'server-pack';

/**
 * MAY THIS APP DRAW THE DOOR AT ALL, and what would it run.
 *
 * `available: false` carries in `why` the sentence the card prints instead of
 * the button; `code` is the app-side refusal name behind it, from the agreed
 * list (see {@link CrucibleUninstallCode}). Hosted, inside BookForge, it is
 * always false: the registry is somebody else's list about possibly somebody
 * else's machine.
 *
 * `server` is the registry name the proof NAMED, or null. It is here rather than
 * recomputed at the far end because §6.4's last act needs it: after a real run
 * that stopped the engine, that entry's token is dead and the row goes. A
 * `windows-host` proof may name nothing, and that is a real answer — the host is
 * installed, this app has no row pointing at it, and there is nothing to remove
 * afterwards.
 */
export interface CrucibleUninstallAvailability {
  available: boolean;
  why: string;
  proof: CrucibleUninstallProof | null;
  via: CrucibleUninstallVia | null;
  server: string | null;
  /** The app-side refusal name when `available` is false, else null. */
  code: CrucibleUninstallCode | null;
  /**
   * Is `--wsl-too` a flag this machine can be offered? Only the host pack drives
   * the guest (§2: *"the guest before the tray's service, and after the tray
   * itself"*), so the checkbox exists on win32 with a host and nowhere else.
   */
  wslTooOffered: boolean;
}

/**
 * THE APP-SIDE REFUSAL NAMES, and they are facts about THIS APP's reach.
 *
 * Agreed with BookForge on 2026-09-15 so the two apps name one situation one
 * way. The CLI's own refusals are a different list and a different layer: they
 * arrive per step, in the engine's words, inside the plan (§6.3's table —
 * `stop_failed`, `weights_absent`, `home_not_empty` and the rest) and are never
 * translated here.
 *
 * - `uninstall_not_local` — §6.1 said no. Nothing on this machine proves the
 *   server is this machine's, or Foundry is hosted.
 * - `uninstall_not_available` — there is no CLI to call, or the one that is
 *   there predates the verb (it answered usage, exit 2).
 * - `uninstall_no_localappdata` — win32 with `%LOCALAPPDATA%` unset. Read from
 *   the environment and never assembled from a username, so unset is a refusal.
 * - `uninstall_no_distro` — the WSL arm with no distro named. There is no
 *   default on purpose: *"the default" is whatever `wsl --set-default` last
 *   said*, and the wrong guest is the wrong machine.
 * - `uninstall_home_unreadable` — the `CRUCIBLE_HOME` this would act on could
 *   not be worked out.
 * - `uninstall_wsl_too_needs_host` — `--wsl-too` asked where nothing can drive
 *   the guest: off win32, or on win32 without the host pack.
 * - `uninstall_unrun` — the command never ran, or never answered.
 * - `uninstall_unreadable` — it ran and printed something that is not the plan,
 *   a missing required field included.
 * - `uninstall_failed` — it ran, fell over and printed no plan at all. The
 *   distinction from `uninstall_unreadable` is real: one is a broken document,
 *   the other is no document.
 */
export type CrucibleUninstallCode =
  | 'uninstall_not_local'
  | 'uninstall_not_available'
  | 'uninstall_no_localappdata'
  | 'uninstall_no_distro'
  | 'uninstall_home_unreadable'
  | 'uninstall_wsl_too_needs_host'
  | 'uninstall_unrun'
  /** win32: `%LOCALAPPDATA%` holds a quote or a percent sign — cmd.exe would read it as syntax. BookForge's name. */
  | 'uninstall_bad_path'
  | 'uninstall_unreadable'
  | 'uninstall_failed';

/** The flags §6.2 spells, as the two doors take them. */
export interface CrucibleUninstallFlags {
  purgeWeights: boolean;
  /** Only where `wslTooOffered` — §6.2, and `uninstall_wsl_too_needs_host`. */
  wslToo: boolean;
}

/**
 * Why a step did not happen — §6.3's `refused`.
 *
 * `fatal: false` is *"there was nothing there"*, the ordinary outcome of
 * uninstalling a half-clean machine. `fatal: true` is the one thing that could
 * not be done, and it makes the plan's `ok` false WITHOUT stopping the run
 * (ARCHITECTURE.md R6) — every other step still happened and its work is on
 * disk. That is why the renderer marks one row and never says "uninstall
 * failed".
 */
export interface CrucibleUninstallRefusal {
  code: string;
  message: string;
  fatal: boolean;
}

/** One row of the plan — §6.3's step object, field for field. */
export interface CrucibleUninstallStep {
  /** Unique in the list. A STRING, never a union — see the module note. */
  name: string;
  /** One sentence, for a person. The server's words, printed as they arrive. */
  what: string;
  /** `remove` | `stop` | `keep` today. Read as a string — see the module note. */
  action: string;
  /** The path, unit name, label, pid or distro. */
  target: string;
  /** Disk the target holds, or null when the target is not a path — not zero. */
  bytes: number | null;
  /** Did THIS run perform the step? Always false after a dry run. */
  done: boolean;
  refused: CrucibleUninstallRefusal | null;
  /** Lines the act printed, or null when it printed none. */
  detail: string[] | null;
}

/** What the plan leaves behind — §6.3's `kept`. */
export interface CrucibleUninstallKept {
  /** The sum of the KEPT `weights:*` steps. The headline the door draws. */
  weightsBytes: number;
  /** Every path this plan leaves behind. */
  paths: string[];
}

/**
 * The whole document — §6.3. A dry run and a real run are the SAME shape, which
 * is why one type serves both doors and `dryRun` is the only thing that says
 * which one a person is looking at.
 */
export interface CrucibleUninstallPlan {
  /** true = nothing was touched. */
  dryRun: boolean;
  /** The `CRUCIBLE_HOME` this plan is against. */
  home: string;
  platform: string;
  /** `systemd` | `launchd` | `startup` (win32's Startup item + tray). */
  mechanism: string;
  /**
   * READ from config.toml's `[backend] kind`, never detected — *"an uninstall
   * does not probe a card"* — so null is the honest answer on a home with no
   * readable config, and is what Owen's PC's Windows half answers today.
   */
  backendKind: string | null;
  /** The flags, echoed by the verb. */
  purgeWeights: boolean;
  wslToo: boolean;
  steps: CrucibleUninstallStep[];
  kept: CrucibleUninstallKept;
  /** The sum of the remove steps that ran. 0 on a dry run. */
  removedBytes: number;
  /** false when any step's refusal was fatal. */
  ok: boolean;
}

/**
 * What the REAL door answers: the performed plan, and the one thing Foundry did
 * about it that is not in the plan.
 *
 * §6.4's last act is this app's, not the verb's: an uninstall that stopped the
 * engine killed the bearer token with `remove-config`, so the registry row
 * pointing at it is a row with a dead credential. `unregistered` is the name
 * that went, or null when the proof named no row or the engine was not stopped.
 * It rides here rather than being inferred in the renderer because the renderer
 * cannot see the registry write, and a door that quietly removed a row a card
 * still draws would be the app changing a list behind somebody's back.
 */
export interface CrucibleUninstallRun {
  plan: CrucibleUninstallPlan;
  unregistered: string | null;
}
