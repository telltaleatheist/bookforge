/**
 * THE CONNECT CODE THE ENGINE ON THIS MACHINE LEFT FOR AN APP TO FIND.
 *
 * crucible `docs/PHASE15-HOST.md` §3.6 and §5.1. `crucible init`, `service
 * install` and the Windows host write the pairing line to a user-only file on
 * the machine the server runs on, so an app on that machine connects **without
 * anyone typing a token**. That is the first of connect's three ways, and the
 * only one that needs no person.
 *
 * ── Why it is its own module ───────────────────────────────────────────────
 *
 * It is part of the same dated seam as `settings-wire.ts` — the SDK is growing
 * `readPairingFile()` (§3.8) and both go the day it lands — and that file
 * re-exports this one so there is a single name to delete. It is SPLIT out
 * because `local.ts` reads the pairing file, `servers.ts` reads `local.ts`, and
 * `settings-wire.ts` reads `servers.ts`: one file would be a require cycle
 * through three modules that each own a different fact.
 *
 * ── `null` IS THE ANSWER, NOT A GAP ────────────────────────────────────────
 *
 * §3.8, verbatim: *"returns the parsed pairing or `null` when absent — `null`
 * is a fact here, not a fallback: the caller's next line is 'install one' or
 * 'paste one'."* A laptop that renders on the Mac has no engine of its own and
 * is not broken. A file that EXISTS and is not a connect code is a different
 * thing and throws: something wrote where the engine keeps its credential, and
 * reading that as "no engine" would hide it for ever.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePairing, type Pairing } from '@crucible/client';

/** How `crucible_home()` names its override, verbatim. */
export const CRUCIBLE_HOME_ENV = 'CRUCIBLE_HOME';

/** The file's own name inside that home. One line, trailing newline. */
export const PAIRING_FILE_NAME = 'pairing';

/** Why a pairing file could not be read, when the reason is not "there is none". */
export type CruciblePairingFileErrorCode =
  /** Windows with no `%LOCALAPPDATA%` — refused rather than assembled from a username. */
  | 'no_local_app_data'
  /** The file is there and could not be opened. */
  | 'pairing_file_unreadable'
  /** The file is there and has nothing in it: an interrupted write. */
  | 'pairing_file_empty'
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
    return path.join(local, 'Crucible', PAIRING_FILE_NAME);
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
  const line = text.trim();
  if (line === '') {
    throw new CruciblePairingFileError(
      'pairing_file_empty',
      `${file} is empty. The engine writes one connect code with a trailing newline, so an empty `
        + 'file is an interrupted write — run `crucible token --url` on that machine again.',
    );
  }
  try {
    return { pairing: parsePairing(line), file };
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
