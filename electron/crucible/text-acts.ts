/**
 * THE FOUR TEXT ACTS, AND WHAT A FOUNDRY ENGINE NEEDS TO REACH A CRUCIBLE.
 *
 * ── Four acts, named truthfully ─────────────────────────────────────────────
 *
 * Owen, 2026-09-13: *"they can't lie to the user and say a translate job is
 * running when it's actually a simplify job. It must accurately represent the
 * job that's running. Previously, before crucible, everything ran under
 * translate."*
 *
 * So `clean`, `translate`, `simplify` and `analysis` are FOUR acts, they are
 * spelled exactly as crucible's `capability.py` spells its capability classes,
 * and the spelling is checked against that file by
 * `tools/test-crucible-text-acts.js` rather than trusted. Crucible **refuses**
 * an act name it does not know (`400 unknown_act`, `crucible/inflight.py`) — a
 * wrong name is worse than none — so a typo here is a refused run rather than a
 * bench that is confidently wrong about what is on the card.
 *
 * ── The header map, and why it is a map ─────────────────────────────────────
 *
 * crucible `docs/PHASE7-LANES.md` §7.1(B) and §8.0. BookForge sets ONE variable
 * on the engine process:
 *
 *   FOUNDRY_ENDPOINT_HEADERS={"Authorization":"Bearer …","X-Crucible-Api":"1",
 *                             "X-Crucible-Act":"simplify"}
 *
 * A JSON object of header name to value, sent on every request the engine makes
 * to its endpoint. The engine learns only *"this endpoint wants these headers"*
 * — the word Crucible appears nowhere in foundry's `src/` — and the day it
 * points at something else, nothing there changes.
 *
 * Three rules travel with it, all of them the contract's:
 *
 *   · **Never a flag.** A command line is pasted into bug reports, printed by
 *     the queue that composed it and listed by the process table.
 *   · **Never logged.** {@link maskEndpointHeaders} is what a log line gets, and
 *     it is the only renderer of this map that exists.
 *   · **Stripped from every child that does not need it.** Which is why
 *     {@link endpointHeadersEnv} hands back an OVERLAY for one spawn rather than
 *     writing anything into `process.env`, and why {@link stripEndpointHeaders}
 *     exists for the spawn door that must not carry it.
 *
 * ── TWO ENGINE GAPS, MEASURED TONIGHT, THAT THIS CANNOT PAPER OVER ──────────
 *
 * Read before changing anything here. Both were found by reading foundry's own
 * source at `83d7b66`/v1.3.0 — the engine BookForge spawns today — rather than
 * by trying a run, and either one alone makes a Crucible text act impossible:
 *
 *  1. **The engine cannot ADDRESS Crucible's OpenAI door.** Crucible mounts it
 *     at `<url>/v1/openai/{models,chat/completions}` (`crucible/api.py`, the
 *     `private` router's `/v1` prefix plus `/openai/...`; PHASE2-LLM.md §5).
 *     foundry's `normaliseVllmEndpoint` (`src/translate/vllm.ts:78`) appends
 *     `/v1` to any base whose LAST segment is not `/v<digits>` — so
 *     `…/v1/openai` becomes `…/v1/openai/v1/models`, a 404. There is no base URL
 *     that satisfies both: the fix is one regex in foundry, or an alias in
 *     Crucible, and neither is BookForge's to write.
 *  2. **A HOSTED act has no per-run environment.** The vendored window spawns
 *     the engine with `env: process.env` (`foundry-app/electron/engine.ts:140`,
 *     identical upstream), so BookForge cannot hand THAT child an overlay the
 *     way it hands one to its own spawn. The act name changes per run, so a
 *     process-wide variable is not merely untidy — it is wrong, because two acts
 *     would name each other.
 *
 * Until an engine ships both fixes, a Crucible text act is **refused by name**
 * before anything spawns (`electron/crucible/text-venue.ts`,
 * `foundry_engine_cannot_reach_crucible`), and the refusal carries both gaps and
 * the one switch that gets work moving again. It is NOT quietly run against
 * llama-server: that is the silent downgrade this whole seam exists to refuse.
 *
 * `FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT` in `electron/foundry-host-queue.ts` is the
 * floor, beside every other foundry version floor this app enforces. The day
 * foundry releases both fixes, that constant is the whole change.
 */

/**
 * The four acts, exactly as crucible's `capability.py` names its classes.
 *
 * Ordered as that file orders them, so a diff against it reads straight down.
 * `echo`, `pages`, `tts`, `asr`, `align` and `rvc` are classes too and are NOT
 * text acts — `pages` is the VLM door and has its own server
 * (`electron/vlm-page-server.ts`).
 */
export const CRUCIBLE_TEXT_ACTS = ['clean', 'translate', 'simplify', 'analysis'] as const;

/** One of the four. Never a free string: a wrong act name is a refused run. */
export type CrucibleTextAct = (typeof CRUCIBLE_TEXT_ACTS)[number];

/** Is this one of the four? The narrowing every caller at a boundary needs. */
export function isCrucibleTextAct(value: unknown): value is CrucibleTextAct {
  return typeof value === 'string' && (CRUCIBLE_TEXT_ACTS as readonly string[]).includes(value);
}

/** The one variable, spelled once. crucible `docs/PHASE7-LANES.md` §8.0. */
export const FOUNDRY_ENDPOINT_HEADERS_VAR = 'FOUNDRY_ENDPOINT_HEADERS';

/** The API version header Crucible requires on every authenticated route. */
export const CRUCIBLE_API_VERSION = '1';

/** The header a client names its act in. `ACT_HEADER`, crucible/inflight.py. */
export const CRUCIBLE_ACT_HEADER = 'X-Crucible-Act';

/**
 * The OpenAI-compatible base for one server, as the engine's `--endpoint`.
 *
 * `<url>/v1/openai`, and it is READ OFF crucible's own router rather than
 * guessed: `api.py` builds `private = APIRouter(prefix="/v1", …)` and mounts
 * `@private.get("/openai/models")` and `@private.post("/openai/chat/completions")`
 * on it. PHASE2-LLM.md §5 tabulates the same two routes.
 *
 * The registry stores a base URL WITHOUT `/v1` (servers.ts refuses one that
 * carries it, because the SDK appends the prefix itself), so this appends the
 * whole of it.
 *
 * See gap 1 in this module's header: an engine at v1.3.0 mangles this. The
 * function is still the one owner of the answer — the fix is on the engine's
 * side and this string is what it will be fixed to accept.
 */
export function crucibleChatBase(url: string): string {
  return `${url.replace(/\/+$/, '')}/v1/openai`;
}

/** The map itself. Values are never rendered anywhere but {@link maskEndpointHeaders}. */
export function endpointHeaderMap(token: string, act: CrucibleTextAct): Record<string, string> {
  if (token === '') {
    // A Crucible has no anonymous mode, so an empty token is not a quieter
    // request — it is a 401 with nothing saying why.
    throw new Error(
      'crucible_empty_token: the endpoint header map would carry an empty bearer token. Every '
      + 'Crucible route but /v1/ping needs one; the local server\'s comes from its own config.toml '
      + 'and a remote\'s from the registry.');
  }
  return {
    Authorization: `Bearer ${token}`,
    'X-Crucible-Api': CRUCIBLE_API_VERSION,
    [CRUCIBLE_ACT_HEADER]: act,
  };
}

/**
 * The env OVERLAY for ONE engine spawn — never a write to `process.env`.
 *
 * Handed to `runFoundry`'s `opts.env`, which merges it over the inherited
 * environment for that child alone. Every other child BookForge spawns is
 * unaffected, which is the contract's "stripped from the environment of any
 * child that does not need it" made mechanical rather than remembered.
 */
export function endpointHeadersEnv(
  token: string,
  act: CrucibleTextAct,
): Record<string, string> {
  return { [FOUNDRY_ENDPOINT_HEADERS_VAR]: JSON.stringify(endpointHeaderMap(token, act)) };
}

/**
 * The map as a LOG LINE may render it: the credential replaced by `****<last 4>`.
 *
 * Enough to tell two tokens apart, not enough to use one — `maskToken`'s rule in
 * `servers.ts`, kept here so that the one place a person can see this map is a
 * place that cannot leak it. Nothing else in this codebase prints the map.
 */
export function maskEndpointHeaders(map: Record<string, string>): string {
  const shown: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    shown[name] = name.toLowerCase() === 'authorization'
      ? `Bearer ****${value.slice(-4)}`
      : value;
  }
  return JSON.stringify(shown);
}

/**
 * An environment with the header map removed.
 *
 * For the spawn door that must NOT carry a credential while one is in the
 * process environment — see {@link withHostedEndpointHeaders}, which is the only
 * thing that ever puts one there.
 */
export function stripEndpointHeaders(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const { [FOUNDRY_ENDPOINT_HEADERS_VAR]: _removed, ...rest } = env;
  return rest;
}

/** Is the hosted window's credential window open right now? */
let hostedHolder: string | null = null;

/**
 * ── A DATED STOPGAP, AND IT IS LABELLED AS ONE ──────────────────────────────
 *
 * The hosted Foundry window spawns the engine with `env: process.env`
 * (`foundry-app/electron/engine.ts:140`, and the same line upstream) — a sealed
 * subtree, a mechanical copy of somebody else's program, so BookForge cannot
 * hand that child an overlay. The only environment it can influence is its own.
 *
 * So this opens a window: the map is on `process.env` for the duration of ONE
 * hosted act and is deleted in a `finally`. What that costs is honest and worth
 * writing down — **any other child BookForge spawns during the window inherits
 * it**, which is precisely the inheritance the contract fixes with an explicit
 * `env` at each spawn. BookForge's own engine door (`runFoundry`) is given that
 * explicit env; the other spawn sites are not, and cannot be until the seam
 * exists.
 *
 * **THE ROOT FIX, which is a request on Foundry and not work outstanding here:**
 * `runEngine(args, onLine)` takes a third argument — an env overlay — and
 * `job-queue.ts` passes the request's headers into it. One parameter, two call
 * sites, and this function is deleted the day it lands.
 *
 * Single-entry by construction: two acts in the window would name each other's
 * act in each other's header, which is the lie Owen's ruling forbids. The queue
 * runs text acts on the `gpu` lane, one at a time, so this guard is a proof
 * rather than a policy — and if it ever fires, the run is refused rather than
 * mis-labelled.
 */
export async function withHostedEndpointHeaders<T>(
  overlay: Record<string, string>,
  holder: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (hostedHolder !== null) {
    throw new Error(
      `crucible_hosted_headers_busy: "${holder}" cannot open the hosted credential window while `
      + `"${hostedHolder}" holds it. The window puts one act's headers on this process's `
      + 'environment, and two acts inside it would each send the other\'s act name — which is the '
      + 'one thing a Crucible must never be told (crucible/inflight.py, unknown_act). Nothing ran.');
  }
  hostedHolder = holder;
  const had = Object.prototype.hasOwnProperty.call(process.env, FOUNDRY_ENDPOINT_HEADERS_VAR);
  const previous = process.env[FOUNDRY_ENDPOINT_HEADERS_VAR];
  Object.assign(process.env, overlay);
  try {
    return await fn();
  } finally {
    if (had) process.env[FOUNDRY_ENDPOINT_HEADERS_VAR] = previous;
    else delete process.env[FOUNDRY_ENDPOINT_HEADERS_VAR];
    hostedHolder = null;
  }
}

/** Who holds the hosted credential window, for a refusal that names them. */
export function hostedEndpointHeadersHolder(): string | null {
  return hostedHolder;
}
