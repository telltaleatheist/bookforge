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
 * It reads. {@link loadModelOn}, {@link unloadModelOn} and
 * {@link loadHiggsVoiceOn} are the exceptions and they are operator verbs
 * (PHASE5-APPS.md section 2: "an operator deciding what is resident is the
 * model this whole design rests on and there is currently nowhere to do it but
 * a CLI flag") — they submit a job that touches the accelerator, so they are
 * wired to a button and nothing calls them on their own. No poll here loads
 * anything, and nothing unloads a model on a machine this app does not own.
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
import { crucibleClientFor, getServer, listServers, maskToken, CRUCIBLE_CLIENT_NAME } from './servers';
import { CrucibleDiscoveryError, discoverCrucible, processDiscoveryHost } from './discovery';
import { getWslDistro } from '../tool-paths';
import { readRouting } from './routing';
import {
  CrucibleVoiceLoadRefused,
  crucibleVoiceLoadFor,
  loadVoiceOn,
  refuseMismatchedReference,
  type CrucibleVoiceLoaded,
} from './voice-load';

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
 * Everything the row draws before it probes anything: every registered server,
 * the rank/enable record resolved against them, and — separately — whether
 * there is a Crucible on THIS computer the add form can be prefilled from.
 *
 * ── The offer is not a row (Owen's ruling, 2026-09-15) ────────────────────
 *
 * `discovered` used to be `local`: a server the panel drew above the list, with
 * its own card, its own Test button and no Remove, because the app manufactured
 * it from this machine's config instead of from the registry. It is now an
 * OFFER — "there is a Crucible here; add it?" — and `registeredAs` says when the
 * offer has already been taken, which is the one thing a person needs to know
 * before pressing Add a second time.
 *
 * The token is masked here exactly as a registry entry's is. It travels no
 * further than the number of characters it takes to tell two apart.
 */
export function serversView(): CrucibleServersView {
  const servers = listServers();
  return {
    servers: servers.map((entry) => ({
      name: entry.name,
      url: entry.url,
      tokenMasked: entry.tokenMasked,
      added: entry.added,
    })),
    discovered: discoveredRow(servers.map((entry) => ({ name: entry.name, url: entry.url }))),
    routing: readRouting(),
  };
}

/** The offer, or the named reason there is nothing to offer. Never throws for "none". */
function discoveredRow(
  registered: readonly { name: string; url: string }[],
): CrucibleServersView['discovered'] {
  try {
    const found = discoverCrucible(processDiscoveryHost(getWslDistro()));
    const url = found.url.replace(/\/+$/, '');
    const already = registered.find((entry) => entry.url.replace(/\/+$/, '') === url);
    return {
      present: true,
      serverName: found.name,
      url: found.url,
      tokenMasked: maskToken(found.token),
      configPath: found.configPath,
      via: found.via,
      registeredAs: already === undefined ? null : already.name,
    };
  } catch (err) {
    if (err instanceof CrucibleDiscoveryError) {
      return { present: false, code: err.code, reason: err.message };
    }
    throw err;
  }
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

/** The same Test, for a server this machine already knows, by its registry name. */
export async function probeServer(name: string): Promise<CrucibleProbeResult> {
  let client: CrucibleClient;
  try {
    client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    // An unknown name, or a corrupt registry: each is already a named refusal
    // with its own fix in the message.
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

/**
 * Make a Higgs VOICE resident, clip and all — the third operator verb.
 *
 * The zero-shot half is why this is not `loadModelOn` with a different string
 * (crucible `docs/PHASE3-TTS.md` §5's amendment, plan §4b): BookForge's four
 * `zeroshot-*` catalog entries are the base weights plus ONE reference
 * recording each, so all four load as Crucible's single `zeroshot` voice with
 * the clip travelling in `params.reference`. `voice-load.ts` reads the wav out
 * of `<userData>/runtime/higgs-models/refs/`, takes its BOOK-EXACT transcript
 * from the same catalog row, and refuses a clip the server would refuse —
 * using the server's own names — before a megabyte crosses a tailnet.
 *
 * Every other kind of voice loads with no reference, which is not an omission:
 * a checkpoint's speaker is in its weights, and sending a clip with one is
 * `reference_not_allowed`.
 *
 * ONE `GET /v1/voices` FIRST, so `needsReference` is the SERVER's answer and
 * not this catalog's guess. It is the same shape and the same reason as
 * `render.ts`'s pre-flight: at load time it turns "the job failed" into "this
 * server does not serve that voice", which are two different fixes.
 */
export async function loadHiggsVoiceOn(
  name: string,
  voiceId: string,
  userDataDir: string,
  onProgress?: (line: string) => void,
): Promise<{ outcome: 'ok'; loaded: CrucibleVoiceLoaded } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>> {
  let client: CrucibleClient;
  try {
    client = crucibleClientFor(name, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  let load;
  try {
    load = crucibleVoiceLoadFor(voiceId, userDataDir);
  } catch (err) {
    // A catalog refusal, a missing clip file, or a clip the server would
    // refuse — all named, all before anything is asked of the server.
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    refuseMismatchedReference(await client.voices(), load, name);
  } catch (err) {
    if (err instanceof CrucibleVoiceLoadRefused) return { outcome: 'refused', message: err.message };
    return failureOutcome(err, `"${name}" (${client.url})`);
  }
  try {
    return { outcome: 'ok', loaded: await loadVoiceOn(client, load, onProgress) };
  } catch (err) {
    if (err instanceof CrucibleVoiceLoadRefused) return { outcome: 'refused', message: err.message };
    return failureOutcome(err, `"${name}" (${client.url})`);
  }
}

/**
 * WHICH CLIP IS ON THAT CARD — read straight off `/v1/activity`, because the
 * vendored SDK drops the field.
 *
 * `zeroshot` is one voice id and any number of recordings, so "zeroshot is
 * resident" does not answer "whose voice will this book be read in" — and two
 * clients (this app and the browser extension) can each have put one there.
 * PHASE3-TTS.md §5's amendment puts it on `/v1/activity`'s `resident` block as
 * `reference: {name, sha256, seconds}`, null for every other kind.
 *
 * ── WHY A `fetch` AND NOT `client.activity()` ─────────────────────────────
 *
 * The 0.6.0 SDK's activity reader builds `resident` out of four named fields —
 * `kind`, `id`, `since`, `memory_bytes_estimate` — and drops the rest,
 * `reference` included. The field IS on the wire and IS in the contract; what
 * is missing is a line in the SDK's shaper. That is the same situation
 * `settings-wire.ts` was in before the phase-15 re-pack, and it gets the same
 * treatment: speak the documented wire, read ONLY the field the SDK does not
 * model, and let `tools/test-zeroshot-reference.js` FAIL BY NAME the day the
 * SDK carries it — which is the instruction to delete this function, not a
 * regression.
 */
export async function residentClipOn(
  name: string,
): Promise<
  { outcome: 'ok'; clip: { name: string | null; sha256: string; seconds: number } | null }
  | Exclude<CrucibleProbeResult, { outcome: 'ok' }>
> {
  let entry;
  try {
    entry = getServer(name);
  } catch (err) {
    return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  let body: { resident?: { reference?: unknown } | null };
  try {
    const response = await fetch(`${entry.url}/v1/activity`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${entry.token}`, 'X-Crucible-Api': '1' },
    });
    if (!response.ok) {
      return {
        outcome: 'refused',
        message: `crucible "${name}" answered HTTP ${response.status} for /v1/activity, so which `
          + 'reference clip is resident there cannot be read.',
      };
    }
    body = await response.json() as { resident?: { reference?: unknown } | null };
  } catch (err) {
    return failureOutcome(err, `"${name}" (${entry.url})`);
  }
  const resident = body.resident;
  if (resident === null || resident === undefined) return { outcome: 'ok', clip: null };
  const reference = resident.reference;
  // `null` is "nothing was cloned" — a checkpoint voice, or a model — and it
  // is an ANSWER. The key being ABSENT is a server that predates §5's
  // amendment, which is a different thing and is said so rather than read as
  // "no clip".
  if (reference === null) return { outcome: 'ok', clip: null };
  if (reference === undefined) {
    return {
      outcome: 'refused',
      message: `crucible "${name}" does not report a resident reference on /v1/activity. That `
        + 'server predates PHASE3-TTS.md §5\'s amendment, so which clip a zero-shot voice was '
        + 'cloned from is unknowable from here — update it.',
    };
  }
  const row = reference as { name?: unknown; sha256?: unknown; seconds?: unknown };
  if (typeof row.sha256 !== 'string' || typeof row.seconds !== 'number') {
    return {
      outcome: 'refused',
      message: `crucible "${name}" reported a resident reference with no sha256 or no seconds.`,
    };
  }
  return {
    outcome: 'ok',
    clip: {
      name: typeof row.name === 'string' && row.name !== '' ? row.name : null,
      sha256: row.sha256,
      seconds: row.seconds,
    },
  };
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
