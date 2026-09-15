/**
 * crucible-pairing — the file a Crucible leaves on its own machine, read once.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * PHASE15-HOST.md §5.1 names three ways an app connects to an engine, IN THIS
 * ORDER: the pairing file on this machine, a pasted connect code for one
 * elsewhere, and getting one installed here. This module is the first of the
 * three, and it is the one nobody has to know about — `crucible init`, `crucible
 * service install` and the Windows host all write one line to
 * `<CRUCIBLE_HOME>/pairing`, and an app on the same machine reads it and
 * registers the server without anybody typing a token (§3.6).
 *
 * ── AN ABSENT FILE IS A FACT, NOT A FALLBACK ────────────────────────────────
 *
 * §3.6, in the contract's own words: *"An absent file means 'no local server' —
 * a fact the app shows, not a fallback it fills."* So this returns null and logs
 * one line at debug volume, and NOTHING downstream treats that null as a reason
 * to guess an address. A machine with no engine on it has no engine on it; the
 * other two doors of §5.1 are how a person says otherwise.
 *
 * ── THE PARSER IS THE SDK'S AND IS NEVER REIMPLEMENTED ──────────────────────
 *
 * `parsePairing` (PHASE13-OPERATOR.md §2.1) percent-decodes the server's name,
 * refuses a second literal `@` in the authority rather than guessing which one
 * separated the userinfo, and refuses a line with no `/` before the fragment.
 * Those refusals have ONE owner — the SDK — because the spelling has one
 * producer, and a second reader that was a little more forgiving would make the
 * meaning of a line depend on which program read it (ARCHITECTURE.md R3).
 *
 * ── THE TOKEN, AND THE ONE RULE IT HAS ──────────────────────────────────────
 *
 * The line IS a credential. It is read here, handed straight to
 * `addCrucibleServer` in the main process, and never logged, never returned over
 * an IPC answer, never put on a command line — crucible-registry.ts's header
 * argues this at length and this module is bound by it. The SDK's own refusal
 * already elides everything after the `#`, which is why its sentence can be
 * printed verbatim when a line will not parse.
 *
 * ── THE PATH TABLE IS THE SDK'S NOW, AND SO IS THE READ ─────────────────────
 *
 * PHASE15 §3.8 gave `@crucible/client` a `readPairingFile(home?)` and a
 * `cruciblePairingPath(home?)` of its own, and the vendored 0.6.0 (packed from
 * crucible `762484f`) carries both. The standing note that said "switch the
 * moment the tarball carries it" has been acted on: this module's own path
 * table, its `crucibleHome()` and its `node:fs` read are gone, and what is left
 * is the one thing that is Foundry's — the THREE-WAY answer below, which the
 * SDK's `Pairing | null` cannot express and the "Look again" door needs.
 *
 * BOTH SDK CALLS ARE ASYNC, deliberately (the SDK assembles its `node:fs`
 * import at run time so a bundler cannot resolve it), so {@link pairingFileRead}
 * is async too. Its one caller was already inside an `await`.
 *
 * ── A NOTE FOR WHOEVER GOES LOOKING ON WINDOWS ──────────────────────────────
 *
 * This module used to look in `%LOCALAPPDATA%\Crucible\pairing` on win32, from
 * a reading of §3.6 pinned at crucible `3bcd003`. The SDK looks in
 * `~/.crucible/pairing` on every platform, `$CRUCIBLE_HOME` overriding. That is
 * now the answer, because the path has one owner and it is the package the
 * server ships — a second table here is exactly how a Windows build starts
 * looking somewhere the host never writes. Nothing writes either location on
 * this machine today; door 2 ("the Crucible on this machine", which reads
 * config.toml through wsl.exe) is still how a WSL server is registered.
 */
import {
  CruciblePairingError,
  cruciblePairingPath,
  parsePairing,
  readPairingFile as readSdkPairingFile,
  type Pairing,
} from '@crucible/client';

/**
 * What the read found — the three answers the "Look again" door has to tell
 * apart, which is one more than the SDK's `Pairing | null` can express.
 *
 * `absent` and `refused` are DIFFERENT THINGS TO DO. Absent is the ordinary
 * state of a machine with no engine on it and the person is told a fact; refused
 * is a file that exists and says something this reader does not understand,
 * which is somebody's to fix, so it carries the SDK's own sentence.
 */
export type PairingFileRead =
  | { found: 'pairing'; pairing: Pairing; path: string }
  | { found: 'absent'; path: string }
  | { found: 'refused'; message: string; path: string };

/**
 * Read the SDK's pairing path and say which of the three it was.
 *
 * THE READ AND THE PARSE ARE BOTH THE SDK'S. `readPairingFile()` answers null
 * for ENOENT/ENOTDIR and for an empty file — which is `absent`, the ordinary
 * state of a machine with no engine on it — and RAISES for everything else:
 * `CruciblePairingError` for a line that is not one, and the raw fs error for a
 * permission problem or a directory where the file should be. The SDK's own
 * note says why the second is not null-ed: *"a caller told `null` would offer
 * to install a second Crucible over the top of one that is already running."*
 * Both raises become `refused` here, which is the same reading this module
 * always had — a file we can see and cannot read is not "you have no engine".
 *
 * THE PATH IS ASKED FOR SEPARATELY because every one of the three answers
 * carries it: a door that can say WHERE it looked is more useful than one that
 * only says "not found", and it is the sentence the "Look again" button shows.
 */
export async function pairingFileRead(): Promise<PairingFileRead> {
  const file = await cruciblePairingPath();
  try {
    const pairing = await readSdkPairingFile();
    return pairing === null
      ? { found: 'absent', path: file }
      : { found: 'pairing', pairing, path: file };
  } catch (err) {
    /*
     * REFUSED BY NAME, IN ONE LINE, WITH NO TOKEN IN IT. `CruciblePairingError`'s
     * own message already replaces everything after the `#` with an ellipsis,
     * which is the whole reason it can be printed verbatim; anything else that
     * came out of here would be a sentence of ours over a refusal that already
     * names what is wrong with the shape.
     */
    const message = err instanceof CruciblePairingError
      ? `${file}: ${err.message}`
      : `${file} could not be read: ${err instanceof Error ? err.message : String(err)}`;
    return { found: 'refused', message, path: file };
  }
}

/**
 * ONE PASTED CONNECT CODE, read — PHASE15 §5.1 way 2, PHASE13-OPERATOR.md §5.1.
 *
 * ── Why this lives beside the file reader ───────────────────────────────────
 *
 * Same line, same parser, same refusal. The two ways in differ only in where the
 * line came from — a file Crucible wrote here, or a line somebody copied off an
 * operator page elsewhere — and putting the second one's parse in the IPC module
 * would be a second place that decides what a `crucible://` line means. It never
 * becomes two places, because there is only ever one `parsePairing`.
 *
 * ── The three doors take THE LINE, every time, and never a token ────────────
 *
 * Preview, Test and Add each call this with the pasted line afresh rather than
 * passing a parsed token between them. A token handed back to the renderer so it
 * could be handed forward again would be a credential living in a component for
 * as long as the door was open, for no gain: parsing is pure and costs nothing.
 *
 * The refusal is the SDK's own sentence VERBATIM — it already replaces everything
 * after the `#` with an ellipsis, and rewording it would take the `invalid_pairing`
 * name off a refusal whose name is the thing to search for.
 */
export type ConnectCodeRead =
  | { read: true; pairing: Pairing }
  | { read: false; message: string };

export function readConnectCode(line: string): ConnectCodeRead {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { read: false, message: 'Paste the connect code a Crucible printed for you.' };
  }
  try {
    return { read: true, pairing: parsePairing(trimmed) };
  } catch (err) {
    if (err instanceof CruciblePairingError) return { read: false, message: err.message };
    return { read: false, message: err instanceof Error ? err.message : String(err) };
  }
}
