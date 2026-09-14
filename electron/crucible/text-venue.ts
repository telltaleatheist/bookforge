/**
 * WHERE A TEXT ACT RUNS, and what the engine is handed when the answer is a
 * Crucible server.
 *
 * ── One routing record, one legacy switch ──────────────────────────────────
 *
 * `generation-venue.ts` answers this question for a RENDER. This answers it for
 * the four text acts, out of the SAME record, in the same order, with the same
 * refusals — because "which machine does this machine's work go to" is one
 * question and two answers to it would drift (crucible `docs/ARCHITECTURE.md`
 * R1). The four answers, unchanged:
 *
 *   1. The caller named a server — the queue row's resolved venue, the CLI's
 *      `--crucible-server`. An explicit instruction is never second-guessed.
 *   2. The legacy switch is on — the LOCAL text engines (llama-server through
 *      `text-server.ts`, or whatever endpoint Foundry's settings name). ONE
 *      switch covers renders and text passes: `legacyLocalRender` in the routing
 *      record, "Run renders and text passes with the local engines instead".
 *   3. `newJobsWaitFor: 'top-ranked'` — the top of the enabled list, NOT pinged,
 *      because naming a machine is an instruction.
 *   4. `newJobsWaitFor: 'any'` — the first enabled server whose `ping` answers.
 *
 * **There is no fallback to the local engines.** With the switch off, a text act
 * that cannot be placed FAILS, by name. Quietly starting llama-server instead
 * would take a card somebody else is using and clean a book with a model nobody
 * chose, and report success.
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
 * ── WHY EVERY CRUCIBLE TEXT ACT IS REFUSED TODAY ───────────────────────────
 *
 * Two gaps in the foundry ENGINE, measured by reading its source rather than by
 * running it, both written out in `text-acts.ts`'s header: it appends `/v1` to
 * Crucible's `/v1/openai` base (`normaliseVllmEndpoint`), and the hosted window
 * gives a spawn no per-run environment. Neither is BookForge's to fix. So this
 * module composes the whole answer and then refuses it —
 * `foundry_engine_cannot_reach_crucible` — rather than spawning a run that would
 * 404 an hour in or reach the server unauthenticated. The gate is a VERSION
 * FLOOR (`FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT`, beside every other foundry floor
 * this app enforces in `foundry-host-queue.ts`), so the day an engine ships both
 * fixes, that constant is the entire change here.
 */
import type { RankedServerRow, RoutingView } from '../../shared/crucible/settings-wire';
import type { ModelInfo } from '@crucible/client';
import { rankedServers, readRouting } from './routing';
import { pingServer, type CruciblePingResult } from './probe';
import { crucibleClientFor, getServer, CRUCIBLE_CLIENT_NAME, type ResolvedServer } from './servers';
import { textModelFor } from './text-models';
import {
  crucibleChatBase,
  endpointHeadersEnv,
  endpointHeaderMap,
  maskEndpointHeaders,
  type CrucibleTextAct,
} from './text-acts';

/** Where one text act runs, and why it is there. */
export type TextActVenue =
  | {
      where: 'crucible';
      /** A registered server's name, or the reserved `local`. Never a URL. */
      server: string;
      because: 'the caller named it' | 'the top-ranked server' | 'any: the first that answered';
    }
  | {
      where: 'legacy-local-engines';
      because: 'the legacy local-engine switch is on';
    };

export type CrucibleTextActErrorCode =
  /** A caller named `crucible` and no server. */
  | 'crucible_server_not_named'
  /** `any`, and not one enabled server answered. Names each one tried. */
  | 'no_reachable_server'
  /** The installed foundry engine cannot address a Crucible. See the header. */
  | 'foundry_engine_cannot_reach_crucible'
  /** The chosen server has no manifest for this act's model id. */
  | 'crucible_unknown_model'
  /** It has one, and nothing is serving it. The operator's job, never ours. */
  | 'crucible_model_not_resident'
  /** 409 from the server: the lane, or narrator's wire, is held. */
  | 'crucible_server_busy';

export class CrucibleTextActError extends Error {
  readonly code: CrucibleTextActErrorCode;
  /** The SDK's "GPU busy: foundry, tts 62% done", for `noteStepBusy`. */
  readonly busyLine?: string;

  constructor(code: CrucibleTextActErrorCode, message: string, busyLine?: string) {
    super(message);
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
  /** The Crucible model id chosen for this act, or a named refusal. */
  modelFor(act: CrucibleTextAct): string;
  /** The installed foundry engine's version, e.g. `1.3.0`. */
  engineVersion(): Promise<string>;
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
    modelFor: textModelFor,
    async engineVersion(): Promise<string> {
      const { foundryVersion } = await import('../foundry-bridge.js');
      return (await foundryVersion()).version;
    },
  };
}

/**
 * Decide where this text act runs. See the header for the four answers and the
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
  if (view.legacyLocalRender) {
    return { where: 'legacy-local-engines', because: 'the legacy local-engine switch is on' };
  }

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
      + `${tried.join('; ')}. Start one, or turn on "Run renders and text passes with the local `
      + 'engines instead" in Settings → Crucible Servers. Nothing runs on this machine by accident.',
  );
}

export interface CrucibleTextActOptions {
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
  /** `--model`: the Crucible id chosen for this act, proved resident. */
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
  opts: CrucibleTextActOptions = {},
): Promise<CrucibleTextEngine> {
  const { FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT, foundryTooOldForCrucibleText } =
    await import('../foundry-host-queue.js');
  const { foundryVersionAtLeast } = await import('../../shared/vlm/readings-bank.js');
  const installed = await host.engineVersion();
  if (!foundryVersionAtLeast(installed, FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT)) {
    throw new CrucibleTextActError(
      'foundry_engine_cannot_reach_crucible',
      foundryTooOldForCrucibleText(installed, act, server),
    );
  }

  // The id, from the ONE record that holds it. Refuses
  // `crucible_text_model_not_set` by name when this act has never been pointed
  // at a model — an Ollama tag is not a Crucible id and is never read as one.
  const model = host.modelFor(act);

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
      `crucible "${server}" has no model "${model}", which is what Settings → AI → Crucible names `
        + `for the ${act} act (${rows.length === 0 ? 'it advertises none' : `known: ${known}`}). `
        + 'Pick one of its own ids; a Crucible id is stable across machines, so the choice is good '
        + 'on every server that serves that manifest.',
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
