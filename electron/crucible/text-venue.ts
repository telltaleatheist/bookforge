/**
 * WHERE A TEXT ACT RUNS, and what the engine is handed when the answer is a
 * Crucible server.
 *
 * ── One routing record ─────────────────────────────────────────────────────
 *
 * `generation-venue.ts` answers this question for a RENDER. This answers it for
 * the four text acts, out of the SAME record, in the same order, with the same
 * refusals — because "which machine does this machine's work go to" is one
 * question and two answers to it would drift (crucible `docs/ARCHITECTURE.md`
 * R1). The three answers, unchanged:
 *
 *   1. The caller named a server — the queue row's resolved venue, the CLI's
 *      `--crucible-server`. An explicit instruction is never second-guessed.
 *   2. `newJobsWaitFor: 'top-ranked'` — the top of the enabled list, NOT pinged,
 *      because naming a machine is an instruction.
 *   3. `newJobsWaitFor: 'any'` — the first enabled server whose `ping` answers.
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
 *   `none`    — somebody else's spawn, reached through a seam that carries no
 *               environment: the app's hosted queue step, which hands the
 *               vendored Foundry window a job through `runJob(request,
 *               {parentStep, signal, onProgress})`. That window's engine spawn
 *               DOES take a per-run environment (foundry `f300fc6`), but the
 *               only thing that fills it is the window's own dispatcher, out of
 *               a registry the vendored copy cannot resolve hosted. **REFUSED
 *               BY NAME** (`hosted_placement_not_vendored`), never quietly run
 *               against llama-server.
 *
 * There is no version comparison here. The blocker is a property of the
 * VENDORED SUBTREE — lines of somebody else's code copied into this repo — and
 * a floor that could go green on a version bump while the subtree still spawned
 * the same way would be a guard that passes without the thing it guards. The
 * whole argument, and the one thing it waits on (a re-vendor at or past foundry
 * `e096734`, where the window reads BookForge's registry and places the act
 * itself), is written on `hostedCrucibleTextActNotVendored` in
 * `foundry-host-queue.ts`, and it is pinned against the subtree by
 * `tools/test-foundry-hosted-crucible-seam.js` rather than remembered.
 */
import type {
  CrucibleCapabilityView, RankedServerRow, RoutingView,
} from '../../shared/crucible/settings-wire';
import type { CapabilityRecord, ModelInfo } from '@crucible/client';
import { rankedServers, readRouting } from './routing';
import { pingServer, type CruciblePingResult } from './probe';
import { crucibleCapabilityWithRoutes } from './engine-settings';
import { crucibleClientFor, getServer, CRUCIBLE_CLIENT_NAME, type ResolvedServer } from './servers';
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
  /** A registered server's name, or the reserved `local`. Never a URL. */
  server: string;
  because: 'the caller named it' | 'the top-ranked server' | 'any: the first that answered';
};

export type CrucibleTextActErrorCode =
  /** The server has no capability row for this class: it has never been measured. */
  | 'crucible_capability_undecided'
  /** The class is off on that server, with its own reason and its shortfall. */
  | 'crucible_capability_disabled'
  /** The row says enabled and names no model — a record contradicting itself. */
  | 'crucible_capability_no_model'
  /**
   * A caller asked to LOAD a model the engine forwards to an upstream. There
   * is nothing on that card to load (crucible PHASE15 §3.4: "an upstream model
   * is never resident; send the chat"), so the ask is refused rather than
   * quietly ignored — somebody wanted a model warmed and it will not be.
   */
  | 'crucible_upstream_not_loadable'
  /** A caller named `crucible` and no server. */
  | 'crucible_server_not_named'
  /** `any`, and not one enabled server answered. Names each one tried. */
  | 'no_reachable_server'
  /**
   * The caller reaches the engine through a seam that carries no environment,
   * so the credential — and the act name that changes per run — has nowhere to
   * go, and the vendored window that owns the spawn cannot compose one for
   * itself yet. The app's hosted queue step, and only it; it goes with the
   * re-vendor. See the header.
   */
  | 'hosted_placement_not_vendored'
  /** The chosen server has no manifest for this act's model id. */
  | 'crucible_unknown_model'
  /** It has one, and nothing is serving it. The operator's job, never ours. */
  | 'crucible_model_not_resident'
  /** 409 from the server: the lane, or narrator's wire, is held. */
  | 'crucible_server_busy'
  /**
   * 409 `model_leased`: another client has said it is mid-run on that model, so
   * nothing may move it off the card — including this act's own lease. A WAIT
   * with the holder's name, act and since, carried the same way `server_busy` is
   * (`busyLine` → the queue's `noteStepBusy`), because it is the same question
   * with a longer clock: a lane frees in minutes, a lease may hold for an hour.
   */
  | 'crucible_model_leased';

export class CrucibleTextActError extends Error {
  readonly code: CrucibleTextActErrorCode;
  /** The SDK's "GPU busy: foundry, tts 62% done", for `noteStepBusy`. */
  readonly busyLine?: string;

  /**
   * The code is PREFIXED onto the message, not only carried beside it.
   *
   * `ai-bridge.ts`'s Crucible refusals do the same, and for the reason this
   * one exists: a CLI and a queue row show `err.message` and nothing else, so
   * "refused by name" is only true where the name is in the sentence.
   */
  constructor(code: CrucibleTextActErrorCode, message: string, busyLine?: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleTextActError';
    this.code = code;
    if (busyLine !== undefined) this.busyLine = busyLine;
  }
}

/**
 * The only things this decision reads from the world — `generation-venue.ts`'s
 * `VenueHost` plus the two doors a text act needs, so a keeper drives every
 * branch with no registry, no record on disk and no network.
 */
export interface TextVenueHost {
  /** The routing record resolved against the servers that exist. */
  view(): RoutingView;
  /** Enabled servers, best first. Refuses `no_enabled_server` when there are none. */
  enabled(): RankedServerRow[];
  /** One unauthenticated reachability check. */
  ping(name: string): Promise<CruciblePingResult>;
  /** One server WITH its token: `local` from its config, a remote from the registry. */
  server(name: string): ResolvedServer;
  /** `GET /v1/models` on that server. */
  models(name: string): Promise<ModelInfo[]>;
  /** Submit a `load-model` job and wait for it. Only ever called with `loadFirst`. */
  loadModel(name: string, model: string): Promise<void>;
  /**
   * `GET /v1/capability` ON THE SERVER THAT WILL RUN THIS ACT.
   *
   * A door of its own, beside `models`, and not a "give me the id" call: the
   * DECISION is pure (`modelFromCapability`) and only the READ touches the
   * network, which is what lets a keeper drive all three refusals with no
   * registry and no server.
   *
   * IT ANSWERS WITH `route` (crucible PHASE15 §3.3), and it goes through
   * `engine-settings.ts` rather than straight to `CrucibleClient.capability()`
   * for the one thing that function adds: a read of capability is a read of
   * the routes, and it RECORDS them (`crucible/routes.ts`), which is what lets
   * the scheduler answer "card or cloud" inside a synchronous pump. Two
   * readers of one document would be two answers to "where does a class run" —
   * this is the one read, and the scheduler's cloud lane and this file's model
   * both come out of it.
   */
  capability(server: string): Promise<CrucibleCapabilityView>;
}

/** The real one: the app's records, the real registry and real HTTP. */
export function processTextVenueHost(): TextVenueHost {
  return {
    view: readRouting,
    enabled: rankedServers,
    ping: pingServer,
    server: getServer,
    async models(name: string): Promise<ModelInfo[]> {
      return crucibleClientFor(name, CRUCIBLE_CLIENT_NAME).models();
    },
    async loadModel(name: string, model: string): Promise<void> {
      const client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
      const jobId = await client.loadModel(model);
      for await (const event of client.events(jobId)) {
        if (event.event === 'done') return;
        if (event.event === 'failed') {
          throw new Error(`crucible "${name}" could not load ${model}: ${JSON.stringify(event.data)}`);
        }
      }
    },
    capability: crucibleCapabilityWithRoutes,
  };
}

/**
 * THE MODEL A CLASS RUNS ON, out of the record that server already answered.
 *
 * PURE — it takes the record, not a server name — because the decision is the
 * interesting half and a keeper has to be able to drive all three refusals
 * without a network. The read is `TextVenueHost.capability`.
 *
 *
 * THREE NAMED REFUSALS, because three different things can be true and each
 * has a different fix:
 *
 *  - `crucible_capability_undecided` — the record has no row for this class at
 *    all, which is what a server says before `crucible capability --write` has
 *    ever run on it. "Undecided" is deliberately different news from
 *    "nothing": nobody has measured the card yet.
 *  - `crucible_capability_disabled` — the class is off, with the SERVER's own
 *    reason and its shortfall in bytes. That is the honest answer for a 12 GB
 *    box asked to translate, and it is not this app's to argue with.
 *  - `crucible_capability_no_model` — enabled and `selected` is empty. The
 *    record's own rule is to branch on `enabled`, never on the emptiness of
 *    `selected`, so this is a record that contradicts itself and it is
 *    reported rather than repaired.
 */
export function modelFromCapability(
  record: CapabilityRecord,
  act: CrucibleTextAct,
  server: string,
): string {
  const row = record.classes.find((c) => c.capability === act);
  if (row === undefined) {
    const known = record.classes.map((c) => c.capability).join(', ');
    throw new CrucibleTextActError(
      'crucible_capability_undecided',
      `crucible "${server}" has no capability row for the "${act}" class `
        + `(${known === '' ? 'its record is empty' : `it reports: ${known}`}), so it has not said `
        + 'which model would serve it. That is what `crucible capability --write` writes, and it '
        + 'installing a job type from that server’s own page is what runs it — "Set up for '
        + 'BookForge" beside its row does the whole of it.',
    );
  }
  if (!row.enabled) {
    const short = row.shortfallBytes > 0
      ? ` It is short by ${(row.shortfallBytes / 1024 ** 3).toFixed(1)} GB.`
      : '';
    throw new CrucibleTextActError(
      'crucible_capability_disabled',
      `crucible "${server}" cannot serve the "${act}" class: ${row.reason}.${short} That is the `
        + 'server measuring its own card, not a setting — run this act on another server, or give '
        + 'that one a model it can hold.',
    );
  }
  if (row.selected.trim() === '') {
    throw new CrucibleTextActError(
      'crucible_capability_no_model',
      `crucible "${server}" reports the "${act}" class as ENABLED and names no model for it `
        + `(${row.reason}). Those two cannot both be true; re-run the capability probe on that `
        + 'server rather than having this app guess an id.',
    );
  }
  return row.selected;
}

/**
 * THE MODEL AN ACT WILL RUN ON, ASKED ONCE PER RUN AND STAMPED.
 *
 * ── The one owner of "which model does this class use on that server" ──────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3: *"The cleanup/OCR/translation/simplify/
 * analysis doors send `capability.selected` as the model to the registry's
 * server and nothing else."* Three call sites need that answer — the cleanup
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
  const model = modelFromCapability(await host.capability(where.server), where.act, where.server);
  where.model = model;
  return model;
}

/**
 * Decide where this text act runs. See the header for the three answers and the
 * order they are asked in.
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
  if (named !== undefined) {
    if (typeof named !== 'string' || named.trim() === '') {
      throw new CrucibleTextActError(
        'crucible_server_not_named',
        'a Crucible server was asked for and none was named. It takes the NAME of an entry in '
          + '<userData>/crucible-servers.json (bookforge-tts --crucible-list), or the reserved '
          + '"local"; there is no default server and no local fallback.',
      );
    }
    return { where: 'crucible', server: named.trim(), because: 'the caller named it' };
  }

  const view = host.view();

  // Throws CrucibleRoutingError `no_enabled_server` in routing's own words,
  // which already tell "you have none" from "you disabled them all".
  const enabled = host.enabled();

  if (view.newJobsWaitFor === 'top-ranked') {
    return {
      where: 'crucible',
      server: (enabled[0] as RankedServerRow).name,
      because: 'the top-ranked server',
    };
  }

  const tried: string[] = [];
  for (const row of enabled) {
    const pong = await host.ping(row.name);
    if (pong.outcome === 'ok') {
      return { where: 'crucible', server: row.name, because: 'any: the first that answered' };
    }
    tried.push(`${row.name} (${pong.outcome}: ${pong.message})`);
  }
  throw new CrucibleTextActError(
    'no_reachable_server',
    'new jobs are set to wait for ANY Crucible server, and none of the enabled ones answered: '
      + `${tried.join('; ')}. Start one, or add one in Settings → Crucible Servers. There are no `
      + 'local text engines to fall back to: a text act runs on a Crucible server or not at all.',
  );
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
  | 'process'
  /**
   * Somebody else's spawn, reached through a seam that carries no environment
   * — the hosted Foundry queue step. Refused by name.
   */
  | 'none';

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
}

/** Everything the engine needs for one act against one Crucible server. */
export interface CrucibleTextEngine {
  /** The server this resolved to, by name. */
  server: string;
  /** `--endpoint`: `<url>/v1/openai`. */
  endpoint: string;
  /**
   * `--model`: the id chosen for this act by the SERVER's capability record.
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
   * THE REACH QUESTION FIRST, because a caller that cannot give the engine an
   * environment cannot run the act however resident the model is — and asking
   * a server about its models to produce the same no would be a round trip
   * spent on a decision already made.
   */
  if (opts.headerReach === 'none') {
    const { hostedCrucibleTextActNotVendored } = await import('../foundry-host-queue.js');
    throw new CrucibleTextActError(
      'hosted_placement_not_vendored',
      hostedCrucibleTextActNotVendored(act, server),
    );
  }

  /*
   * THE ID, FROM THE SERVER THAT WILL RUN IT. `GET /v1/capability` is the one
   * owner of "which model serves this class here" (2026-09-14) — see
   * `TextVenueHost.modelFor`. Refuses by name in three different ways, each
   * naming what a person would do about it, and never invents an id.
   */
  const model = modelFromCapability(await host.capability(server), act, server);

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
   * tell somebody their capability record and their model list disagree, which
   * they do not. `loadFirst` is refused rather than skipped, because a caller
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
      endpoint: crucibleChatBase(entry.url),
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
      `crucible "${server}" has no model "${model}", which is what its OWN capability record `
        + `names for the ${act} class (${rows.length === 0 ? 'it advertises none' : `known: ${known}`}). `
        + 'The record and the model list disagree with each other on that server; re-run its '
        + 'capability probe, or pull the model the record names.',
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
    endpoint: crucibleChatBase(entry.url),
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
 * `409 model_leased` on the take is a WAIT and never a retry loop: it arrives as
 * {@link CrucibleTextActError} `crucible_model_leased` carrying the holder's line,
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
  // Required the same way and for the same reason, and by NAME rather than by
  // code: `model_leased` is a CrucibleRefused subclass, so it must be asked about
  // before the generic branch below or it would lose the holder's line.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CrucibleLeased } = require('./lease.js') as typeof import('./lease');
  if (err instanceof CrucibleLeased) {
    return new CrucibleTextActError(
      'crucible_model_leased',
      `crucible "${server}"'s resident model is leased by another run, so the ${act} act was not `
        + `started: ${err.leasedLine} (until at least ${err.expiresAt}). A lease is that client `
        + 'saying it intends more work on this model; nothing here waits it out or loads a model '
        + 'somewhere else. This book waits for that server.',
      err.leasedLine,
    );
  }
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
