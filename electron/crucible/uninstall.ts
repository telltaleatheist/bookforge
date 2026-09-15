/**
 * TAKING A CRUCIBLE OFF THIS MACHINE — the app's side of `crucible uninstall`.
 *
 * ── WHOSE COMMAND THIS IS ──────────────────────────────────────────────────
 *
 * Crucible's, entirely. `crucible uninstall` is a verb of the engine's own CLI
 * (crucible `crucible/uninstall.py`): it plans every step against the machine,
 * reports each one with its target and its size, keeps the weights unless
 * `--purge-weights` says otherwise, and answers `--json` in a shape written
 * for an app to draw. BookForge composes NO sequence of its own here. It finds
 * the CLI that owns the local server, runs the dry run, shows it, and — if a
 * person says so — runs the same plan for real.
 *
 * That is the whole design, and it is the same rule the install side follows
 * (crucible PHASE15-HOST.md §4.3, PHASE14 §4a): two descriptions of one
 * sequence cannot differ, so there is one, and it is not this one.
 *
 * ── LOCAL ONLY, AND REFUSED BY NAME OTHERWISE (ruling 2026-09-15) ──────────
 *
 * The door is drawn ONLY for a Crucible this app can prove is on THIS machine:
 * the pairing file it left here, the `config.toml` it wrote here, or the host
 * on loopback. Never for a registry entry that names another machine, and
 * never for a `local`-named row this app cannot prove is local — `crucible
 * uninstall` deletes a service, a home directory and possibly tens of
 * gigabytes of weights, and a door that could reach the Mac Studio from a
 * laptop is a door that will. Anything else is `uninstall_not_local`.
 *
 * There is deliberately no remote uninstall and no "are you sure" that turns
 * into one: an engine somewhere else is uninstalled on the machine it is on.
 *
 * ── AND `uninstall_not_available`, WHICH IS A VERSION FACT ─────────────────
 *
 * The verb is new. A Crucible installed before it existed answers argparse's
 * "invalid choice" on stderr and exits 2, which is a perfectly clear sentence
 * about a CLI and a useless one about a machine. It is translated ONCE, by
 * name, into `uninstall_not_available` carrying the upgrade as its command —
 * the one place in this file where another owner's words are replaced, and
 * only because the words are about argparse rather than about Crucible.
 *
 * ── THE CONTRACT THIS IS BUILT TO ──────────────────────────────────────────
 *
 * `crucible/uninstall.py`'s `Plan.to_dict()` and `Step.to_dict()`, read at
 * 2026-09-15 while that side was still being written, plus the flags its
 * argument parser declares (`--dry-run`, `--purge-weights`, `--wsl-too`,
 * `--json`). `tools/test-crucible-uninstall.js` pins every field this file
 * reads.
 *
 * TODO(crucible): `docs/INSTALL-UNINSTALL.md` is the doc that will own this
 * contract and it had not landed when this was written. When it does, check
 * the shape below against it and delete this note — the doc is the owner of
 * every name on the wire, exactly as PHASE15 is for the settings door.
 */

import type { Runner } from '@crucible/bootstrap';

import type { LocalServer } from './local';
import {
  CrucibleLocalError,
  processHost as processLocalHost,
  readLocalServer,
} from './local';
import { getWslDistro } from '../tool-paths';
import type {
  CrucibleUninstallPlan,
  CrucibleUninstallRefusalCode,
  CrucibleUninstallTarget,
} from '../../shared/crucible/uninstall-wire';

/** The subdirectory a server pack unpacks into, as `@crucible/bootstrap` spells it. */
const SERVER_SUBDIR = 'server';

/**
 * How long a dry run and a real run are each given.
 *
 * A dry run measures six weight directories with a recursive walk and touches
 * nothing else, so a minute is generous. A real run stops a service, deletes
 * tens of gigabytes and may reach into a WSL guest, so it gets an hour — and
 * still has a limit, because a call that can block forever is a window that
 * never comes back.
 */
export const UNINSTALL_DRY_RUN_TIMEOUT_MS = 60_000;
export const UNINSTALL_RUN_TIMEOUT_MS = 60 * 60_000;

/** A refusal from this door. The code is prefixed onto the message, as everywhere. */
export class CrucibleUninstallError extends Error {
  readonly code: CrucibleUninstallRefusalCode;
  readonly command: string | null;
  readonly detail: string | null;

  constructor(
    code: CrucibleUninstallRefusalCode,
    message: string,
    options: { command?: string; detail?: string } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleUninstallError';
    this.code = code;
    this.command = options.command ?? null;
    this.detail = options.detail ?? null;
  }

  toRefusal(): { code: CrucibleUninstallRefusalCode; message: string; command: string | null; detail: string | null } {
    return { code: this.code, message: this.message, command: this.command, detail: this.detail };
  }
}

/**
 * WHICH `crucible` OWNS THE ENGINE ON THIS MACHINE, or `uninstall_not_local`.
 *
 * Three answers and no fourth, each tied to how `local.ts` found the server —
 * because the thing that found it is the thing that knows where it lives:
 *
 *   - **win32, host present.** `%LOCALAPPDATA%\Crucible\host\crucible.cmd`, the
 *     host pack's entry point (PHASE15 §4.4). It uninstalls the Windows side,
 *     and `--wsl-too` carries the same flags into the guest first.
 *   - **win32, read through `wsl.exe`.** There is no host on this machine yet
 *     (Owen's PC today), so the only Crucible CLI here is the guest's own and
 *     it is reached the way `local.ts` reached its config.
 *   - **darwin / linux.** `<CRUCIBLE_HOME>/server/bin/crucible` — the machine
 *     IS the server, and there is no host anywhere but Windows.
 *
 * `serverName` is checked against the caller's: a UI that has a row selected
 * must not be able to press this while looking at another one.
 */
export function crucibleUninstallTarget(
  server: string,
  runner: Runner,
  distro: string | undefined = getWslDistro(),
  /*
   * WHERE THIS MACHINE'S SERVER IS, injectable for the reason `install.ts`'s
   * `InstallHost` is: a keeper must be able to drive "no engine here" without
   * the answer depending on whether the machine it runs on happens to have
   * one. The default IS the real read; nothing in the app passes this.
   */
  readLocal: () => LocalServer = () => readLocalServer(processLocalHost(distro)),
): CrucibleUninstallTarget {
  if (server !== 'local') {
    throw new CrucibleUninstallError(
      'uninstall_not_local',
      `"${server}" is a Crucible somewhere else. An engine is uninstalled on the machine it is `
      + 'on, by somebody at that machine: this door deletes a service, a home directory and '
      + 'possibly tens of gigabytes of weights, and it is not reachable across a network on '
      + 'purpose. Remove the row from the list here if you no longer want to use it.',
    );
  }

  let local: LocalServer;
  try {
    local = readLocal();
  } catch (err) {
    if (err instanceof CrucibleLocalError) {
      /*
       * `local.ts`'s OWN NAME travels in the detail. Its message is the
       * reason alone (`no local Crucible: ~/.crucible/config.toml does not
       * exist …`), and the code beside it is the difference between "there is
       * nothing here", "the config is unreadable" and "the config is missing a
       * key" — three states with three different next moves, which one
       * sentence about "no Crucible" would flatten into one.
       */
      throw new CrucibleUninstallError(
        'uninstall_not_local',
        `there is no Crucible on this machine to uninstall: ${err.message}`,
        { detail: `${err.code}: ${err.message}` },
      );
    }
    throw err;
  }

  if (runner.platform === 'win32') {
    const appData = runner.env['LOCALAPPDATA'];
    if (appData === undefined || appData === '') {
      throw new CrucibleUninstallError(
        'uninstall_no_localappdata',
        'LOCALAPPDATA is not set in this process\'s environment, so the Crucible host\'s own '
        + 'directory cannot be named. It is read from the environment and never assembled from '
        + 'a username.',
      );
    }
    const hostCli = `${appData}\\Crucible\\host\\crucible.cmd`;
    if (runner.fileExists(hostCli)) {
      return { kind: 'host', argv: [hostCli], describe: hostCli, via: local.via };
    }
    if (local.via === 'wsl') {
      if (distro === undefined || distro.trim() === '') {
        throw new CrucibleUninstallError(
          'uninstall_no_distro',
          'this machine\'s Crucible was read through WSL and no distro is named. Set it in '
          + 'Settings → Add-ons → WSL distro. "The default distro" is whatever `wsl --set-default` '
          + 'last said, and an uninstall run in the wrong guest is the worst possible guess.',
        );
      }
      /*
       * The GUEST'S OWN CLI, because there is no host on this machine. The
       * home is the guest's default (`~/.crucible`), which is where `local.ts`
       * read the config from, so the binary beside it is the one that owns it.
       */
      return {
        kind: 'guest',
        argv: ['wsl.exe', '-d', distro, '--exec', `${guestHome(local.configPath)}/${SERVER_SUBDIR}/bin/crucible`],
        describe: `${distro}: ${guestHome(local.configPath)}/${SERVER_SUBDIR}/bin/crucible`,
        via: local.via,
      };
    }
    throw new CrucibleUninstallError(
      'uninstall_not_available',
      `this machine's Crucible was found at ${local.configPath}, and there is no Crucible CLI `
      + `here to uninstall it with: no host at ${hostCli}, and the config was not read through a `
      + 'WSL guest either. Install the host — it is the thing that owns an install on Windows — '
      + 'and this door works from its CLI.',
      { detail: `via=${local.via}` },
    );
  }

  const home = nativeHome(local.configPath);
  const cli = `${home}/${SERVER_SUBDIR}/bin/crucible`;
  if (!runner.fileExists(cli)) {
    throw new CrucibleUninstallError(
      'uninstall_not_available',
      `there is no server pack at ${cli}, so this machine has a Crucible config with no Crucible `
      + 'CLI beside it. That is what a server installed some other way looks like, and it is not '
      + 'something this app can take apart: uninstall it the way it was installed.',
    );
  }
  return { kind: 'native', argv: [cli], describe: cli, via: local.via };
}

/** `<home>/config.toml` → `<home>`, as the GUEST spells it (forward slashes). */
function guestHome(configPath: string): string {
  const normalised = configPath.replace(/\\/g, '/');
  const cut = normalised.lastIndexOf('/');
  if (cut <= 0) {
    throw new CrucibleUninstallError(
      'uninstall_home_unreadable',
      `"${configPath}" is not a path with a directory in it, so the Crucible home it names cannot `
      + 'be read out of it.',
    );
  }
  return normalised.slice(0, cut);
}

/** The same, on the machine this process runs on. */
function nativeHome(configPath: string): string {
  return guestHome(configPath);
}

/** The flags one run carries, spelled once so the dry run and the real run agree. */
export function uninstallArgv(
  target: CrucibleUninstallTarget,
  options: { dryRun: boolean; purgeWeights: boolean; wslToo: boolean },
): string[] {
  const argv = [...target.argv, 'uninstall', '--json'];
  if (options.dryRun) argv.push('--dry-run');
  if (options.purgeWeights) argv.push('--purge-weights');
  /*
   * `--wsl-too` IS A HOST FLAG AND NOTHING ELSE. It tells the WINDOWS CLI to
   * run the guest's own uninstall first, with the same flags. Sending it to
   * the guest's CLI would be asking a distro to reach into itself, and sending
   * it on a Mac names a thing that is not there — so it is refused rather than
   * dropped, because a flag that is silently ignored is a choice a person made
   * that did not happen.
   */
  if (options.wslToo) {
    if (target.kind !== 'host') {
      throw new CrucibleUninstallError(
        'uninstall_wsl_too_needs_host',
        '"also remove the WSL2 engine" is a flag of the WINDOWS host\'s CLI: it runs the guest\'s '
        + `own uninstall first, with the same flags. This machine's Crucible is being uninstalled `
        + `through ${target.describe}, which is ${target.kind === 'guest' ? 'already inside the guest' : 'not a Windows host'}.`,
      );
    }
    argv.push('--wsl-too');
  }
  return argv;
}

/**
 * RUN IT, dry or for real, and answer the plan the CLI printed.
 *
 * `onLine` is optional and exists for the real run: a person watching twelve
 * gigabytes disappear wants to see it happening. The dry run answers in a
 * second and needs none.
 */
export async function crucibleUninstall(
  server: string,
  options: { dryRun: boolean; purgeWeights: boolean; wslToo: boolean },
  runner: Runner,
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  /** See {@link crucibleUninstallTarget}. Nothing in the app passes this. */
  readLocal?: () => LocalServer,
): Promise<CrucibleUninstallPlan> {
  const target = readLocal === undefined
    ? crucibleUninstallTarget(server, runner)
    : crucibleUninstallTarget(server, runner, getWslDistro(), readLocal);
  const argv = uninstallArgv(target, options);
  const timeoutMs = options.dryRun ? UNINSTALL_DRY_RUN_TIMEOUT_MS : UNINSTALL_RUN_TIMEOUT_MS;
  const result = onLine === undefined
    ? await runner.run(argv, { timeoutMs })
    : await runner.stream(argv, { timeoutMs, onLine });

  if (result.failure !== null) {
    throw new CrucibleUninstallError(
      'uninstall_unrun',
      `${target.describe} could not be run: ${result.failure}`,
      { detail: result.stderr.trim() === '' ? undefined : result.stderr },
    );
  }

  /*
   * ARGPARSE'S "invalid choice" IS A VERSION FACT, and the one sentence this
   * file translates. Exit 2 with that phrase means the CLI on this machine
   * predates the verb; every other non-zero exit is Crucible's own answer and
   * is read out of the JSON below, because `crucible uninstall` prints its
   * plan even when a step refused.
   */
  if (result.code === 2 && /invalid choice: ['"]?uninstall/.test(result.stderr)) {
    throw new CrucibleUninstallError(
      'uninstall_not_available',
      `the Crucible at ${target.describe} predates \`crucible uninstall\` and has no such verb. `
      + 'Upgrade that engine and the door works; until then it is removed the way it was '
      + 'installed.',
      { detail: result.stderr.trim() },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CrucibleUninstallError(
      'uninstall_unreadable',
      `${target.describe} answered something that is not the --json document this door reads.`,
      { detail: `exit ${String(result.code)}; ${result.stdout.slice(0, 2000)}${result.stderr.slice(0, 2000)}` },
    );
  }
  return readUninstallPlan(parsed, target);
}

/**
 * The CLI's `--json` document, checked field by field.
 *
 * NOTHING IS DEFAULTED. A document missing `steps` is not an uninstall with no
 * steps — it is a document this app cannot read, and saying so names the
 * version skew instead of drawing an empty list that looks like success.
 */
export function readUninstallPlan(parsed: unknown, target: CrucibleUninstallTarget): CrucibleUninstallPlan {
  const doc = parsed as Record<string, unknown>;
  const require_ = <T>(field: string, ok: (value: unknown) => boolean, what: string): T => {
    if (!ok(doc[field])) {
      throw new CrucibleUninstallError(
        'uninstall_unreadable',
        `the uninstall document's \`${field}\` is not ${what}. This app reads the shape `
        + '`crucible uninstall --json` prints, and that is not it.',
        { detail: JSON.stringify(doc[field]) },
      );
    }
    return doc[field] as T;
  };
  const isString = (v: unknown): boolean => typeof v === 'string';
  const isBool = (v: unknown): boolean => typeof v === 'boolean';

  const rawSteps = require_<unknown[]>('steps', Array.isArray, 'a list');
  const steps = rawSteps.map((raw, index) => {
    const step = raw as Record<string, unknown>;
    for (const field of ['name', 'what', 'action', 'target'] as const) {
      if (typeof step[field] !== 'string') {
        throw new CrucibleUninstallError(
          'uninstall_unreadable',
          `step ${index} of the uninstall document has no \`${field}\`.`,
          { detail: JSON.stringify(step) },
        );
      }
    }
    if (typeof step['done'] !== 'boolean') {
      throw new CrucibleUninstallError(
        'uninstall_unreadable',
        `step ${index} of the uninstall document has no \`done\`.`,
        { detail: JSON.stringify(step) },
      );
    }
    const refused = step['refused'] as Record<string, unknown> | undefined;
    return {
      name: step['name'] as string,
      what: step['what'] as string,
      action: step['action'] as string,
      target: step['target'] as string,
      done: step['done'] as boolean,
      // `bytes` is absent where the target is not a path (a unit, a pid, a
      // distro), and absent is NOT zero — so it stays null and a screen shows
      // no size rather than "0 B".
      bytes: typeof step['bytes'] === 'number' ? step['bytes'] : null,
      refused: refused === undefined ? null : {
        code: String(refused['code']),
        message: String(refused['message']),
        fatal: refused['fatal'] === true,
      },
      detail: Array.isArray(step['detail']) ? (step['detail'] as unknown[]).map(String) : [],
    };
  });

  const kept = require_<Record<string, unknown>>('kept', (v) => typeof v === 'object' && v !== null, 'an object');
  if (typeof kept['weights_bytes'] !== 'number' || !Array.isArray(kept['paths'])) {
    throw new CrucibleUninstallError(
      'uninstall_unreadable',
      'the uninstall document\'s `kept` block has no `weights_bytes` and `paths`.',
      { detail: JSON.stringify(kept) },
    );
  }

  return {
    ranThrough: target.describe,
    through: target.kind,
    dryRun: require_<boolean>('dry_run', isBool, 'a boolean'),
    home: require_<string>('home', isString, 'a string'),
    platform: require_<string>('platform', isString, 'a string'),
    mechanism: require_<string>('mechanism', isString, 'a string'),
    backendKind: typeof doc['backend_kind'] === 'string' ? doc['backend_kind'] : null,
    purgeWeights: require_<boolean>('purge_weights', isBool, 'a boolean'),
    wslToo: require_<boolean>('wsl_too', isBool, 'a boolean'),
    ok: require_<boolean>('ok', isBool, 'a boolean'),
    removedBytes: typeof doc['removed_bytes'] === 'number' ? doc['removed_bytes'] : 0,
    keptWeightsBytes: kept['weights_bytes'] as number,
    keptPaths: (kept['paths'] as unknown[]).map(String),
    steps,
  };
}

/** Any failure of this door, as the renderer's one refusal shape. */
export function uninstallRefusalOf(err: unknown): {
  code: CrucibleUninstallRefusalCode; message: string; command: string | null; detail: string | null;
} {
  if (err instanceof CrucibleUninstallError) return err.toRefusal();
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'uninstall_failed', message: `uninstall_failed: ${message}`, command: null, detail: null };
}
