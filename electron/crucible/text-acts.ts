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
 * ── WHO CAN GIVE A SPAWN ITS OWN ENVIRONMENT, AND WHO CANNOT ───────────────
 *
 * Read before changing anything here. Two gaps were found on 2026-09-13 by
 * reading foundry's source rather than by running it, and **both are fixed on
 * their side now** — crucible `a97ef70` mounts the OpenAI door where OpenAI
 * clients look (see {@link CRUCIBLE_OPENAI_BASE_PATH}), and foundry `f300fc6`
 * gave the vendored `runEngine` an `extraEnv` overlay. A real `clean` act has
 * run end to end against the local server. What still stands is neither of
 * them, and it is not about an engine version at all:
 *
 * > **The seam BookForge hands the hosted window a job through carries no
 * > environment** — `runJob(request, {parentStep, signal, onProgress})` — and
 * > the only thing that fills `extraEnv` is the window's OWN dispatcher, out
 * > of a registry the vendored copy cannot resolve hosted. So BookForge cannot
 * > hand THAT child an environment, and that child cannot yet compose one.
 *
 * It matters that the fix is the window's rather than ours, because the act
 * name changes per run: a map on a shared process's environment is not merely
 * untidy — two acts inside one process would each send the other's
 * `X-Crucible-Act`, which is exactly the lie Owen ruled out.
 *
 * So the question every caller must answer is **how far its reach into the
 * spawn's environment goes**, and it is a required argument rather than a
 * default: {@link EndpointHeaderReach} in `text-venue.ts`. `spawn` (an explicit
 * `env` on this child and no other) is BookForge's own engine door and runs for
 * real. `process` is a single-purpose CLI run, where the process IS the act.
 * `none` is the app's hosted queue step — somebody else's spawn, reached
 * through a seam that carries no environment — and it is **refused by name**,
 * never quietly run against llama-server.
 *
 * `hostedCrucibleTextActNotVendored` in `electron/foundry-host-queue.ts` holds
 * the whole argument and names the one thing it waits on: a re-vendor of
 * `foundry-app/` at or past foundry `e096734`, where the window reads
 * BookForge's own server registry and places the act itself. It is keyed to the
 * VENDORED SUBTREE rather than to a release number, and
 * `tools/test-foundry-hosted-crucible-seam.js` is what reads that subtree, so
 * the refusal cannot outlive its reason the way it did once already.
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

/**
 * IS THIS MODEL ID ONE THE ENGINE FORWARDS, rather than one it holds?
 *
 * crucible `docs/PHASE15-HOST.md` §1: an upstream model id is
 * `<upstream>/<model>` — `anthropic/claude-sonnet-5` — and **"the slash is
 * what tells a chat request apart from a local model id; a local model id
 * never contains `/`"**. The server checks that at manifest load
 * (`manifest_model_id_slash`), so the rule is enforced at the only place ids
 * are minted and this is a reading of it rather than a second opinion.
 *
 * It is here, beside the act names, because it is the same kind of fact: a
 * piece of the contract's vocabulary that several doors have to agree on. Two
 * of them care right now — a run must not LEASE one of these (§3.4: a lease on
 * an upstream model is refused `lease_not_needed`, "an upstream model is never
 * resident; send the chat"), and the scheduler must not give it a GPU slot.
 */
export function isUpstreamModelId(model: string): boolean {
  return model.includes('/');
}

/** The one variable, spelled once. crucible `docs/PHASE7-LANES.md` §8.0. */
export const FOUNDRY_ENDPOINT_HEADERS_VAR = 'FOUNDRY_ENDPOINT_HEADERS';

/** The API version header Crucible requires on every authenticated route. */
export const CRUCIBLE_API_VERSION = '1';

/** The header a client names its act in. `ACT_HEADER`, crucible/inflight.py. */
export const CRUCIBLE_ACT_HEADER = 'X-Crucible-Act';

/**
 * The path an OPENAI CLIENT is given as its base URL, and the one owner of it.
 *
 * `/openai` — NOT `/v1/openai`, and the difference is the whole of what was
 * wrong on 2026-09-13.
 *
 * Crucible's own namespace for that door is `/v1/openai/{models,chat/completions}`
 * (`crucible/api.py`'s `private` router, PHASE2-LLM.md §5), and the SDK uses it.
 * But an OpenAI client is not given a route, it is given a BASE, and it composes
 * `<base>/v1/models` and `<base>/v1/chat/completions` itself — foundry's
 * `normaliseVllmEndpoint` (`src/translate/vllm.ts`) appends `/v1` to any base
 * that does not already end in a version. Handing it `…/v1/openai` therefore
 * produced `…/v1/openai/v1/models`, a 404 against a door that existed.
 *
 * Crucible `a97ef70` mounts the SAME two handlers — same auth, same version
 * header, nothing duplicated but the path — at `/openai/v1/…`, which is where
 * every OpenAI client looks. So the base this app hands an engine is
 * `<url>/openai`, the engine makes it `<url>/openai/v1`, and the two spellings
 * name one door.
 *
 * PROVEN LIVE, 2026-09-13: `foundry clean-text --epub … --model qwen3.5-9b
 * --endpoint http://127.0.0.1:7100/openai` against the resident 9B — 734
 * blocks, 265 changed, 78.5 s, EPUB written.
 *
 * The registry stores a base URL with no version on it at all (servers.ts
 * refuses one carrying `/v1`, because the SDK appends its own prefix), so this
 * appends exactly one segment.
 */
export const CRUCIBLE_OPENAI_BASE_PATH = '/openai';

/** The OpenAI-compatible base for one server, as the engine's `--endpoint`. */
export function crucibleChatBase(url: string): string {
  return `${url.replace(/\/+$/, '')}${CRUCIBLE_OPENAI_BASE_PATH}`;
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

/** Who holds the process-wide credential window right now. */
let hostedHolder: string | null = null;

/**
 * ── THE CREDENTIAL ON A WHOLE PROCESS, AND THE ONE PLACE THAT IS HONEST ─────
 *
 * The map belongs on ONE child's environment. Where the caller owns the spawn
 * it goes there and nowhere else (`runFoundry`'s `env` overlay, reach `spawn`).
 * This is the other case: the spawn belongs to somebody else's code — the
 * vendored Foundry window's, reached through a seam that carries no
 * environment — so the only environment BookForge can influence is its own.
 *
 * **THAT IS ONLY ACCEPTABLE WHERE THE PROCESS *IS* THE ACT**, which means
 * exactly one caller: a single-purpose CLI run (`cli/clean-step.js`), started to
 * do this one thing, spawning nothing else while it does it, and exiting after.
 * There the process environment and the act's environment are the same set, and
 * "stripped from every child that does not need it" is satisfied because there
 * are no other children.
 *
 * **IT IS NOT ACCEPTABLE IN THE APP, and the app does not use it.** BookForge's
 * main process has ~180 spawn sites and runs queue lanes concurrently, so a map
 * on its environment would be inherited by a rasteriser, an ffmpeg, a python
 * env — the inheritance the contract fixes mechanically. The hosted queue step
 * therefore REFUSES a Crucible text act by name (reach `none`) rather than
 * reaching for this.
 *
 * **THE ROOT FIX IS FOUNDRY'S AND IT IS BUILT, WAITING ON A RE-VENDOR.** Their
 * `runEngine` takes an overlay (`f300fc6`) and, at `e096734`, the hosted window
 * reads BookForge's own server registry and COMPOSES that overlay itself —
 * credential, act name and all — so nothing has to be pushed through the job
 * seam. This function and the hosted refusal both go the day `foundry-app/` is
 * copied in at or past that commit.
 *
 * Single-entry by construction: two acts inside one window would each send the
 * other's act name, which is the lie Owen's ruling forbids. If the guard ever
 * fires, the run is refused rather than mis-labelled.
 */
export async function withProcessEndpointHeaders<T>(
  overlay: Record<string, string>,
  holder: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (hostedHolder !== null) {
    throw new Error(
      `crucible_process_headers_busy: "${holder}" cannot open the credential window while `
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

/** Who holds the process-wide credential window, for a refusal that names them. */
export function processEndpointHeadersHolder(): string | null {
  return hostedHolder;
}
