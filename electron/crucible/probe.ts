/**
 * What a Crucible server says about itself, for the settings row that asks.
 *
 * ── Why this exists as its own module ───────────────────────────────────────
 *
 * `servers.ts` builds a client, `routing.ts` ranks them, and neither talks to a
 * server. This is the talking half, and it is separate for one reason: every
 * answer here is a NAMED OUTCOME rather than an exception, because the row's
 * whole job is to tell four different failures apart and show the fix for each.
 *
 * `ping` is unauthenticated and `info` is not (crucible `docs/PHASE5-APPS.md`
 * section 2), so the pair distinguishes:
 *
 *   nothing there            → `unreachable`
 *   something, not a Crucible→ `not_a_crucible`
 *   a Crucible, bad token    → `wrong_token`
 *   a Crucible, other API    → `version_mismatch`
 *   a Crucible               → `ok`, with the backend, GPU, job types and
 *                              what is resident
 *
 * ── Not a second translator ─────────────────────────────────────────────────
 *
 * `ai-bridge.ts` translates the same SDK errors into cleanup-run sentences, and
 * that is a different question with a different reader: there the answer is
 * "your cleanup will not run, here is the CLI verb that fixes it", here it is
 * "this address/token pair is or is not a server". The SDK's error TYPES are the
 * one shared fact, and both sides switch on those rather than on each other's
 * prose.
 *
 * ── What this module will not do ────────────────────────────────────────────
 *
 * It reads. {@link loadModelOn} and {@link unloadModelOn} are the two exceptions
 * and they are operator verbs (PHASE5-APPS.md section 2: "an operator deciding
 * what is resident is the model this whole design rests on and there is
 * currently nowhere to do it but a CLI flag") — they submit a job that touches
 * the accelerator, so they are wired to a button and nothing calls them on their
 * own. No poll here loads anything, and nothing unloads a model on a machine
 * this app does not own.
 */
import {
  CrucibleAuthError,
  CrucibleClient,
  CrucibleNotACrucible,
  CrucibleRefused,
  CrucibleUnreachable,
  CrucibleVersionError,
  type Activity,
  type ModelInfo,
  type ServerInfo,
} from '@crucible/client';
import type {
  CrucibleActivityView,
  CrucibleModelRow,
  CrucibleProbeResult,
  CrucibleServersView,
  ServerFacts,
} from '../../shared/crucible/settings-wire';
import { crucibleClientFor, describeLocal, listServers, CRUCIBLE_CLIENT_NAME } from './servers';
import { readRouting } from './routing';

/**
 * What one unauthenticated `ping` answered.
 *
 * Its own type rather than a {@link CrucibleProbeResult}: `ping` learns the
 * server's name and its api version and NOTHING else — no backend, no GPU, no
 * job types, nothing about the token — and filling a facts block with empty
 * strings to reuse a shape would be inventing four answers this call never got.
 */
export type CruciblePingResult =
  | { outcome: 'ok'; serverName: string; apiVersion: number }
  | Exclude<CrucibleProbeResult, { outcome: 'ok' }>;

/**
 * Everything the row draws before it probes anything: the local server (or the
 * named reason there is none), the registered remotes, and the rank/enable
 * record resolved against both.
 */
export function serversView(): CrucibleServersView {
  const local = describeLocal();
  return {
    local: local.present
      ? {
          present: true,
          serverName: local.serverName,
          url: local.url,
          tokenMasked: local.tokenMasked,
          configPath: local.configPath,
          via: local.via,
        }
      : { present: false, code: local.code, reason: local.reason },
    remotes: listServers().map((entry) => ({
      name: entry.name,
      url: entry.url,
      tokenMasked: entry.tokenMasked,
      added: entry.added,
      stale: entry.stale,
    })),
    routing: readRouting(),
  };
}

/**
 * One SDK or registry failure as the outcome the row shows.
 *
 * Every branch names what to fix. The last one keeps the message it was given
 * rather than inventing one: a refusal this module has not heard of is still the
 * server's own sentence, and replacing it with "something went wrong" is how a
 * fixable problem becomes an unfixable one.
 */
function failureOutcome(err: unknown, at: string): Exclude<CrucibleProbeResult, { outcome: 'ok' }> {
  if (err instanceof CrucibleUnreachable) {
    return {
      outcome: 'unreachable',
      message: `Nothing answered at ${err.url}. Check the address, that the server is running `
        + '(`crucible serve`), and that this machine can reach it.',
    };
  }
  if (err instanceof CrucibleNotACrucible) {
    return {
      outcome: 'not_a_crucible',
      message: `${at} answered, but it is not a Crucible: ${err.body}. Check the address — this is `
        + 'the base URL without /v1.',
    };
  }
  if (err instanceof CrucibleAuthError) {
    return {
      outcome: 'wrong_token',
      message: `${at} is a Crucible and refused the token (${err.serverMessage}). Paste the one `
        + '`crucible token --show` prints on that host.',
    };
  }
  if (err instanceof CrucibleVersionError) {
    return {
      outcome: 'version_mismatch',
      message: `${at} speaks API version ${err.serverApiVersion ?? 'unknown'}; this build speaks `
        + `${err.clientApiVersion}. Upgrade whichever is older (${err.serverMessage}).`,
    };
  }
  return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
}

/** `info` + `health`, as one set of facts. */
async function factsOf(client: CrucibleClient): Promise<ServerFacts> {
  const info: ServerInfo = await client.info();
  const health = await client.health();
  return {
    serverName: info.server.name,
    version: info.server.version,
    apiVersion: info.server.apiVersion,
    platform: info.host.platform,
    arch: info.host.arch,
    backend: info.host.backend,
    gpu: { vendor: info.host.gpu.vendor, name: info.host.gpu.name, vramBytes: info.host.gpu.vramBytes },
    jobTypes: [...info.jobTypes],
    health: health.status,
    queueDepth: health.queueDepth,
    residentModels: [...health.residentModels],
    residentKind: health.residentKind,
  };
}

/**
 * The Add form's Test: an address and a token that are not in the registry yet.
 *
 * The token is REQUIRED even though `ping` does not use it — a Crucible has no
 * anonymous mode, so an entry without one can only 401, and testing half an
 * entry would report success for a pairing that cannot work.
 */
export async function probeAddress(url: string, token: string): Promise<CrucibleProbeResult> {
  const at = url.trim() === '' ? 'that address' : url.trim();
  if (token.trim() === '') {
    return {
      outcome: 'refused',
      message: 'No token. Every Crucible route except /v1/ping needs the bearer token '
        + '`crucible token --show` prints on that host; there is no anonymous mode.',
    };
  }
  let client: CrucibleClient;
  try {
    client = new CrucibleClient({ url: url.trim(), token: token.trim(), clientName: CRUCIBLE_CLIENT_NAME });
  } catch (err) {
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    await client.ping();
    return { outcome: 'ok', facts: await factsOf(client) };
  } catch (err) {
    return failureOutcome(err, at);
  }
}

/**
 * IS THERE A CRUCIBLE AT THIS SERVER'S ADDRESS — one unauthenticated call.
 *
 * The candidacy question, and deliberately the cheapest one that answers it:
 * `waitFor: any` asks it of each enabled server in rank order before it sends a
 * book (crucible `docs/PHASE7-LANES.md` §4.2.1 — "unreachable servers are simply
 * not candidates"), so it must not cost three round trips per machine.
 *
 * **An `ok` here is not permission to submit.** It says the address answers;
 * whether the lane is free is settled at the door by `POST /v1/jobs`, which
 * admits one client and refuses the other by name. A client is built to be
 * refused after reading this.
 */
export async function pingServer(name: string): Promise<CruciblePingResult> {
  let client: CrucibleClient;
  try {
    client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    const pong = await client.ping();
    return { outcome: 'ok', serverName: pong.name, apiVersion: pong.apiVersion };
  } catch (err) {
    return failureOutcome(err, `"${name}" (${client.url})`);
  }
}

/** The same Test, for a server this machine already knows: `local` or a registry name. */
export async function probeServer(name: string): Promise<CrucibleProbeResult> {
  let client: CrucibleClient;
  try {
    client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    // An unknown name, a stale local entry, or no local config at all: each is
    // already a named refusal with its own fix in the message.
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    await client.ping();
    return { outcome: 'ok', facts: await factsOf(client) };
  } catch (err) {
    return failureOutcome(err, `"${name}" (${client.url})`);
  }
}

/** `GET /v1/activity` — what that machine is doing, or why it cannot be asked. */
export async function activityOf(
  name: string,
): Promise<{ outcome: 'ok'; activity: CrucibleActivityView } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>> {
  let client: CrucibleClient;
  try {
    client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    // No accelerator probe: this is a bench read on a machine that may be
    // rendering, and the probe costs a card query nobody asked for. The row has
    // its own button for that question.
    const activity: Activity = await client.activity();
    return {
      outcome: 'ok',
      activity: {
        serverName: activity.server.name,
        uptimeS: activity.server.uptimeS,
        resident: activity.resident
          ? { kind: activity.resident.kind, id: activity.resident.id, since: activity.resident.since }
          : null,
        warming: activity.warming,
        claimedBy: activity.claim ? activity.claim.heldBy : null,
        streaming: activity.streaming
          ? {
              sessionId: activity.streaming.sessionId,
              voice: activity.streaming.voice,
              since: activity.streaming.since,
              client: activity.streaming.client,
              said: activity.streaming.said,
              finished: activity.streaming.finished,
              inFlight: activity.streaming.inFlight,
              seconds: activity.streaming.seconds,
            }
          : null,
        chatInFlight: activity.chat.inFlight,
        slot: {
          busy: activity.slots.accelerated.busy,
          of: activity.slots.accelerated.of,
          queueDepth: activity.slots.accelerated.queueDepth,
          acceptsWork: activity.slots.accelerated.acceptsWork,
        },
        running: activity.running.map(jobRow),
        queued: activity.queued.map(jobRow),
      },
    };
  } catch (err) {
    // A 404 here is not "no activity" and not a bad address: `/v1/activity`
    // arrived in Crucible 0.5.0, so an older server simply has no such route.
    // Measured against the Mac on 2026-09-13, which runs 0.4.0 and answered
    // "404 not_found: Not Found" — a sentence nobody could have acted on.
    if (err instanceof CrucibleRefused && err.status === 404) {
      return {
        outcome: 'refused',
        message: `"${name}" has no /v1/activity route: that arrived in Crucible 0.5.0, and this `
          + 'server is older. Everything else on this row works; upgrade it to see what it is doing.',
      };
    }
    return failureOutcome(err, `"${name}" (${client.url})`);
  }
}

function jobRow(job: Activity['running'][number]) {
  return {
    jobId: job.jobId,
    type: job.type,
    model: job.model,
    status: job.status,
    progress: job.progress,
    message: job.message,
    client: job.client,
  };
}

/**
 * `GET /v1/models` — every model that server has a manifest for, with the four
 * separate facts and the reason for a no. The row shows all of them: "installed
 * but not resident" is exactly the state a cleanup run refuses on, and hiding it
 * would leave the operator with a model picker that cannot explain itself.
 */
export async function modelsOf(
  name: string,
): Promise<{ outcome: 'ok'; models: CrucibleModelRow[] } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>> {
  let client: CrucibleClient;
  try {
    client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    const rows: ModelInfo[] = await client.models();
    return {
      outcome: 'ok',
      models: rows.map((row) => ({
        id: row.id,
        family: row.family,
        paramsB: row.paramsB,
        backendSupported: row.backendSupported,
        installed: row.installed,
        resident: row.resident,
        loadable: row.loadable,
        ...(row.reason === undefined ? {} : { reason: row.reason }),
        memoryBytesEstimate: row.memoryBytesEstimate,
      })),
    };
  } catch (err) {
    return failureOutcome(err, `"${name}" (${client.url})`);
  }
}

/**
 * Make a model resident. An OPERATOR VERB: it submits a `load-model` job, which
 * takes the lane and the card on that machine, so it happens only when somebody
 * presses the button. Returns the job id — watch it on the activity row, which
 * is where `warming` shows up.
 */
export async function loadModelOn(
  name: string,
  model: string,
): Promise<{ outcome: 'ok'; jobId: string } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>> {
  return operate(name, (client) => client.loadModel(model));
}

/**
 * Take a model off the card. The other operator verb, and the reason the app
 * never does it by itself: an unload behind someone's back evicts the model
 * their next run is about to use, on a machine this app does not own.
 */
export async function unloadModelOn(
  name: string,
  model: string,
): Promise<{ outcome: 'ok'; jobId: string } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>> {
  return operate(name, (client) => client.unloadModel(model));
}

async function operate(
  name: string,
  submit: (client: CrucibleClient) => Promise<string>,
): Promise<{ outcome: 'ok'; jobId: string } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>> {
  let client: CrucibleClient;
  try {
    client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { outcome: 'ok', jobId: await submit(client) };
  } catch (err) {
    return failureOutcome(err, `"${name}" (${client.url})`);
  }
}
