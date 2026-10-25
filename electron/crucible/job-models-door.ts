/**
 * THE DOOR A JOB'S MODEL DROPDOWN READS (Owen, 2026-10-25).
 *
 * Verbatim: *"put the option the user can pick in a dropdown on the modal that
 * configures the job"*; *"cloud accounts should be listed as an option in every
 * model dropdown if its available, just like 27b or 9b or anything else.
 * however, bookforge should use the last used model as the default. the ideal is
 * that the user wont need to use cloud models because theyre expensive. but it
 * should be there if their system is too weak to run a local model"*; *"keep it
 * at 27b as the max right now"*.
 *
 * So a clean, a translate or an analysis no longer reads the server's per-class
 * setting for its model: the modal that configures the job offers a list and the
 * job carries the choice (`chosenModel`, absent = AUTOMATIC). The LIST is
 * `shared/crucible/job-models.ts`'s pure rule; this module is the two reads it is
 * built from and nothing else:
 *
 *  1. `GET /v1/models` — every model the server has a manifest for. REQUIRED: a
 *     server that does not answer it has no list to offer, and the modal says so
 *     by the server's name rather than drawing an AUTOMATIC row that names a
 *     machine nobody reached.
 *  2. `GET /v1/openai/models` — what each configured upstream account serves
 *     (Crucible 2.0.31). OPTIONAL: when it cannot be read the local rows are
 *     still the list, and the cloud half is a sentence (`cloudNote`) saying why
 *     it is missing. A person whose card runs the 27B loses nothing by it, and a
 *     person who needs the cloud is told what to look at.
 *
 * ── WHICH SERVER ──────────────────────────────────────────────────────────
 *
 * The one the job will run on. A modal that names a server (the AI config's
 * engine) passes it; a modal that does not passes null, and the list is read
 * from the server the act's own venue rule picks — `decideWhereTextActRuns`
 * with nothing named, the first enabled server that answers — which is the
 * machine an unassigned text act would be placed on. The answer names the
 * server either way, so the dropdown can say whose card AUTOMATIC means.
 *
 * ── WEATHER, AND WHAT IS NOT ──────────────────────────────────────────────
 *
 * CLAUDE.md, Owen 2026-09-20: *"the no fallbacks rule is about unexpected
 * codepaths and band-aids."* A socket that died, a connect that timed out, a
 * 5xx from a server restarting its engine: each of those is retried within
 * {@link JOB_MODELS_READ_ATTEMPTS} attempts, because a dropdown that went red on
 * one blip would be the fragility that ruling names. Past the budget it is a
 * sentence naming the server and the cause, and the modal's Re-check is the
 * wait. A server name nobody registered, or a body that is not the contract's,
 * is not weather and is never retried.
 */
import type { ModelInfo, UpstreamModels } from '@crucible/client';
import {
  jobModelChoices,
  type JobModelChoices,
} from '../../shared/crucible/job-models';
import { crucibleClientFor, CRUCIBLE_CLIENT_NAME } from './servers';
import { crucibleUnavailableCause, transportFailureCause } from './transport-failure';
import { decideWhereTextActRuns, processTextVenueHost } from './text-venue';

/** How many times one read is tried when the failure is the wire. */
export const JOB_MODELS_READ_ATTEMPTS = 3;
/** The pause before each retry, in ms: 0.5 s, then 1.5 s — under 2 s of waiting in all. */
const RETRY_PAUSES_MS: readonly number[] = [500, 1500];

/** The reads this door makes, so a keeper can drive every branch with a fake server. */
export interface JobModelsHost {
  /** The server a job with no named server would run on. */
  decideServer(): Promise<string>;
  models(server: string): Promise<ModelInfo[]>;
  upstreamModels(server: string): Promise<UpstreamModels>;
  /** Waits between attempts; a keeper passes one that does not. */
  pause(ms: number): Promise<void>;
}

/** The real one: the registry, the routing record and real HTTP. */
export function processJobModelsHost(): JobModelsHost {
  return {
    async decideServer(): Promise<string> {
      return (await decideWhereTextActRuns(undefined, processTextVenueHost())).server;
    },
    async models(server: string): Promise<ModelInfo[]> {
      return (await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME)).models();
    },
    async upstreamModels(server: string): Promise<UpstreamModels> {
      return (await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME)).upstreamModels();
    },
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The wire's own words for a failure worth another try, or null when it is not one. */
function weatherCause(err: unknown): string | null {
  return crucibleUnavailableCause(err) ?? transportFailureCause(err);
}

/**
 * One read, retried while the failure is the wire. Past the budget the LAST
 * cause is thrown in a sentence; anything that is not weather is thrown on the
 * first attempt, unchanged, because retrying a misconfiguration only delays the
 * sentence that names it.
 */
async function readWithBudget<T>(
  host: JobModelsHost,
  what: string,
  server: string,
  read: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (err) {
      const cause = weatherCause(err);
      if (cause === null) throw err;
      if (attempt >= JOB_MODELS_READ_ATTEMPTS) {
        throw new Error(
          `crucible "${server}" did not answer ${what} after ${attempt} tries: ${cause}. `
          + 'Check that it is running and reachable, then press Re-check.');
      }
      await host.pause(RETRY_PAUSES_MS[attempt - 1] ?? RETRY_PAUSES_MS[RETRY_PAUSES_MS.length - 1]!);
    }
  }
}

/**
 * THE LIST FOR ONE SERVER. `named` is the server the modal's job will run on,
 * or null to read it from the venue rule (see the header).
 *
 * Throws when the server cannot be named or its models cannot be read — the
 * renderer shows that sentence by the server's name. Never throws for the cloud
 * half: that becomes `cloudNote`.
 */
export async function readJobModelChoices(
  named: string | null,
  host: JobModelsHost = processJobModelsHost(),
): Promise<JobModelChoices> {
  if (named !== null && named.trim() === '') {
    throw new Error('crucible_server_not_named: the model list was asked for a server and was '
      + 'given an empty name. Pass the server the job will run on, or null to use the one the '
      + 'queue would pick.');
  }
  const server = named === null ? await host.decideServer() : named.trim();
  const local = await readWithBudget(host, 'GET /v1/models', server, () => host.models(server));

  let cloud: UpstreamModels | null = null;
  let cloudUnreadable: string | null = null;
  try {
    cloud = await readWithBudget(
      host, 'GET /v1/openai/models', server, () => host.upstreamModels(server));
  } catch (err) {
    // The cloud half is OPTIONAL by Owen's own words — "it should be there if
    // their system is too weak" — so its absence is said, not thrown. The
    // reason is the server's (or the wire's), verbatim.
    cloudUnreadable = err instanceof Error ? err.message : String(err);
  }

  return jobModelChoices(
    server,
    local.map((m) => ({
      id: m.id,
      paramsB: m.paramsB,
      installed: m.installed,
      loadable: m.loadable,
      backendSupported: m.backendSupported,
      verbs: m.verbs,
      modalities: m.modalities,
    })),
    cloud === null
      ? null
      : {
        models: cloud.models.map((m) => ({ id: m.id, upstream: m.upstream })),
        upstreams: cloud.upstreams,
      },
    cloudUnreadable,
  );
}
