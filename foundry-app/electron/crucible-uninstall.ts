/**
 * crucible-uninstall — "Remove the engine from this computer", and the two
 * questions it is made of: may this app draw the door at all, and what does the
 * verb say.
 *
 * ── THE RULING THIS FILE EXISTS TO ENFORCE ─────────────────────────────────
 *
 * Owen, through crucible `docs/INSTALL-UNINSTALL.md` §6.1: **the door only for a
 * server the app can PROVE is this machine's; never a registry entry.** The
 * contract's own words: *"A `crucible://` connect code in an app's server list
 * says where a server is and what its token is. It does not say whose machine it
 * is on, and a loopback-looking address proves nothing — a tailnet, a
 * port-forward or an SSH tunnel all put `127.0.0.1:7100` in front of somebody
 * else's card. An app that offered Uninstall on a registry row would eventually
 * offer to delete a colleague's engine, and there is no confirmation dialog that
 * makes that safe."*
 *
 * So {@link crucibleUninstallAvailability} is the ONE function that decides, the
 * doors component asks it before it draws anything, and both run doors refuse on
 * it as well — a hidden control over an open door is a decoration, which is the
 * argument `crucible:install` already makes one family along.
 *
 * ── TWO QUESTIONS, NOT ONE: WHAT PROVED IT, AND WHAT WILL RUN ──────────────
 *
 * They have different answers on the same machine and both are in the answer.
 * Owen's PC is proved by its PAIRING FILE (the line the WSL guest left, whose
 * url and token are the ones a registry entry holds) and the work is done by the
 * HOST PACK's `crucible.cmd`. A single field would have had to pick one of those
 * two facts and throw the other away.
 *
 * `proof` — §6.1's list:
 *   - `pairing-file`, this machine's file, read through the SDK, matching a
 *     registry entry on BOTH url and token. THE NAME IS NEVER PART OF THE
 *     PROOF, and Owen's ruling is why: *"a local crucible server shouldnt be
 *     treated any differently than a remote crucible server"* — a name is
 *     something a person typed and proves nothing about whose machine an engine
 *     is on. The entry may also have been renamed since it was added, which is a
 *     gesture that must not quietly take a door away.
 *   - `windows-host`, the existence of `%LOCALAPPDATA%\Crucible\host\
 *     crucible.cmd` — which is what *"the host is installed"* MEANS (§6.2,
 *     quoting `crucible/host/paths.py`). §6.1 words this proof as "the host this
 *     app can reach at 127.0.0.1:7101"; the FILE is what is read, because §6.2 is
 *     explicit that the host's loopback door was never extended with an
 *     uninstall, so there is no route to knock on and inventing one would be this
 *     app asserting an endpoint the server does not serve. The port stays
 *     informational.
 *   - `wsl-guest`, win32 with no host pack, where Foundry's own door 2 reads a
 *     `config.toml` out of a NAMED distro. A guest on this machine is on this
 *     machine; the distro is the one in settings and there is no default, for
 *     door 2's own reason.
 *
 * §6.1's remaining proof — *"the server this app installed in this session
 * through `@crucible/bootstrap`'s `install()`"* — is NOT implemented and cannot
 * be today: `driveCrucibleInstall` (electron/crucible-install.ts) refuses on
 * every machine because the bootstrap package ships with Crucible's next
 * release, so no session of this app has ever installed a server and there is no
 * state for this proof to read. It becomes real in the same change that turns
 * that door on, and not before.
 *
 * Hosted, inside BookForge, there is no proof at all and none is looked for: the
 * registry is somebody else's list about possibly somebody else's machine.
 *
 * ── WHAT IS INVOKED, PER §6.2, AND WHY WINDOWS NEEDS A SHELL AFTER ALL ─────
 *
 *   win32 + host pack   %LOCALAPPDATA%\Crucible\host\crucible.cmd uninstall --json …
 *   win32 + the guest   wsl.exe -d <distro> --exec bash -c '<guest home>/server/bin/crucible …'
 *   darwin / linux      ${CRUCIBLE_HOME:-$HOME/.crucible}/server/bin/crucible uninstall --json …
 *
 * `LOCALAPPDATA` is READ from the environment and never assembled from a
 * username — the contract says so and so does the SDK's pairing reader.
 *
 * **A `.cmd` CANNOT BE SPAWNED WITHOUT A SHELL ON THIS NODE, AND THAT IS
 * MEASURED, NOT ASSUMED.** Node 20.19.5 and Electron 33's Node both carry the
 * CVE-2024-27980 fix, which makes `spawn('…\\crucible.cmd', argv)` throw
 * `EINVAL` outright — verified on this machine before this file was written. So
 * the win32 host arm takes the documented fallback: `cmd.exe /d /s /c
 * "<quoted>"` with `windowsVerbatimArguments`, which is what Node's own
 * `shell: true` builds, except that the command line is assembled HERE from an
 * argv array so nothing a person typed can reach it. Every token is
 * double-quoted; the flags are literals and the only variable is the path out of
 * `%LOCALAPPDATA%`, refused by name if it carries a `"` or a `%` that cmd would
 * read as syntax rather than as a folder.
 *
 * The WSL arm goes through `bash -c` with a FIXED script for the same reason
 * `addLocalCrucible` does (crucible-registry.ts): the guest has to expand
 * `${CRUCIBLE_HOME:-$HOME/.crucible}` itself, and only the guest knows it. The
 * distro travels as its own argv token and never enters the script.
 *
 * > **The measured gotcha, §4, and it will show in the plan.** The WSL user bus
 * > is unreachable from a `wsl.exe --exec` session, so `stop-engine` inside the
 * > guest may come back refused `stop_failed` — fatal, `ok: false`, and *"the
 * > other nine steps still run"*. The door draws that as one red row, which is
 * > exactly what §6.3 asks for.
 *
 * ── THE WRAPPER IS NOT CALLED FROM HERE, EVER ──────────────────────────────
 *
 * §6.2: *"An app that needs a machine-readable answer calls the verb; an app
 * that wants the machine clean runs the wrapper."* Foundry needs the answer, so
 * it calls the verb and says in the door's own last line that the pack and the
 * home stay — quoting the plan's own `pack:server` / `pack:host` row, which
 * already names itself as kept and says why.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { readAppSettings } from './app-settings';
import { pairingFileRead } from './crucible-pairing';
import { crucibleServers } from './crucible-registry';
import { hosted } from './host';
import type {
  CrucibleUninstallAvailability,
  CrucibleUninstallCode,
  CrucibleUninstallFlags,
  CrucibleUninstallKept,
  CrucibleUninstallPlan,
  CrucibleUninstallProof,
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
/** One cold `wsl.exe` call, which is the only cost of the guest proof. */
const PROBE_TIMEOUT_MS = 30_000;

/** The guest's own path to its server pack, expanded BY THE GUEST — see header. */
const GUEST_CRUCIBLE = '"${CRUCIBLE_HOME:-$HOME/.crucible}/server/bin/crucible"';

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
  /*
   * HOSTED, THERE IS NOTHING TO PROVE AND NOTHING TO PROVE IT WITH. The server
   * list belongs to the application this window runs inside; its rows may point
   * at a machine down the hall. §6.1's rule is about which rows get the button,
   * and hosted the honest answer is "none of them, here".
   */
  if (hosted()) {
    return refused(
      'uninstall_not_local',
      'Foundry is running inside another application, and the engines it lists belong to that '
      + 'application. Remove Crucible from the computer the engine is actually on.',
    );
  }

  let invocation: Invocation;
  try {
    invocation = await resolveInvocation();
  } catch (err) {
    return refused(codeOf(err), sentenceOf(err));
  }

  const pairing = await pairingFileRead();
  let proof: CrucibleUninstallProof | null = null;
  let server: string | null = null;
  if (pairing.found === 'pairing') {
    /*
     * BOTH HALVES OR NEITHER. A url match alone would be satisfied by any row
     * that happened to say 127.0.0.1:7100 — which is the tunnel case §6.1 names
     * — and a token match alone would be a row pointing somewhere else with the
     * same secret. Together they say: this registry row and this machine's
     * pairing file are about one server.
     */
    const row = crucibleServers().find(
      (entry) => entry.url === pairing.pairing.url && entry.token === pairing.pairing.token,
    );
    if (row !== undefined) {
      proof = 'pairing-file';
      server = row.name;
    }
  }
  if (proof === null && invocation.via === 'windows-host') proof = 'windows-host';
  if (proof === null && invocation.via === 'wsl-guest') proof = 'wsl-guest';

  if (proof === null) {
    /*
     * A SERVER PACK ON A MAC OR A LINUX BOX IS NOT, BY ITSELF, ONE OF §6.1's
     * PROOFS. The list is closed on purpose, so the posix arm needs the pairing
     * file — which is precisely the thing a Crucible on this machine leaves.
     */
    return refused(
      'uninstall_not_local',
      pairing.found === 'refused'
        ? 'This computer\'s Crucible connect code could not be read, so Foundry cannot tell '
          + `which engine is on this machine (${pairing.message}).`
        : 'Foundry only removes a Crucible it can prove is on this computer, and nothing here '
          + `proves one — no connect code was left at ${pairing.path}.`,
    );
  }

  return {
    available: true,
    proof,
    via: invocation.via,
    server,
    code: null,
    /*
     * ONLY THE HOST DRIVES THE GUEST. §2's order — *"the guest before the tray's
     * service, and after the tray itself"* — is the host's sequence, and the
     * `--wsl-too` flag belongs to the command that can run it. Asked anywhere
     * else it is `uninstall_wsl_too_needs_host`.
     */
    wslTooOffered: invocation.via === 'windows-host',
    why: whyAvailable(proof, server, pairing.path),
  };
}

function whyAvailable(
  proof: CrucibleUninstallProof,
  server: string | null,
  pairingPath: string,
): string {
  if (proof === 'pairing-file') {
    return server === null
      ? `This computer's Crucible left its connect code at ${pairingPath}.`
      : `This computer's Crucible left its connect code at ${pairingPath}, and it is the engine `
        + `registered here as ${server}.`;
  }
  return proof === 'windows-host'
    ? 'The Crucible host is installed on this computer.'
    : 'Crucible is installed in the WSL distribution named in the door above.';
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
async function resolveInvocation(): Promise<Invocation> {
  if (process.platform !== 'win32') {
    const exe = posixServerCommand();
    if (!existsSync(exe)) {
      throw refuse(
        'uninstall_not_available',
        `there is no Crucible to run at ${exe}, so there is nothing here to remove`,
      );
    }
    return { via: 'server-pack', distro: null };
  }

  const local = process.env['LOCALAPPDATA'];
  if (local === undefined || local.trim().length === 0) {
    throw refuse(
      'uninstall_no_localappdata',
      'this Windows session has no %LOCALAPPDATA%, so Foundry cannot say where Crucible would '
      + 'be — and it never assembles that path from a username',
    );
  }
  if (existsSync(windowsHostCommand(local))) return { via: 'windows-host', distro: null };

  /*
   * NO HOST, SO THE GUEST — and the distro is the one somebody named in door 2.
   * There is no default on purpose (door 2's own note): *"the default" is
   * whatever `wsl --set-default` last said*, and the wrong guest is the wrong
   * machine to uninstall Crucible from.
   */
  const distro = readAppSettings().wslDistro.trim();
  if (distro.length === 0) {
    throw refuse(
      'uninstall_no_distro',
      'Crucible\'s host is not installed on the Windows side, and no WSL distribution has been '
      + 'named, so Foundry does not know which guest to look in',
    );
  }
  if (!await guestHasCrucible(distro)) {
    throw refuse(
      'uninstall_not_available',
      `there is no Crucible to run inside the WSL distribution ${distro}`,
    );
  }
  return { via: 'wsl-guest', distro };
}

/** One `wsl.exe` call: does that guest hold a server pack it could run? */
async function guestHasCrucible(distro: string): Promise<boolean> {
  const result = await runProcess(
    'wsl.exe',
    ['-d', distro, '--exec', 'bash', '-c', `test -x ${GUEST_CRUCIBLE} && echo yes`],
    PROBE_TIMEOUT_MS,
    false,
  );
  return result.failure === null && result.code === 0 && result.stdout.includes('yes');
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

  const argv = ['uninstall', '--json'];
  if (dryRun) argv.push('--dry-run');
  if (flags.purgeWeights) argv.push('--purge-weights');
  if (flags.wslToo) argv.push('--wsl-too');

  const timeoutMs = dryRun ? DRY_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;
  const result = await runVia(availability.via, argv, timeoutMs);

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

function runVia(
  via: CrucibleUninstallVia,
  argv: string[],
  timeoutMs: number,
): Promise<CommandOutput> {
  if (via === 'server-pack') return runProcess(posixServerCommand(), argv, timeoutMs, false);
  if (via === 'windows-host') return runWindowsHost(argv, timeoutMs);
  return runWslGuest(argv, timeoutMs);
}

/** `%LOCALAPPDATA%\Crucible\host\crucible.cmd` — §6.2's win32 line. */
function windowsHostCommand(localAppData: string): string {
  return path.join(localAppData, 'Crucible', 'host', 'crucible.cmd');
}

/** `${CRUCIBLE_HOME:-$HOME/.crucible}/server/bin/crucible` — §6.2's posix line. */
function posixServerCommand(): string {
  const home = process.env['CRUCIBLE_HOME'];
  const root = home !== undefined && home.trim().length > 0
    ? home.trim()
    : path.join(homedir(), '.crucible');
  return path.join(root, 'server', 'bin', 'crucible');
}

/**
 * win32 + the host pack — `cmd.exe /d /s /c "<every token quoted>"`, verbatim.
 *
 * See the header for why a shell is here at all. `/d` skips AutoRun (a registry
 * value somebody else's installer may have set), `/s` is what makes cmd strip
 * the outer pair of quotes and take the rest as the command line, and
 * `windowsVerbatimArguments` stops Node from re-quoting what has already been
 * quoted for cmd's own parser.
 */
function runWindowsHost(argv: string[], timeoutMs: number): Promise<CommandOutput> {
  const local = process.env['LOCALAPPDATA'] ?? '';
  const exe = windowsHostCommand(local);
  /*
   * WHAT CMD WOULD READ AS SYNTAX INSIDE QUOTES. A double quote ends the quoted
   * run; a `%` starts an environment expansion, which happens inside quotes as
   * well. Neither has ever been in a Windows profile path, and a folder that
   * held one would be a command line that means something other than what it
   * says — so it is refused by name instead of escaped by guesswork.
   */
  if (exe.includes('"') || exe.includes('%')) {
    // BookForge's name for the same refusal, so the two apps say one thing.
    throw refuse(
      'uninstall_bad_path',
      'this computer\'s %LOCALAPPDATA% contains a quote or a percent sign, which Windows\'s '
      + 'command interpreter reads as syntax, so Crucible\'s uninstall cannot be run from it',
    );
  }
  const line = [exe, ...argv].map((token) => `"${token}"`).join(' ');
  return runProcess('cmd.exe', ['/d', '/s', '/c', `"${line}"`], timeoutMs, true);
}

/**
 * win32 without a host pack — the guest's own verb, through `wsl.exe`.
 *
 * The distro is its own argv token and never enters the script; the script is
 * fixed text plus flags that are literals in this file, so there is nothing in
 * the line a person typed. `--exec bash -c` rather than a bare `--exec` because
 * only the guest can expand its own `CRUCIBLE_HOME` — `addLocalCrucible` reads
 * `config.toml` exactly this way and for exactly this reason.
 */
function runWslGuest(argv: string[], timeoutMs: number): Promise<CommandOutput> {
  const script = [GUEST_CRUCIBLE, ...argv].join(' ');
  const distro = readAppSettings().wslDistro.trim();
  return runProcess(
    'wsl.exe',
    ['-d', distro, '--exec', 'bash', '-c', script],
    timeoutMs,
    false,
  );
}

interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or timed out. Never with a code. */
  failure: string | null;
}

/**
 * One process, its stdout collected as BYTES and decoded once at the end.
 *
 * DECODED ONCE, NOT PER CHUNK, because the thing being read is a single JSON
 * document and a multi-byte character split across two chunks would otherwise
 * become two replacement characters in the middle of a path. (crucible-registry
 * .ts's `runCommand` decodes per chunk on purpose — it is reading `wsl.exe`,
 * which interleaves its OWN UTF-16LE messages with the guest's UTF-8 on one
 * pipe. Here a wsl.exe message is not a plan either way, so the simpler read
 * loses nothing: an undecodable answer is `uninstall_unreadable`.)
 */
function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  verbatim: boolean,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    let settled = false;
    let out = Buffer.alloc(0);
    let err = '';
    const finish = (result: CommandOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        failure: `could not be started (${error instanceof Error ? error.message : String(error)})`,
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({
        code: null,
        stdout: decodeDocument(out),
        stderr: err,
        failure: `did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { out = Buffer.concat([out, chunk]); });
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    child.on('error', (error) => finish({
      code: null,
      stdout: decodeDocument(out),
      stderr: err,
      failure: `could not be started (${error.message})`,
    }));
    child.on('close', (code) => finish({
      code,
      stdout: decodeDocument(out),
      stderr: err,
      failure: null,
    }));
  });
}

/** UTF-8, with the BOM a Windows pipe may put in front of it taken off. */
function decodeDocument(bytes: Buffer): string {
  return bytes.toString('utf8').replace(/^﻿/, '');
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
