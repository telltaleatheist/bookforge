/**
 * THE ENGINE'S SETTINGS — three requests, and no store behind them.
 *
 * ── What this module is, and the ruling that made it ───────────────────────
 *
 * Owen, 2026-09-14: *"Bookforge and foundry setup/settings should be able to
 * configure crucible settings. If the user enters an anthropic api key, it
 * should pass through to crucible … the user shouldn't have to interact with
 * crucible almost at all but should have access to it if they want to."* And
 * BookForge's addition, which he agreed: the GPU engine is the SINGLE SOURCE OF
 * TRUTH for these settings, so a key entered in Foundry is saved in the engine
 * and BookForge uses the same one.
 *
 * The contract is crucible `docs/PHASE15-HOST.md` §3.1 (`GET /v1/settings`),
 * §3.2 (`PUT /v1/settings`, and the upstream test) and §5.2 (what a window is
 * allowed to be). §5.2 is the sentence that decides everything in this file:
 *
 *   *"every control in these sections is a request to the engine, and its
 *   result is the engine's answer re-read. There is no Save button that writes
 *   an app file and syncs later."*
 *
 * So there is NO CACHE here, no debounce, no optimistic copy, and nothing
 * written to `app-settings.json`. Every function below is one round trip, and
 * the PUT hands back the whole document the server holds AFTER the write (§3.2:
 * *"so a window never has to guess what took"*), which is what the card redraws
 * from. A window that redrew from what it sent would be showing a route the
 * server may have refused.
 *
 * ── THE KEY GOES ONE WAY ──────────────────────────────────────────────────
 *
 * Renderer → main → server, and it stops there. It is in no answer (§3.1: *"a
 * key is write-only"*; the document carries `key_hint`, the last four
 * characters, and nothing more), in no log line — including the failure lines,
 * where the temptation to print the body is greatest — and on no command line.
 * That is electron/crucible-registry.ts's rule for a server token, one wire
 * along, and it is why no function in this file logs a request body.
 *
 * ── THE SDK OWNS THE WIRE, AND AS OF crucible 762484f IT OWNS ALL THREE ────
 *
 * These were hand-rolled fetches while `@crucible/client` had no `settings()`,
 * `putSettings()` or `testUpstream()`, with a standing note to switch the
 * moment the tarball carried them. It does: **0.6.0, packed from crucible
 * `762484f`**, and all three now go through `engineClientFor(entry)` — the same
 * client every other Crucible call in this app goes through, with the same
 * error types, the same `User-Agent` and the same `X-Crucible-Api` header.
 *
 * ── AND THE ENGINE IS WHOSE SETTINGS THESE ARE ─────────────────────────────
 *
 * `engineClientFor` rather than `clientFor`, following crucible
 * docs/PHASE17-ORCHESTRATOR.md §6's one hop, because a settings document is the
 * ENGINE's: it holds the upstream keys and the route rows for the classes that
 * run on that card, and an orchestrator (§3.2 — `job_types: []`, no settings
 * route) has none of it. The card is named "Where the text work runs", and an
 * orchestrator is where no text work runs.
 *
 * WHAT WENT WITH THE SWITCH is the snake_case translation this file used to
 * carry. The SDK reads `key_hint`, `desktop_allowance_bytes` and
 * `backend_kind` off the wire and hands back camelCase, so the only shaping
 * left here is the one thing the SDK deliberately does NOT do: fill in the
 * route rows the server omitted (§2, *"absent key = local"*), because the SDK
 * reports the document as sent and this app's card draws four rows always.
 */
import {
  CrucibleRefused,
  type SettingsDocument as EngineSettingsDocument,
  type SettingsPatch as EngineSettingsPatch,
  type UpstreamName as EngineUpstreamName,
} from '@crucible/client';

import { engineClientFor } from './crucible-registry';
import type { CrucibleServerEntry } from './app-settings';
import {
  LLM_CLASSES,
  UPSTREAM_LABEL,
  type LlmClass,
  type SettingsDocument,
  type SettingsPatch,
  type UpstreamName,
  type UpstreamProbe,
  type UpstreamTestResult,
} from '../shared/engine-settings';

/**
 * `GET /v1/settings` — the document, for one server.
 *
 * THE FOUR ROUTE ROWS ARE FILLED IN even when the server omits one — §2 says
 * *"absent key = local"*, so an absent row IS an answer and is spelled out here
 * rather than left for a template to find missing. That is the whole of what
 * {@link documentFrom} does now; every field's type is the SDK's problem and a
 * document that is not API v1's shape is a `CrucibleProtocolError` from it,
 * which is the honest news rather than a row quietly reading `local`.
 *
 * NO TIMEOUT PARAMETER. `CrucibleClient` takes none and this call has never had
 * a caller that passed one — a settings card is a person's press being answered
 * and may wait, exactly as a placement may.
 */
export async function readEngineSettings(
  entry: CrucibleServerEntry,
): Promise<SettingsDocument> {
  return documentFrom(await (await engineClientFor(entry)).settings());
}

/**
 * `PUT /v1/settings` — a partial write, answered with the whole document.
 *
 * ONE REQUEST CARRIES BOTH HALVES when both halves are needed. §3.2: *"upstreams
 * are applied, then routes, then the whole is validated; a refusal applies
 * nothing."* That ordering is the server's promise and it is what lets the
 * wizard configure a key AND set the routes that name it in a single press —
 * two requests would leave a configured key behind whenever the second failed.
 *
 * REJECTS WITH A SENTENCE THAT NAMES THE FIELD. The four named refusals
 * (`route_not_routable`, `route_bad_model`, `route_upstream_unconfigured`,
 * `upstream_in_use`) each arrive with `details` saying which field or which
 * classes; {@link refusalSentence} composes one line from that and the card
 * draws it beside the control. A thrown Error rather than a result arm because
 * unlike a Test there is nothing to show instead — the write did not happen and
 * the document on screen is still the truth.
 */
export async function writeEngineSettings(
  entry: CrucibleServerEntry,
  patch: SettingsPatch,
): Promise<SettingsDocument> {
  try {
    return documentFrom(await (await engineClientFor(entry)).putSettings(patchFor(patch)));
  } catch (err) {
    if (err instanceof CrucibleRefused) throw new Error(refusalSentence(err));
    throw err;
  }
}

/**
 * `POST /v1/settings/upstreams/{name}/test` — what model ids this credential
 * can actually use.
 *
 * THIS IS HOW A PERSON PICKS A MODEL, and it is deliberately the only way.
 * §2: *"the server does not ship a cloud model list"*, and neither does this
 * app — a catalog compiled into a build is wrong by the next release and
 * confidently so, offering models that have been retired and hiding the one
 * somebody is paying for (the Cloud card made the same argument for itself).
 * The engine asks the upstream's own listing — Anthropic `GET /v1/models`,
 * OpenAI `GET /v1/models`, Ollama `GET /api/tags` — unbilled.
 *
 * `probe` IS THE UNSAVED CREDENTIAL, or absent for the one already configured.
 * The key crosses into main out of a box somebody is typing in, is used for one
 * request and is dropped; nothing here stores it and no answer carries it back.
 *
 * ── THE THREE REFUSALS ARE A RESULT, AND THE SDK IS WHAT DECIDES THAT ──────
 *
 * `upstream_unreachable`, `upstream_rejected` and `upstream_unconfigured` come
 * back as `{ok: false, code, message}` rather than as a throw, because the card
 * prints the sentence beside the box somebody is typing in and offers nothing
 * to press (`CrucibleProbe`'s reason, shared/slots.ts) — a rejection would make
 * a wrong key look like a broken app. That test used to live here, over three
 * different error classes; since crucible `762484f` it is the SDK's
 * (`UPSTREAM_TEST_REFUSALS`), which is the right owner: the three codes are the
 * contract's and this file had a second copy of them.
 *
 * ALL THAT IS LEFT IS THE WORD FOR THE ARM. The SDK says `ok`; this app's wire
 * says `outcome`, for the same reason every other three-way answer here does.
 */
export async function testUpstream(
  entry: CrucibleServerEntry,
  name: UpstreamName,
  probe?: UpstreamProbe,
): Promise<UpstreamTestResult> {
  const result = await (await engineClientFor(entry)).testUpstream(name as EngineUpstreamName, probe);
  return result.ok
    ? { outcome: 'ok', models: [...result.models] }
    : { outcome: 'failed', code: result.code, message: result.message };
}

// ─────────────────────────────────────────────────────────────────────────────
// The SDK's shape ↔ this app's shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The patch, as the SDK takes it.
 *
 * ONLY THE KEYS SOMEBODY SET. §3.2's body is *"any subset"*, and an explicit
 * build says out loud that an absent key means "leave it" while
 * `upstreams.<name>: null` means REMOVE, which are two different instructions
 * that look alike in a debugger. The SDK serialises the snake_case from here
 * (`desktop_allowance_bytes`); this app stopped spelling it in Wave 62.
 *
 * THE ROUTES ARE COPIED KEY BY KEY rather than spread, because this app's patch
 * types the four llm classes and the SDK's types any class name — a spread
 * would carry `undefined` values into a record whose values are strings, which
 * is a different instruction from "leave it".
 */
function patchFor(patch: SettingsPatch): EngineSettingsPatch {
  const out: {
    routes?: Record<string, string>;
    upstreams?: Partial<Record<EngineUpstreamName, { key?: string; url?: string } | null>>;
    desktopAllowanceBytes?: number;
  } = {};
  if (patch.routes !== undefined) {
    const routes: Record<string, string> = {};
    for (const cls of LLM_CLASSES) {
      const named = patch.routes[cls];
      if (named !== undefined) routes[cls] = named;
    }
    out.routes = routes;
  }
  if (patch.upstreams !== undefined) {
    const upstreams: Partial<Record<EngineUpstreamName, { key?: string; url?: string } | null>> = {};
    if (patch.upstreams.anthropic !== undefined) upstreams.anthropic = patch.upstreams.anthropic;
    if (patch.upstreams.openai !== undefined) upstreams.openai = patch.upstreams.openai;
    if (patch.upstreams.ollama !== undefined) upstreams.ollama = patch.upstreams.ollama;
    out.upstreams = upstreams;
  }
  if (patch.desktopAllowanceBytes !== undefined) {
    out.desktopAllowanceBytes = patch.desktopAllowanceBytes;
  }
  return out;
}

/**
 * The document, with the four route rows spelled out.
 *
 * THE ONLY SHAPING LEFT. The SDK reads every field and refuses a document that
 * is not API v1's, so there is nothing here to read defensively; what it does
 * NOT do is invent a row the server omitted, and §2 says an omitted row IS an
 * answer (*"absent key = local"*). `local` is also the answer for a class the
 * server named with a route this app has no row for, which is the conservative
 * direction: it does not claim a person's book is being sent to a company.
 */
function documentFrom(doc: EngineSettingsDocument): SettingsDocument {
  return {
    routes: Object.fromEntries(
      LLM_CLASSES.map((cls) => {
        const row = doc.routes[cls];
        return [cls, {
          route: row?.route === 'upstream' ? 'upstream' : 'local',
          model: row?.model ?? null,
        }];
      }),
    ) as Record<LlmClass, SettingsDocument['routes'][LlmClass]>,
    upstreams: {
      anthropic: {
        configured: doc.upstreams.anthropic.configured,
        keyHint: doc.upstreams.anthropic.keyHint ?? null,
      },
      openai: {
        configured: doc.upstreams.openai.configured,
        keyHint: doc.upstreams.openai.keyHint ?? null,
      },
      ollama: {
        configured: doc.upstreams.ollama.configured,
        url: doc.upstreams.ollama.url ?? null,
      },
    },
    desktopAllowanceBytes: doc.desktopAllowanceBytes,
    backendKind: doc.backendKind,
  };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// The four PUT refusals, said in one line each
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE CARD SHOWS WHEN A WRITE IS REFUSED — the engine's own message, with
 * the field or the classes its `details` names put in front of it.
 *
 * THE SERVER'S SENTENCE IS KEPT, always. Replacing it with a word of ours is
 * how a fixable problem becomes an unfixable one (`CrucibleProbe` makes the
 * same argument in shared/slots.ts): the engine is the thing that knows WHICH
 * upstream is unconfigured and what it wanted instead, and this app's job is to
 * say which control the answer is about.
 *
 * ── An assumption, said out loud ──────────────────────────────────────────
 *
 * PHASE15 §3.2 says each refusal carries `details` *"saying which field"* and,
 * for `upstream_in_use`, *"the classes that name it"* — it does not name the
 * keys inside `details`. This reads `field` (a string) and `classes` (an array
 * of strings) and falls back to the message alone when neither is there, which
 * is correct whatever the server sends. **If the contract later names those
 * keys and they are different, this is the one place that changes.**
 */
function refusalSentence(err: CrucibleRefused): string {
  const details = asRecord(err.details);
  const field = typeof details['field'] === 'string' ? details['field'] : null;
  const classes = Array.isArray(details['classes'])
    ? details['classes'].filter((value): value is string => typeof value === 'string')
    : [];
  const head = namedBy(err.code, field, classes);
  return head === null ? err.serverMessage : `${head}: ${err.serverMessage}`;
}

/** Which control the refusal is about, in this app's words for it. */
function namedBy(code: string, field: string | null, classes: readonly string[]): string | null {
  switch (code) {
    case 'route_not_routable':
    case 'route_bad_model':
    case 'route_upstream_unconfigured':
      return field === null ? 'That route was refused' : `The route for ${field} was refused`;
    case 'upstream_in_use':
      return classes.length === 0
        ? 'That upstream is still in use'
        : `${upstreamLabelOf(field)} still runs ${classes.join(', ')} — re-route those first`;
    default:
      return null;
  }
}

/** The upstream's name for a person, when `details` named one. */
function upstreamLabelOf(field: string | null): string {
  if (field !== null && field in UPSTREAM_LABEL) {
    return UPSTREAM_LABEL[field as UpstreamName];
  }
  return 'That upstream';
}
