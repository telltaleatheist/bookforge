/**
 * SPAWNING THE WINDOWS HOST'S `crucible.cmd` — the one thing
 * `@crucible/bootstrap`'s own runner cannot do from Electron.
 *
 * ── THE BUG THIS EXISTS FOR, MEASURED ──────────────────────────────────────
 *
 * Node's fix for CVE-2024-27980 (the BatBadBut command-injection hole) makes
 * `child_process.spawn` REFUSE a `.cmd` or `.bat` target outright unless the
 * call asks for a shell: it throws `EINVAL` before the process exists. The
 * package's `processRunner()` calls `spawn(argv[0], argv.slice(1))` with no
 * `shell` and no `windowsVerbatimArguments` — correct for every target it was
 * written for (`wsl.exe`, `curl`, a console script beside an interpreter) and
 * fatal for exactly one: `%LOCALAPPDATA%\Crucible\host\crucible.cmd`, which is
 * the host pack's entry point (crucible PHASE15-HOST.md §4.4) and therefore
 * the only Crucible CLI a Windows machine has.
 *
 * Measured by Foundry on this same PC, on Electron 33's Node. So this is not a
 * precaution: the first real press of "Remove the engine from this computer"
 * would have thrown `EINVAL` with nothing on screen about batch files.
 *
 * ── AND MEASURED AGAIN HERE, AGAINST A REAL `.cmd` (2026-09-15) ────────────
 *
 * A scratch `crucible.cmd` in a directory with a SPACE in its name, driven
 * through this file's own runner rather than a mock:
 *
 *   bare `spawn(cmd, ['uninstall','--json'])`  ->  `EINVAL: spawn EINVAL`
 *   `crucibleProcessRunner().run(...)`         ->  exit 7 (the script's own),
 *                                                  stdout captured, no failure
 *   `.stream(...)`                             ->  three lines, in order
 *   a non-`.cmd` target                        ->  the package's runner, exit 0
 *
 * ONE THING THAT SURPRISES A READER AND IS CORRECT. The batch script sees its
 * arguments still quoted — `%1` is `"uninstall"`, not `uninstall`. That is
 * what cmd.exe does with a quoted token, and it is harmless for the target
 * this exists for: `crucible.cmd` is a console-script shim that forwards `%*`
 * to a real `.exe`, and the C runtime strips those quotes as it builds that
 * process's argv. It is the same thing `npm.cmd` and `npx.cmd` do. A batch
 * file that compared `%1` to a bare word WOULD see the quotes — which is why
 * this form is used for the host's shim and is not a general spawn policy.
 *
 * ── WHY NOT `shell: true` ──────────────────────────────────────────────────
 *
 * Because `shell: true` hands the WHOLE line to `cmd.exe` after Node has built
 * it by string concatenation, which is the injection hole the CVE is about. A
 * path or a flag carrying `&`, `|` or `^` would run as a command. Building the
 * line HERE, quoting every token, and telling libuv not to touch it is the
 * same thing done deliberately instead of by accident.
 *
 * ── THE FORM, AND WHY EACH FLAG IS THERE ───────────────────────────────────
 *
 *   cmd.exe /d /s /c ""<program>" "<arg>" "<arg>""
 *
 * - `/d` skips AutoRun — a `HKCU\...\Command Processor\AutoRun` value on
 *   somebody's machine would otherwise run before the uninstall and its output
 *   would land in the JSON this app parses.
 * - `/c` runs the line and exits.
 * - `/s` makes the quoting rule ONE rule instead of cmd's legacy heuristics:
 *   with `/s`, if the first and last characters of the rest of the line are
 *   both quotes, cmd strips exactly those two and takes everything between
 *   them verbatim. That is why the whole line is wrapped in an OUTER pair and
 *   every token in its own INNER pair: after the strip, cmd sees a quoted
 *   program followed by quoted arguments, and no token can be re-split on a
 *   space or read as an operator.
 * - `windowsVerbatimArguments` because libuv would otherwise escape the quotes
 *   this line is made of, and the line would arrive at cmd.exe as literal
 *   backslash-quote pairs.
 *
 * ── AND THE TOKENS THAT ARE REFUSED RATHER THAN ESCAPED ────────────────────
 *
 * A `"` cannot survive this form: the outer/inner pairs are the structure, and
 * a quote inside a token is indistinguishable from the end of one. A `%` is
 * expanded by cmd.exe as it reads the line, so `C:\Users\%USERNAME%x\…` would
 * be silently rewritten into some other path. Both are refused BY NAME
 * (`uninstall_bad_path`) rather than escaped, because an escape that is nearly
 * right is how a path becomes a different path and an uninstall deletes the
 * wrong directory. `LOCALAPPDATA` is read from the environment and never
 * assembled, so a `"` or `%` in it is a machine this app will not act on
 * blind.
 */

import { spawn } from 'child_process';

import {
  decodeWslBytes,
  incompleteTailBytes,
  processRunner,
  splitLines,
} from '@crucible/bootstrap';
import type { OutputStream, RunOptions, RunResult, Runner, StreamOptions } from '@crucible/bootstrap';

import { CrucibleUninstallError } from './uninstall';

/** The two extensions Windows runs through the command processor. */
export const SHELL_SCRIPT_EXTENSIONS = ['.cmd', '.bat'] as const;

/** What a token may not contain. See the header: refused, never escaped. */
const FORBIDDEN = /["%\r\n\u0000]/;

/**
 * HOW ONE argv IS ACTUALLY SPAWNED on this platform.
 *
 * A pure function, separate from the runner, because it is the thing a keeper
 * can assert about without spawning anything: a `.cmd` target must come out as
 * `cmd.exe /d /s /c …`, and everything else must come out untouched.
 */
export interface CrucibleSpawnPlan {
  program: string;
  args: string[];
  /**
   * True only for the cmd.exe form. When true the args are ALREADY the exact
   * characters cmd.exe must receive and libuv must not re-quote them.
   */
  verbatim: boolean;
}

/** Does this target have to go through the command processor? */
export function needsCommandProcessor(program: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const lower = program.toLowerCase();
  return SHELL_SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * The spawn plan for one argv, or a refusal naming the token that cannot be
 * carried.
 *
 * NOTHING IS REWRITTEN FOR A NON-`.cmd` TARGET. `wsl.exe`, a guest binary and
 * a Mac's console script are spawned exactly as the package spawns them today
 * — this is a fix for one target, not a new spawn policy for every target.
 */
export function crucibleSpawnPlan(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): CrucibleSpawnPlan {
  const program = argv[0];
  if (program === undefined) {
    throw new CrucibleUninstallError(
      'uninstall_bad_path',
      'an empty argv reached the runner, so there is no program to run and nothing to name.',
    );
  }
  if (!needsCommandProcessor(program, platform)) {
    return { program, args: [...argv.slice(1)], verbatim: false };
  }
  for (const token of argv) {
    if (FORBIDDEN.test(token)) {
      throw new CrucibleUninstallError(
        'uninstall_bad_path',
        `"${token}" cannot be passed to the Windows command processor: it contains a quote, a `
        + 'percent sign or a line break. A quote is indistinguishable from the end of a token in '
        + "cmd.exe's quoting, and a percent sign is expanded as the line is read — so a path "
        + 'carrying either would become a DIFFERENT path, and this command deletes directories. '
        + 'It is refused rather than escaped.',
        {
          detail:
            'LOCALAPPDATA is read from the environment and never assembled from a username, so '
            + 'this is a fact about the machine rather than about the app.',
        },
      );
    }
  }
  const line = argv.map((token) => `"${token}"`).join(' ');
  return { program: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * The runner BookForge hands `@crucible/bootstrap` and its own uninstall door.
 *
 * Everything except the win32 `.cmd` case is the package's own
 * `processRunner()`, unchanged — one owner for the WSL UTF-16 handling, the
 * timeouts and the refusals. The `.cmd` case is spawned here because the
 * package's `launch` has no way to ask for `windowsVerbatimArguments`, and the
 * decoding it needs is the package's own exported helpers rather than a second
 * copy: a chunk that ends mid-character is held, not turned into U+FFFD.
 */
export function crucibleProcessRunner(): Runner {
  const base = processRunner();
  return {
    ...base,
    run: (argv, options) => {
      const plan = crucibleSpawnPlan(argv, base.platform);
      return plan.verbatim ? launchVerbatim(plan, options) : base.run(argv, options);
    },
    stream: (argv, options) => {
      const plan = crucibleSpawnPlan(argv, base.platform);
      return plan.verbatim ? launchVerbatim(plan, options, options.onLine) : base.stream(argv, options);
    },
  };
}

/**
 * One `cmd.exe /d /s /c` run, collected and optionally streamed.
 *
 * NEVER THROWS, because the `Runner` contract says so: a spawn that could not
 * happen and a process that timed out both come back as a `RunResult` with
 * `failure` set, and the caller names the refusal. The one thing that DOES
 * throw is {@link crucibleSpawnPlan}, before this is reached, because a token
 * that cannot be carried is a refusal about the machine and not a failed run.
 */
function launchVerbatim(
  plan: CrucibleSpawnPlan,
  options: RunOptions,
  onLine?: StreamOptions['onLine'],
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const pending: Record<OutputStream, string> = { stdout: '', stderr: '' };
    const carry: Record<OutputStream, Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let settled = false;

    const child = (() => {
      try {
        return spawn(plan.program, plan.args, {
          cwd: options.cwd,
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        });
      } catch (spawnError) {
        resolve({ code: null, stdout: '', stderr: '', failure: (spawnError as Error).message });
        return null;
      }
    })();
    if (child === null) return;

    const timer = setTimeout(() => {
      child.kill();
      finish(null, `timed out after ${options.timeoutMs} ms`);
    }, options.timeoutMs);

    const finish = (code: number | null, failure: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onLine !== undefined) {
        for (const stream of ['stdout', 'stderr'] as const) {
          // Whatever was held back is decoded now: the process is gone, so
          // there is no next chunk to complete it, and a truncated last line
          // is still what it said.
          const tail = carry[stream].length === 0 ? '' : decodeWslBytes(carry[stream]);
          const text = pending[stream] + tail;
          if (text.trim().length > 0) onLine(text, stream);
        }
      }
      resolve({
        code,
        stdout: decodeWslBytes(Buffer.concat(out)),
        stderr: decodeWslBytes(Buffer.concat(err)),
        failure,
      });
    };

    const take = (chunk: Buffer, stream: OutputStream): void => {
      (stream === 'stdout' ? out : err).push(chunk);
      if (onLine === undefined) return;
      const whole = carry[stream].length === 0 ? chunk : Buffer.concat([carry[stream], chunk]);
      const hold = incompleteTailBytes(whole);
      carry[stream] = hold === 0 ? Buffer.alloc(0) : Buffer.from(whole.subarray(whole.length - hold));
      const usable = hold === 0 ? whole : whole.subarray(0, whole.length - hold);
      const split = splitLines(pending[stream] + decodeWslBytes(usable));
      pending[stream] = split.rest;
      for (const line of split.lines) if (line.trim().length > 0) onLine(line, stream);
    };

    child.stdout?.on('data', (chunk: Buffer) => take(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => take(chunk, 'stderr'));
    child.on('error', (childError) => finish(null, childError.message));
    child.on('close', (code) => finish(code, null));
  });
}
