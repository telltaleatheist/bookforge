/**
 * WHERE A TEXT ACT RUNS, and what the engine is handed when the answer is a
 * Crucible server.
 *
 * ── One routing record, and now ONE RULE BODY ──────────────────────────────
 *
 * `generation-venue.ts` answers this question for a RENDER; this answers it for
 * the four text acts. They used to say so and then each carry its own copy of
 * the body — which is the drift crucible `docs/ARCHITECTURE.md` R1 forbids, and
 * the bug hunt (`docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md` A8) found them
 * already diverging in their wording. The rule moved to `venue-decision.ts` on
 * 2026-09-19; what is left here is this door's error class and the sentence
 * that is its own. The two answers:
 *
 *   1. The caller named a server — the queue row's resolved venue, the CLI's
 *      `--crucible-server`. An explicit instruction is never second-guessed,
 *      and never pinged.
 *   2. The first ENABLED server, in rank order, whose `ping` answers. Never a
 *      disabled one; `newJobsWaitFor` is not consulted (Owen, 2026-09-19 — it
 *      is the default written onto a NEW QUEUE ROW and nothing else).
 *
 * **There is no fallback to the local engines, and no switch that would make
 * one.** `legacyLocalRender` and the local text-engine arm behind it are DELETED
 * (docs/LEGACY-REMOVAL.md; ROLLOUT_PLAN §A2 names the local text engines as part
 * of that layer). A text act that cannot be placed FAILS, by name. Quietly
 * starting llama-server instead would take a card somebody else is using and
 * clean a book with a model nobody chose, and report success.
 *
 * ── Residency is the operator's, checked by name ───────────────────────────
 *
 * `ai-bridge.ts`'s provider already has this discipline and it is copied here
 * deliberately: the act's model must be `resident` on the chosen server BEFORE
 * anything spawns, and a run never loads one on somebody's card. The one door
 * that does is explicit and separate ({@link CrucibleTextActOptions.loadFirst},
 * the SDK's `loadModel`), because a load EVICTS whatever is resident — which on
 * a shared server is somebody else's book.
 *
 * ── HOW FAR THE CALLER REACHES INTO THE SPAWN'S ENVIRONMENT ────────────────
 *
 * The credential travels in the engine process's environment, so the one thing
 * this module must know about a caller is whether it can GIVE that process an
 * environment. It is {@link EndpointHeaderReach}, it is required, and it decides
 * whether the act runs at all:
 *
 *   `spawn`   — an explicit `env` on this child and no other. BookForge's own
 *               engine door (`runFoundry`). RUNS.
 *   `process` — the process IS the act: a single-purpose CLI run that spawns
 *               nothing else while it works. RUNS.
 *
 * **THERE IS NO THIRD ANSWER ANY MORE.** `none` meant *somebody else's spawn,
 * reached through a seam that carries no environment* — the app's hosted
 * Foundry queue step — and it was REFUSED by name
 * (`hosted_placement_not_vendored`), because the act could be composed neither
 * here nor in the vendored window. It is deleted, along with that code, by the
 * re-vendor of 2026-09-15 (`foundry-app/` at foundry `4e0a4cb`, which carries
 * `e096734`): hosted, that window reads BookForge's own registry through
 * `FoundryHost.servers()` and its dispatcher composes the endpoint, the model,
 * the header map with `X-Crucible-Act`, the residency and the LEASE for itself.
 *
 * So the hosted step no longer calls this module at all for an engine — it
 * decides the SERVER ({@link decideWhereTextActRuns}) and hands the name across
 * as `runJob`'s `waitFor`. **Nothing here composes a credential for a spawn
 * this app does not make**, which is the rule the deleted arm existed to state,
 * now stated by there being no way to ask.
 */
import type {
  RankedServerRow,
} from '../../shared/crucible/settings-wire';
import type { ModelInfo, ResolveOptions, ResolvePreview } from '@crucible/client';
import { rankedServers } from './routing';
import { pingServer, type CruciblePingResult } from './probe';
import {
  VenueDecisionRefusal,
  decideVenueAmongEnabled,
  type VenueBecause,
  type VenueWords,
} from './venue-decision';
import { CRUCIBLE_INTERACTIVE_QUEUE } from '../../shared/crucible/server-queue';
import { crucibleClientFor, getServer, CRUCIBLE_CLIENT_NAME, type ResolvedServer } from './servers';
import { resolveEngine } from './engine-resolve';
import {
  crucibleChatBase,
  endpointHeadersEnv,
  endpointHeaderMap,
  isUpstreamModelId,
  maskEndpointHeaders,
  type CrucibleTextAct,
} from './text-acts';

/**
 * Where one text act runs, and why it is there.
 *
 * ONE MEMBER, like {@link import('./generation-venue').GenerationVenue} and for
 * the same reason: an act runs on a Crucible server or it does not run.
 */
export type TextActVenue = {
  where: 'crucible';
  /** A registered server's name. Never a URL. */
  server: string;
  because: VenueBecause;
};

export type CrucibleTextActErrorCode =
  /**
   * This app's ceiling for the act ({@link TEXT_ACT_CEILING_B}) and the server's
   * `GET /v1/resolve` named no model under it: its own refusal, in its own words
   * — nothing installed small enough, or nothing that fits the card.
   */
  | 'crucible_resolve_refused'
  /**
   * A caller asked to LOAD a model the engine forwards to an upstream. There
   * is nothing on that card to load (crucible PHASE15 §3.4: "an upstream model
   * is never resident; send the chat"), so the ask is refused rather than
   * quietly ignored — somebody wanted a model warmed and it will not be.
   */
  | 'crucible_upstream_not_loadable'
  /** A caller named `crucible` and no server. */
  | 'crucible_server_not_named'
  /** Not one enabled server answered. Names each one tried. */
  | 'no_reachable_server'
  /** The chosen server has no manifest for this act's model id. */
  | 'crucible_unknown_model'
  /** It has one, and nothing is serving it. The operator's job, never ours. */
  | 'crucible_model_not_resident'
  /** 409 from the server: the lane, or narrator's wire, is held. */
  | 'crucible_server_busy'
  /**
   * 409 `leased`: another client has said it is mid-run on that model, so
   * nothing may move it off the card — including this act's own lease. A WAIT
   * with the holder's name, act and since, carried the same way `server_busy` is
   * (`busyLine` → the queue's `busyLineOf`), because it is the same question
   * with a longer clock: a lane frees in minutes, a lease may hold for an hour.
   */
  | 'crucible_session_wait';

export class CrucibleTextActError extends Error {
  readonly code: CrucibleTextActErrorCode;
  /** The SDK's "GPU busy: foundry, tts 62% done", read by the queue's `busyLineOf`. */
  readonly busyLine?: string;
  /** An operator took this act's session out of the server's line (`removedLineOf`). */
  readonly removedLine?: string;

  /**
   * The code is PREFIXED onto the message, not only carried beside it.
   *
   * `ai-bridge.ts`'s Crucible refusals do the same, and for the reason this
   * one exists: a CLI and a queue row show `err.message` and nothing else, so
   * "refused by name" is only true where the name is in the sentence.
   */
  constructor(code: CrucibleTextActErrorCode, message: string, busyLine?: string, removedLine?: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleTextActError';
    this.code = code;
    if (busyLine !== undefined) this.busyLine = busyLine;
    if (removedLine !== undefined) this.removedLine = removedLine;
  }
}

/**
 * The only things this decision reads from the world — `generation-venue.ts`'s
 * `VenueHost` plus the two doors a text act needs, so a keeper drives every
 * branch with no registry, no record on disk and no network.
 */
export interface TextVenueHost {
  /** Enabled servers, best first. Refuses `no_enabled_server` when there are none. */
  enabled(): RankedServerRow[];
  /** One unauthenticated reachability check. */
  ping(name: string): Promise<CruciblePingResult>;
  /** One server WITH its token, from the registry. */
  server(name: string): ResolvedServer;
  /**
   * THE ADDRESS THAT SERVES WORK FOR THIS NAME, which is not always the one
   * registered under it.
   *
   * crucible `docs/PHASE17-ORCHESTRATOR.md`: a registered address may be an
   * ORCHESTRATOR — backend kind `orchestrator`, ZERO job types, one engine
   * managed, capability read through to it. A chat sent to one ends in
   * `job_type_not_served`, so the endpoint a text act is handed must be the
   * ENGINE's, reached by following `engine.url` once with the SAME token.
   *
   * Beside {@link server} rather than folded into it, because they answer two
   * different questions and only one of them touches the network: `server` is
   * the registry ROW (the name a person typed, and the token), and this is
   * where that row's work goes. The token is unchanged across the hop, so the
   * two are used together and neither is derivable from the other.
   *
   * REQUIRED, not optional. The two guesses available to a host that omitted
   * it are "assume the registered address is the engine" — which is the defect
   * — and "refuse every act", and neither is a thing to decide on a caller's
   * behalf. A keeper that forgets it is refused by the compiler, exactly as
   * `slotSets` refuses a caller that says nothing about `roles`.
   *
   * The real one goes through `crucible/engine-resolve.ts`, which is the ONE
   * resolver: `info()` once, the SDK's `engineOf`, one hop, the second document
   * read and refused by name if it is not an engine, and a cache that holds no
   * token. The bench answers the same question from the same record, so the
   * endpoint a chat is sent to and the row it is placed on cannot disagree
   * about which process is the engine.
   */
  engineUrl(name: string): Promise<string>;
  /** `GET /v1/models` on that server. */
  models(name: string): Promise<ModelInfo[]>;
  /** Submit a `load-model` job and wait for it. Only ever called with `loadFirst`. */
  loadModel(name: string, model: string): Promise<void>;
  /**
   * `GET /v1/resolve` ON THE SERVER THAT WILL RUN THIS ACT: which model a chat
   * with these levers would be served by, chosen by the very function the door
   * calls, with nothing loaded. The decision is pure (`modelFromResolve`), so a
   * keeper drives every refusal with no server.
   */
  resolve(server: string, options: ResolveOptions): Promise<ResolvePreview>;
}

/** The real one: the app's records, the real registry and real HTTP. */
export function processTextVenueHost(): TextVenueHost {
  return {
    enabled: rankedServers,
    ping: pingServer,
    server: getServer,
    async engineUrl(name: string): Promise<string> {
      return (await resolveEngine(getServer(name), CRUCIBLE_CLIENT_NAME)).url;
    },
    async models(name: string): Promise<ModelInfo[]> {
      return (await crucibleClientFor(name, CRUCIBLE_CLIENT_NAME)).models();
    },
    async loadModel(name: string, model: string): Promise<void> {
      /*
       * THE EXPLICIT `loadFirst` DOOR — a person asked for the model, and waits
       * on this call. It waits in the server's line with the INTERACTIVE wait
       * (10 min, `shared/crucible/server-queue.ts`) rather than being refused
       * by another client's job; this loop follows the job, which keeps it
       * present.
       */
      const client = await crucibleClientFor(name, CRUCIBLE_CLIENT_NAME, CRUCIBLE_INTERACTIVE_QUEUE);
      const jobId = await client.loadModel(model);
      for await (const event of client.events(jobId)) {
        if (event.event === 'done') return;
        if (event.event === 'failed') {
          throw new Error(`crucible "${name}" could not load ${model}: ${JSON.stringify(event.data)}`);
        }
        if (event.event === 'cancelled') {
          throw new Error(`crucible "${name}" cancelled the load of ${model}`);
        }
        if (event.event === 'removed') {
          // Not a failure and not resubmitted: it left the line without running.
          throw new Error(`crucible "${name}": the load of ${model} left the server's line without `
            + `running (${event.data.reason}): ${event.data.message}`);
        }
        // `queued` / `started` / `warming` / `progress`: the load is on its way.
      }
      // `events()` ends only on a terminal frame or by throwing; anything else
      // is the contract moving, and is not read as a load that happened.
      throw new Error(`crucible "${name}": the load of ${model} ended with no terminal event`);
    },
    async resolve(name: string, options: ResolveOptions): Promise<ResolvePreview> {
      return (await crucibleClientFor(name, CRUCIBLE_CLIENT_NAME)).resolve(options);
    },
  };
}

/**
 * ── THE ACTS THIS APP SIZES ITSELF (Owen, 2026-10-25) ─────────────────────
 *
 * Verbatim: *"i think bookforge should make the decision about which model is
 * used for cleanup. we should just call the model in chat. maximum of 27b. but
 * whatever is the biggest model we can get up to that point."*
 *
 * So a cleanup no longer reads the server's `clean` capability row. It asks the
 * plain chat verb (`generate`) for the biggest model at or under this many
 * billion parameters — Crucible's ceiling lever, which only ever LOWERS the
 * server's own pick (crucible docs/VERB-SIZING.md). On a 24 GB card that is a
 * 4-bit 27B; on a smaller one, whatever that server measures as fitting.
 *
 * Translate, simplify and analysis followed the same day: *"it should probably
 * call crucible's chat verb"*, *"keep it at 27b as the max right now"*. So no
 * text act reads the server's capability row any more, and the table is total:
 * a fifth act is a compile error here until somebody sizes it. The cleanup's
 * TRIAGE is not a chat; it is sized on the Foundry side (Owen: *"triage should
 * stay on 9b for now"*).
 *
 * ROUTING TO CLAUDE moved with it. The row was where a class was routed to an
 * upstream account; a resolved model is always on the server's own card, so an
 * upstream is now the JOB's choice, named in its own modal
 * ({@link CrucibleTextActOptions.model}).
 */
export const TEXT_ACT_CEILING_B: Readonly<Record<CrucibleTextAct, number>> = {
  clean: 27,
  translate: 27,
  simplify: 27,
  analysis: 27,
};

/**
 * THE MODEL AN ACT RUNS ON when its job named none: this app's ceiling
 * ({@link TEXT_ACT_CEILING_B}), answered by the server through `GET /v1/resolve`.
 * The one door every caller goes through, so an act cannot be sized one way in
 * a preflight and another in its run.
 */
export async function modelForAct(
  server: string,
  act: CrucibleTextAct,
  host: Pick<TextVenueHost, 'resolve'>,
): Promise<string> {
  const ceiling = TEXT_ACT_CEILING_B[act];
  const preview = await host.resolve(server, { verb: 'generate', maxParamsB: ceiling });
  return modelFromResolve(preview, act, server, ceiling);
}

/**
 * THE MODEL OUT OF A RESOLVE PREVIEW, or the server's own refusal by name.
 *
 * PURE, so a keeper drives every branch with no server. One code, three ways to earn it: the door's own refusal (in its
 * words), a preview that names nothing, and a model that does not fit the card
 * — which a chat would only report after waiting in the line for it.
 */
export function modelFromResolve(
  preview: Pick<ResolvePreview, 'model' | 'fit' | 'refused'>,
  act: CrucibleTextAct,
  server: string,
  ceiling: number,
): string {
  const asked = `the biggest chat model up to ${ceiling}B for the "${act}" act`;
  if (preview.refused !== null) {
    throw new CrucibleTextActError(
      'crucible_resolve_refused',
      `crucible "${server}" was asked for ${asked} and refused: ${preview.refused.message} `
        + `(${preview.refused.code}).`,
    );
  }
  if (preview.model === null || preview.model.trim() === '') {
    throw new CrucibleTextActError(
      'crucible_resolve_refused',
      `crucible "${server}" was asked for ${asked} and named none, without saying why. `
        + 'Install a chat model on that server that fits its card.',
    );
  }
  if (preview.fit !== null && !preview.fit.fits) {
    const short = (preview.fit.needBytes - preview.fit.availableBytes) / 1024 ** 3;
    throw new CrucibleTextActError(
      'crucible_resolve_refused',
      `crucible "${server}" was asked for ${asked} and named ${preview.model}, which does not `
        + `fit its card (${short.toFixed(1)} GB short). Install a smaller chat model there.`,
    );
  }
  return preview.model;
}

/**
 * THE MODEL AN ACT WILL RUN ON, ASKED ONCE PER RUN AND STAMPED.
 *
 * ── The one owner of "which model does this act use on that server" ───────
 *
 * The model the job was told, or the one the server names for this app's
 * ceiling on the act ({@link modelForAct}). Three call sites need that answer — the cleanup
 * preflight in `ai-bridge.ts`, `callCrucible` in `text-ai.ts`, and the engine
 * door below — and three copies of the read would be three chances to disagree
 * about what a `simplify` runs on (crucible ARCHITECTURE.md R1).
 *
 * ── WHY IT STAMPS, AND WHY THAT IS NOT A CACHE ────────────────────────────
 *
 * A translation makes three hundred batch calls and each one goes through
 * `callAI`. Asking the server three hundred times for an answer it settled at
 * install time would be three hundred round trips for one fact. So the answer
 * is written onto THIS RUN's provider block — the same "stamped once, for
 * reporting" the deleted cloud preflight used — which means it lives exactly
 * as long as the run and cannot go stale behind anybody: a new run asks again,
 * and a settings write that re-routes a class is picked up by the next run
 * rather than mid-book, which is the only sane moment to change a book's
 * model.
 *
 * It is NOT a module-level cache and there must never be one here. A cache
 * across runs would answer with a model a settings write had already replaced,
 * and `crucible_model_not_resident` at chunk 47 is what that looks like.
 *
 * `route` is deliberately not consulted: `selected` is already the upstream
 * model id when the class routes upstream (§3.3), so one field answers both
 * cases and this door does not need to know which it got. The SCHEDULER needs
 * to know, and reads `route` for its own reason — a lane, not a model.
 */
export async function crucibleActModel(
  where: { server: string; act: CrucibleTextAct; model?: string },
  host: TextVenueHost = processTextVenueHost(),
): Promise<string> {
  if (where.model !== undefined && where.model !== '') return where.model;
  const model = await modelForAct(where.server, where.act, host);
  where.model = model;
  return model;
}

/**
 * What a TEXT ACT has instead of a local fallback — the half of the refusals
 * that is this door's own. See `venue-decision.ts` for the half that is shared.
 */
const TEXT_ACT_WORDS: VenueWords = {
  notNamed:
    'a Crucible server was asked for and none was named. It takes the NAME of an entry in '
    + '<userData>/crucible-servers.json (bookforge-tts --crucible-list); there is no default '
    + 'and no fallback to this machine.',
  noneAnswered:
    'There are no local text engines to fall back to: a text act runs on a Crucible server '
    + 'or not at all.',
};

/**
 * Decide where this text act runs. The RULE is `venue-decision.ts`'s and is
 * asked once; what happens here is the translation of its refusal into
 * {@link CrucibleTextActError}, which is the class every text door's `catch` is
 * written against — and which prefixes the code onto the sentence, because a
 * CLI and a queue row show `err.message` and nothing else.
 *
 * `named` is the caller's instruction — the queue row's resolved venue, the
 * CLI's `--crucible-server` — and `undefined` means the caller did not say.
 * An empty string is a caller that MEANT to name one and did not, which is
 * refused rather than read as "did not say".
 */
export async function decideWhereTextActRuns(
  named: string | undefined,
  host: TextVenueHost,
): Promise<TextActVenue> {
  try {
    const decided = await decideVenueAmongEnabled(named, host, TEXT_ACT_WORDS);
    return { where: 'crucible', ...decided };
  } catch (err) {
    // routing's `no_enabled_server` passes through in its own words; only the
    // decision's own two refusals are re-dressed.
    if (err instanceof VenueDecisionRefusal) {
      throw new CrucibleTextActError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * HOW FAR A CALLER REACHES INTO THE ENGINE PROCESS'S ENVIRONMENT.
 *
 * Required on every call, never defaulted: the credential and the per-run act
 * name travel in that environment, so a caller that cannot set one cannot run
 * the act, and a default would answer that question on somebody's behalf.
 * See this module's header for what each answer means.
 */
export type EndpointHeaderReach =
  /** An explicit `env` on this child and no other — `runFoundry`'s overlay. */
  | 'spawn'
  /** The process IS the act: a single-purpose CLI run. `withProcessEndpointHeaders`. */
  | 'process';

export interface CrucibleTextActOptions {
  /**
   * How far this caller reaches into the engine process's environment.
   * REQUIRED — see {@link EndpointHeaderReach}.
   */
  headerReach: EndpointHeaderReach;
  /**
   * Submit a `load-model` job and wait for it before the residency check.
   *
   * The EXPLICIT door, and it is never the default: a load evicts whatever is
   * resident, which on a shared server is somebody else's book. Set only from a
   * gesture that means "load it first" — a queue step composed with it, or the
   * Settings card's Load button.
   */
  loadFirst?: boolean;
  /**
   * THE MODEL THIS JOB WAS TOLD TO RUN ON, when a person chose one in the job's
   * own modal (Owen, 2026-10-25: *"they should be able to go to claude … put the
   * option the user can pick in a dropdown on the modal that configures the
   * job"*). An `<upstream>/<model>` id is forwarded by the server on its
   * account; absent means this app's own sizing ({@link TEXT_ACT_CEILING_B}).
   */
  model?: string;
}

/** Everything the engine needs for one act against one Crucible server. */
export interface CrucibleTextEngine {
  /** The server this resolved to, by name. */
  server: string;
  /** `--endpoint`: `<url>/v1/openai`. */
  endpoint: string;
  /**
   * `--model`: the id this job was told to run on, or the one the SERVER names
   * for this app's ceiling on the act.
   *
   * Proved RESIDENT when it is a local model. An upstream model id
   * (`<upstream>/<model>`) is returned without that proof and deliberately so:
   * it is never resident, the engine forwards the request, and there is
   * nothing on a card to have proved (crucible PHASE15 §3.4).
   */
  model: string;
  /** The act, named truthfully. Goes in `X-Crucible-Act`. */
  act: CrucibleTextAct;
  /** The env OVERLAY for the spawn. One key: `FOUNDRY_ENDPOINT_HEADERS`. */
  env: Record<string, string>;
  /** The header map with the credential masked — the ONLY form a log may carry. */
  maskedHeaders: string;
}

/**
 * Compose what a Crucible text act needs, or refuse by name before any spawn.
 *
 * In the order the refusals matter: the engine gate first, because an engine
 * that cannot address a Crucible makes every later question moot and asking a
 * server about its models first would cost a round trip to produce the same no.
 */
export async function resolveCrucibleTextEngine(
  act: CrucibleTextAct,
  server: string,
  host: TextVenueHost,
  opts: CrucibleTextActOptions,
): Promise<CrucibleTextEngine> {
  /*
   * `headerReach` IS STILL REQUIRED THOUGH BOTH ANSWERS NOW RUN, and that is
   * deliberate rather than a leftover. Every caller of this function is about
   * to be handed a credential map, and the argument is where it states, in one
   * word a reviewer can grep, which mechanism puts that map on a process: an
   * overlay on one child (`spawn`) or the whole process for the length of one
   * single-purpose CLI run (`process`). A caller with NEITHER — the hosted
   * queue step — no longer has a value it can pass, which is a stronger
   * statement than the refusal it replaced.
   */

  /*
   * THE ID: the one this job was told to run on, or this app's own sizing for
   * the act, which the SERVER answers ({@link modelForAct}). Refuses by name,
   * naming what a person would do about it, and never invents an id.
   */
  const model = opts.model !== undefined && opts.model !== ''
    ? opts.model
    : await modelForAct(server, act, host);

  /*
   * AN UPSTREAM-ROUTED CLASS SKIPS ALL OF THE RESIDENCY MACHINERY BELOW.
   *
   * crucible `docs/PHASE15-HOST.md` §3.4: a chat whose model is
   * `<upstream>/<model>` is forwarded on the operator's account, with *"no
   * lease, no lane, the settlement untouched (nothing was on the card)"*, and
   * a lease or a load naming one is refused `lease_not_needed` — *"an upstream
   * model is never resident; send the chat."*
   *
   * `GET /v1/models` lists what this HOST has manifests for, so the id is not
   * in it and never will be; asking would refuse `crucible_unknown_model` and
   * tell somebody the server named a model it does not list, which it did not. `loadFirst` is refused rather than skipped, because a caller
   * that asked to load something asked for a thing that cannot happen and
   * should hear so.
   *
   * The discriminator is the contract's own — a local model id never contains
   * a slash (§1), checked where ids are minted — and it is read through the
   * one function `isUpstreamModelId`, so this decision and the queue's lane
   * decision cannot come to disagree.
   */
  if (isUpstreamModelId(model)) {
    if (opts.loadFirst === true) {
      throw new CrucibleTextActError(
        'crucible_upstream_not_loadable',
        `crucible "${server}" forwards the ${act} class to "${model}", so there is nothing on `
          + 'its card to load. An upstream model is never resident; send the chat.',
      );
    }
    const entry = host.server(server);
    const upstreamMap = endpointHeaderMap(entry.token, act);
    return {
      server,
      /*
       * THE ENGINE'S ADDRESS, NOT THE REGISTERED ONE. An upstream-routed class
       * is forwarded BY an engine — the orchestrator in front of one forwards
       * nothing and serves no job type — so this hop is followed here too, and
       * for the same reason as below. See `TextVenueHost.engineUrl`.
       */
      endpoint: crucibleChatBase(await host.engineUrl(server)),
      model,
      act,
      env: endpointHeadersEnv(entry.token, act),
      maskedHeaders: maskEndpointHeaders(upstreamMap),
    };
  }

  if (opts.loadFirst === true) {
    // The explicit door. Wired, and deliberately not on any default path: see
    // CrucibleTextActOptions.loadFirst.
    await host.loadModel(server, model);
  }

  let rows: ModelInfo[];
  try {
    rows = await host.models(server);
  } catch (err) {
    throw describeTextActRefusal(err, server, act);
  }
  const row = rows.find((m) => m.id === model);
  if (!row) {
    const known = rows.map((m) => m.id).join(', ');
    throw new CrucibleTextActError(
      'crucible_unknown_model',
      `crucible "${server}" has no model "${model}", which is what this ${act} was to run on `
        + `(${rows.length === 0 ? 'it advertises none' : `known: ${known}`}). Pull that model `
        + 'onto the server, or choose another for the job.',
    );
  }
  if (!row.resident) {
    const resident = rows.filter((m) => m.resident).map((m) => m.id);
    throw new CrucibleTextActError(
      'crucible_model_not_resident',
      `"${model}" is not resident on crucible "${server}", so the ${act} act cannot run `
        + `(${resident.length > 0 ? `resident: ${resident.join(', ')}` : 'nothing is resident'}`
        + `${row.loadable ? '' : `; and it is not loadable there — ${row.reason ?? 'no reason given'}`}). `
        + 'Loading a model evicts whatever is on that card, so a text act never does it: load it '
        + `yourself — bookforge-tts --crucible-load --server ${server} --model ${model}, or the `
        + 'Load button in Settings → Crucible Servers.',
    );
  }

  const entry = host.server(server);
  const map = endpointHeaderMap(entry.token, act);
  return {
    server,
    /*
     * THE ENGINE'S ADDRESS, NOT THE REGISTERED ONE — `TextVenueHost.engineUrl`.
     * The token is `entry`'s and is deliberately unchanged: PHASE17 §6 follows
     * the hop with the SAME token, which is why the row and the address are
     * read from two doors rather than one.
     */
    endpoint: crucibleChatBase(await host.engineUrl(server)),
    model,
    act,
    env: endpointHeadersEnv(entry.token, act),
    maskedHeaders: maskEndpointHeaders(map),
  };
}

/**
 * ── A TEXT ACT IS A RUN, SO IT TAKES A LEASE ───────────────────────────────
 *
 * Owen ruled on 2026-09-14 that a Crucible unloads the resident model the moment
 * nothing holds it. A text act holds nothing the server can see: the engine's
 * work reaches it as hundreds of ORDINARY CHAT COMPLETIONS through the OpenAI
 * door, and a chat takes no lane and holds no claim (`crucible/inflight.py`,
 * deliberately — serialising chats to fix a reporting gap would destroy the
 * batching a vLLM engine exists for). So between any two blocks of a book this
 * server is idle by every measure it publishes, and it would unload a 19 GB model
 * and reload it for the next block.
 *
 * ONE LEASE FOR THE WHOLE ACT, not one per request — one per request would BE the
 * reload, wearing a different hat. It is taken here, around the engine spawn,
 * because that spawn is exactly the span in which this app intends more requests:
 * before it there is nothing to protect, and after it there is nothing left to
 * send.
 *
 * The act name is the one {@link resolveCrucibleTextEngine} composed and the
 * engine sends in `X-Crucible-Act`. One name, two places it must agree, taken
 * from the same field — a lease that recorded `translate` while the engine sent
 * `simplify` would put the lie Owen ruled out on a bench beside the card.
 *
 * `409 leased` on the take is a WAIT and never a retry loop: it arrives as
 * {@link CrucibleTextActError} `crucible_session_wait` carrying the holder's line,
 * which is the road the queue's busy hold already travels.
 */
export async function withCrucibleTextActLease<T>(
  engine: CrucibleTextEngine,
  run: () => Promise<T>,
): Promise<T> {
  const { withCrucibleLease } = await import('./lease.js');
  // Only the TAKE is translated. Once `run` has begun, whatever it throws is the
  // ACT's own failure and travels with its own stack — dressing an engine crash
  // as a Crucible refusal would name the wrong thing to fix.
  let started = false;
  try {
    return await withCrucibleLease(
      { server: engine.server, kind: 'model', id: engine.model, act: engine.act },
      async () => {
        started = true;
        return run();
      },
    );
  } catch (err) {
    if (started) throw err;
    throw describeTextActRefusal(err, engine.server, engine.act);
  }
}

/**
 * One SDK failure, as a named refusal.
 *
 * `render.ts`'s `describeCrucibleRefusal` is the same job for a render and this
 * is deliberately a second reader rather than a shared one, for the reason that
 * file gives: the cleanup path's translator maps unreachability onto the word
 * "network" so a CHUNK is retried, and a whole act must not be. Same SDK,
 * different policy.
 */
export function describeTextActRefusal(
  err: unknown,
  server: string,
  act: CrucibleTextAct,
): unknown {
  // Required lazily: the SDK's error classes come from the same package the
  // client does, and this module is loadable from a CLI harness.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CrucibleBusy, CrucibleRefused } = require('@crucible/client') as typeof import('@crucible/client');
  if (err instanceof CrucibleBusy) {
    return new CrucibleTextActError(
      'crucible_server_busy',
      `crucible "${server}" takes one job at a time and is already running one, so the ${act} act `
        + `was not started. ${err.busyLine} (job ${err.jobId}, ${err.jobStatus} since ${err.since}`
        + `${err.jobMessage === null ? '' : `; latest: ${err.jobMessage}`}). This book waits for `
        + 'that server rather than running anywhere else.',
      err.busyLine,
    );
  }
  // Required the same way and for the same reason. ANOTHER CLIENT'S SESSION, or
  // a session of ours the line let go, is asked about BEFORE the generic branch:
  // `session_open` and `session_closed` are CrucibleRefused subclasses and would
  // otherwise lose the holder's line there. After the busy LANE above, which
  // keeps its own code.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { asSessionWait, CrucibleSessionWait } = require('./lease.js') as typeof import('./lease');
  const wait = asSessionWait(err, server, act);
  if (wait instanceof CrucibleSessionWait) {
    return new CrucibleTextActError(
      'crucible_session_wait',
      `the ${act} act was not started: ${wait.message}. Nothing here runs it somewhere else; `
        + 'this book waits for that server.',
      wait.busyLine,
      wait.removedLine,
    );
  }
  if (err instanceof CrucibleRefused && err.code === 'engine_in_use') {
    return new CrucibleTextActError(
      'crucible_server_busy',
      `crucible "${server}" has its resident engine held by another conversation, so the ${act} `
        + `act was not started: ${err.serverMessage}`,
      err.serverMessage,
    );
  }
  return err;
}
