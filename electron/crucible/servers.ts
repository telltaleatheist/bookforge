/**
 * The Crucible server registry — which inference servers this machine knows.
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
 * ── Phase 1: no UI, no IPC ──────────────────────────────────────────────────
 *
 * Nothing in the app calls this yet, by design (crucible `docs/PLAN.md`, phase
 * 1B). The first and only consumer is `cli/crucible.js`, which loads the
 * COMPILED module out of dist/electron the same way every other CLI adapter
 * loads the app's own code. The seam is therefore proven through the shipped
 * build before a single renderer file moves.
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
 * it is handled like a credential: {@link listServers} cannot return it — it
 * returns a different type, carrying `tokenMasked` — and only
 * {@link getServer} and {@link crucibleClientFor}, which exist to use it, ever
 * see the plaintext. Making the list path structurally unable to leak is worth
 * more than remembering not to print it.
 *
 * ── No fallbacks ────────────────────────────────────────────────────────────
 *
 * Every refusal here is by name, with a {@link CrucibleRegistryError} whose
 * `code` says which one it is: an unknown server is not an empty client, a
 * duplicate name does not silently replace the entry it collides with, and a URL
 * without a scheme is refused rather than prefixed with a guessed `http://`.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleClient } from '@crucible/client';

/** The registry file's shape on disk. */
interface RegistryFile {
  servers: CrucibleServerEntry[];
}

/**
 * One server as recorded on disk. Carries the plaintext token, so it is only
 * ever handed out by {@link getServer} — the door whose whole purpose is to
 * authenticate a call.
 */
export interface CrucibleServerEntry {
  /** How the operator names this server: `wsl`, `mac`, `droplet`. */
  name: string;
  /** The base URL, WITHOUT `/v1` — the SDK appends the version prefix itself. */
  url: string;
  /** The bearer token `crucible init` minted on that host. */
  token: string;
  /** When it was added, ISO 8601. */
  added: string;
}

/**
 * One server as it may be shown. Same record with the token replaced by
 * `****<last 4>`: a listing that cannot print a credential, because it does not
 * have one.
 */
export interface CrucibleServerListing {
  name: string;
  url: string;
  /** `****abcd` — enough to tell two tokens apart, not enough to use one. */
  tokenMasked: string;
  added: string;
}

/** Every way this registry refuses, each named by its `code`. */
export type CrucibleRegistryErrorCode =
  | 'unknown_server'
  | 'duplicate_server'
  | 'invalid_name'
  | 'invalid_url'
  | 'empty_token'
  | 'corrupt_registry';

/**
 * A named refusal from the registry. Never a generic "something went wrong":
 * the `code` says which of the six it is, so a caller can act on it and the CLI
 * can exit with a message a reader can fix.
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
  };
}

/**
 * The registry as it is on disk.
 *
 * A missing file is an EMPTY registry — that is the honest reading of "no
 * servers have been added yet", not a fallback. A file that exists and does not
 * parse, or does not hold a `servers` array, is a refusal: it is a record, and
 * quietly starting over would lose every token in it.
 */
function readRegistry(): RegistryFile {
  const file = registryPath();
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
function writeRegistry(registry: RegistryFile): void {
  const file = registryPath();
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Every known server, tokens masked. The listing type cannot carry one. */
export function listServers(): CrucibleServerListing[] {
  return readRegistry().servers.map(listingOf);
}

/**
 * One server, WITH its token, or a refusal naming what is registered instead.
 * There is no "nearest match" and no default server: a typo'd name is a typo,
 * not an instruction to pick one.
 */
export function getServer(name: string): CrucibleServerEntry {
  const { servers } = readRegistry();
  const found = servers.find((entry) => entry.name === name);
  if (found) return found;
  const known = servers.map((entry) => entry.name).join(', ');
  throw new CrucibleRegistryError(
    'unknown_server',
    `no crucible server named "${name}" is registered `
      + `(${servers.length === 0 ? 'the registry is empty' : `known: ${known}`}). `
      + `Add it:  bookforge-tts --crucible-add --name ${name} --url <url> --token-file <path>`,
  );
}

/**
 * Record a server. Refuses, by name:
 *  - a name already in the registry (replacing it would silently repoint every
 *    later call at a different machine),
 *  - a URL with no scheme, or one carrying the `/v1` the SDK appends itself,
 *  - an empty token — a Crucible has no anonymous mode, so an entry without one
 *    is an entry that can only 401.
 */
export function addServer(server: { name: string; url: string; token: string }): CrucibleServerListing {
  const name = server.name.trim();
  const url = server.url.trim();
  const token = server.token.trim();

  if (name === '') {
    throw new CrucibleRegistryError('invalid_name', 'a server needs a name to be reached by');
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
  if (token === '') {
    throw new CrucibleRegistryError(
      'empty_token',
      `no token for "${name}". Every Crucible route except /v1/ping needs the bearer token `
        + '`crucible token --show` prints on that host; there is no anonymous mode',
    );
  }

  const registry = readRegistry();
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
  writeRegistry(registry);
  return listingOf(entry);
}

/** Forget a server. Refuses a name that is not registered — see {@link getServer}. */
export function removeServer(name: string): CrucibleServerListing {
  const registry = readRegistry();
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
  writeRegistry(registry);
  return listingOf(removed);
}

/**
 * A client bound to one registered server.
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
