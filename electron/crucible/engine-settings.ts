/**
 * THE ENGINE'S OWN SETTINGS, PROJECTED ONTO THIS APP'S IPC WIRE.
 *
 * ── WHAT THIS REPLACED, AND WHY IT IS A THIRD OF THE SIZE ──────────────────
 *
 * `electron/crucible/settings-wire.ts` spoke `GET /v1/settings`,
 * `PUT /v1/settings`, the upstream test and `GET /v1/capability` over raw
 * `fetch`, because the vendored SDK had none of them. It does now — crucible
 * `docs/PHASE15-HOST.md` §3.8 landed in `vendor/crucible-client-0.6.0.tgz` as
 * `settings()`, `putSettings()`, `testUpstream()` and a `CapabilityRow.route`
 * — the seam's own keeper went red saying exactly that, and the HTTP is gone.
 * All four calls are now one line each on `CrucibleClient`.
 *
 * What is left is a PROJECTION: the SDK's types in, the shapes of
 * `shared/crucible/settings-wire.ts` out. That is the job `probe.ts` already
 * does for `info`/`activity`/`models`, and it exists for the reason its header
 * gives — the renderer has no `@crucible/client` and must not re-spell its
 * types, so somebody carries the SDK's answers across the seam, and ONE module
 * doing it is one owner of that translation (crucible ARCHITECTURE.md R1).
 *
 * ── THE CAPABILITY ROUTE, AND THE ONE DEFECT THAT IS NOT WORKED AROUND ────
 *
 * `CapabilityRow.route` was the whole reason the old seam had a capability
 * reader at all: the SDK's parser built a row out of five named fields and
 * DROPPED the sixth, so a route read through it was not merely missing, it was
 * discarded — and the queue's `[cloud]` lane is decided on that field
 * (`shared/queue/slot-sets.ts`). The SDK keeps it now, so
 * {@link crucibleCapabilityWithRoutes} is a projection like the other three,
 * and the three-case reading of §3.3 belongs to the SDK's parser.
 *
 * And since the 0.6.0 re-pack (`1a1fb892`, 2026-09-14) it MAKES all three.
 * A document in which NO row carries `route` is a server that predates the
 * field, and §3.3 pins that for both apps by name — *"every class on such a
 * server IS local … BookForge's helper and Foundry's package K alike"* —
 * which `readCapabilityRow` now reads exactly that way (no row has it ⇒
 * `local`; SOME rows have it ⇒ refused, naming the row; a value that is
 * neither ⇒ refused, naming the value).
 *
 * Until that re-pack the SDK refused the routeless document, and this file
 * deliberately did NOT work around it: catching that refusal and reading
 * `local` out of it would have been this app holding a second opinion about a
 * document the SDK owns, which is the two-owners defect the seam was deleted
 * to end (ARCHITECTURE.md R1). `tools/test-crucible-settings-seam.js` carried
 * the tripwire that pinned the defect in the open. **Because nothing was
 * worked around, inverting that check was the entire fix — no code in this
 * file changed, and this paragraph is the only thing that had to.**
 *
 * ── NOTHING HERE STORES ANYTHING ───────────────────────────────────────────
 *
 * PHASE15 §0: settings live in the engine and nowhere else. There is no cache,
 * no `<userData>` file, no module-level copy of a document, and no key ever
 * reaches this process's memory for longer than the one request that carries
 * it upward. `tools/test-no-cloud-doors.js` pins that BookForge writes no key
 * anywhere.
 */
import {
  CrucibleAuthError,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
  type CapabilityRecord,
  type SettingsDocument,
  type SettingsPatch,
  type UpstreamSetting,
  type UpstreamTestResult,
} from '@crucible/client';
import type {
  CrucibleCapabilityRow,
  CrucibleCapabilityView,
  CrucibleEngineSettings,
  CrucibleEngineSettingsPatch,
  CrucibleEngineSettingsRefusal,
  CrucibleRouteRow,
  CrucibleTextActName,
  CrucibleUpstreamName,
  CrucibleUpstreamProbe,
  CrucibleUpstreamRow,
  CrucibleUpstreamTestResult,
} from '../../shared/crucible/settings-wire';
import { CRUCIBLE_UPSTREAM_NAMES } from '../../shared/crucible/settings-wire';
import { CRUCIBLE_TEXT_ACTS } from './text-acts';
import { crucibleClientFor, CRUCIBLE_CLIENT_NAME } from './servers';
import {
  noteCrucibleRoutes,
  noteCrucibleServedClasses,
  noteCrucibleUpstreams,
  routesFromCapability,
  routesFromSettings,
} from './routes';

/**
 * Every way this door refuses, by name.
 *
 * ── WHICH NAMES ARE THE SERVER'S AND WHICH ARE THIS APP'S ─────────────────
 *
 * The first six are the SERVER's own codes (PHASE15 §3.2), and they are not
 * listed here because this file produces them — they arrive on
 * `CrucibleRefused.code` and are passed through UNTRANSLATED. A refusal renamed
 * on the way past is a refusal nobody can look up, and the SDK even exports
 * each of these as a constant so a caller comparing codes compares against one
 * spelling of it.
 *
 * The rest are this client's, and each exists because the SDK has NO name for
 * the thing it describes — a typed error with no `code` cannot cross an IPC
 * boundary as a code, and a panel that has to `instanceof` an SDK class in the
 * renderer is a renderer with a copy of the SDK in it.
 */
export type CrucibleEngineSettingsErrorCode =
  /** A non-llm class was named in `routes`. The server's, passed through. */
  | 'route_not_routable'
  /** No slash, or an upstream name that is not one of the three. The server's. */
  | 'route_bad_model'
  /** The route names an upstream with no key/url. The server's. */
  | 'route_upstream_unconfigured'
  /** Removing an upstream a route still names. The server's. */
  | 'upstream_in_use'
  /** A name that is not one of the three. The server's. */
  | 'unknown_upstream'
  /** An upstream handed a field it does not take (a `url` for `anthropic`). The server's. */
  | 'upstream_bad_field'
  /** That door is not mounted on this server — it predates PHASE15. THIS CLIENT'S. */
  | 'settings_door_absent'
  /**
   * The server answered, and the body is not the document the contract
   * describes — the SDK's `CrucibleProtocolError`, which names the field path
   * it could not read and carries no code of its own.
   *
   * THE TWO CAPABILITY ROUTE DEFECTS ARRIVE HERE, and they used to have names
   * of their own (`capability_route_missing`, `capability_route_unknown`).
   * Those names are gone because the SDK's parser now refuses both documents
   * itself, and a second reader inventing a nicer name for a refusal the SDK
   * already made is the two-owners defect wearing a label (§3.3 is the
   * contract; `readCapabilityRow` is the implementation of it). What was lost
   * is the class NAME in the sentence — the SDK names the row by index and
   * field path, `capability.classes[1] has no field "route"` — and that is the
   * SDK's to improve, not this file's to re-derive.
   */
  | 'settings_document_unreadable'
  /** Nothing answered at that address, or the request could not be made. */
  | 'settings_unreachable'
  /** A refusal this client refuses to send, before anything crosses the wire. */
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

/**
 * THE REFUSAL AS A SCREEN NEEDS IT — code, sentence, and the control it is about.
 *
 * ── Why the projection lives here and not at the IPC handler ───────────────
 *
 * {@link CrucibleEngineSettingsError.details} is the SERVER's `details` object,
 * verbatim and typed `unknown`, because this file's job is to pass a refusal
 * through without renaming it. Somebody still has to say what shape that object
 * has — `details.field` is a dotted path and `details.classes` is a list of
 * class names (crucible `docs/PHASE15-HOST.md` §3.2, "The `details` keys,
 * pinned") — and the module that owns the error is the only honest place for
 * that sentence. Written in `main.ts` instead it would be a second reader of a
 * shape this file already claims to carry, in a file that has no other reason
 * to know the contract (ARCHITECTURE.md R1).
 *
 * **Nothing here is invented.** A refusal that carried no `field` comes back
 * with `field: null`, and the panel then has nowhere particular to put the
 * sentence and says it at the top — which is the truth about that refusal, not
 * a gap to be filled with a guessed control name. Same for `classes`.
 */
export function crucibleSettingsRefusalOf(
  err: CrucibleEngineSettingsError,
): CrucibleEngineSettingsRefusal {
  const details = err.details;
  let field: string | null = null;
  let classes: string[] | null = null;
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    const bag = details as Record<string, unknown>;
    if (typeof bag['field'] === 'string' && bag['field'] !== '') field = bag['field'];
    const raw = bag['classes'];
    if (Array.isArray(raw) && raw.every((c) => typeof c === 'string')) classes = raw as string[];
  }
  return { code: err.code, message: err.message, field, classes };
}

// ─────────────────────────────────────────────────────────────────────────────
// One SDK failure, as the one error the callers catch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SDK's typed errors as the named refusal this door's callers handle.
 *
 * ── PASS THE CODE, DO NOT MINT ONE ────────────────────────────────────────
 *
 * Every error the SDK raises for a refusal the SERVER made already carries the
 * server's own `code`, so this hands that code onward unchanged. The codes that
 * are minted here are exactly the ones for failures that are NOT a server
 * refusal and therefore have no server code to carry: a transport failure
 * (`CrucibleUnreachable` names a url and nothing else) and a body that is not
 * the contract's (`CrucibleProtocolError` names a field path and nothing else).
 * Both still have to cross an IPC boundary as a code, because the renderer has
 * no `@crucible/client` to `instanceof` against.
 *
 * ── THE ONE 404 THAT IS NOT `not_found` ───────────────────────────────────
 *
 * A 404 whose code is the router's generic `not_found` (`crucible/api.py`:
 * `{404: "not_found", 405: "method_not_allowed"}`) means the door is not
 * mounted at all, which is a server that predates PHASE15 and has a completely
 * different fix from "the key you typed was rejected". The SDK does not
 * distinguish it — nothing could, from the code alone; it takes knowing WHICH
 * route was asked for, which is why `door` is a parameter — so
 * `settings_door_absent` is minted here.
 *
 * A 404 that carries any OTHER code is a refusal the server named, and it goes
 * through with that name. Renaming `unknown_upstream` to "this server is old"
 * would be the exact defect the paragraph above forbids.
 */
function settingsFailure(server: string, door: string, err: unknown): unknown {
  if (err instanceof CrucibleRefused) {
    if (err.status === 404 && err.code === 'not_found') {
      return new CrucibleEngineSettingsError(
        'settings_door_absent',
        `"${server}" has no ${door} door (404). That server predates the one place routes and `
          + 'upstream keys live; upgrade it, and its own console gets a Settings panel at the '
          + 'same time.',
      );
    }
    return new CrucibleEngineSettingsError(err.code, `"${server}": ${err.serverMessage}`, err.details);
  }
  if (err instanceof CrucibleAuthError || err instanceof CrucibleVersionError
    || err instanceof CrucibleServerError) {
    return new CrucibleEngineSettingsError(err.code, `"${server}": ${err.serverMessage}`);
  }
  if (err instanceof CrucibleUnreachable) {
    return new CrucibleEngineSettingsError('settings_unreachable', `"${server}": ${err.message}`);
  }
  if (err instanceof CrucibleProtocolError) {
    return new CrucibleEngineSettingsError(
      'settings_document_unreadable',
      `"${server}" answered ${door} with something that is not the document the contract `
        + `describes: ${err.detail}`,
    );
  }
  /*
   * NOT OURS, NOT RENAMED. A registry miss, a `CrucibleConfigError` from the
   * client factory, or a defect in this process is not a settings refusal, and
   * giving it a settings code would put a wrong fix in front of somebody. It
   * goes back as it came, which is what the IPC handlers' `error` branch is for.
   */
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the document (PHASE15 3.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SDK's `SettingsDocument` as this app's, and the one check the SDK's
 * parser does not make.
 *
 * `readSettings` insists on `upstreams` (all three, by name), on
 * `desktop_allowance_bytes` and on `backend_kind`, so none of those is checked
 * again here — a second reader of the same fact is the thing this file exists
 * not to be. It reads `routes` as whatever keys the document carried, though,
 * because the SDK serves clients that do not know what a text act is. THIS app
 * does: all four llm classes are always present on the wire, absent-means-local
 * being a CONFIG FILE rule and not a wire rule (§3.1), so a missing one is a
 * server this app cannot read rather than a local route.
 */
function projectSettings(doc: SettingsDocument, server: string): CrucibleEngineSettings {
  const routes = {} as Record<CrucibleTextActName, CrucibleRouteRow>;
  for (const act of CRUCIBLE_TEXT_ACTS) {
    const row = doc.routes[act];
    if (row === undefined) {
      throw new CrucibleEngineSettingsError(
        'settings_document_unreadable',
        `"${server}" sent a settings document with no routes."${act}". The contract says all four `
          + 'llm classes are always present, absent-means-local being a CONFIG FILE rule and not a '
          + 'wire rule — so a missing one is a server this app cannot read, not a local route.',
      );
    }
    routes[act] = { route: row.route, model: row.model };
  }

  const upstreams = {} as Record<CrucibleUpstreamName, CrucibleUpstreamRow>;
  for (const name of CRUCIBLE_UPSTREAM_NAMES) {
    const row: UpstreamSetting = doc.upstreams[name];
    /*
     * `keyHint` and `url` are each ABSENT on the upstreams they do not apply to
     * — ollama has no key, anthropic and openai have no url — and the SDK keeps
     * that absence rather than flattening it, deliberately ("read what is there
     * rather than demanding both"). This wire spells the same fact `null`,
     * because the contract's own example (§3.1) prints `"key_hint": null` for
     * an unconfigured key and both spellings mean one thing to every reader of
     * this shape. It is a translation between two ways of saying "there is no
     * such field here", not a default filled in for a missing one.
     */
    upstreams[name] = {
      configured: row.configured,
      keyHint: row.keyHint === undefined ? null : row.keyHint,
      url: row.url === undefined ? null : row.url,
    };
  }

  /*
   * THE QUEUE'S CLOUD LANE IS RECORDED HERE, and this is the one funnel every
   * settings document passes through — the GET at coordination and the whole
   * document `PUT /v1/settings` answers with (§3.2) alike. So an upstream
   * configured from this app's own panel, or read off a machine at connect,
   * reaches the scheduler by the same line, and neither caller can forget it.
   *
   * ANY of the three, because the lane means "this engine can forward work",
   * not "it can forward it to Anthropic": which upstream a class goes to is the
   * route's business, and the lane counts sockets rather than accounts
   * (`shared/queue/slot-sets.ts`, `CLOUD_LANE_SLOTS`).
   *
   * `configured` is the SERVER's own boolean about its own stored key or url
   * (§3.1), read rather than re-derived from `keyHint`: a key hint is what a
   * panel prints, and an upstream configured with a url and no key would read
   * as unconfigured if this counted hints (crucible ARCHITECTURE.md R1).
   */
  noteCrucibleUpstreams(
    server,
    CRUCIBLE_UPSTREAM_NAMES.some((name) => upstreams[name].configured),
  );

  return {
    routes,
    upstreams,
    desktopAllowanceBytes: doc.desktopAllowanceBytes,
    backendKind: doc.backendKind,
    localModels: projectLocalModels(doc, server),
  };
}

/**
 * The two model-assignment maps, both REQUIRED.
 *
 * This read a document with neither as a VINTAGE — a server older than model
 * assignment — and drew the panel disabled with a sentence saying so. Owen
 * ended that on 2026-09-16: *"I won't be releasing any of this until it's
 * completely done, so we don't need to worry about legacy functionality at all
 * right now. Nothing is legacy because nothing exists publicly. There will be
 * no person trying to access the system with an older version of crucible
 * other than us."*
 *
 * So the vintage path served nobody, and it cost a branch in every reader plus
 * a `null` that each of them had to remember the meaning of. The SDK now reads
 * both as required and refuses a document without them by name and with the
 * field path, which means this function keeps only the shape translation.
 *
 * The empty case is still real and still different: `local_model_choices` is
 * `{}` on an engine that has not measured its card yet (`crucible/settings.py`
 * returns `{}` when `config.capability` is None), and `/v1/capability` says
 * `capability_undecided` by name. That is an engine answering the question
 * with nothing, which was always a different claim from not answering it.
 */
function projectLocalModels(
  doc: SettingsDocument,
  server: string,
): CrucibleEngineSettings['localModels'] {
  return {
    selected: { ...doc.localModels },
    choices: Object.fromEntries(
      Object.entries(doc.localModelChoices).map(([capability, rows]) => [
        capability,
        rows.map((row) => ({
          id: row.id,
          memoryBytesEstimate: row.memoryBytesEstimate,
          fits: row.fits,
          installed: row.installed,
        })),
      ]),
    ),
  };
}

/** `GET /v1/settings` — the whole document, read, never cached. */
export async function crucibleEngineSettings(server: string): Promise<CrucibleEngineSettings> {
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  try {
    return projectSettings(await client.settings(), server);
  } catch (err) {
    throw settingsFailure(server, 'GET /v1/settings', err);
  }
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
  /*
   * The routes half is copied key by key, and the ONLY thing dropped is a key
   * whose value is `undefined`.
   *
   * The two types disagree about one thing: this app's patch is keyed by the
   * four text acts, so its values are `string | undefined`, while the SDK's is
   * an open `Record<string, string>`. A class named with `undefined` would
   * travel as `{"clean": undefined}`, which `JSON.stringify` silently drops
   * and which no later reader could tell from a class deliberately left alone
   * — stating only what was stated is what makes a patch partial (§3.2).
   *
   * WHAT IS **NOT** FILTERED IS THE KEY. A class this build has never heard of
   * — `tts`, or whatever the next phase adds — is forwarded exactly as it was
   * given, because `route_not_routable` is the SERVER's refusal to make
   * (§3.2) and it names the field. Keeping only the four acts this app knows
   * would turn "you cannot route that class" into a 200 and an unchanged
   * document, which reads as a save that worked.
   */
  const routes: Record<string, string> = {};
  if (patch.routes !== undefined) {
    for (const [act, value] of Object.entries(patch.routes)) {
      if (value !== undefined) routes[act] = value;
    }
  }
  const sent: SettingsPatch = {
    ...(patch.routes === undefined ? {} : { routes }),
    ...(patch.upstreams === undefined ? {} : { upstreams: patch.upstreams }),
    ...(patch.desktopAllowanceBytes === undefined
      ? {}
      : { desktopAllowanceBytes: patch.desktopAllowanceBytes }),
    /*
     * `localModels` PASSES THROUGH WHOLE, keys and all — `null` included,
     * because null is the value that hands the choice back to the engine and
     * dropping it would turn "decide this yourself" into "change nothing". The
     * key is not filtered for the same reason `routes` above is not: which
     * classes are selectable is the SERVER's to refuse, by name
     * (`local_model_not_selectable`), and a class quietly removed here would
     * come back 200 with an unchanged document, which a panel draws as a save.
     */
    ...(patch.localModels === undefined ? {} : { localModels: patch.localModels }),
  };
  /*
   * AN EMPTY PATCH NEVER LEAVES THIS PROCESS, and it is refused here rather
   * than at the door because of what the door would answer: `PUT /v1/settings`
   * with nothing in it comes back as the UNCHANGED document and a 200, which a
   * panel would draw as a successful save of whatever it happened to be
   * holding. The SDK sends what it is given (`settingsPayload` omits only what
   * the caller left unstated), so the check belongs to whoever builds the
   * patch, and this is the one place every patch goes through.
   */
  if (Object.keys(sent).length === 0) {
    throw new CrucibleEngineSettingsError(
      'settings_refused',
      'an empty settings patch was not sent. A PUT with nothing in it would come back as the '
        + 'unchanged document and read like a successful save of whatever the screen happened to '
        + 'be holding.',
    );
  }

  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  let after: CrucibleEngineSettings;
  try {
    after = projectSettings(await client.putSettings(sent), server);
  } catch (err) {
    throw settingsFailure(server, 'PUT /v1/settings', err);
  }
  /*
   * THE WRITE-THROUGH PATH IS WHAT INVALIDATES THE ROUTE RECORD, and it costs
   * no round trip: the answer to a PUT is the whole document after the write
   * (§3.2), so the new routes are already in hand. Recorded HERE rather than
   * at the call sites because a caller that forgot would leave the scheduler
   * placing rows on the lane the operator just changed — and this is the one
   * function through which a route can change from inside this app.
   */
  noteCrucibleRoutes(server, routesFromSettings(after.routes));
  return after;
}

/**
 * `POST /v1/settings/upstreams/{name}/test` — what that account can reach.
 *
 * Test BEFORE Save (§5.2): the probe carries a key or a url that is NOT stored,
 * so a typo is a refusal rather than a saved credential that fails at chapter
 * nine. An empty probe tests what is already configured.
 *
 * IT ANSWERS, IT DOES NOT THROW, and that is now the SDK's own shape rather
 * than one this app matched in advance: `testUpstream` returns
 * `{ok: false, code, message}` for `upstream_unreachable`, `upstream_rejected`
 * and `upstream_unconfigured` (its `UPSTREAM_TEST_REFUSALS`) and throws for
 * everything else. So the list of the three codes that used to live here is
 * gone — it had one honest owner and this was never it. All that is left is the
 * shape: the SDK's flat `{code, message}` becomes this wire's nested `refusal`,
 * which is the shape a panel draws beside the field.
 *
 * Everything else still throws: a server that is not there, a 404 on the door,
 * a body that is not the contract's. Those are not answers about the upstream.
 */
export async function testCrucibleUpstream(
  server: string,
  name: CrucibleUpstreamName,
  probe: CrucibleUpstreamProbe,
): Promise<CrucibleUpstreamTestResult> {
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  let result: UpstreamTestResult;
  try {
    result = await client.testUpstream(name, probe);
  } catch (err) {
    throw settingsFailure(server, 'the upstream test', err);
  }
  return result.ok
    ? { ok: true, models: result.models }
    : { ok: false, refusal: { code: result.code, message: result.message } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability, and the field the queue's cloud lane turns on
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/capability`, **with `route`** (§3.3).
 *
 * ── WHY THIS FUNCTION STILL HAS A NAME OF ITS OWN ─────────────────────────
 *
 * It is a projection now — the SDK reads the record, including the sixth field
 * its parser used to drop — but it is not a bare re-export, and the extra line
 * is the reason: **a read of capability is a read of the routes, so it is
 * recorded**. `noteCrucibleRoutes` is what lets the scheduler answer "does this
 * class run on the card or in somebody's account" inside a synchronous pump
 * (`shared/queue/slot-sets.ts`), and coordination makes this read on every
 * connect (PHASE14 §4a), which is what fills that record with nothing polling.
 * A caller given `client.capability()` directly would leave it empty, and an
 * empty record is a WAIT rather than a guess — correct, and a queue that never
 * moves.
 *
 * ── THE THREE-CASE READING OF `route` IS THE SDK'S ────────────────────────
 *
 * §3.3 settles it for both apps (crucible `eb59f7b`), and all three cases are
 * decided by `readCapabilityRow` rather than here:
 *
 *  1. **NO row carries `route`** — a server built before phase 15, on which
 *     every class IS local, because it has no upstreams and nothing to forward
 *     to. A STATED FACT about that server, not a default filled in for a
 *     missing field. **The SDK refuses this document today instead of reading
 *     it**, which is a known defect being fixed under this same version; it is
 *     not compensated for here, because a client that caught the refusal and
 *     read `local` out of it would be a second opinion about a document the
 *     SDK owns. The tripwire is in `tools/test-crucible-settings-seam.js`.
 *  2. **Some rows carry it and one does not** — a defect, refused. The SDK
 *     names the row by its index and the field it could not read.
 *  3. **Present and not `local` or `upstream`** — a value from a newer
 *     contract, refused. Guessing which half of it to believe would put work
 *     on the wrong lane.
 *
 * Both refusals reach a caller as `settings_document_unreadable`, because the
 * SDK's `CrucibleProtocolError` carries no code and this app does not mint one
 * per shape of somebody else's parse failure.
 *
 * ── THE CLOCK IS THE CALLER'S, AND THERE IS NO DEFAULT ────────────────────
 *
 * `capability()` takes `ProbeOptions` — this is one of the three calls an app
 * makes about a machine that may be ASLEEP, and a suspended Mac Studio answers
 * nothing at all while a `fetch` with no deadline hangs for minutes. So
 * `timeoutMs` is forwarded when a caller states one and OMITTED when it does
 * not, exactly as the SDK's own note asks: *"this client never puts a deadline
 * on a call the caller did not put one on"*. A number invented here would be
 * this file cancelling somebody's slow-but-working probe, which is the shape of
 * a fallback even though it wears a unit.
 */
export async function crucibleCapabilityWithRoutes(
  server: string,
  timeoutMs?: number,
): Promise<CrucibleCapabilityView> {
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  let record: CapabilityRecord;
  try {
    record = await client.capability(timeoutMs === undefined ? undefined : { timeoutMs });
  } catch (err) {
    throw settingsFailure(server, 'GET /v1/capability', err);
  }
  /*
   * All six fields, spelled out rather than spread. The row the renderer draws
   * and the row the SDK parsed are two different types that happen to agree
   * today, and a projection that listed five of the six is exactly how `route`
   * went missing the first time.
   */
  const classes: CrucibleCapabilityRow[] = record.classes.map((row) => ({
    capability: row.capability,
    enabled: row.enabled,
    selected: row.selected,
    reason: row.reason,
    shortfallBytes: row.shortfallBytes,
    route: row.route,
  }));
  noteCrucibleRoutes(server, routesFromCapability(classes));
  /*
   * A READ OF CAPABILITY IS A READ OF WHAT WILL BE SERVED, so it is recorded on
   * the same pass — the routing record answers "does this class run on the card
   * or upstream", and this half answers the prior question "will this engine
   * serve it at all" (`crucible/routes.ts`, `noteCrucibleServedClasses`). It is
   * what lets the scheduler route around a server that has published
   * `enabled: false` for a class rather than land a book there and be refused
   * (Owen's pages-refused report, 2026-09-21).
   */
  noteCrucibleServedClasses(server, classes.map((row) => ({
    capability: row.capability, enabled: row.enabled,
  })));
  return {
    backendKind: record.backendKind,
    totalBytes: record.totalBytes,
    desktopAllowanceBytes: record.desktopAllowanceBytes,
    classes,
  };
}
