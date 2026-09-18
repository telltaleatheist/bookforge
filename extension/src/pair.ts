/**
 * Add a Crucible by typing its address — no token, ever, in a text box.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `servers.ts` takes a pasted `crucible://name@host:port/#token` connect code,
 * which is how BookForge and the operator page hand a server over. It works and
 * it stays. But it asks a person to carry a 43-character secret between two
 * windows, and Owen's objection (2026-09-17) is the right one: *"i should be
 * able to just type the ip"*.
 *
 * The engine has had the door for this all along and nothing used it.
 * `POST /v1/pairing/start` and `POST /v1/pairing/poll` sit on Crucible's PUBLIC
 * router — no bearer, by design — and implement the device-code handshake:
 *
 *   1. this extension asks to be let in, naming itself
 *   2. the engine answers with a short `user_code` (`386B-R6FA`) and a long
 *      `device_code` that only this extension ever sees
 *   3. the person approves that short code on the Crucible page, where they are
 *      already authenticated
 *   4. this extension polls with the DEVICE code and receives the token
 *
 * Measured end to end against 0.6.12 on 2026-09-17 before a line of this was
 * written: ping, start, the operator seeing it pending, poll saying `pending`,
 * the decision, and poll returning the token.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It does not discover servers. `crucible/connect.py` rate-limits `start` to one
 * request per address per five seconds and caps the table at 32, so sweeping a
 * subnet would be refused and would deserve to be. The address is typed.
 *
 * It weakens nothing. The token is disclosed only after an authenticated
 * operator approves; the short code is never accepted as the polling
 * credential; a request expires in five minutes. The secret in `device_code`
 * leaves this module only to the server it came from, and appears in no message
 * this file builds.
 */

import { CLIENT_NAME } from './servers';

/** How the engine advertises this handshake on `GET /v1/ping`. */
const SUPPORTED_PAIRING_VERSION = 1;

/** Crucible's port, when the typed address does not name one. */
const DEFAULT_PORT = 7100;

/** What `startPairing` hands to `pollForToken`, plus what the page must show. */
export interface PairingStart {
  /** The server's own name, as it answered ping. */
  readonly name: string;
  /** The normalised base URL the token will belong to. */
  readonly url: string;
  /** The engine's handle for this request. Not a secret. */
  readonly id: string;
  /** The polling credential. A SECRET: never displayed, never logged. */
  readonly deviceCode: string;
  /** The short code a person approves, e.g. `386B-R6FA`. Shown. */
  readonly userCode: string;
  /** Seconds until the engine forgets this request. */
  readonly expiresIn: number;
  /** Seconds the engine requires BETWEEN polls. It answers 429 if crowded. */
  readonly interval: number;
  /**
   * Whether a person has to approve `userCode` before a token is sent.
   *
   * FALSE on an engine that pairs openly, which is Crucible's default since
   * 2026-09-17 — reaching it is the whole of the authorisation, the way Ollama
   * works. There is then no code for anybody to approve and showing one would
   * be asking the user to go and do nothing.
   *
   * TRUE when the engine says so, AND when it says nothing: a server too old to
   * carry this field is a server from before the ruling, and every one of those
   * does require approval. That is reading an old server correctly, not
   * defaulting around a missing value.
   */
  readonly approvalRequired: boolean;
}

/**
 * Turn what a person typed into a base URL, or refuse and say why.
 *
 * `192.168.68.79`, `192.168.68.79:7100` and `http://192.168.68.79:7100` are the
 * same server and all three are accepted; a missing port means Crucible's own.
 * A trailing `/v1` is trimmed because that is what gets copied out of a browser
 * bar after visiting the API, and `CrucibleClient` appends its own.
 */
export function normaliseServerUrl(typed: string): string {
  const raw = typed.trim();
  if (raw === '') throw new Error('Type the address of a Crucible, e.g. 192.168.68.79');
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not an address this extension can dial.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `"${raw}" names ${parsed.protocol.replace(':', '')}, and a Crucible is reached over http or https.`,
    );
  }
  if (parsed.hostname === '') throw new Error(`"${raw}" has no host in it.`);
  const port = parsed.port === '' ? String(DEFAULT_PORT) : parsed.port;
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1')) path = path.slice(0, -3);
  return `${parsed.protocol}//${parsed.hostname}:${port}${path}`;
}

/** A refusal that carries the engine's own code, when it sent one. */
async function refusalFrom(response: Response, url: string): Promise<Error> {
  let code = '';
  let message = '';
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    code = typeof body?.error?.code === 'string' ? body.error.code : '';
    message = typeof body?.error?.message === 'string' ? body.error.message : '';
  } catch {
    // A refusal with no JSON body is reported by its status; inventing a
    // sentence for it would be inventing the reason.
  }
  if (code !== '' && message !== '') return new Error(`${url} refused this: ${code} — ${message}`);
  return new Error(`${url} answered HTTP ${response.status}.`);
}

/**
 * Ask a server to let this extension in. Returns the code a person approves.
 *
 * Pings FIRST, and not as a courtesy: `pairing/start` against something that is
 * not a Crucible answers 404, and the person would be told their address is
 * wrong when the address is right and the service is not. Ping tells those two
 * apart, which is the reason it is unauthenticated in the first place.
 */
export async function startPairing(typed: string): Promise<PairingStart> {
  const url = normaliseServerUrl(typed);
  let ping: Response;
  try {
    ping = await fetch(`${url}/v1/ping`, { cache: 'no-store' });
  } catch (err) {
    throw new Error(
      `Nothing answered at ${url}. Check the address, that the engine is running, and that this `
      + `browser is allowed to reach it. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!ping.ok) throw await refusalFrom(ping, url);
  const hello = await ping.json() as
    { crucible?: unknown; name?: unknown; pairing_version?: unknown };
  if (hello?.crucible !== true || typeof hello.name !== 'string') {
    throw new Error(`Something answers at ${url}, but it is not a Crucible.`);
  }
  if (hello.pairing_version !== SUPPORTED_PAIRING_VERSION) {
    throw new Error(
      `${hello.name} speaks pairing version ${String(hello.pairing_version)} and this extension `
      + `speaks ${SUPPORTED_PAIRING_VERSION}. Paste a connect code instead, or upgrade one of them.`,
    );
  }
  const response = await fetch(`${url}/v1/pairing/start`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Crucible-Api': '1' },
    body: JSON.stringify({ client_name: CLIENT_NAME }),
  });
  if (!response.ok) throw await refusalFrom(response, url);
  const body = await response.json() as Record<string, unknown>;
  for (const key of ['id', 'device_code', 'user_code'] as const) {
    if (typeof body[key] !== 'string' || body[key] === '') {
      throw new Error(`${hello.name} started a pairing with no "${key}", which cannot be completed.`);
    }
  }
  return {
    name: typeof body['name'] === 'string' ? body['name'] : hello.name,
    url,
    id: body['id'] as string,
    deviceCode: body['device_code'] as string,
    userCode: body['user_code'] as string,
    expiresIn: typeof body['expires_in'] === 'number' ? body['expires_in'] : 300,
    interval: typeof body['interval'] === 'number' ? body['interval'] : 2,
    approvalRequired: body['approval_required'] !== false,
  };
}

/** Where a poll ended up. `approved` is the only one that carries a token. */
export type PairingOutcome =
  | { readonly status: 'approved'; readonly name: string; readonly token: string }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' };

const sleep = (seconds: number) => new Promise((done) => { setTimeout(done, seconds * 1000); });

/**
 * Wait for the person to approve, deny, or let it lapse.
 *
 * The engine enforces its own spacing — two seconds, `pairing_slow_down` with
 * HTTP 429 if a caller crowds it — so that one refusal is WAITED OUT rather
 * than surfaced: it is this function polling too eagerly, not anything the
 * person did, and showing it to them would report our impatience as their
 * problem. Every other refusal is theirs to see.
 *
 * `onTick` exists so the page can count down without this module knowing what a
 * DOM is.
 */
export async function pollForToken(
  start: PairingStart,
  onTick?: (secondsLeft: number) => void,
): Promise<PairingOutcome> {
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    await sleep(start.interval);
    const response = await fetch(`${start.url}/v1/pairing/poll`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Crucible-Api': '1' },
      body: JSON.stringify({ id: start.id, device_code: start.deviceCode }),
    });
    if (response.status === 429) continue;
    if (!response.ok) throw await refusalFrom(response, start.url);
    const body = await response.json() as { status?: unknown; name?: unknown; token?: unknown };
    if (body?.status === 'approved') {
      if (typeof body.token !== 'string' || body.token === '') {
        throw new Error(`${start.name} approved this connection but sent no token.`);
      }
      return {
        status: 'approved',
        name: typeof body.name === 'string' ? body.name : start.name,
        token: body.token,
      };
    }
    if (body?.status === 'denied') return { status: 'denied' };
    if (body?.status === 'expired') return { status: 'expired' };
  }
  return { status: 'expired' };
}
