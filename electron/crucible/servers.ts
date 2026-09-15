/**
 * THE CRUCIBLE SERVER REGISTRY — every inference server this machine knows.
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
 * ── ONE KIND OF SERVER (Owen's ruling, 2026-09-15) ─────────────────────────
 *
 * *"a local crucible server shouldnt be treated any differently than a remote
 * crucible server. it should all be entered the exact same way … bookforge
 * shouldnt even know if it's local because it doesnt mater"*
 *
 * There used to be two kinds here. The registry held REMOTE servers, and the
 * name `local` was RESERVED: `get('local')` answered out of a `config.toml`
 * (read through `wsl.exe` on Windows) instead of out of this file, a loopback
 * URL was REFUSED at the add door, and half the app carried a branch for the
 * difference. The rank record grew a row nobody had added, the bench drew a
 * heading no operator had typed, and coordination at start was that one row's
 * alone.
 *
 * All of it is deleted. **A Crucible server is a registry entry and nothing
 * else**: a name the operator chose, a URL and a token, added the same way
 * whether it answers on `127.0.0.1` or across the tailnet. Nothing here asks
 * which, and nothing can tell.
 *
 * What was NOT deleted is the convenience that made the reserved name look
 * necessary: `discovery.ts` still reads this machine's pairing file or
 * `config.toml` and answers *"here is what the entry for the Crucible on this
 * computer would look like"*. That answer PREFILLS the add form. It is not a
 * server until somebody adds it.
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
 * returns a different type, carrying `tokenMasked` — and only {@link getServer}
 * and {@link crucibleClientFor}, which exist to use it, ever see the plaintext.
 * Making the list path structurally unable to leak is worth more than
 * remembering not to print it.
 *
 * ── No fallbacks ────────────────────────────────────────────────────────────
 *
 * Every refusal here is by name, with a {@link CrucibleRegistryError} whose
 * `code` says which one it is: an unknown server is not an empty client, a
 * duplicate name does not silently replace the entry it collides with, a URL
 * without a scheme is refused rather than prefixed with a guessed `http://`,
 * and an unusable name is refused at the point of entry rather than repaired.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleClient } from '@crucible/client';
import { isLoopbackUrl } from './discovery';
import { forgetCrucibleRoutes } from './routes';
import { forgetResolvedEngine } from './engine-resolve';
import { LOCAL_WORK_SET, LONGFORM_ALIGN_SET } from '../../shared/queue/slot-sets';
import { RETIRED_LOCAL_NARRATOR_VENUE, WAIT_FOR_ANY } from '../../shared/queue/wait-for';

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
 * One server as recorded on disk. Carries the plaintext token, so it is only
 * ever handed out through {@link getServer} — the door whose whole purpose is to
 * authenticate a call.
 */
export interface CrucibleServerEntry {
  /** How the operator names this server: `3090 Ti`, `M1 Ultra`, `droplet`. */
  name: string;
  /** The base URL, WITHOUT `/v1` — the SDK appends the version prefix itself. */
  url: string;
  /** The bearer token `crucible init` minted on that host. */
  token: string;
  /** When it was added, ISO 8601. */
  added: string;
}

/**
 * A server resolved for use. The only type that carries a plaintext token out of
 * this module.
 */
export interface ResolvedServer {
  /** The name it is filed under. */
  name: string;
  url: string;
  token: string;
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
  | 'corrupt_registry'
  /**
   * The name is one of the queue's OWN bench rows, which are not servers:
   * `local-work` (what BookForge does itself), the long-form aligner's row, the
   * retired narrator venue, and `any` (what a row waits for when it will take
   * the first machine that answers). See {@link RESERVED_SET_IDS}.
   */
  | 'reserved_name';

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

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A SERVER MAY BE CALLED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NAMES ARE FREE TEXT NOW, so the rules are written down and enforced HERE.
 *
 * With `local` no longer reserved, a server's name is simply what the operator
 * typed, and Owen names machines after their cards — `3090 Ti`, `M1 Ultra`. So
 * spaces are legal, which they were not before. There is deliberately NO display
 * label beside the name: one string, shown everywhere, is what makes the bench
 * heading, the queue row's "waiting for", the log line and the registry all say
 * the same word.
 *
 * That makes the name load-bearing in places a name did not used to reach, and
 * each rule below closes one of them.
 */
export const MAX_SERVER_NAME_LENGTH = 48;

/**
 * IDS ON THE BENCH THAT ARE NOT SERVERS. A server may not take one of these
 * names, because the queue's own rows and its `waitFor` vocabulary are drawn
 * from the same string space (`shared/queue/slot-sets.ts`,
 * `shared/queue/wait-for.ts`) — a server called `local-work` would share a bench
 * row with BookForge's own CPU work and be allocated against it.
 *
 * Imported, never re-spelled: one fact, one owner (crucible
 * `docs/ARCHITECTURE.md` R1).
 */
export const RESERVED_SET_IDS: readonly string[] = [
  LOCAL_WORK_SET,
  LONGFORM_ALIGN_SET,
  RETIRED_LOCAL_NARRATOR_VENUE,
  WAIT_FOR_ANY,
];

/**
 * How two names are compared for "these are the same server".
 *
 * Case-INSENSITIVE, so `Mac` and `mac` cannot both be registered. Lookups stay
 * EXACT ({@link ServerRegistry.get}) — a queue row that names `Mac` is answered
 * about `Mac` or refused, never quietly resolved to `mac`, which would be the
 * fallback. The pair simply cannot exist, which is what makes the exact lookup
 * safe.
 */
export function serverNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The name, trimmed, or a {@link CrucibleRegistryError} saying what is wrong
 * with it. Called at the one moment a name enters the system.
 *
 * Trimming is not a repair: leading and trailing whitespace in a typed field is
 * invisible, so accepting `"mac "` as `mac` is reading the field, where
 * accepting it as a DIFFERENT name from `mac` would make two indistinguishable
 * rows. Everything else is refused rather than fixed.
 */
export function validateServerName(raw: string): string {
  const name = raw.trim();
  if (name === '') {
    throw new CrucibleRegistryError('invalid_name', 'a server needs a name to be reached by');
  }
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    throw new CrucibleRegistryError(
      'invalid_name',
      `"${name}" is ${name.length} characters and a server name may be at most `
        + `${MAX_SERVER_NAME_LENGTH}. The name is a bench heading and a queue row's "waiting for", `
        + 'so it has to fit on one.',
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    throw new CrucibleRegistryError(
      'invalid_name',
      'a server name may not contain control characters (a tab or a newline pasted in with it, '
        + 'usually). Type the name rather than pasting it.',
    );
  }
  if (name.includes(':')) {
    throw new CrucibleRegistryError(
      'invalid_name',
      `"${name}" contains a colon, which the queue uses to hang an engine's cloud lane off its `
        + 'name (`<server>:cloud`, shared/queue/slot-sets.ts). A name with one in it would make '
        + 'that split a guess.',
    );
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new CrucibleRegistryError(
      'invalid_name',
      `"${name}" contains a slash. The name becomes a browser session partition for that server's `
        + 'own console (electron/crucible/operator-window.ts), which is not a path.',
    );
  }
  if (/ {2,}/.test(name)) {
    throw new CrucibleRegistryError(
      'invalid_name',
      `"${name}" has two spaces in a row, which nobody can see. Single spaces only — "3090 Ti", `
        + 'not "3090  Ti".',
    );
  }
  const reserved = RESERVED_SET_IDS.find((id) => id.toLowerCase() === name.toLowerCase());
  if (reserved !== undefined) {
    throw new CrucibleRegistryError(
      'reserved_name',
      `"${reserved}" is one of the queue's own rows, not a server: it is how BookForge names its `
        + 'own work on the bench and what a job waits for. Call the machine something else — its '
        + 'card, usually.',
    );
  }
  return name;
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
 * The registry over one file.
 *
 * The app and the CLI use the module-level functions below, which bind this to
 * `<userData>`. A keeper constructs one over a temp file, so every refusal is
 * exercised without touching the registry that holds Owen's real tokens.
 */
export class ServerRegistry {
  constructor(private readonly file: string) {}

  /**
   * The registry as it is on disk.
   *
   * A missing file is an EMPTY registry — that is the honest reading of "no
   * servers have been added yet", not a fallback. A file that exists and does
   * not parse, or does not hold a `servers` array, is a refusal: it is a record,
   * and quietly starting over would lose every token in it.
   */
  read(): RegistryFile {
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
  write(registry: RegistryFile): void {
    const file = this.file;
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temp, file);
  }

  /** Every server, tokens masked. The listing type cannot carry one. */
  list(): CrucibleServerListing[] {
    return this.read().servers.map(listingOf);
  }

  /**
   * One server, WITH its token, or a refusal naming what is registered instead.
   *
   * EXACT on the name. There is no "nearest match", no case-folding at the
   * lookup and no default server: a typo'd name is a typo, not an instruction
   * to pick one. Two names that differ only by case cannot both be registered
   * ({@link serverNameKey}), which is what makes the exact match safe rather
   * than brittle.
   */
  get(name: string): ResolvedServer {
    const { servers } = this.read();
    const found = servers.find((entry) => entry.name === name);
    if (!found) {
      const known = servers.map((entry) => entry.name).join(', ');
      throw new CrucibleRegistryError(
        'unknown_server',
        `no crucible server named "${name}" is registered `
          + `(${servers.length === 0 ? 'the registry is empty' : `known: ${known}`}). `
          + `Add it:  bookforge-tts --crucible-add --name "${name}" --url <url> --token-file <path>`,
      );
    }
    return { name: found.name, url: found.url, token: found.token };
  }

  /**
   * Record a server — ANY server, wherever it runs. Refuses, by name:
   *  - a name that breaks one of {@link validateServerName}'s rules,
   *  - a name already in the registry, compared case-insensitively (replacing it
   *    would silently repoint every later call at a different machine),
   *  - a URL with no scheme, or one carrying the `/v1` the SDK appends itself,
   *  - an empty token — a Crucible has no anonymous mode, so an entry without one
   *    is an entry that can only 401.
   *
   * A LOOPBACK URL IS ORDINARY HERE. It used to be refused
   * (`local_is_not_registered`), because the server on this machine was read
   * from its own config under a reserved name. That is gone: a Crucible on
   * `127.0.0.1` is added exactly like one across the tailnet, and the token
   * recorded here is the only copy this app keeps of it either way.
   */
  add(server: { name: string; url: string; token: string }): CrucibleServerListing {
    const name = validateServerName(server.name);
    const url = server.url.trim();
    const token = server.token.trim();

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

    const registry = this.read();
    const key = serverNameKey(name);
    const collision = registry.servers.find((entry) => serverNameKey(entry.name) === key);
    if (collision !== undefined) {
      throw new CrucibleRegistryError(
        'duplicate_server',
        `a crucible server named "${collision.name}" is already registered`
          + `${collision.name === name ? '' : ` — names are compared without case, so "${name}" `
            + 'would be the same row'}`
          + `. Remove it first (--crucible-remove --name "${collision.name}") rather than pointing `
          + 'the name at a second machine',
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

  /** Forget a server. Refuses a name that is not registered — see {@link get}. */
  remove(name: string): CrucibleServerListing {
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

/** The app's registry: `<userData>/crucible-servers.json`. */
function defaultRegistry(): ServerRegistry {
  return new ServerRegistry(registryPath());
}

/** Every server, tokens masked. See {@link ServerRegistry.list}. */
export function listServers(): CrucibleServerListing[] {
  return defaultRegistry().list();
}

/** One server with its token. See {@link ServerRegistry.get}. */
export function getServer(name: string): ResolvedServer {
  return defaultRegistry().get(name);
}

/** Record a server. See {@link ServerRegistry.add}. */
export function addServer(server: { name: string; url: string; token: string }): CrucibleServerListing {
  return defaultRegistry().add(server);
}

/** Forget a server. See {@link ServerRegistry.remove}. */
export function removeServer(name: string): CrucibleServerListing {
  const after = defaultRegistry().remove(name);
  /*
   * WHICH PROCESS THAT ADDRESS RESOLVED TO GOES FIRST.
   *
   * `engine-resolve.ts` holds, for a minute, the engine behind each registered
   * address — and capability, placement and the bench read THROUGH that hop
   * now. So it is forgotten before anything else: a stale resolution would send
   * the next read to a machine the operator has just taken away, and one whose
   * NAME is re-added for a different machine would be answered about from the
   * old one.
   */
  forgetResolvedEngine(name);
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
 * WHICH REGISTERED SERVERS ANSWER ON THIS MACHINE'S LOOPBACK.
 *
 * Not a second kind of server and not a property of the entry — see
 * `discovery.ts`'s {@link isLoopbackUrl} for the one question this answers and
 * the one caller that asks it (the scheduler's one-card interlock, which exists
 * because BookForge still runs the long-form aligner on this machine's GPU
 * itself).
 */
export function serversOnThisMachine(): string[] {
  return listServers().filter((entry) => isLoopbackUrl(entry.url)).map((entry) => entry.name);
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
