/**
 * THE FOUR CALLS `@crucible/client` IS GROWING, WRITTEN HERE UNTIL IT HAS THEM.
 *
 * ── A DATED SEAM, AND THE DAY IT DIES IS A RED TEST ────────────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §3.8 says the SDK gains `settings()`,
 * `putSettings(patch)`, `testUpstream(name, probe?)` and `readPairingFile()`,
 * plus `CapabilityRow.route`. The pinned tarball
 * (`vendor/crucible-client-0.6.0.tgz`) has none of them — the Crucible agent is
 * adding them now — and BookForge's half of phase 15 cannot wait for a
 * re-vendor, because the whole of §5 is built on those five names.
 *
 * So this module speaks the wire the doc specifies, against the doc's shapes
 * (`shared/crucible/settings-wire.ts`), and **`tools/test-crucible-settings-seam.js`
 * fails BY NAME the day the vendored SDK exports any of them**. The failure is
 * not a regression: it is the instruction to delete this file and point every
 * caller at `CrucibleClient`. A seam with no expiry is a second SDK, which is
 * the two-owners defect (crucible ARCHITECTURE.md R1) — this one has a date and
 * a test that enforces it.
 *
 * ── WHY RAW `fetch` AND NOT THE CLIENT ─────────────────────────────────────
 *
 * `CrucibleClient` exposes no generic request verb, deliberately: every route
 * it serves is a typed method. There is therefore nothing to extend — the
 * choice is a local HTTP call or nothing — and the local call is written to
 * translate refusals into the SAME named-code shape the SDK's `CrucibleRefused`
 * carries, so the call sites do not change shape when the seam goes.
 *
 * ── ONE THING THIS FILE ALSO OWNS, AND WHY ─────────────────────────────────
 *
 * {@link crucibleCapabilityWithRoutes}. `CrucibleClient.capability()` parses a
 * row into exactly five fields and **drops `route`** (`readCapabilityRow`,
 * `dist/esm/client.js`), so a route read through the SDK today is not merely
 * absent, it is silently discarded. The scheduler's `[cloud]` lane is decided
 * on that field, so reading it through a parser that throws it away would be a
 * lane that never appears with nothing saying why. This reads the route the
 * server sends; it goes with the rest of the seam.
 *
 * ── NOTHING HERE STORES ANYTHING ───────────────────────────────────────────
 *
 * PHASE15 §0: settings live in the engine and nowhere else. There is no cache,
 * no `<userData>` file, no module-level copy of a document, and no key ever
 * reaches this process's memory for longer than the one request that carries
 * it upward. `tools/test-no-cloud-doors.js` pins that BookForge writes no key
 * anywhere.
 */
import type {
  CrucibleCapabilityRow,
  CrucibleCapabilityView,
  CrucibleEngineSettings,
  CrucibleEngineSettingsPatch,
  CrucibleRouteKind,
  CrucibleRouteRow,
  CrucibleTextActName,
  CrucibleUpstreamModels,
  CrucibleUpstreamName,
  CrucibleUpstreamProbe,
  CrucibleUpstreamRow,
} from '../../shared/crucible/settings-wire';
import { CRUCIBLE_UPSTREAM_NAMES } from '../../shared/crucible/settings-wire';
import { CRUCIBLE_TEXT_ACTS } from './text-acts';
import { getServer } from './servers';

/**
 * THE NAMES THIS SEAM STANDS IN FOR.
 *
 * Read by the keeper, which asserts that `@crucible/client` exports NONE of
 * them. The list is here rather than in the test so that the thing being waited
 * for is named in the file that is waiting.
 */
export const SDK_SETTINGS_NAMES_AWAITED = [
  'settings',
  'putSettings',
  'testUpstream',
  'readPairingFile',
] as const;

/** The API version header every authenticated Crucible route requires. */
const API_VERSION_HEADER = 'X-Crucible-Api';
const API_VERSION = '1';

/**
 * How long a settings call waits. A settings write touches a config file and,
 * for a test, one upstream's model listing — none of it is card work, so a
 * minute is generous and an unbounded wait would park a settings screen on a
 * server that went away.
 */
const SETTINGS_TIMEOUT_MS = 60_000;

/**
 * Every way this seam refuses, by name.
 *
 * The first seven are the SERVER's own codes (PHASE15 §3.2) passed through
 * untranslated — a refusal renamed on the way past is a refusal nobody can look
 * up. The last three are this client's, and each is a different fix.
 */
export type CrucibleEngineSettingsErrorCode =
  /** A non-llm class was named in `routes`. */
  | 'route_not_routable'
  /** No slash, or an upstream name that is not one of the three. */
  | 'route_bad_model'
  /** The route names an upstream with no key/url — configure it in the same request. */
  | 'route_upstream_unconfigured'
  /** Removing an upstream a route still names. */
  | 'upstream_in_use'
  /** The upstream did not answer. */
  | 'upstream_unreachable'
  /** The upstream answered 401. */
  | 'upstream_rejected'
  /** Tested an upstream that has nothing configured and no probe was sent. */
  | 'upstream_unconfigured'
  /** This server has no settings door — it predates PHASE15. */
  | 'settings_door_absent'
  /** The server answered, and the body is not the document the contract describes. */
  | 'settings_document_unreadable'
  /** Nothing answered at that address, or the request could not be made. */
  | 'settings_unreachable'
  /** Any other named refusal the server sent. */
  | 'settings_refused';

export class CrucibleEngineSettingsError extends Error {
  readonly code: string;
  /** The server's `details`, verbatim. It names the field a refusal is about. */
  readonly details: unknown;

  constructor(code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'CrucibleEngineSettingsError';
    this.code = code;
    this.details = details;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The one request
// ─────────────────────────────────────────────────────────────────────────────

interface RequestOptions {
  method: 'GET' | 'PUT' | 'POST';
  route: string;
  body?: unknown;
}

/**
 * One authenticated call to one server, with every failure named.
 *
 * A 404 is told apart from every other refusal on purpose: on a server built
 * before PHASE15 the settings door simply is not mounted, and "this engine is
 * older than this app" has a different fix from "the key you typed was
 * rejected".
 */
async function request(server: string, options: RequestOptions): Promise<unknown> {
  const entry = getServer(server);
  const url = `${entry.url.replace(/\/+$/, '')}${options.route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${entry.token}`,
        [API_VERSION_HEADER]: API_VERSION,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new CrucibleEngineSettingsError(
      'settings_unreachable',
      `"${server}" did not answer ${options.method} ${options.route}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (response.ok) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CrucibleEngineSettingsError(
        'settings_document_unreadable',
        `"${server}" answered ${options.route} with something that is not JSON `
          + `(${JSON.stringify(text.slice(0, 120))}).`,
      );
    }
  }

  if (response.status === 404) {
    throw new CrucibleEngineSettingsError(
      'settings_door_absent',
      `"${server}" has no settings door (404 on ${options.route}). That server predates the one `
        + 'place routes and upstream keys live; upgrade it, and its own console gets a Settings '
        + 'panel at the same time.',
    );
  }

  let code = 'settings_refused';
  let message = text.trim() === '' ? `${response.status} with no body` : text.trim();
  let details: unknown = null;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } };
    const error = parsed.error;
    if (error !== undefined && error !== null && typeof error === 'object') {
      if (typeof error.code === 'string' && error.code !== '') code = error.code;
      if (typeof error.message === 'string' && error.message !== '') message = error.message;
      details = error.details ?? null;
    }
  } catch {
    // Not a Crucible refusal envelope. `message` stays the body, which is the
    // most a caller can be told, and the code stays the generic one rather than
    // being invented from a status number.
  }
  throw new CrucibleEngineSettingsError(code, `"${server}": ${message}`, details);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the document (PHASE15 3.1)
// ─────────────────────────────────────────────────────────────────────────────

function asObject(value: unknown, what: string, server: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" sent ${what} as ${value === null ? 'null' : typeof value}, and the contract `
        + 'says it is an object. Nothing was read.',
    );
  }
  return value as Record<string, unknown>;
}

function readRouteRow(value: unknown, act: string, server: string): CrucibleRouteRow {
  const row = asObject(value, `routes.${act}`, server);
  const route = row['route'];
  if (route !== 'local' && route !== 'upstream') {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" sent routes.${act}.route as ${JSON.stringify(route)}; the contract has exactly `
        + 'two values, "local" and "upstream".',
    );
  }
  const model = row['model'];
  if (model !== null && typeof model !== 'string') {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" sent routes.${act}.model as ${typeof model}; it is a string or null.`,
    );
  }
  return { route: route as CrucibleRouteKind, model: model as string | null };
}

function readUpstreamRow(value: unknown, name: string, server: string): CrucibleUpstreamRow {
  const row = asObject(value, `upstreams.${name}`, server);
  const configured = row['configured'];
  if (typeof configured !== 'boolean') {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" sent upstreams.${name}.configured as ${typeof configured}; it is the one field `
        + 'a window branches on and it is a boolean.',
    );
  }
  /*
   * `key_hint` and `url` are each absent on the upstreams they do not apply to
   * — ollama has no key, anthropic and openai have no url — so an absent one is
   * `null` here. That is not a defaulted value: the contract's own example
   * (§3.1) prints `"key_hint": null` for an unconfigured key, and the two
   * spellings mean the same thing to every reader of this shape.
   */
  const hint = row['key_hint'];
  const url = row['url'];
  return {
    configured,
    keyHint: typeof hint === 'string' && hint !== '' ? hint : null,
    url: typeof url === 'string' && url !== '' ? url : null,
  };
}

function readSettingsDocument(body: unknown, server: string): CrucibleEngineSettings {
  const doc = asObject(body, 'the settings document', server);
  const rawRoutes = asObject(doc['routes'], 'routes', server);
  const routes = {} as Record<CrucibleTextActName, CrucibleRouteRow>;
  for (const act of CRUCIBLE_TEXT_ACTS) {
    const row = rawRoutes[act];
    if (row === undefined) {
      throw new CrucibleEngineSettingsError(
        'settings_document_unreadable',
        `"${server}" sent a settings document with no routes."${act}". The contract says all four `
          + 'llm classes are always present, absent-means-local being a CONFIG FILE rule and not a '
          + 'wire rule — so a missing one is a server this app cannot read, not a local route.',
      );
    }
    routes[act] = readRouteRow(row, act, server);
  }

  const rawUpstreams = asObject(doc['upstreams'], 'upstreams', server);
  const upstreams = {} as Record<CrucibleUpstreamName, CrucibleUpstreamRow>;
  for (const name of CRUCIBLE_UPSTREAM_NAMES) {
    const row = rawUpstreams[name];
    if (row === undefined) {
      throw new CrucibleEngineSettingsError(
        'settings_document_unreadable',
        `"${server}" sent a settings document with no upstreams."${name}". All three are always `
          + 'listed, configured or not.',
      );
    }
    upstreams[name] = readUpstreamRow(row, name, server);
  }

  const allowance = doc['desktop_allowance_bytes'];
  if (typeof allowance !== 'number' || !Number.isFinite(allowance)) {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" sent desktop_allowance_bytes as ${typeof allowance}; it is a number of bytes.`,
    );
  }
  const backendKind = doc['backend_kind'];
  if (typeof backendKind !== 'string' || backendKind === '') {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" sent no backend_kind. Host mode says "none" and says it out loud; an absent one `
        + 'is a server that did not answer the question.',
    );
  }

  return { routes, upstreams, desktopAllowanceBytes: allowance, backendKind };
}

/** `GET /v1/settings` — the whole document, read, never cached. */
export async function crucibleEngineSettings(server: string): Promise<CrucibleEngineSettings> {
  return readSettingsDocument(await request(server, { method: 'GET', route: '/v1/settings' }), server);
}

/**
 * `PUT /v1/settings` — write through, and READ THE ANSWER.
 *
 * The response is the whole document after the write (§3.2), so a window never
 * has to guess what took: the caller replaces what it is drawing with what came
 * back rather than with what it sent.
 */
export async function putCrucibleEngineSettings(
  server: string,
  patch: CrucibleEngineSettingsPatch,
): Promise<CrucibleEngineSettings> {
  const body: Record<string, unknown> = {};
  if (patch.routes !== undefined) body['routes'] = patch.routes;
  if (patch.upstreams !== undefined) body['upstreams'] = patch.upstreams;
  if (patch.desktopAllowanceBytes !== undefined) {
    body['desktop_allowance_bytes'] = patch.desktopAllowanceBytes;
  }
  if (Object.keys(body).length === 0) {
    throw new CrucibleEngineSettingsError(
      'settings_refused',
      'an empty settings patch was not sent. A PUT with nothing in it would come back as the '
        + 'unchanged document and read like a successful save of whatever the screen happened to '
        + 'be holding.',
    );
  }
  return readSettingsDocument(
    await request(server, { method: 'PUT', route: '/v1/settings', body }),
    server,
  );
}

/**
 * `POST /v1/settings/upstreams/{name}/test` — what that account can reach.
 *
 * Test BEFORE Save (§5.2): the probe carries a key or a url that is NOT stored,
 * so a typo is a refusal rather than a saved credential that fails at chapter
 * nine. An empty probe tests what is already configured.
 */
export async function testCrucibleUpstream(
  server: string,
  name: CrucibleUpstreamName,
  probe: CrucibleUpstreamProbe,
): Promise<CrucibleUpstreamModels> {
  const body = await request(server, {
    method: 'POST',
    route: `/v1/settings/upstreams/${encodeURIComponent(name)}/test`,
    body: probe,
  });
  const doc = asObject(body, `the ${name} test result`, server);
  const models = doc['models'];
  if (!Array.isArray(models) || models.some((id) => typeof id !== 'string')) {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" answered the ${name} test without a list of model ids. The list is the whole `
        + 'point of the test: BookForge ships no cloud model list and shows what the upstream said.',
    );
  }
  return { models: models as string[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability, with the field the SDK's parser drops
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/capability`, **including `route`** (§3.3).
 *
 * The SDK's `capability()` builds each row from five named fields and discards
 * everything else, so `route` read through it is not missing — it is thrown
 * away, silently, which is worse. Until `CapabilityRow.route` lands this is the
 * read, and it is the read the scheduler's `[cloud]` lane depends on.
 *
 * A row with no `route` is refused rather than assumed `local`: assuming would
 * put an upstream-routed class on a GPU slot it will never use, and the whole
 * of §5.3's lane change turns on this one field being true.
 */
export async function crucibleCapabilityWithRoutes(server: string): Promise<CrucibleCapabilityView> {
  const body = asObject(
    await request(server, { method: 'GET', route: '/v1/capability' }),
    'the capability record',
    server,
  );
  const rawClasses = body['classes'];
  if (!Array.isArray(rawClasses)) {
    throw new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" sent a capability record with no classes array.`,
    );
  }
  const classes: CrucibleCapabilityRow[] = rawClasses.map((raw, index) => {
    const row = asObject(raw, `classes[${index}]`, server);
    const capability = row['capability'];
    const route = row['route'];
    if (typeof capability !== 'string' || capability === '') {
      throw new CrucibleEngineSettingsError(
        'settings_document_unreadable',
        `"${server}" sent a capability row with no class name at index ${index}.`,
      );
    }
    if (route !== 'local' && route !== 'upstream') {
      throw new CrucibleEngineSettingsError(
        'settings_document_unreadable',
        `"${server}" sent the "${capability}" capability row without a route (PHASE15 §3.3). The `
          + 'queue decides between a GPU slot and a cloud lane on that field, so a row without one '
          + 'is read as nothing rather than as "local" — upgrade that engine.',
      );
    }
    return {
      capability,
      enabled: row['enabled'] === true,
      selected: typeof row['selected'] === 'string' ? (row['selected'] as string) : '',
      reason: typeof row['reason'] === 'string' ? (row['reason'] as string) : '',
      shortfallBytes: typeof row['shortfallBytes'] === 'number'
        ? (row['shortfallBytes'] as number)
        : typeof row['shortfall_bytes'] === 'number' ? (row['shortfall_bytes'] as number) : 0,
      route: route as CrucibleRouteKind,
    };
  });
  const totalBytes = body['totalBytes'] ?? body['total_bytes'];
  const allowance = body['desktopAllowanceBytes'] ?? body['desktop_allowance_bytes'];
  const backendKind = body['backendKind'] ?? body['backend_kind'];
  return {
    backendKind: typeof backendKind === 'string' ? backendKind : '',
    totalBytes: typeof totalBytes === 'number' ? totalBytes : 0,
    desktopAllowanceBytes: typeof allowance === 'number' ? allowance : 0,
    classes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The pairing file (PHASE15 3.6, 5.1) — same seam, its own module
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `readPairingFile()` is the fourth name §3.8 gives the SDK, so it belongs to
 * this seam and goes with it. It LIVES in `pairing-file.ts` because `local.ts`
 * reads it, `servers.ts` reads `local.ts`, and this file reads `servers.ts` —
 * one module would be a require cycle through three owners of three different
 * facts. Re-exported here so the seam is still one name to delete.
 */
export {
  CRUCIBLE_HOME_ENV,
  CruciblePairingFileError,
  cruciblePairingFilePath,
  processPairingFileHost,
  readCruciblePairingFile,
} from './pairing-file';
export type { PairingFileHost, PairingFileReading } from './pairing-file';
