/**
 * THE CONNECT CODE THE ENGINE ON THIS MACHINE LEFT FOR AN APP TO FIND.
 *
 * crucible `docs/PHASE15-HOST.md` §3.6 and §5.1. `crucible init`, `crucible
 * service install` and the Windows host write the pairing line to a user-only
 * file on the machine the server runs on, so an app on that machine connects
 * **without anyone typing a token**. That is the first of connect's three
 * ways, and the only one that needs no person.
 *
 * ── WHY THIS IS NOT `@crucible/client`'s `readPairingFile` ─────────────────
 *
 * The SDK grew one on 2026-09-14 and this file did NOT go with the rest of the
 * seam it belonged to (`settings-wire.ts`, deleted the same day). There were
 * TWO reasons. **Reason two is gone** — see below — and ONE remains, dated,
 * with the condition that ends it.
 *
 * **1. The SDK's is ASYNC and this read is on a SYNCHRONOUS path.** The SDK's
 * own header says why it is async, and the reason is a packaging rule rather
 * than anything about the operation: a static `import … from 'node:fs'` would
 * put fs into the module graph of `import {CrucibleClient}` and break a
 * bundler targeting a browser-ish runtime, so its imports are assembled at run
 * time and a dynamic import is a promise. `cruciblePairingPath` is async for
 * the same reason, so even the PATH cannot be had synchronously.
 *
 * BookForge's side of the meeting is the opposite constraint, and it is
 * architectural rather than stylistic: {@link readLocalServer} is synchronous
 * because `servers.ts`'s registry, `routing.ts`'s `readRouting()` and the
 * hosted-Foundry snapshot all are, and `readRouting()` is called inside the
 * queue's synchronous pump (`crucibleAdmission`). `host-registry.ts`'s header
 * sets out what that costs and why it is paid. Making the local-server
 * resolution async is a real refactor of the scheduler's read path; it is not
 * something to do on the way past.
 *
 * **ENDS WHEN:** the local-server resolution becomes async, or the SDK grows a
 * synchronous variant. Then this file is deleted and the callers await.
 *
 * **2. ~~The SDK's path rule does not carry the Windows case~~ — SETTLED
 * 2026-09-14, and this is what it settled to.** It used to be a real
 * divergence: §3.6's table pins `%LOCALAPPDATA%\Crucible\pairing` on Windows,
 * and `cruciblePairingPath` implemented `$CRUCIBLE_HOME`, else
 * `~/.crucible/pairing`, on every platform. BookForge followed the DOC and
 * refused to work around the SDK, and `tools/test-crucible-pairing-file.js`
 * asserted the disagreement in the open so the re-vendor would turn it red.
 *
 * The re-vendor (`1a1fb892`) fixed it. The SDK's rule is now §3.6's rule —
 * `$CRUCIBLE_HOME`, else on win32 `%LOCALAPPDATA%\<WINDOWS_HOME_DIRNAME>\`
 * with `LOCALAPPDATA` unset REFUSED rather than assembled from a username,
 * else `~/.crucible/` — and the empty-file case agrees too (it throws, where
 * it used to answer `null`). **So there is exactly ONE rule left in this
 * file: the sync-ness.**
 *
 * Which means this file is no longer a second OPINION, only a second
 * EXECUTION, and the three names it composes the path out of are IMPORTED
 * from the SDK rather than re-spelled here (`CRUCIBLE_HOME_ENV`,
 * `PAIRING_FILE`, `WINDOWS_HOME_DIRNAME`). The keeper's section 3 stopped
 * being a tripwire and is now a plain agreement check: it compares the path
 * THIS composes against the one `cruciblePairingPath()` returns, and the
 * empty-file and multi-line refusals against the SDK's own.
 *
 * ── `null` IS THE ANSWER, NOT A GAP ────────────────────────────────────────
 *
 * §3.8, verbatim: *"returns the parsed pairing or `null` when absent — `null`
 * is a fact here, not a fallback: the caller's next line is 'install one' or
 * 'paste one'."* A laptop that renders on the Mac has no engine of its own and
 * is not broken. A file that EXISTS and is not a connect code is a different
 * thing and throws: something wrote where the engine keeps its credential, and
 * reading that as "no engine" would send somebody to install a second one over
 * the top of one that is already running. The SDK argues it in exactly those
 * words, and applies it to the empty file and the multi-line file as well —
 * both of which this reader now refuses by name for the same reason.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CRUCIBLE_HOME_ENV as SDK_CRUCIBLE_HOME_ENV,
  PAIRING_FILE as SDK_PAIRING_FILE,
  WINDOWS_HOME_DIRNAME as SDK_WINDOWS_HOME_DIRNAME,
  parsePairing,
  type Pairing,
} from '@crucible/client';

/**
 * How `crucible_home()` names its override, verbatim — THE SDK'S CONSTANT,
 * re-exported rather than re-typed. A string spelled twice is a fact with two
 * owners (crucible `docs/ARCHITECTURE.md` R1), and the SDK is the owner.
 */
export const CRUCIBLE_HOME_ENV = SDK_CRUCIBLE_HOME_ENV;

/** The file's own name inside that home. One line, trailing newline. The SDK's. */
export const PAIRING_FILE_NAME = SDK_PAIRING_FILE;

/** `%LOCALAPPDATA%\Crucible` — the Windows home's directory name. The SDK's. */
export const WINDOWS_HOME_DIRNAME = SDK_WINDOWS_HOME_DIRNAME;

/** Why a pairing file could not be read, when the reason is not "there is none". */
export type CruciblePairingFileErrorCode =
  /** Windows with no `%LOCALAPPDATA%` — refused rather than assembled from a username. */
  | 'no_local_app_data'
  /** The file is there and could not be opened. */
  | 'pairing_file_unreadable'
  /** The file is there and has nothing in it: an interrupted write. */
  | 'pairing_file_empty'
  /**
   * The file holds more than one non-blank line, so which one the server wrote
   * is a guess — and a guessed bearer token is an auth error nobody can
   * explain. The SDK refuses this too (`crucible/pairing.py` writes exactly
   * one line, so a second one is something else appending).
   */
  | 'pairing_file_multiline'
  /** The file is there and is not a `crucible://` line. */
  | 'pairing_file_invalid';

export class CruciblePairingFileError extends Error {
  readonly code: CruciblePairingFileErrorCode;

  constructor(code: CruciblePairingFileErrorCode, message: string) {
    super(message);
    this.name = 'CruciblePairingFileError';
    this.code = code;
  }
}

/** What the reader needs, so a keeper can drive every branch with no filesystem. */
export interface PairingFileHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** The file's text, or `null` when it is not there. Anything else throws. */
  readFile: (file: string) => string | null;
}

/** The real one. */
export function processPairingFileHost(): PairingFileHost {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new CruciblePairingFileError(
          'pairing_file_unreadable',
          `${file} exists and could not be read: ${(err as Error).message}`,
        );
      }
    },
  };
}

/**
 * Where the pairing file is, pinned by crucible `docs/PHASE15-HOST.md` §3.6.
 *
 * `$CRUCIBLE_HOME/pairing` when the operator set that variable — the same
 * override `crucible_home()` honours, so a second server on a second home is
 * found the way the CLI finds it — otherwise the platform's ONE location:
 *
 *   win32          `%LOCALAPPDATA%\Crucible\pairing`
 *   linux, darwin  `~/.crucible/pairing`
 *
 * Two doors with an order is not a fallback: the first is a value somebody set
 * on purpose and the second is the only default there is. On Windows the file
 * is NOT under the profile's `.crucible` — the server there is the WSL guest's
 * or the host-mode child's, and the thing that writes a Windows-side copy is
 * `crucible host`, whose per-machine root is already `%LOCALAPPDATA%\Crucible\`
 * (`wsl\`, `downloads\`, `host\`). `LOCALAPPDATA` unset is REFUSED by name,
 * exactly as `sdk/bootstrap/src/distro.ts` refuses it, rather than assembled
 * from a username.
 *
 * THE SDK'S `cruciblePairingPath()` NOW COMPOSES THE SAME PATH out of the same
 * three constants, which this file imports from it. This is the synchronous
 * execution of that one rule, not a second reading of it, and the keeper
 * compares the two answers rather than trusting the sentence.
 */
export function cruciblePairingFilePath(host: PairingFileHost): string {
  const override = host.env[CRUCIBLE_HOME_ENV];
  if (override !== undefined && override !== '') return path.join(override, PAIRING_FILE_NAME);
  if (host.platform === 'win32') {
    const local = host.env['LOCALAPPDATA'];
    if (local === undefined || local === '') {
      throw new CruciblePairingFileError(
        'no_local_app_data',
        'LOCALAPPDATA is not set, so there is no per-user place the Crucible host would have '
          + 'written a connect code. Paste one instead, or set CRUCIBLE_HOME.',
      );
    }
    return path.join(local, WINDOWS_HOME_DIRNAME, PAIRING_FILE_NAME);
  }
  return path.join(host.homedir, '.crucible', PAIRING_FILE_NAME);
}

/** The pairing line this machine's engine wrote, with the file it came from. */
export interface PairingFileReading {
  pairing: Pairing;
  /** The path it was read from, for the row that says where a fact came from. */
  file: string;
}

/**
 * The connect code on this machine, or `null` because there is no engine here.
 *
 * Never throws for absence. Throws, by name, for every other thing that can be
 * true of a file at that path.
 */
export function readCruciblePairingFile(
  host: PairingFileHost = processPairingFileHost(),
): PairingFileReading | null {
  const file = cruciblePairingFilePath(host);
  const text = host.readFile(file);
  if (text === null) return null;
  /*
   * THE SDK'S LINE RULE, EXACTLY: split, trim, drop the blanks, and then the
   * file holds one line or it is a defect. Zero lines is an interrupted write;
   * two or more is something OTHER than `crucible init` appending to the file,
   * and picking one of them would be guessing at a bearer token.
   */
  const lines = text.split(/\r?\n/).map((each) => each.trim()).filter((each) => each !== '');
  if (lines.length === 0) {
    throw new CruciblePairingFileError(
      'pairing_file_empty',
      `${file} is empty. The engine writes one connect code with a trailing newline, so an empty `
        + 'file is an interrupted write — run `crucible token --url` on that machine again.',
    );
  }
  if (lines.length > 1) {
    throw new CruciblePairingFileError(
      'pairing_file_multiline',
      `${file} holds ${lines.length} lines and a pairing file holds exactly one. Something other `
        + 'than `crucible init` has written to it; delete it and re-run `crucible token --url`.',
    );
  }
  try {
    return { pairing: parsePairing(lines[0]!), file };
  } catch (err) {
    /*
     * `parsePairing` is the ONE parser of this format (PHASE13 §2.1) and its
     * sentence about what was wrong is kept verbatim — it elides the token
     * before it throws, so nothing here has to. What is added is the file,
     * which the SDK cannot know and which is the whole of the fix.
     */
    throw new CruciblePairingFileError(
      'pairing_file_invalid',
      `${file} is not a connect code: ${(err as Error).message}`,
    );
  }
}
