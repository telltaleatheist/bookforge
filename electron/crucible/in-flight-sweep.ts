/**
 * GIVING BACK EVERY CARD THIS APP IS STILL HOLDING — at quit, and at the start
 * after a quit that never happened.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-19, after ctrl-C on `electron:dev` left a `tts` job running at
 * 70% on the Mac's Crucible for an hour with the voice resident and the card
 * claimed: *"update bookforge to send the model kill command to crucible servers
 * before actually closing so that doesn't happen again."*
 *
 * There are two moments and they are the same sweep:
 *
 *   QUIT    — the app is going away on purpose. Every job it has on every
 *             server is DELETEd, and the card is confirmed clear before the
 *             loggers close.
 *   START   — the app is coming back from a quit that never ran. The ledger on
 *             disk is the only thing that knows what was left behind; the same
 *             sweep finishes it.
 *
 * ── Cancelling IS the model kill ────────────────────────────────────────────
 *
 * Crucible unloads what is on the card the moment nothing holds it (Owen's
 * 2026-09-14 ruling: *"Models should always be unloaded when we're done with
 * them. Every time."* — `crucible/settle.py`'s `Settlement`). A model is
 * resident only while a job, a lease, a claim, a stream or a chat holds it. So
 * the DELETE is the kill: stop holding the card and the server takes the 12 GB
 * off by itself, usually before this sweep has finished polling.
 *
 * The explicit `unload-*` here is for the ONE case that ruling does not cover:
 * the card still carries a resident that NOTHING holds. That is a server whose
 * settlement has not fired, and it is asked once, by name, never in a loop.
 *
 * ── What it will never do ───────────────────────────────────────────────────
 *
 * **It never unloads a model somebody else is using.** A Crucible is shared —
 * the PC's BookForge and this one report the SAME `client` string
 * (`bookforge crucible-client/1.0.6`), so a server cannot tell two installs
 * apart and neither can this. The only thing this app can honestly claim is a
 * JOB ID it wrote down itself. Anything else holding the card — another job, a
 * claim, a lease, a stream, a chat in flight — means hands off, and one named
 * log line saying so.
 *
 * **It never hangs the quit.** Every server is bounded by {@link SweepTiming},
 * every refusal and unreachable is a named log line, and the caller wraps the
 * whole thing in `quitStepWithDeadline` on top of that.
 *
 * **It never retries a refusal.** A `409 leased`/`server_busy` on an unload is
 * the server saying somebody else owns that card; retrying it is how an app
 * that is quitting takes a model off a run that is not its own.
 *
 * ── What survives a sweep ───────────────────────────────────────────────────
 *
 * A ledger row whose server could not be reached STAYS. That is the difference
 * between a delayed cleanup and a permanent hole: the machine may be asleep,
 * the tailnet down, the token rotated — and at the next start the same sweep
 * asks again. Only a job the server confirmed cancelled or no longer has is
 * forgotten.
 */
import type { Activity, CrucibleClient } from '@crucible/client';
import { CrucibleUnreachable } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import { cancelCrucibleJobById, describeCrucibleJobRefusal } from './job';
import {
  readInFlightLedger,
  settleInFlight,
  type CrucibleInFlightEntry,
} from './in-flight-ledger';

/**
 * The unload job type that takes a resident of this KIND off the card.
 *
 * The kinds are Crucible's own (`crucible/residency.py`: `KIND_LLM = "llm"`,
 * `KIND_TTS = "tts"`, `KIND_ALIGN = "align"`, `KIND_DENOISE = "denoise"`) and
 * the job types are the ones its lane table maps them back to
 * (`crucible/leases.py` `CardEffect(takes_off=…)`).
 *
 * A kind this table has not heard of answers null and is LOGGED, never guessed
 * at by string-munging `unload-${kind}`: the set grows on the server's schedule,
 * and a manufactured job type would be a 400 from a sweep that is quitting.
 */
export function unloadJobTypeForResidentKind(kind: string): string | null {
  switch (kind) {
    case 'llm': return 'unload-model';
    case 'tts': return 'unload-voice';
    case 'align': return 'unload-aligner';
    case 'denoise': return 'unload-denoiser';
    default: return null;
  }
}

/**
 * Who, other than a job in `ours`, is holding this server's card — or null when
 * the answer is nobody.
 *
 * PURE, and it is the whole safety rule of this module: an unload is submitted
 * only when this answers null. Every one of these is a real holder in
 * Crucible's settlement (`crucible/settle.py`): a job on the lane, a queued job
 * about to take it, narrator's claim, an open lease, a streaming session, a
 * chat in flight, and a stop already under way.
 */
export function cardHeldBy(
  activity: Activity,
  ours: ReadonlySet<string>,
): string | null {
  const foreignRunning = activity.running.filter((job) => !ours.has(job.jobId));
  if (foreignRunning.length > 0) {
    const job = foreignRunning[0]!;
    return `a ${job.type} job (${job.jobId}) from ${job.client}`;
  }
  const foreignQueued = activity.queued.filter((job) => !ours.has(job.jobId));
  if (foreignQueued.length > 0) {
    const job = foreignQueued[0]!;
    return `a queued ${job.type} job (${job.jobId}) from ${job.client}`;
  }
  if (activity.claim !== null) return `a claim held by ${activity.claim.heldBy}`;
  if (activity.lease !== null) return 'an open lease';
  if (activity.streaming !== null) return `a streaming session from ${activity.streaming.client}`;
  if (activity.chat.inFlight > 0) return `${activity.chat.inFlight} chat completion(s) in flight`;
  if (activity.stopping !== null) return `a stop of ${activity.stopping.id} already under way`;
  return null;
}

/** Our job ids still on this server's lane, running or queued. PURE. */
export function oursStillOnTheLane(activity: Activity, ours: ReadonlySet<string>): string[] {
  return [...activity.running, ...activity.queued]
    .map((job) => job.jobId)
    .filter((id) => ours.has(id));
}

/**
 * How long a sweep may spend per server confirming the card came back.
 *
 * A DELETE is answered `cancelling` in milliseconds and the job then stops at
 * its next checkpoint — "the job can take a minute to actually stop while its
 * batch finishes" (Crucible's own words). This sweep does not wait a minute:
 * the DELETE has landed, the server will settle on its own schedule, and a quit
 * that waited out a batch would be a quit that hangs. Six seconds is enough for
 * the ordinary case — a queued job cancels at once, a running one usually
 * inside a chunk — and the honest report for the rest is "told to stop, had not
 * yet".
 */
export interface SweepTiming {
  /** Total time polling `/v1/activity` per server. */
  readonly confirmForMs: number;
  /** Gap between polls. */
  readonly pollEveryMs: number;
}

export const QUIT_SWEEP_TIMING: SweepTiming = { confirmForMs: 6_000, pollEveryMs: 500 };

/** What happened to one ledger row. */
export interface SweptJob {
  readonly entry: CrucibleInFlightEntry;
  readonly outcome: 'cancelled' | 'gone' | 'unreachable' | 'refused';
  readonly detail: string;
}

/** What happened to one server's card. */
export interface SweptServer {
  readonly server: string;
  /** True when no job of ours is on the lane any more (or the server could not say). */
  readonly ourJobsCleared: boolean;
  /** The `unload-*` job id submitted, or null when none was. */
  readonly unloadJobId: string | null;
  readonly note: string;
}

export interface CrucibleSweepReport {
  readonly jobs: readonly SweptJob[];
  readonly servers: readonly SweptServer[];
  /** Rows still in the ledger afterwards — an unreachable server's work. */
  readonly kept: readonly CrucibleInFlightEntry[];
  /** Every scratch path the swept jobs owned, for the scratch sweep that follows. */
  readonly scratchOwned: readonly string[];
}

/**
 * Cancel every job this app has recorded, on every server, then confirm each
 * card is clear.
 *
 * `reason` goes in every log line — "quitting" and "the last run did not quit
 * cleanly" are the two, and a person reading the log needs to know which sweep
 * they are looking at.
 *
 * Never throws. Every failure is a named line in the report and in the log,
 * because both callers are places where throwing would cost more than the
 * failure does: one is a quit, the other is a startup.
 */
export async function sweepCrucibleInFlight(options: {
  readonly reason: string;
  readonly timing?: SweepTiming;
  readonly log?: (line: string) => void;
}): Promise<CrucibleSweepReport> {
  return sweep({ ...options, onlyServer: null });
}

/**
 * THE SAME SWEEP, FOR ONE SERVER, WHILE THE APP IS RUNNING — bug hunt Q7,
 * 2026-09-20.
 *
 * A Crucible job's event stream can drop mid-job: the tailnet blips, the server
 * restarts its uvicorn, a proxy resets the socket. The ledger row is KEPT (a
 * broken stream is not a job that stopped) and the step fails — but until this
 * entry point existed **no DELETE was ever sent**, so the server went on
 * rendering. `gpuHoldOf` then released the card because the next act had
 * failed, the queue admitted the next book to that same server, and it was
 * refused `409 server_busy` by BookForge's own orphan and parked every 15 s
 * until somebody restarted the app and the startup sweep found it. Nothing in
 * the running process reconciled the ledger against the server.
 *
 * This is that reconciliation, and it is deliberately the WHOLE server rather
 * than the one job: a Crucible takes one job at a time on the lane, so anything
 * else of ours recorded there is queued behind the job that is about to be
 * cancelled, and it is this app's to cancel either way. The safety rule is
 * unchanged — `cardHeldBy` still refuses to unload anything somebody else is
 * using.
 *
 * Never throws, exactly like the quit and startup callers, because the caller
 * here is already in a `catch` about to report the real failure and a throw
 * from the tidying would replace it.
 */
export async function sweepCrucibleServerInFlight(options: {
  readonly server: string;
  readonly reason: string;
  readonly timing?: SweepTiming;
  readonly log?: (line: string) => void;
}): Promise<CrucibleSweepReport> {
  return sweep({ ...options, onlyServer: options.server });
}

async function sweep(options: {
  readonly reason: string;
  readonly onlyServer: string | null;
  readonly timing?: SweepTiming;
  readonly log?: (line: string) => void;
}): Promise<CrucibleSweepReport> {
  const log = options.log ?? ((line: string) => console.log(`[CRUCIBLE] ${line}`));
  const timing = options.timing ?? QUIT_SWEEP_TIMING;
  const entries = options.onlyServer === null
    ? readInFlightLedger()
    : readInFlightLedger().filter((row) => row.server === options.onlyServer);
  if (entries.length === 0) {
    return { jobs: [], servers: [], kept: readInFlightLedger(), scratchOwned: [] };
  }

  log(`${entries.length} crucible job(s) recorded as in flight`
    + `${options.onlyServer === null ? '' : ` on "${options.onlyServer}"`} — ${options.reason}`);
  const byServer = new Map<string, CrucibleInFlightEntry[]>();
  for (const entry of entries) {
    const rows = byServer.get(entry.server);
    if (rows === undefined) byServer.set(entry.server, [entry]);
    else rows.push(entry);
  }

  const jobs: SweptJob[] = [];
  const servers: SweptServer[] = [];
  const scratchOwned: string[] = [];

  // Server by server, not job by job: the activity poll and the card check are
  // per server, and doing them once per job would ask the same question five
  // times of a book that is five rows.
  for (const [server, rows] of byServer) {
    const ours = new Set<string>();
    for (const row of rows) {
      const result = await cancelCrucibleJobById(server, row.jobId);
      jobs.push({ entry: row, outcome: result.outcome, detail: result.detail });
      if (result.outcome === 'cancelled' || result.outcome === 'gone') {
        log(`${row.jobType} ${row.jobId} (${row.localId}) on "${server}": ${result.detail}`);
        settleInFlight(server, row.jobId);
        scratchOwned.push(...row.owns);
        ours.add(row.jobId);
      } else {
        // KEPT IN THE LEDGER on purpose — see the header. An asleep machine is
        // a delay; forgetting its job is a card held forever.
        log(`could NOT cancel ${row.jobType} ${row.jobId} (${row.localId}) on "${server}": `
          + `${result.detail}. Its row stays in the ledger for the next start.`);
        ours.add(row.jobId);
      }
    }
    servers.push(await clearTheCard(server, ours, timing, log));
  }

  return { jobs, servers, kept: readInFlightLedger(), scratchOwned };
}

/**
 * Poll one server until none of our jobs is on its lane, then — and only if
 * nothing at all holds the card — ask it to unload what is still resident.
 */
async function clearTheCard(
  server: string,
  ours: ReadonlySet<string>,
  timing: SweepTiming,
  log: (line: string) => void,
): Promise<SweptServer> {
  let client: CrucibleClient;
  try {
    client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    const note = `cannot reach the registry entry for "${server}": ${err instanceof Error ? err.message : String(err)}`;
    log(note);
    return { server, ourJobsCleared: false, unloadJobId: null, note };
  }

  const deadline = Date.now() + timing.confirmForMs;
  let activity: Activity | null = null;
  let lingering: string[] = [];
  for (;;) {
    try {
      activity = await client.activity();
    } catch (err) {
      // A server without `/v1/activity` (Crucible < 0.5.0) answers 404 here.
      // The DELETEs already landed; what cannot be done is CONFIRMING they
      // did, and saying so is the honest end of this sweep for that server.
      const described = describeCrucibleJobRefusal(err, server, 'reading /v1/activity');
      const note = err instanceof CrucibleUnreachable
        ? `"${server}" did not answer /v1/activity (${err.url}) — the cancels were sent, nothing confirmed them`
        : `"${server}" could not report its activity: `
          + `${described instanceof Error ? described.message : String(described)}`;
      log(note);
      return { server, ourJobsCleared: false, unloadJobId: null, note };
    }
    lingering = oursStillOnTheLane(activity, ours);
    if (lingering.length === 0) break;
    if (Date.now() >= deadline) break;
    await sleep(timing.pollEveryMs);
  }

  if (lingering.length > 0) {
    // NOT an unload: our own job is still on the card, which means it is still
    // finishing its batch. Crucible settles it when it ends.
    const note = `"${server}" still has ${lingering.length} of our job(s) on the lane `
      + `(${lingering.join(', ')}) ${timing.confirmForMs} ms after the DELETE — they were told to `
      + 'stop and will settle on that server; nothing here waits longer.';
    log(note);
    return { server, ourJobsCleared: false, unloadJobId: null, note };
  }

  if (activity === null || activity.resident === null) {
    const note = `"${server}" is clear: nothing of ours on the lane, nothing resident.`;
    log(note);
    return { server, ourJobsCleared: true, unloadJobId: null, note };
  }

  const holder = cardHeldBy(activity, ours);
  if (holder !== null) {
    // THE LINE THIS MODULE EXISTS TO PRINT RATHER THAN ACT ON.
    const note = `"${server}" still holds ${activity.resident.kind} "${activity.resident.id}", but `
      + `${holder} is using it — leaving it alone.`;
    log(note);
    return { server, ourJobsCleared: true, unloadJobId: null, note };
  }

  const unloadType = unloadJobTypeForResidentKind(activity.resident.kind);
  if (unloadType === null) {
    const note = `"${server}" holds a resident of kind "${activity.resident.kind}", which this `
      + 'build has no unload job type for. Crucible unloads it itself once nothing holds it.';
    log(note);
    return { server, ourJobsCleared: true, unloadJobId: null, note };
  }

  try {
    const jobId = await client.submit({
      type: unloadType,
      model: activity.resident.id,
      params: {},
      inputs: {},
    });
    const note = `asked "${server}" to ${unloadType} "${activity.resident.id}" (job ${jobId})`;
    log(note);
    return { server, ourJobsCleared: true, unloadJobId: jobId, note };
  } catch (err) {
    // Refused — `leased`, `server_busy`, `*_not_resident` because the server's
    // own settlement beat us to it. Named once, never retried: see the header.
    const described = describeCrucibleJobRefusal(err, server, `${unloadType} "${activity.resident.id}"`);
    const note = `"${server}" refused ${unloadType} "${activity.resident.id}": `
      + `${described instanceof Error ? described.message : String(described)}`;
    log(note);
    return { server, ourJobsCleared: true, unloadJobId: null, note };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
