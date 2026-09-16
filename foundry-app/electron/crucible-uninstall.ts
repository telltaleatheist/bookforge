/** Preview and perform the installed Crucible runtime's own uninstall plan. */
import { localUninstallCommand, processRunner, readLocalInstallation } from '@crucible/bootstrap';
import { pairingFileRead } from './crucible-pairing';
import { crucibleServers } from './crucible-registry';
import { hosted } from './host';
import type {
  CrucibleUninstallAvailability,
  CrucibleUninstallCode,
  CrucibleUninstallFlags,
  CrucibleUninstallKept,
  CrucibleUninstallPlan,
  CrucibleUninstallRefusal,
  CrucibleUninstallStep,
  CrucibleUninstallVia,
} from '../shared/uninstall-wire';

/**
 * A dry run reads a few directories and sums them; a real run stops a service
 * and deletes them. Two ceilings, because one number that fitted both would
 * either cut a real uninstall off mid-delete or leave a door spinning for ten
 * minutes on a listing that hung. (`runCommand` in crucible-registry.ts stops at
 * 20 seconds, which is right for `wsl.exe -l -v` and wrong for both of these —
 * which is why this module spawns its own.)
 */
const DRY_RUN_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 600_000;
/**
 * A refusal by one of the agreed names — see `CrucibleUninstallCode`.
 *
 * NAME FIRST, THEN THE SENTENCE. The name is the thing to search for and is the
 * same word BookForge uses for the same situation; the sentence is what a person
 * reads. Nothing here translates one of the CLI's own step refusals, which
 * arrive inside the plan in the engine's words and stay there.
 */
function refuse(code: CrucibleUninstallCode, sentence: string): Error {
  return new Error(`${code} — ${sentence}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// May the door be drawn
// ─────────────────────────────────────────────────────────────────────────────

/** What this machine would run, and why there is nothing to run when there is not. */
interface Invocation {
  via: CrucibleUninstallVia;
  /** The distro, on the `wsl-guest` arm only. */
  distro: string | null;
}

/**
 * THE ONE ANSWER, and the door and both runs all read it — see the header.
 *
 * It asks the two questions in the order that costs least: what is ON this
 * machine (a file test, and one `wsl.exe` call only on the arm that needs it),
 * then what PROVED the server is this machine's.
 */
export async function crucibleUninstallAvailability(): Promise<CrucibleUninstallAvailability> {
  if (hosted()) return refused('uninstall_not_local',
    'Remove Crucible from the application managing this installation.');
  try {
    const invocation = await resolveInvocation();
    const pairing = await pairingFileRead();
    const row = pairing.found === 'pairing'
      ? crucibleServers().find((entry) => entry.url === pairing.pairing.url && entry.token === pairing.pairing.token)
      : undefined;
    return {
      available: true, proof: 'installation-record', via: invocation.via,
      server: row?.name ?? null, code: null,
      wslTooOffered: invocation.via === 'windows-host',
      why: 'Crucible published its local installation and uninstall controls on this computer.',
    };
  } catch (err) {
    return refused(codeOf(err), sentenceOf(err));
  }
}
function refused(code: CrucibleUninstallCode, why: string): CrucibleUninstallAvailability {
  return { available: false, why, proof: null, via: null, server: null, code, wslTooOffered: false };
}

/**
 * WHAT THIS MACHINE WOULD RUN — §6.2's three lines, in the order the contract
 * puts them on Windows: *"The Windows host manages the guest, so the Windows
 * side goes last in both directions."* The host pack is therefore asked about
 * first, and the guest is the arm for a machine that has Crucible in WSL and no
 * host yet — which is the machine Foundry's door 2 exists for.
 */
/**
 * WHERE CRUCIBLE IS ON THIS COMPUTER, and how this app would invoke it.
 *
 * Exported since 2026-09-15 because the START door needs the same answer the
 * uninstall door needs, and the question *"is there a Crucible on this machine
 * and where"* must have ONE answer. Two locators would eventually disagree
 * about a machine that has the Windows host pack AND a WSL guest — and the
 * order they are tested in IS the answer (the host pack wins, because on such a
 * machine the tray is what owns the engine).
 *
 * IT THROWS FOR "THERE IS NONE", which reads oddly beside a boolean but is the
 * shape both callers want: the refusal carries the SENTENCE naming which of the
 * four silences it was — no %LOCALAPPDATA%, no distro named, no Crucible in the
 * named guest, no server pack — and a caller that offered to install one would
 * otherwise have to re-derive which.
 */
export { resolveInvocation as locateCrucible };
export type { Invocation as CrucibleInvocation };

async function resolveInvocation(): Promise<Invocation> {
  const installed = readLocalInstallation();
  if (installed === null) throw refuse('uninstall_not_available',
    'No local installation record exists. Repair or update Crucible before removing it here.');
  return { via: installed.platform === 'win32' ? 'windows-host' : 'server-pack', distro: null };
}
// ─────────────────────────────────────────────────────────────────────────────
// The two runs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The plan, unperformed — §6.4 step 1. Nothing is touched.
 *
 * The door calls this again every time a checkbox moves, which is the contract's
 * own instruction: *"a checkbox for `--purge-weights` that re-runs the dry run so
 * the number moves."* There is no second description of the work to keep in step
 * because the dry run IS the work, unperformed.
 */
export function crucibleUninstallDryRun(
  flags: CrucibleUninstallFlags,
): Promise<CrucibleUninstallPlan> {
  return invokeUninstall(flags, true);
}

/** The same flags, performed — §6.4 step 2. */
export function crucibleUninstallPerform(
  flags: CrucibleUninstallFlags,
): Promise<CrucibleUninstallPlan> {
  return invokeUninstall(flags, false);
}

/**
 * DID THIS RUN STOP THE ENGINE a registry row was pointing at?
 *
 * §2's box: *"THE TOKEN ALWAYS GOES, on every uninstall, including the default
 * one"* — `remove-config` is unconditional — so a run that got as far as
 * stopping the server has left every paired app holding a dead credential. That
 * is the moment the row goes, and it is read off the PLAN rather than assumed
 * from the exit code, because a fatal `stop_failed` is a run where the other
 * steps happened and the server did not stop.
 *
 * `wsl-guest` counts as well: on Owen's PC the engine that row points at is
 * inside the guest, and `--wsl-too` is what stops that one.
 */
export function uninstallStoppedTheEngine(plan: CrucibleUninstallPlan): boolean {
  return plan.steps.some(
    (step) => (step.name === 'stop-engine' || step.name === 'wsl-guest') && step.done,
  );
}

async function invokeUninstall(
  flags: CrucibleUninstallFlags,
  dryRun: boolean,
): Promise<CrucibleUninstallPlan> {
  const availability = await crucibleUninstallAvailability();
  if (!availability.available || availability.via === null) {
    throw refuse(availability.code ?? 'uninstall_not_local', availability.why);
  }
  if (flags.wslToo && !availability.wslTooOffered) {
    throw refuse(
      'uninstall_wsl_too_needs_host',
      'only Crucible\'s Windows host removes the engine inside the WSL guest, and it is not '
      + 'installed on this computer',
    );
  }

  const command = localUninstallCommand({ dryRun, purgeWeights: flags.purgeWeights, wslToo: flags.wslToo });
  const result = await processRunner().run(command.argv, {
    timeoutMs: dryRun ? DRY_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS,
    env: command.env, cwd: command.cwd,
  });
  if (result.failure !== null) {
    throw refuse('uninstall_unrun', `Crucible's uninstall ${result.failure}.`);
  }
  /*
   * §6.2's EXIT CODES, AND ONE OF THEM IS NOT A FAILURE. `1` is *"a step did"*
   * fail and is STILL A PLAN — the JSON's `ok: false` names which one, the other
   * steps happened, and a rejection there would tell somebody nothing happened
   * when most of it did. `2` is usage, which means the CLI on this machine
   * predates the verb, so it is `uninstall_not_available` rather than a
   * complaint about this app's argv. Any other non-zero code that still printed
   * a document is parsed too, for the same reason `1` is.
   */
  if (result.code === 2) {
    throw refuse(
      'uninstall_not_available',
      'the Crucible installed on this computer does not have an uninstall command — it is an '
      + `older build than this door needs${said(result.stderr)}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw result.code === 0
      ? refuse('uninstall_unreadable', 'Crucible\'s uninstall printed nothing at all.')
      : refuse(
        'uninstall_failed',
        `Crucible's uninstall ended with code ${String(result.code)} and printed no plan`
        + `${said(result.stderr)}`,
      );
  }
  return readUninstallDocument(result.stdout);
}

function said(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/)[0] ?? '';
  return line.length === 0 ? '.' : `: ${line}`;
}

function codeOf(err: unknown): CrucibleUninstallCode {
  const message = err instanceof Error ? err.message : String(err);
  const name = message.split(' — ')[0] ?? '';
  return name.startsWith('uninstall_') ? name as CrucibleUninstallCode : 'uninstall_not_available';
}

function sentenceOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const parts = message.split(' — ');
  return parts.length > 1 ? parts.slice(1).join(' — ') : message;
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE JSON DOCUMENT, read into Foundry's wire — §6.3.
 *
 * STRICT ABOUT FIELDS, OPEN ABOUT VALUES, which is the split BookForge and
 * Foundry agreed on 2026-09-15 so that one plan reads the same in both apps:
 *
 *   - a field the doc says is always there and is NOT there is
 *     `uninstall_unreadable`. A plan with an invented `ok`, or an invented
 *     `kept.weights_bytes`, is a plan that says the wrong thing about a machine
 *     somebody is about to change;
 *   - a field the doc says is OPTIONAL arrives as null and means what §6.3 says
 *     it means — an absent `bytes` is *"the target is not a path"*, not zero;
 *   - an unknown STEP NAME or action word is carried through as a string and
 *     DRAWN. Nothing in this app switches on one, because two of §6.3's name
 *     shapes are open-ended (the catalog kinds are the server's list, and
 *     `keep-unknown:` names a file Crucible did not write).
 *
 * Exported so it can be proved against a hand-written document: a fatal refusal
 * and a `keep` step are two arms a clean machine never produces.
 */
export function readUninstallDocument(text: string): CrucibleUninstallPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch (error) {
    throw refuse(
      'uninstall_unreadable',
      `Crucible's uninstall did not print a plan this app can read `
      + `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const doc = asObject(parsed, 'the plan');
  const steps = doc['steps'];
  if (!Array.isArray(steps)) {
    throw refuse('uninstall_unreadable', 'Crucible\'s uninstall printed a plan with no steps in it.');
  }
  return {
    dryRun: needBoolean(doc, 'dry_run'),
    home: needString(doc, 'home'),
    platform: needString(doc, 'platform'),
    mechanism: needString(doc, 'mechanism'),
    backendKind: needNullableString(doc, 'backend_kind'),
    purgeWeights: needBoolean(doc, 'purge_weights'),
    wslToo: needBoolean(doc, 'wsl_too'),
    steps: steps.map(readStep),
    kept: readKept(doc['kept']),
    removedBytes: needNumber(doc, 'removed_bytes'),
    ok: needBoolean(doc, 'ok'),
  };
}

function readStep(raw: unknown): CrucibleUninstallStep {
  const row = asObject(raw, 'a step');
  return {
    name: needString(row, 'name'),
    what: needString(row, 'what'),
    action: needString(row, 'action'),
    target: needString(row, 'target'),
    // OPTIONAL, and absent is null rather than 0 — §6.3, and see the module note.
    bytes: typeof row['bytes'] === 'number' && Number.isFinite(row['bytes'])
      ? row['bytes']
      : null,
    done: needBoolean(row, 'done'),
    refused: readRefusal(row['refused']),
    detail: Array.isArray(row['detail'])
      ? row['detail'].filter((line): line is string => typeof line === 'string')
      : null,
  };
}

function readRefusal(raw: unknown): CrucibleUninstallRefusal | null {
  if (raw === undefined || raw === null) return null;
  const row = asObject(raw, 'a refusal');
  return {
    code: needString(row, 'code'),
    message: needString(row, 'message'),
    fatal: needBoolean(row, 'fatal'),
  };
}

function readKept(raw: unknown): CrucibleUninstallKept {
  const row = asObject(raw, 'what the plan keeps');
  const paths = row['paths'];
  if (!Array.isArray(paths)) {
    throw refuse('uninstall_unreadable', 'Crucible\'s uninstall printed no list of kept paths.');
  }
  return {
    weightsBytes: needNumber(row, 'weights_bytes'),
    paths: paths.filter((entry): entry is string => typeof entry === 'string'),
  };
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw refuse('uninstall_unreadable', `Crucible's uninstall printed ${what} in a shape this app cannot read.`);
  }
  return raw as Record<string, unknown>;
}

function needBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw missing(key);
  return value;
}

function needString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw missing(key);
  return value;
}

function needNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw missing(key);
  return value;
}

function needNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw missing(key);
  return value;
}

function missing(key: string): Error {
  return refuse(
    'uninstall_unreadable',
    `Crucible's uninstall printed a plan with no readable "${key}" in it, so Foundry cannot say `
    + 'what it would do.',
  );
}
