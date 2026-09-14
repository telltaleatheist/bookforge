/**
 * The local Crucible server — read from its OWN config, never copied.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 *
 * Until 2026-09-13 the registry (`servers.ts`) held an entry for the server on
 * this very machine, `wsl` → `http://127.0.0.1:7100`, with a copy of the token
 * `crucible init` had minted. Two owners of one fact (crucible
 * `docs/ARCHITECTURE.md`, R1): `crucible init --force` mints a new token, the
 * copy goes stale, and the first symptom is a 401 with nothing saying why.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The local server has ONE owner: `<CRUCIBLE_HOME>/config.toml`, the file the
 * server itself reads (`crucible/config.py`). This module reads that file and
 * nothing else. The registry holds REMOTE servers only — the machines whose
 * tokens Owen pasted, because for those no other source exists.
 *
 *   [server]  name, host, port      [auth]  token
 *
 * The connect address is derived from the bind address: a server bound to
 * `0.0.0.0` or `::` is reached at `127.0.0.1`; one bound to a specific address
 * is reached there. That is a bind→connect mapping, not a fallback — the two
 * are different facts and the file only records the first.
 *
 * ── TWO DOORS SINCE PHASE 15, AND THE SECOND ONE IS DATED ──────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §3.6 gives the local server a SECOND way to
 * be found, and it is the contract's own: a **pairing file** the engine (or,
 * on Windows, `crucible host`) writes beside its config, holding the one
 * connect code. §5.1 makes reading it the first of connect's three ways —
 * *"No typing."* — and it works with no WSL, no distro setting and no
 * `wsl.exe` spawn at all.
 *
 * So {@link readLocalServer} asks in this order:
 *
 *   1. the pairing file (`pairing-file.ts`)      `via: 'pairing'`
 *   2. `config.toml`, read here                  `via: 'file'` / `'wsl'`
 *
 * That is two named doors with an order, not a fallback chain: each is a
 * DIFFERENT artefact written by a different part of the system, the first is
 * what the contract says an app reads, and §3.6 dates the second — *"an app's
 * 'read config.toml through wsl.exe' door is how the WSL server gets
 * registered, and that door is deleted when the host lands."* On Owen's PC
 * today there is no host, so door 2 is the live one and door 1 finds nothing;
 * the day the host runs, door 1 answers first and door 2 stops being reached.
 *
 * ── Where the config file is ────────────────────────────────────────────────
 *
 * On macOS and Linux: `$CRUCIBLE_HOME/config.toml`, default `~/.crucible`,
 * exactly as `crucible_home()` resolves it. On Windows the local server lives in
 * WSL2 — Windows is never a backend (crucible `docs/DESIGN.md`) — so the file is
 * read THROUGH `wsl.exe -d <distro> --exec bash -c ...`, which resolves
 * `$CRUCIBLE_HOME`/`$HOME` inside the guest. Always `--exec`: the implicit
 * shell pre-expands `$var` on the Windows side (memory: wsl-exe-implicit-shell-
 * trap). The distro is the app's WSL setting; there is no default distro here,
 * because "the default distro" is whatever `wsl --set-default` last said and a
 * server read from the wrong guest is a wrong server.
 *
 * ── No fallbacks ────────────────────────────────────────────────────────────
 *
 * A machine may legitimately have no local Crucible (a laptop that only ever
 * renders on the Mac). That is `no_local_config`, a NAMED state the caller shows,
 * not an empty client. Every other way this can fail is its own code.
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
import type { LocalServerVia } from '../../shared/crucible/settings-wire';

/** The reserved server name that means "the server on this machine". */
export const LOCAL_SERVER_NAME = 'local';

export { CRUCIBLE_HOME_ENV };

/** The local server, as its own config describes it. */
export interface LocalServer {
  /** `[server] name` — what the server calls itself, e.g. `crucible@owens-pc-wsl`. */
  name: string;
  /** Base URL to connect to, without `/v1`. Derived from `[server] host`/`port`. */
  url: string;
  /** `[auth] token`, verbatim. */
  token: string;
  /** The file this was read from, as the reading side names it. */
  configPath: string;
  /** Which of the two doors answered. See the header. */
  via: LocalServerVia;
}

export type CrucibleLocalErrorCode =
  /** Neither door found a server on this machine. A state, not a bug. */
  | 'no_local_config'
  /** Windows, and the app has no WSL distro setting to read through. */
  | 'no_wsl_distro'
  /** `wsl.exe` could not be run, or the guest command failed for a reason other than a missing file. */
  | 'wsl_read_failed'
  /** The file exists and is not TOML, or could not be read. */
  | 'config_unreadable'
  /** The file parses but lacks a key the server itself requires. */
  | 'config_missing_key';

export class CrucibleLocalError extends Error {
  readonly code: CrucibleLocalErrorCode;

  constructor(code: CrucibleLocalErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleLocalError';
    this.code = code;
  }
}

/** The one guest-side command. Exit 3 is "no config there", told apart from every other failure. */
const WSL_READ_SCRIPT =
  'p="${CRUCIBLE_HOME:-$HOME/.crucible}/config.toml"; '
  + 'if [ ! -f "$p" ]; then echo "$p" >&2; exit 3; fi; '
  + 'echo "$p"; cat "$p"';

/** What `readLocalServer` needs from its host, so a test can supply all of it. */
export interface LocalHost {
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
export function processHost(wslDistro: string | undefined): LocalHost {
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
export function localConfigPath(env: NodeJS.ProcessEnv, homedir: string): string {
  const override = env[CRUCIBLE_HOME_ENV];
  const home = override !== undefined && override !== '' ? override : path.join(homedir, '.crucible');
  return path.join(home, 'config.toml');
}

/**
 * The address a client connects to, from the address the server bound.
 * `0.0.0.0`/`::` mean "every interface", and the interface a local client uses
 * is loopback. Anything else is a specific address and is used as written.
 */
export function connectHost(bindHost: string): string {
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') return '127.0.0.1';
  return bindHost;
}

/**
 * Parse a config.toml into a {@link LocalServer}. Requires the same keys
 * `crucible/config.py`'s `load_config` requires, and refuses by name when one is
 * missing or of the wrong type — the server would refuse to start on that file,
 * so a client must not pretend it describes a server.
 */
export function parseLocalConfig(text: string, configPath: string, via: 'file' | 'wsl'): LocalServer {
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw new CrucibleLocalError(
      'config_unreadable',
      `${configPath} is not valid TOML (${(err as Error).message}). The server would refuse it too.`,
    );
  }
  const name = requireKey(table, 'server', 'name', 'string', configPath) as string;
  const host = requireKey(table, 'server', 'host', 'string', configPath) as string;
  const port = requireKey(table, 'server', 'port', 'integer', configPath) as number;
  const token = requireKey(table, 'auth', 'token', 'string', configPath) as string;
  if (token.trim() === '') {
    throw new CrucibleLocalError(
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
    throw new CrucibleLocalError('config_missing_key', `${configPath} is missing the [${section}] section`);
  }
  const value = (block as Record<string, unknown>)[key];
  if (value === undefined) {
    throw new CrucibleLocalError('config_missing_key', `${configPath} is missing ${section}.${key}`);
  }
  const ok = kind === 'string'
    ? typeof value === 'string'
    : typeof value === 'number' && Number.isInteger(value);
  if (!ok) {
    throw new CrucibleLocalError(
      'config_missing_key',
      `${configPath}: ${section}.${key} must be ${kind === 'string' ? 'a string' : 'an integer'}, got ${typeof value}`,
    );
  }
  return value;
}

/**
 * The local server, from its own config, or a {@link CrucibleLocalError}.
 *
 * Synchronous on purpose: it is called in the same breath as the registry read
 * it replaces, and a WSL round-trip to `cat` one file is a few hundred
 * milliseconds — a settings row and a CLI both tolerate that, and neither
 * tolerates a second copy of the token.
 */
export function readLocalServer(host: LocalHost): LocalServer {
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

  const configPath = localConfigPath(host.env, host.homedir);
  if (!fs.existsSync(configPath)) {
    throw new CrucibleLocalError(
      'no_local_config',
      `no local Crucible: neither a connect code nor ${configPath} is on this machine. Install `
        + 'one with `crucible init` here, or add a remote server.',
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new CrucibleLocalError(
      'config_unreadable',
      `could not read ${configPath}: ${(err as Error).message}`,
    );
  }
  return parseLocalConfig(text, configPath, 'file');
}

function readThroughWsl(host: LocalHost): LocalServer {
  const distro = host.wslDistro;
  if (distro === undefined || distro.trim() === '') {
    throw new CrucibleLocalError(
      'no_wsl_distro',
      'the local Crucible on Windows runs inside WSL2, and no WSL distro is set — Settings → '
        + 'Add-ons → WSL distro. There is no default distro here on purpose: the server read from '
        + 'the wrong guest is the wrong server.',
    );
  }
  const result = host.runWsl(distro, WSL_READ_SCRIPT);
  if (result.error) {
    throw new CrucibleLocalError(
      'wsl_read_failed',
      `could not run wsl.exe -d ${distro}: ${result.error.message}`,
    );
  }
  if (result.status === 3) {
    const missing = result.stderr.trim();
    throw new CrucibleLocalError(
      'no_local_config',
      `no local Crucible: no connect code on this machine, and ${missing} does not exist inside `
        + `WSL distro "${distro}". Install one with \`crucible init\` there, or add a remote server.`,
    );
  }
  if (result.status !== 0) {
    throw new CrucibleLocalError(
      'wsl_read_failed',
      `reading the local Crucible config inside WSL distro "${distro}" failed (exit ${result.status}): `
        + `${result.stderr.trim() || '(no stderr)'}`,
    );
  }
  const newline = result.stdout.indexOf('\n');
  if (newline < 0) {
    throw new CrucibleLocalError(
      'wsl_read_failed',
      `the guest printed no config path before the file (stdout: ${JSON.stringify(result.stdout.slice(0, 80))})`,
    );
  }
  const guestPath = result.stdout.slice(0, newline).trim();
  const text = result.stdout.slice(newline + 1);
  return parseLocalConfig(text, `${distro}:${guestPath}`, 'wsl');
}

/** Is this URL's host the machine it is read on? The shapes `addServer` refuses. */
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
