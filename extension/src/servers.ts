/**
 * The Crucible server registry — which engines this extension knows about, and
 * which one it is speaking to.
 *
 * ── Why the extension has its own ───────────────────────────────────────────
 *
 * Phase 16 (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §0): the extension is a Crucible
 * client now, not a client of BookForge's WebSocket on 8766. It connects the
 * way the apps connect — a pasted `crucible://` connect code, parsed by the
 * SDK's `parsePairing` — but it CANNOT connect the way they connect at the file
 * level: BookForge reads `~/.crucible/pairing` off the disk and keeps its
 * registry in `<userData>/crucible-servers.json`, and a browser extension has
 * neither a home directory nor a userData path. So the operator page's Connect
 * panel and BookForge's Settings both offer the same "Copy connect code", and
 * this is where the paste lands.
 *
 * ── The token ───────────────────────────────────────────────────────────────
 *
 * A Crucible's bearer token is the whole of its auth, and it lives here in
 * `chrome.storage.local` in plaintext, because there is nowhere else in an
 * extension to put it: `chrome.storage.session` dies with the browser and a
 * user is not re-pasting a 43-character secret every morning. That storage is
 * per-profile and not reachable from a page, which is the same protection
 * BookForge's own registry file has on Windows (advisory modes).
 *
 * NOTHING HERE PUTS A TOKEN IN AN ERROR OR A LOG. `parsePairing` already elides
 * the fragment from its own refusals; every message this module builds names
 * the server and the URL and stops there.
 *
 * ── One selected server ─────────────────────────────────────────────────────
 *
 * There is exactly one, and it is a name rather than an index: a list that
 * re-orders must not silently re-point the reader at a different machine. A
 * selection naming a server that has been removed is not repaired by falling
 * back to the first one — it is reported as "nothing is selected", because a
 * page read aloud on a machine nobody chose is the failure this whole phase
 * exists to avoid.
 */

import { CruciblePairingError, CrucibleClient, parsePairing } from '@crucible/client';

/** What this extension calls itself in a server's log. */
export const CLIENT_NAME = 'bookforge-reader';

/** One registered server, as stored. */
export interface ServerEntry {
  /** The server's own name, from the connect code. `crucible@mac-studio`. */
  readonly name: string;
  /** Base URL, no trailing slash and no `/v1` — `CrucibleClient`'s shape. */
  readonly url: string;
  /** The bearer token. Never logged, never shown, never put in an error. */
  readonly token: string;
  /** ISO 8601, for the Options list. */
  readonly added: string;
}

/** The registry as a whole. */
export interface Registry {
  readonly servers: readonly ServerEntry[];
  /** The selected server's NAME, or null when none is selected. */
  readonly selected: string | null;
}

/** `chrome.storage.local` keys. Namespaced so they cannot collide with Settings. */
const SERVERS_KEY = 'crucibleServers';
const SELECTED_KEY = 'crucibleSelected';

/** A server may be shown; its token may not. `****abcd`, as BookForge masks it. */
export function maskToken(token: string): string {
  return `****${token.slice(-4)}`;
}

/**
 * Read the registry.
 *
 * A stored value of the wrong shape is REFUSED, not repaired: this file holds
 * every token the extension has, and quietly starting over would lose all of
 * them with nothing said.
 */
export async function loadRegistry(): Promise<Registry> {
  const stored = await chrome.storage.local.get([SERVERS_KEY, SELECTED_KEY]);
  const raw = stored[SERVERS_KEY];
  if (raw === undefined) return { servers: [], selected: null };
  if (!Array.isArray(raw)) {
    throw new Error(
      `chrome.storage.local["${SERVERS_KEY}"] is not a list. It holds the bearer token for every `
      + 'Crucible this extension knows; nothing here will overwrite it. Open the extension\'s '
      + 'storage and repair it, or clear that one key to start over.',
    );
  }
  const servers: ServerEntry[] = [];
  for (const entry of raw) {
    for (const key of ['name', 'url', 'token', 'added'] as const) {
      if (typeof (entry as Record<string, unknown>)?.[key] !== 'string'
          || (entry as Record<string, string>)[key] === '') {
        throw new Error(
          `A stored Crucible entry has no "${key}". Every server needs a name, a url, a token and `
          + 'an added date; an entry missing one cannot be used and is not guessed at.',
        );
      }
    }
    const e = entry as Record<string, string>;
    servers.push({ name: e['name'], url: e['url'], token: e['token'], added: e['added'] });
  }
  const selected = typeof stored[SELECTED_KEY] === 'string' ? stored[SELECTED_KEY] as string : null;
  return { servers, selected };
}

/** Write the registry back. Callers pass the whole thing. */
async function saveRegistry(registry: Registry): Promise<void> {
  await chrome.storage.local.set({
    [SERVERS_KEY]: registry.servers.map((s) => ({ ...s })),
    [SELECTED_KEY]: registry.selected,
  });
}

/**
 * Add a server from a pasted `crucible://` connect code.
 *
 * A code for a name already registered REPLACES that entry — re-pasting is how
 * a rotated token is applied, and refusing it would leave the user with a
 * broken server and no way to fix it but Remove-then-Add. The first server
 * added is selected, because a registry of one with nothing selected is a state
 * nobody means.
 */
export async function addFromPairing(line: string): Promise<ServerEntry> {
  let pairing;
  try {
    pairing = parsePairing(line);
  } catch (err) {
    if (err instanceof CruciblePairingError) {
      // `detail` says what was wrong with the SHAPE; the SDK has already
      // elided everything after `#` from the line it quotes, which is the half
      // of it that is a secret.
      throw new Error(`That is not a Crucible connect code: ${err.detail}`);
    }
    throw err;
  }
  const entry: ServerEntry = {
    name: pairing.name,
    url: pairing.url,
    token: pairing.token,
    added: new Date().toISOString(),
  };
  const registry = await loadRegistry();
  const servers = registry.servers.filter((s) => s.name !== entry.name);
  servers.push(entry);
  await saveRegistry({
    servers,
    selected: registry.selected ?? entry.name,
  });
  return entry;
}

/** Forget a server. Selecting nothing is a real state, so removing the selected
 *  one leaves NOTHING selected rather than picking a neighbour. */
export async function removeServer(name: string): Promise<void> {
  const registry = await loadRegistry();
  await saveRegistry({
    servers: registry.servers.filter((s) => s.name !== name),
    selected: registry.selected === name ? null : registry.selected,
  });
}

/** Choose the server every read, load and unload goes to. */
export async function selectServer(name: string): Promise<void> {
  const registry = await loadRegistry();
  if (!registry.servers.some((s) => s.name === name)) {
    throw new Error(`No Crucible named "${name}" is registered in this extension.`);
  }
  await saveRegistry({ servers: registry.servers, selected: name });
}

/**
 * The selected server, WITH its token, or null when none is selected.
 *
 * Null is an answer the caller must handle — "pick a server in Options" — and
 * never a reason to reach for the first entry in the list.
 */
export async function selectedServer(): Promise<ServerEntry | null> {
  const registry = await loadRegistry();
  if (registry.selected === null) return null;
  return registry.servers.find((s) => s.name === registry.selected) ?? null;
}

/** A client bound to one registered server, named so its log says who called. */
export function clientFor(entry: ServerEntry): CrucibleClient {
  return new CrucibleClient({ url: entry.url, token: entry.token, clientName: CLIENT_NAME });
}

/**
 * The one sentence every surface shows when nothing is selected. Written once
 * so the popup, the options page and the offscreen document say the same thing.
 */
export const NO_SERVER_SELECTED =
  'No Crucible is selected. Open this extension\'s Options and paste a connect code '
  + '(the operator page\'s "Copy connect code", or BookForge Settings → Crucible).';

/**
 * Host permission for one server's origin.
 *
 * The manifest asks for NO host permissions up front and lists
 * `http://*​/*` + `https://*​/*` as OPTIONAL, because the set of servers is the
 * user's and is not knowable at packaging time. Chrome grants an optional
 * permission only from a user gesture, so this is called from the Options
 * page's Add and Test buttons — never from the offscreen document, which has
 * no gesture to spend and would simply be refused.
 */
export function originPatternFor(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/*`;
}

/** Has the user already granted this extension access to that server's origin? */
export function hasOriginPermission(url: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPatternFor(url)] });
}

/** Ask for it. MUST be called synchronously inside a user gesture's handler. */
export function requestOriginPermission(url: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [originPatternFor(url)] });
}
