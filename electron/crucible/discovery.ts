/**
 * IS THERE A CRUCIBLE ON THIS COMPUTER — a machine fact, offered as a PREFILL.
 *
 * ── Owen's ruling, 2026-09-15, which is what this file now is ───────────────
 *
 * *"it shouldnt be named 'local' anywhere. it might not be local. a local
 * crucible server shouldnt be treated any differently than a remote crucible
 * server. it should all be entered the exact same way … bookforge shouldnt even
 * know if it's local because it doesnt mater"*
 *
 * Until that ruling this module owned a reserved SERVER NAME, `local`, and the
 * whole app was threaded with it: the registry answered `get('local')` from a
 * config file instead of from itself, `knownServers()` grew a row nobody had
 * added, coordination at start was `local`'s alone, the bench drew a row whose
 * name no operator had typed, and a loopback URL was REFUSED at the add door.
 * Two kinds of server, two code paths, one of them reachable only on the machine
 * it was about.
 *
 * There is now ONE kind of Crucible server: **a registry entry** (`servers.ts`),
 * added with a URL and a token, whether it answers on `127.0.0.1` or across the
 * tailnet. Nothing in BookForge asks which.
 *
 * What survives is the part that was never about identity: **this machine may
 * already have a Crucible on it, and typing its address out of a config file is
 * a thing a person should not have to do.** So this module answers one question
 * — *what would the entry for the Crucible on this computer look like?* — and
 * its answer goes into the ADD FORM, prefilled, to be added like any other. It
 * is a convenience with no consequences: nothing routes through it, nothing
 * ranks it, nothing coordinates with it. Refuse the offer and the machine has no
 * Crucible registered, which is a true and ordinary state.
 *
 * ── TWO DOORS, WITH AN ORDER, AND THE SECOND ONE IS DATED ──────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §3.6 gives the server on this machine the
 * contract's own way to be found: a **pairing file** the engine (or, on Windows,
 * `crucible host`) writes beside its config, holding one connect code. §5.1
 * makes reading it the first of connect's three ways — *"No typing."* — and it
 * works with no WSL, no distro setting and no `wsl.exe` spawn at all.
 *
 * So {@link discoverCrucible} asks in this order:
 *
 *   1. the pairing file (`pairing-file.ts`)      `via: 'pairing'`
 *   2. `config.toml`, read here                  `via: 'file'` / `'wsl'`
 *
 * That is two named doors with an order, not a fallback chain: each is a
 * DIFFERENT artefact written by a different part of the system, the first is
 * what the contract says an app reads, and §3.6 dates the second — *"an app's
 * 'read config.toml through wsl.exe' door is how the WSL server gets
 * registered, and that door is deleted when the host lands."*
 *
 * ── Where the config file is ────────────────────────────────────────────────
 *
 * On macOS and Linux: `$CRUCIBLE_HOME/config.toml`, default `~/.crucible`,
 * exactly as `crucible_home()` resolves it. On Windows a Crucible engine lives
 * in WSL2 — Windows is never a backend (crucible `docs/DESIGN.md`) — so the file
 * is read THROUGH `wsl.exe -d <distro> --exec bash -c ...`, which resolves
 * `$CRUCIBLE_HOME`/`$HOME` inside the guest. Always `--exec`: the implicit shell
 * pre-expands `$var` on the Windows side (memory: wsl-exe-implicit-shell-trap).
 * The distro is the app's WSL setting; there is no default distro here, because
 * "the default distro" is whatever `wsl --set-default` last said and a server
 * read from the wrong guest is a wrong server.
 *
 * ── No fallbacks ────────────────────────────────────────────────────────────
 *
 * A machine may legitimately have no Crucible on it (a laptop that only ever
 * renders on the Mac). That is `no_local_config` — the bootstrap package's own
 * name for it, see the code — a NAMED state the caller shows, not an empty
 * answer. Every other way this can fail is its own code.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parse as parseToml } from 'smol-toml';
import {
  CRUCIBLE_HOME_ENV,
  processPairingFileHost,
  readCruciblePairingFile,
  type PairingFileHost,
} from './pairing-file';
import type { CrucibleDiscoveryVia } from '../../shared/crucible/settings-wire';

export { CRUCIBLE_HOME_ENV };

/**
 * A Crucible found on this computer, in the shape the add form wants.
 *
 * It is NOT a server this app knows about. It becomes one only when the
 * operator adds it, under whatever name they type, through the same door every
 * other server goes through.
 */
export interface DiscoveredCrucible {
  /**
   * `[server] name` — what the server calls ITSELF, e.g. `crucible@owens-pc-wsl`.
   * Offered as the add form's suggested name and nothing more: the name a server
   * is filed under here is the operator's to choose.
   */
  name: string;
  /** Base URL to connect to, without `/v1`. Derived from `[server] host`/`port`. */
  url: string;
  /** `[auth] token`, verbatim. */
  token: string;
  /** The file this was read from, as the reading side names it. */
  configPath: string;
  /** Which of the two doors answered. See the header. */
  via: CrucibleDiscoveryVia;
}

export type CrucibleDiscoveryErrorCode =
  /**
   * Neither door found a Crucible on this machine. A state, not a bug.
   *
   * THE WORD `local` SURVIVES IN THIS ONE NAME, and it is not the reserved
   * server name coming back. It is `@crucible/bootstrap`'s own code for exactly
   * this fact (`BootstrapRefusalCode`, which `shared/crucible/install-wire.ts`
   * re-exports rather than transcribing), and the install plan shows it
   * verbatim. Renaming it here would make BookForge the second author of one
   * string (crucible `docs/ARCHITECTURE.md` R1) — and it is a statement about a
   * CONFIG FILE on this computer, never about a server's identity.
   */
  | 'no_local_config'
  /** Windows, and the app has no WSL distro setting to read through. */
  | 'no_wsl_distro'
  /** `wsl.exe` could not be run, or the guest command failed for a reason other than a missing file. */
  | 'wsl_read_failed'
  /** The file exists and is not TOML, or could not be read. */
  | 'config_unreadable'
  /** The file parses but lacks a key the server itself requires. */
  | 'config_missing_key';

export class CrucibleDiscoveryError extends Error {
  readonly code: CrucibleDiscoveryErrorCode;

  constructor(code: CrucibleDiscoveryErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleDiscoveryError';
    this.code = code;
  }
}

/** The one guest-side command. Exit 3 is "no config there", told apart from every other failure. */
const WSL_READ_SCRIPT =
  'p="${CRUCIBLE_HOME:-$HOME/.crucible}/config.toml"; '
  + 'if [ ! -f "$p" ]; then echo "$p" >&2; exit 3; fi; '
  + 'echo "$p"; cat "$p"';

/** What {@link discoverCrucible} needs from its host, so a test can supply all of it. */
export interface DiscoveryHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** The app's WSL distro setting, or undefined when there is none. Only read on win32. */
  wslDistro: string | undefined;
  /**
   * Run `wsl.exe -d <distro> --exec bash -c <script>` and hand back what it
   * said. Injectable so the keeper can exercise every code path without a guest.
   */
  runWsl: (distro: string, script: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
  /** The pairing-file door, injectable for the same reason. */
  pairing: PairingFileHost;
}

/** The real host. */
export function processDiscoveryHost(wslDistro: string | undefined): DiscoveryHost {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    wslDistro,
    pairing: processPairingFileHost(),
    runWsl: (distro, script) => {
      const result = spawnSync('wsl.exe', ['-d', distro, '--exec', 'bash', '-c', script], {
        encoding: 'utf-8',
        windowsHide: true,
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  };
}

/** `$CRUCIBLE_HOME/config.toml`, resolved exactly as `crucible_home()` does. */
export function crucibleConfigPath(env: NodeJS.ProcessEnv, homedir: string): string {
  const override = env[CRUCIBLE_HOME_ENV];
  const home = override !== undefined && override !== '' ? override : path.join(homedir, '.crucible');
  return path.join(home, 'config.toml');
}

/**
 * The address a client connects to, from the address the server bound.
 * `0.0.0.0`/`::` mean "every interface", and the interface a client on the same
 * machine uses is loopback. Anything else is a specific address and is used as
 * written.
 */
export function connectHost(bindHost: string): string {
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') return '127.0.0.1';
  return bindHost;
}

/**
 * Parse a config.toml into a {@link DiscoveredCrucible}. Requires the same keys
 * `crucible/config.py`'s `load_config` requires, and refuses by name when one is
 * missing or of the wrong type — the server would refuse to start on that file,
 * so a client must not pretend it describes a server.
 */
export function parseCrucibleConfig(
  text: string,
  configPath: string,
  via: 'file' | 'wsl',
): DiscoveredCrucible {
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw new CrucibleDiscoveryError(
      'config_unreadable',
      `${configPath} is not valid TOML (${(err as Error).message}). The server would refuse it too.`,
    );
  }
  const name = requireKey(table, 'server', 'name', 'string', configPath) as string;
  const host = requireKey(table, 'server', 'host', 'string', configPath) as string;
  const port = requireKey(table, 'server', 'port', 'integer', configPath) as number;
  const token = requireKey(table, 'auth', 'token', 'string', configPath) as string;
  if (token.trim() === '') {
    throw new CrucibleDiscoveryError(
      'config_missing_key',
      `${configPath}: auth.token is empty. A Crucible has no anonymous mode; run \`crucible init\` on that host.`,
    );
  }
  const urlHost = connectHost(host);
  const url = `http://${urlHost.includes(':') ? `[${urlHost}]` : urlHost}:${port}`;
  return { name, url, token, configPath, via };
}

function requireKey(
  table: Record<string, unknown>,
  section: string,
  key: string,
  kind: 'string' | 'integer',
  configPath: string,
): unknown {
  const block = table[section];
  if (block === undefined || block === null || typeof block !== 'object') {
    throw new CrucibleDiscoveryError('config_missing_key', `${configPath} is missing the [${section}] section`);
  }
  const value = (block as Record<string, unknown>)[key];
  if (value === undefined) {
    throw new CrucibleDiscoveryError('config_missing_key', `${configPath} is missing ${section}.${key}`);
  }
  const ok = kind === 'string'
    ? typeof value === 'string'
    : typeof value === 'number' && Number.isInteger(value);
  if (!ok) {
    throw new CrucibleDiscoveryError(
      'config_missing_key',
      `${configPath}: ${section}.${key} must be ${kind === 'string' ? 'a string' : 'an integer'}, got ${typeof value}`,
    );
  }
  return value;
}

/**
 * The Crucible on this computer, as an entry waiting to be added — or a
 * {@link CrucibleDiscoveryError} naming why there is none to offer.
 *
 * Synchronous on purpose: the install plan and the settings panel both compose
 * it beside other synchronous machine reads, and a WSL round-trip to `cat` one
 * file is a few hundred milliseconds. Nothing on the scheduler's path calls it
 * any more — that was the reserved name's doing, and the reserved name is gone.
 */
export function discoverCrucible(host: DiscoveryHost): DiscoveredCrucible {
  /*
   * DOOR 1, the contract's: the connect code the engine left on this machine.
   * It answers on every platform, needs no WSL and names its own file, so when
   * it is there nothing else is asked.
   */
  const paired = readCruciblePairingFile(host.pairing);
  if (paired !== null) {
    return {
      name: paired.pairing.name,
      url: paired.pairing.url,
      token: paired.pairing.token,
      configPath: paired.file,
      via: 'pairing',
    };
  }

  // DOOR 2, dated (see the header): the server's own config.toml.
  if (host.platform === 'win32') return readThroughWsl(host);

  const configPath = crucibleConfigPath(host.env, host.homedir);
  if (!fs.existsSync(configPath)) {
    throw new CrucibleDiscoveryError(
      'no_local_config',
      `no Crucible on this computer: neither a connect code nor ${configPath} is here. Install `
        + 'one, or add a server that is running somewhere else.',
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new CrucibleDiscoveryError(
      'config_unreadable',
      `could not read ${configPath}: ${(err as Error).message}`,
    );
  }
  return parseCrucibleConfig(text, configPath, 'file');
}

function readThroughWsl(host: DiscoveryHost): DiscoveredCrucible {
  const distro = host.wslDistro;
  if (distro === undefined || distro.trim() === '') {
    throw new CrucibleDiscoveryError(
      'no_wsl_distro',
      'a Crucible engine on Windows runs inside WSL2, and no WSL distro is set — Settings → '
        + 'Add-ons → WSL distro. There is no default distro here on purpose: the server read from '
        + 'the wrong guest is the wrong server.',
    );
  }
  const result = host.runWsl(distro, WSL_READ_SCRIPT);
  if (result.error) {
    throw new CrucibleDiscoveryError(
      'wsl_read_failed',
      `could not run wsl.exe -d ${distro}: ${result.error.message}`,
    );
  }
  if (result.status === 3) {
    const missing = result.stderr.trim();
    throw new CrucibleDiscoveryError(
      'no_local_config',
      `no Crucible on this computer: no connect code here, and ${missing} does not exist inside `
        + `WSL distro "${distro}". Install one with \`crucible init\` there, or add a server that `
        + 'is running somewhere else.',
    );
  }
  if (result.status !== 0) {
    throw new CrucibleDiscoveryError(
      'wsl_read_failed',
      `reading a Crucible config inside WSL distro "${distro}" failed (exit ${result.status}): `
        + `${result.stderr.trim() || '(no stderr)'}`,
    );
  }
  const newline = result.stdout.indexOf('\n');
  if (newline < 0) {
    throw new CrucibleDiscoveryError(
      'wsl_read_failed',
      `the guest printed no config path before the file (stdout: ${JSON.stringify(result.stdout.slice(0, 80))})`,
    );
  }
  const guestPath = result.stdout.slice(0, newline).trim();
  const text = result.stdout.slice(newline + 1);
  return parseCrucibleConfig(text, `${distro}:${guestPath}`, 'wsl');
}

/**
 * DOES THIS ADDRESS ANSWER ON THE MACHINE THAT IS ASKING.
 *
 * ── The one question about "here" that survived the ruling, and why ────────
 *
 * It is NOT about a server's identity, and it decides nothing about how a server
 * is added, named, ranked, coordinated with or drawn. Every registry entry is
 * the same kind of thing whatever this answers.
 *
 * It is about **this app's own graphics card**. BookForge still has one GPU
 * tenant of its own — the long-form aligner (`shared/queue/slot-sets.ts`,
 * `LONGFORM_ALIGN_SET`) — and it also holds a GPU lock and an arbiter for work
 * outside the queue. A render placed on a Crucible that answers on loopback is
 * a render on the SAME card, so starting one beside the other puts two models on
 * one 3090 Ti. The scheduler states that rule rather than rediscovering it
 * (`queue-engine.ts`, `thisMachinesCardHeldBy`), and the only honest way to
 * answer "does this venue share my card" is the address it is reached at.
 *
 * ENDS WHEN long-form alignment becomes a Crucible job
 * (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §B7): with no in-app GPU tenant left there is
 * no second venue over this machine's card, and the last caller of this goes
 * with it.
 *
 * A hostname that merely happens to resolve to this machine answers `false`, and
 * that is deliberate: this reads the ADDRESS, which is a fact in hand, rather
 * than resolving names, which would be a network call inside a synchronous pump.
 * The cost of the miss is the interlock not firing for a server somebody
 * registered by its LAN name — which is the same as the behaviour before the
 * interlock existed, and is why it is written down here.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::'
    || host === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host.endsWith('.localhost');
}
