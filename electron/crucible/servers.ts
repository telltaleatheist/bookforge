/**
 * The Crucible server registry — which REMOTE inference servers this machine knows,
 * and the door through which the LOCAL one is reached without being copied.
 *
 * ── What Crucible is ────────────────────────────────────────────────────────
 *
 * Crucible (`C:\Users\tellt\Projects\crucible`, `docs/DESIGN.md`) is one
 * inference server for all of Owen's apps: it runs models and returns bytes, and
 * it never knows what an audiobook, a cleanup pass or a PDF conversion is. A
 * client speaks HTTP to it even when the server is on localhost — there is no
 * in-process shortcut, so the PC's WSL2 server, the Mac across the room and a
 * rented droplet are all reached by exactly one code path.
 *
 * This module is BookForge's half of that: the list of servers, their tokens,
 * and a constructed `CrucibleClient` for one of them. It knows nothing about
 * jobs, GPUs or backends — `@crucible/client` owns the protocol and the server
 * owns the hardware.
 *
 * ── Two kinds of server, one owner each (2026-09-13) ────────────────────────
 *
 * **The local server** is the one on this machine (inside WSL2 on Windows). Its
 * token lives in ITS OWN `config.toml`, and that file is the only place it
 * lives: {@link getServer}`('local')` reads it through `local.ts` on every call.
 * Until tonight the registry held a copy under the name `wsl`; `crucible init
 * --force` mints a new token, the copy went stale, and the first symptom was a
 * 401 with nothing saying why. One fact, one owner (crucible
 * `docs/ARCHITECTURE.md`, R1) — so the copy is now refused, by name, both when
 * it is added ({@link addServer}: `local_is_not_registered`) and when a
 * pre-existing one is used (`stale_local_entry`, with the fix in the message).
 *
 * **Remote servers** — the Mac, a droplet — are the registry's whole job. For
 * them a pasted token is the only source that exists (PHASE7-LANES.md
 * section 7.1), so it is recorded here, once.
 *
 * ── Where the registry lives ────────────────────────────────────────────────
 *
 * `<userData>/crucible-servers.json`, beside library-root.json and
 * derivation-cache.json:
 *
 *   { "servers": [ { "name", "url", "token", "added" } ] }
 *
 * Written temp-and-rename like every other userData record here (see
 * derivation-cache.ts, bookshelf-identity.ts): a half-written registry is the
 * one shape that would lose every server at once.
 *
 * ── The token ───────────────────────────────────────────────────────────────
 *
 * The bearer token is the whole of a Crucible's auth (DESIGN.md section 9), so
 * it is handled like a credential: {@link listServers} and {@link describeLocal}
 * cannot return it — they return different types, carrying `tokenMasked` — and
 * only {@link getServer} and {@link crucibleClientFor}, which exist to use it,
 * ever see the plaintext. Making the list path structurally unable to leak is
 * worth more than remembering not to print it.
 *
 * ── No fallbacks ────────────────────────────────────────────────────────────
 *
 * Every refusal here is by name, with a {@link CrucibleRegistryError} whose
 * `code` says which one it is: an unknown server is not an empty client, a
 * duplicate name does not silently replace the entry it collides with, a URL
 * without a scheme is refused rather than prefixed with a guessed `http://`,
 * and a machine with no local Crucible is a named state, not an empty client.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleClient } from '@crucible/client';
import {
  CrucibleLocalError,
  LOCAL_SERVER_NAME,
  isLoopbackUrl,
  processHost,
  readLocalServer,
  type LocalServer,
} from './local';
import { getWslDistro } from '../tool-paths';
import type { LocalServerVia } from '../../shared/crucible/settings-wire';
import { forgetCrucibleRoutes } from './routes';

export { LOCAL_SERVER_NAME, CrucibleLocalError } from './local';
export type { LocalServer } from './local';

/**
 * What this app calls itself to a Crucible.
 *
 * Lands in the `User-Agent` the SDK sends, which is what `GET /v1/activity`
 * reports as a job's `client` — so a server shared by the PC and the Mac can
 * say whose render is on the card (crucible `docs/PHASE7-LANES.md` section 5,
 * "`client` is load-bearing"). One name, declared once: two spellings would be
 * two apps in that log.
 */
export const CRUCIBLE_CLIENT_NAME = 'bookforge';

/** The registry file's shape on disk. */
interface RegistryFile {
  servers: CrucibleServerEntry[];
}

/**
 * One REMOTE server as recorded on disk. Carries the plaintext token, so it is
 * only ever handed out through {@link getServer} — the door whose whole purpose
 * is to authenticate a call.
 */
export interface CrucibleServerEntry {
  /** How the operator names this server: `mac`, `droplet`. Never `local`. */
  name: string;
  /** The base URL, WITHOUT `/v1` — the SDK appends the version prefix itself. */
  url: string;
  /** The bearer token `crucible init` minted on that host. */
  token: string;
  /** When it was added, ISO 8601. */
  added: string;
}

/**
 * A server resolved for use: the local one (from its config) or a remote one
 * (from the registry). The only type that carries a plaintext token out of
 * this module.
 */
export interface ResolvedServer {
  /** The name it was asked for: `local`, or a registry name. */
  name: string;
  url: string;
  token: string;
  /** Which owner answered. */
  source: 'local' | 'registry';
  /** The local server's own name (`[server] name`) and config path; absent for a registry entry. */
  local?: { serverName: string; configPath: string; via: LocalServerVia };
}

/**
 * One remote server as it may be shown. Same record with the token replaced by
 * `****<last 4>`: a listing that cannot print a credential, because it does not
 * have one.
 */
export interface CrucibleServerListing {
  name: string;
  url: string;
  /** `****abcd` — enough to tell two tokens apart, not enough to use one. */
  tokenMasked: string;
  added: string;
  /**
   * `null` for a usable entry. `loopback_duplicates_local` for an entry whose
   * URL is this machine: a copy of the local server's token from before the
   * one-owner rule, refused at use and shown here so it can be removed.
   */
  stale: null | 'loopback_duplicates_local';
}

/** The local server as it may be shown, or the named reason there is none. */
export type LocalListing =
  | {
      present: true;
      /** `[server] name`, e.g. `crucible@owens-pc-wsl`. */
      serverName: string;
      url: string;
      tokenMasked: string;
      configPath: string;
      via: LocalServerVia;
    }
  | {
      present: false;
      code: CrucibleLocalError['code'];
      reason: string;
    };

/** Every way this registry refuses, each named by its `code`. */
export type CrucibleRegistryErrorCode =
  | 'unknown_server'
  | 'duplicate_server'
  | 'invalid_name'
  | 'invalid_url'
  | 'empty_token'
  | 'corrupt_registry'
  /** The name `local` is reserved for the server this machine's config describes. */
  | 'reserved_name'
  /** A loopback URL names the local server, which is read from its config, never registered. */
  | 'local_is_not_registered'
  /** A pre-rule registry entry for the local server; remove it and use `local`. */
  | 'stale_local_entry';

/**
 * A named refusal from the registry. Never a generic "something went wrong":
 * the `code` says which one it is, so a caller can act on it and the CLI can
 * exit with a message a reader can fix.
 */
export class CrucibleRegistryError extends Error {
  readonly code: CrucibleRegistryErrorCode;

  constructor(code: CrucibleRegistryErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleRegistryError';
    this.code = code;
  }
}

/**
 * `<userData>/crucible-servers.json`.
 *
 * Resolved through Electron's `app` at CALL time, not at import time, so the
 * headless CLI stub (cli/electron-stub.js) is already installed when this runs.
 */
export function registryPath(): string {
  return path.join(app.getPath('userData'), 'crucible-servers.json');
}

/** `****abcd` — a token rendered so it can be shown. */
export function maskToken(token: string): string {
  return `****${token.slice(-4)}`;
}

function listingOf(entry: CrucibleServerEntry): CrucibleServerListing {
  return {
    name: entry.name,
    url: entry.url,
    tokenMasked: maskToken(entry.token),
    added: entry.added,
    stale: isLoopbackUrl(entry.url) ? 'loopback_duplicates_local' : null,
  };
}

/**
 * The registry over one file, with the local reader it resolves `local` through.
 *
 * The app and the CLI use the module-level functions below, which bind this to
 * `<userData>` and the real host. A keeper constructs one over a temp file with
 * a scripted local reader, so every refusal is exercised without a WSL guest
 * and without touching the registry that holds Owen's real tokens.
 */
export class ServerRegistry {
  constructor(
    private readonly file: string,
    private readonly readLocal: () => LocalServer,
  ) {}

  /**
   * The registry as it is on disk.
   *
   * A missing file is an EMPTY registry — that is the honest reading of "no
   * servers have been added yet", not a fallback. A file that exists and does
   * not parse, or does not hold a `servers` array, is a refusal: it is a record,
   * and quietly starting over would lose every token in it.
   */
  private read(): RegistryFile {
    const file = this.file;
    if (!fs.existsSync(file)) return { servers: [] };

    let parsed: unknown;
    const raw = fs.readFileSync(file, 'utf-8');
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CrucibleRegistryError(
        'corrupt_registry',
        `${file} is not valid JSON (${(err as Error).message}). It holds the bearer token for `
          + 'every server, so nothing here will replace it — repair or delete the file by hand.',
      );
    }
    const servers = (parsed as { servers?: unknown } | null)?.servers;
    if (!Array.isArray(servers)) {
      throw new CrucibleRegistryError(
        'corrupt_registry',
        `${file} has no "servers" array. It holds the bearer token for every server, so nothing `
          + 'here will replace it — repair or delete the file by hand.',
      );
    }
    for (const entry of servers) {
      const row = entry as Partial<CrucibleServerEntry> | null;
      for (const key of ['name', 'url', 'token', 'added'] as const) {
        if (typeof row?.[key] === 'string' && row[key] !== '') continue;
        throw new CrucibleRegistryError(
          'corrupt_registry',
          `${file} holds an entry with no "${key}": every server needs a name, a url, a token and `
            + 'an added timestamp. Repair or delete the file by hand.',
        );
      }
    }
    return { servers: servers as CrucibleServerEntry[] };
  }

  /**
   * Write the registry beside itself and rename onto it.
   *
   * The file is created 0600 where the platform honours it: it holds bearer
   * tokens, and `crucible init` takes the same care on the server side (README:
   * "created at mode 0600 under a 0700 home, so it is never briefly
   * world-readable"). On Windows the mode is advisory, which is why the token is
   * ALSO never printed.
   */
  private write(registry: RegistryFile): void {
    const file = this.file;
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temp, file);
  }

  /** Every remote server, tokens masked. The listing type cannot carry one. */
  list(): CrucibleServerListing[] {
    return this.read().servers.map(listingOf);
  }

  /** The local server as it may be shown, or why there is none. Never throws for "none". */
  describeLocal(): LocalListing {
    let local: LocalServer;
    try {
      local = this.readLocal();
    } catch (err) {
      if (err instanceof CrucibleLocalError) {
        return { present: false, code: err.code, reason: err.message };
      }
      throw err;
    }
    return {
      present: true,
      serverName: local.name,
      url: local.url,
      tokenMasked: maskToken(local.token),
      configPath: local.configPath,
      via: local.via,
    };
  }

  /**
   * One server, WITH its token, or a refusal naming what is registered instead.
   *
   * `local` is answered by the local server's own config and never by the
   * registry. Any other name is a registry lookup. There is no "nearest match"
   * and no default server: a typo'd name is a typo, not an instruction to pick
   * one.
   */
  get(name: string): ResolvedServer {
    if (name === LOCAL_SERVER_NAME) {
      const local = this.readLocal();
      return {
        name: LOCAL_SERVER_NAME,
        url: local.url,
        token: local.token,
        source: 'local',
        local: { serverName: local.name, configPath: local.configPath, via: local.via },
      };
    }
    const { servers } = this.read();
    const found = servers.find((entry) => entry.name === name);
    if (!found) {
      const known = servers.map((entry) => entry.name).join(', ');
      throw new CrucibleRegistryError(
        'unknown_server',
        `no crucible server named "${name}" is registered `
          + `(${servers.length === 0 ? 'the registry is empty' : `known: ${known}`}; `
          + `"${LOCAL_SERVER_NAME}" always names the server on this machine). `
          + `Add it:  bookforge-tts --crucible-add --name ${name} --url <url> --token-file <path>`,
      );
    }
    if (isLoopbackUrl(found.url)) {
      throw new CrucibleRegistryError(
        'stale_local_entry',
        `"${name}" (${found.url}) is this machine's own Crucible, recorded with a COPY of its token `
          + 'from before the one-owner rule; a copy goes stale the moment `crucible init --force` '
          + `runs. Remove it (bookforge-tts --crucible-remove --name ${name}) and use --server `
          + `${LOCAL_SERVER_NAME}, which reads the server's own config.toml every time.`,
      );
    }
    return { name: found.name, url: found.url, token: found.token, source: 'registry' };
  }

  /**
   * Record a REMOTE server. Refuses, by name:
   *  - the reserved name `local`,
   *  - a loopback URL — that is the local server, which is read from its own
   *    config and never registered (see the module comment),
   *  - a name already in the registry (replacing it would silently repoint every
   *    later call at a different machine),
   *  - a URL with no scheme, or one carrying the `/v1` the SDK appends itself,
   *  - an empty token — a Crucible has no anonymous mode, so an entry without one
   *    is an entry that can only 401.
   */
  add(server: { name: string; url: string; token: string }): CrucibleServerListing {
    const name = server.name.trim();
    const url = server.url.trim();
    const token = server.token.trim();

    if (name === '') {
      throw new CrucibleRegistryError('invalid_name', 'a server needs a name to be reached by');
    }
    if (name === LOCAL_SERVER_NAME) {
      throw new CrucibleRegistryError(
        'reserved_name',
        `"${LOCAL_SERVER_NAME}" is reserved: it always means the Crucible on this machine, read from `
          + 'its own config.toml. It is never added, because it is never copied.',
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new CrucibleRegistryError(
        'invalid_name',
        `"${name}" is not a usable server name — letters, digits, dot, dash and underscore, `
          + 'starting with a letter or digit',
      );
    }
    if (!/^https?:\/\//.test(url)) {
      throw new CrucibleRegistryError(
        'invalid_url',
        `"${url}" has no http:// or https:// scheme. The base URL is not guessed here — a server `
          + 'reached over the wrong scheme is a different server',
      );
    }
    if (/\/v1\/?$/.test(url)) {
      throw new CrucibleRegistryError(
        'invalid_url',
        `"${url}" ends in /v1, which @crucible/client appends itself — record the base URL`,
      );
    }
    if (isLoopbackUrl(url)) {
      throw new CrucibleRegistryError(
        'local_is_not_registered',
        `"${url}" is this machine. The local Crucible is reached as --server ${LOCAL_SERVER_NAME}, `
          + 'which reads its token from the server\'s own config.toml — registering a copy is how '
          + 'the copy goes stale. Only servers on OTHER machines are registered here.',
      );
    }
    if (token === '') {
      throw new CrucibleRegistryError(
        'empty_token',
        `no token for "${name}". Every Crucible route except /v1/ping needs the bearer token `
          + '`crucible token --show` prints on that host; there is no anonymous mode',
      );
    }

    const registry = this.read();
    if (registry.servers.some((entry) => entry.name === name)) {
      throw new CrucibleRegistryError(
        'duplicate_server',
        `a crucible server named "${name}" is already registered. Remove it first `
          + `(--crucible-remove --name ${name}) rather than pointing the name at a second machine`,
      );
    }

    const entry: CrucibleServerEntry = {
      name,
      url: url.replace(/\/+$/, ''),
      token,
      added: new Date().toISOString(),
    };
    registry.servers.push(entry);
    this.write(registry);
    return listingOf(entry);
  }

  /**
   * Forget a server. Refuses a name that is not registered — see {@link get}.
   * A stale local entry IS removable: this is the door that repairs it.
   */
  remove(name: string): CrucibleServerListing {
    if (name === LOCAL_SERVER_NAME) {
      throw new CrucibleRegistryError(
        'reserved_name',
        `"${LOCAL_SERVER_NAME}" is not a registry entry; it is the server this machine's config.toml `
          + 'describes, and it goes away when that file does.',
      );
    }
    const registry = this.read();
    const index = registry.servers.findIndex((entry) => entry.name === name);
    if (index < 0) {
      const known = registry.servers.map((entry) => entry.name).join(', ');
      throw new CrucibleRegistryError(
        'unknown_server',
        `no crucible server named "${name}" is registered `
          + `(${registry.servers.length === 0 ? 'the registry is empty' : `known: ${known}`})`,
      );
    }
    const [removed] = registry.servers.splice(index, 1);
    this.write(registry);
    return listingOf(removed as CrucibleServerEntry);
  }
}

/**
 * The app's registry: `<userData>/crucible-servers.json`, resolving `local`
 * through the real host — on Windows, through the WSL distro the app is
 * configured with.
 */
function defaultRegistry(): ServerRegistry {
  return new ServerRegistry(registryPath(), () => readLocalServer(processHost(getWslDistro())));
}

/** Every remote server, tokens masked. See {@link ServerRegistry.list}. */
export function listServers(): CrucibleServerListing[] {
  return defaultRegistry().list();
}

/** The local server as it may be shown, or why there is none. See {@link ServerRegistry.describeLocal}. */
export function describeLocal(): LocalListing {
  return defaultRegistry().describeLocal();
}

/** One server with its token. See {@link ServerRegistry.get}. */
export function getServer(name: string): ResolvedServer {
  return defaultRegistry().get(name);
}

/** Record a remote server. See {@link ServerRegistry.add}. */
export function addServer(server: { name: string; url: string; token: string }): CrucibleServerListing {
  return defaultRegistry().add(server);
}

/** Forget a remote server. See {@link ServerRegistry.remove}. */
export function removeServer(name: string): CrucibleServerListing {
  const after = defaultRegistry().remove(name);
  /*
   * ITS ROUTES GO WITH IT.
   *
   * `crucible/routes.ts` remembers where each class runs on each engine, so
   * the scheduler can ask inside a synchronous pump. A record about a server
   * that is no longer registered is a record about nothing — and if the same
   * NAME is added again for a different machine, it would be answered from
   * for one pump before coordination corrects it, which is a row placed on a
   * lane nobody chose. Forgotten here rather than left to expire, because the
   * record has no expiry on purpose: age is not what makes a route wrong.
   *
   * Only on REMOVE, not on disable. A disabled server's routes are still true
   * of it, its set stays on the bench until its occupant lands (§4.3), and
   * forgetting them would make re-enabling it a wait rather than a resume.
   */
  forgetCrucibleRoutes(name);
  return after;
}

/**
 * A client bound to one server — `local`, or a registered remote.
 *
 * `clientName` lands in the `User-Agent` the SDK sends, so the server's log says
 * which app queued a job — it is required here for the same reason the SDK
 * requires it: an unnamed client in a shared server's log is an unanswerable
 * question.
 */
export function crucibleClientFor(name: string, clientName: string): CrucibleClient {
  const entry = getServer(name);
  return new CrucibleClient({ url: entry.url, token: entry.token, clientName });
}
