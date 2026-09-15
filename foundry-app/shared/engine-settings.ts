/**
 * THE ENGINE'S OWN SETTINGS — the wire shapes of `GET/PUT /v1/settings` and
 * `POST /v1/settings/upstreams/{name}/test`, as this app reads and writes them.
 *
 * ── Why these types exist at all, and why nothing here is stored ───────────
 *
 * Owen, 2026-09-14: *"Bookforge and foundry setup/settings should be able to
 * configure crucible settings. If the user enters an anthropic api key, it
 * should pass through to crucible."* The contract that ruling became is
 * crucible `docs/PHASE15-HOST.md` §3.1, §3.2 and §5.2, and §5.2 is the sentence
 * that decides the shape of this file:
 *
 *   *"Each app's AI/engine settings section and its wizard's AI step draw the
 *   engine's settings document for the selected server and write through with
 *   `PUT /v1/settings`. The app holds nothing: no key, no route, no model
 *   list … There is no Save button that writes an app file and syncs later."*
 *
 * So there is no `AppSettings` field for any of this and there must never be
 * one. A route and a key are facts about ONE Crucible, two apps and that
 * server's own page all edit them, and a copy in `app-settings.json` would be a
 * second owner that goes stale the first time somebody uses the other window.
 * Everything below is a WIRE shape — what crosses the preload on its way to and
 * from a server — and the only thing this app keeps between presses is the
 * document it was last answered with.
 *
 * ── WHY THESE ARE A MIRROR OF THE SDK'S TYPES AND NOT A RE-EXPORT ─────────
 *
 * `@crucible/client` 0.6.0 (crucible `762484f`) declares `SettingsDocument`,
 * `SettingsPatch`, `RouteSetting`, `UpstreamSetting`, `UpstreamName` and
 * `UpstreamTestResult` of its own, and the snake_case translation this file's
 * header used to describe is GONE — the SDK reads `key_hint`,
 * `desktop_allowance_bytes` and `backend_kind` off the wire itself. What is
 * here is still a separate declaration, on purpose, for three reasons:
 *
 *   1. **This is the IPC wire, not the HTTP one.** Everything in this file
 *      crosses the preload, and a preload type whose definition lives in
 *      `node_modules` is a renderer whose shapes change when a tarball is
 *      re-vendored, silently.
 *   2. **The four routes are always all four here.** The SDK's `routes` is
 *      `Record<string, RouteSetting>` — what the server sent. This app's is
 *      `Record<LlmClass, RouteRow>`, filled in by
 *      electron/crucible-settings.ts, because the card draws four rows and a
 *      template that had to find a missing one is a template with a hole in it.
 *   3. **The arm words are this app's.** `{outcome: 'ok' | 'failed'}` is the
 *      shape every three-way answer on this wire wears (`CrucibleProbe`,
 *      shared/slots.ts); the SDK says `{ok: true | false}`. One word is
 *      translated, in one place, rather than two conventions inside one
 *      preload.
 *
 * The SDK's shapes are the HTTP truth and these are the IPC truth, and
 * electron/crucible-settings.ts is the single seam between them.
 *
 * ── THE KEY GOES ONE WAY ──────────────────────────────────────────────────
 *
 * §3.1: *"A key is write-only. `key_hint` is the last four characters."* That
 * is why {@link SettingsPatch} has a `key` and {@link SettingsDocument} has a
 * `keyHint`, and why no type in this file has a field that could carry a
 * credential back. It is the registry's token rule one wire along
 * (electron/crucible-registry.ts's header states it for the token).
 */
import type { CrucibleServerView } from './slots';

/**
 * THE FOUR CLASSES THAT MAY ROUTE UPSTREAM, spelled as crucible's
 * `capability.py` spells them.
 *
 * PHASE15 §1: *"Only the four `llm` classes (`clean translate simplify
 * analysis`) can route upstream in this phase; every other class is `local` and
 * refuses anything else (`route_not_routable`)."* `pages` is deliberately not
 * here — nothing in the cloud serves dots.ocr, and a fifth row on the settings
 * card offering to send a scan to Anthropic would be offering something the
 * server refuses by name.
 *
 * It is a NARROWING of `ModelClass` (shared/types.ts) rather than a second
 * vocabulary: the words are that type's words, minus the one the contract
 * excludes. The day `pages` becomes routable this widens here, with the reason
 * written down, rather than by somebody adding a string somewhere else.
 */
export type LlmClass = 'clean' | 'translate' | 'simplify' | 'analysis';

/** The four, in the order a card draws them. One owner of the order. */
export const LLM_CLASSES: readonly LlmClass[] = ['clean', 'translate', 'simplify', 'analysis'];

/**
 * THE THREE UPSTREAM NAMES, and there are exactly three.
 *
 * PHASE15 §1: *"an HTTP chat-completions service the server forwards to on the
 * operator's account: `anthropic`, `openai`, `ollama`. Exactly these three
 * names."* They are the server's names for them, not brands, because they are
 * half of an upstream model id (`anthropic/claude-sonnet-5`) and that string is
 * parsed on the other side.
 */
export type UpstreamName = 'anthropic' | 'openai' | 'ollama';

/** The three, in the order a card draws them. */
export const UPSTREAM_NAMES: readonly UpstreamName[] = ['anthropic', 'openai', 'ollama'];

/** What to call each one in front of a person. */
export const UPSTREAM_LABEL: Readonly<Record<UpstreamName, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
};

/**
 * ONE CLASS'S ROUTE, as the document reports it (PHASE15 §3.1).
 *
 * `model` FOR A LOCAL ROUTE IS THE SELECTED LOCAL MODEL, or `null` when nothing
 * on that card fits — §3.1 puts it in the document *"so a window can show
 * 'translate: local, qwen3.8-27b-4bit' without a second call"*. For an upstream
 * route it is the upstream model id, slash and all, which is exactly what a
 * chat request sends as `model`.
 */
export interface RouteRow {
  route: 'local' | 'upstream';
  model: string | null;
}

/**
 * An upstream reached by a KEY — `anthropic` and `openai`.
 *
 * `keyHint` is the stored key's last four characters and is the only thing
 * about it that ever comes back (§3.1). `configured` is not derived from the
 * hint being non-null: the server owns that boolean and a window that computed
 * its own would be a second opinion about whether a route can be served.
 */
export interface KeyedUpstream {
  configured: boolean;
  keyHint: string | null;
}

/**
 * An upstream reached by an ADDRESS — `ollama`, which has no key (§2:
 * *"no key; ollama is reached by address"*).
 */
export interface AddressedUpstream {
  configured: boolean;
  url: string | null;
}

/**
 * `GET /v1/settings` (PHASE15 §3.1) — the whole document, for one server.
 *
 * It is answered WHOLE by the PUT as well (§3.2: *"the response of `PUT` is the
 * full `GET /v1/settings` document after the write, so a window never has to
 * guess what took"*), which is why every surface here redraws from a write's
 * answer instead of from what it sent.
 */
export interface SettingsDocument {
  /** Every llm class, always all four — the server fills the ones nobody set. */
  routes: Record<LlmClass, RouteRow>;
  upstreams: {
    anthropic: KeyedUpstream;
    openai: KeyedUpstream;
    ollama: AddressedUpstream;
  };
  /** `desktop_allowance_bytes` — what the engine leaves the desktop on its card. */
  desktopAllowanceBytes: number;
  /** `cuda-linux`, `mlx-darwin`, or `none` for host mode (§3.5). */
  backendKind: string;
}

/**
 * `PUT /v1/settings` (PHASE15 §3.2) — ANY SUBSET, and the subset is the point.
 *
 * A window sends the one thing a person just changed. `routes` values are the
 * literal `"local"` or an upstream model id `<upstream>/<model>`; an upstream
 * entry is its credential, or `null` to REMOVE it. Order inside one request is
 * the server's and is stated in §3.2: upstreams are applied, then routes, then
 * the whole is validated, and *"a refusal applies nothing"* — which is what
 * makes the wizard's one press (configure the key AND set the route) safe to
 * send as a single body.
 */
export interface SettingsPatch {
  routes?: Partial<Record<LlmClass, string>>;
  upstreams?: {
    anthropic?: { key: string } | null;
    openai?: { key: string } | null;
    ollama?: { url: string } | null;
  };
  desktopAllowanceBytes?: number;
}

/**
 * What a Test sends for an upstream that is NOT SAVED YET.
 *
 * §3.2: the body is *"optional `{"key": "…"}` or `{"url": "…"}` (to test BEFORE
 * saving)"*, and absent means "the one already configured". That is
 * `crucible:test-at`'s argument one registry along: storing a credential in
 * order to find out whether it works would be this app writing into somebody's
 * engine to answer a question.
 */
export type UpstreamProbe = { key: string } | { url: string };

/**
 * What Test learned — a RESULT, never a rejection.
 *
 * `CrucibleProbe`'s shape and its reason (shared/slots.ts): the card prints the
 * sentence and offers nothing to press, so the three refusals share one arm and
 * keep their code so a reader can tell "wrong key" from "nothing answered".
 *
 * AND THE MODEL LIST IS WHY THIS EXISTS AT ALL. §2: *"the server does not ship a
 * cloud model list"*, and neither does this app — the Cloud card already made
 * that argument for itself (*"a list compiled into this build would be wrong by
 * the next release and confidently so"*). Test is how a person learns which
 * model ids their own key can use.
 */
export type UpstreamTestResult =
  | { outcome: 'ok'; models: string[] }
  | {
    outcome: 'failed';
    /** `upstream_unreachable`, `upstream_rejected`, `upstream_unconfigured` (§3.2). */
    code: string;
    /** The engine's own words, or the upstream's passed through it. */
    message: string;
  };

/**
 * ONE CLASS'S ROW of `GET /v1/capability`, as this app reads it.
 *
 * MOVED HERE FROM electron/crucible-dispatch.ts in Wave 62 package I, unchanged
 * in every field, because the wizard's routes step needs the same record the
 * dispatcher reads and a renderer cannot import from `electron/`. The
 * dispatcher re-exports these two names, so every existing importer is
 * untouched and there is still exactly one declaration of the shape.
 */
export interface CapabilityRow {
  capability: string;
  /**
   * THE MODEL ID — the same id the model listing carries, and what `--model`
   * gets. `""` (not absent) when nothing fit, which is why the check at the call
   * site is on the length and not on the presence.
   */
  selected: string;
  enabled: boolean;
  /** The server's own words for why, present whether enabled or not. */
  reason: string;
  /** How much bigger the card would have to be. 0 on an enabled class. */
  shortfallBytes: number;
  /**
   * WHERE THIS CLASS'S WORK RUNS ON THAT SERVER (crucible PHASE15 §3.3).
   *
   *   `local`    — the selected LOCAL model, resident on that machine's card.
   *                Everything this module has ever done.
   *   `upstream` — the server forwards the chat to `anthropic`, `openai` or
   *                `ollama` on the operator's account, and `selected` is the
   *                `<upstream>/<model>` id to send.
   *
   * ── ABSENT IS `local`, AND THE RULE IS ABOUT THE DOCUMENT, NOT THE ROW ────
   *
   * PHASE15 §3.3, pinned with both apps 2026-09-14 (crucible eb59f7b): a
   * capability document in which NO row carries `route` comes from a server that
   * predates this phase, and every class on such a server IS local — *"a fact the
   * document states, not a default the client fills"*. Owen's own WSL Crucible is
   * one today, and reading its silence as a refusal, or as `upstream`, would dark
   * every tile on the machine this app is built on.
   *
   * A PARTIAL DOCUMENT IS A DEFECT AND IS REFUSED, not patched:
   * `capability_route_missing` naming the row, and `capability_route_unknown`
   * for a value that is neither word. Filling either in with `local` would be
   * an app inventing the one fact that decides whether a run costs GPU-minutes
   * or money.
   *
   * ALL THREE ARMS ARE `@crucible/client`'s NOW, and this app keeps none of
   * them. 0.6.0 (re-packed from crucible `e342fee`) reads the vintage ONCE for
   * the whole document and grants the pre-phase-15 tolerance the pack before it
   * did not, so `capability()` answers Owen's WSL Crucible — eleven rows, no
   * `route` on any of them — as eleven local classes, and raises the other two
   * arms as a `CrucibleProtocolError` naming the code. `readCapability`
   * (electron/crucible-dispatch.ts) is that call plus the copy into this
   * mirror, and Foundry's own copy of the rule is deleted rather than kept
   * beside the SDK's (crucible ARCHITECTURE.md R1).
   *
   * `enabled` ONE FIELD UP STILL READS A MISSING FLAG AS FALSE, and that is not
   * inconsistent: a missing `enabled` is a server declining to answer a question
   * it knows about, where a missing `route` on a document that has none anywhere
   * is a server from before the question existed.
   */
  route: 'local' | 'upstream';
}

export interface CapabilityRecord {
  backendKind: string;
  totalBytes: number;
  classes: CapabilityRow[];
}

/**
 * WHICH REGISTERED SERVER A WINDOW ONTO THE SETTINGS OPENS ONTO, when nobody
 * has picked one — the settings card and the wizard's routes step, one rule.
 *
 * The loopback entry first, because the engine on this machine is the one whose
 * routes decide what THIS computer does and is the one somebody who just ran
 * setup means; then the first enabled entry; then the first entry at all, so a
 * registry whose every row is switched off still draws a window rather than a
 * blank card that looks broken. `null` only for an empty registry, which is the
 * card's own "there is nothing to draw a window onto" and hides it.
 */
export function defaultEngineServer(
  servers: readonly CrucibleServerView[],
): CrucibleServerView | null {
  return servers.find((server) => server.enabled && server.loopback)
    ?? servers.find((server) => server.enabled)
    ?? servers[0]
    ?? null;
}

/**
 * Split an upstream model id into its two halves, or `null` when it is not one.
 *
 * §1: *"The slash is what tells a chat request apart from a local model id; a
 * local model id never contains `/`."* The FIRST slash divides, because an
 * ollama tag may carry more of them and the upstream name may not.
 */
export function splitUpstreamModel(
  id: string,
): { upstream: UpstreamName; model: string } | null {
  const cut = id.indexOf('/');
  if (cut <= 0 || cut === id.length - 1) return null;
  const head = id.slice(0, cut);
  if (!UPSTREAM_NAMES.includes(head as UpstreamName)) return null;
  return { upstream: head as UpstreamName, model: id.slice(cut + 1) };
}
