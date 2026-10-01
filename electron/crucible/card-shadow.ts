/**
 * WHAT IS ON A CRUCIBLE CARD, READ FOR THE QUEUE: whether it is shut to us,
 * and what somebody else is doing on it. PURE, so a keeper can drive it.
 *
 * Owen, 2026-09-26: *"if theres something in the queue, and the user is on the
 * queue page, it should poll crucible to see if something is holding a lease.
 * if it is, show it as a shadow in the bookforge queue with a progress bar.
 * when it finishes, bookforge tries to take the lease if the queue is active
 * and something is waiting in line."*
 *
 * ── Two answers from one read ──────────────────────────────────────────────
 *
 *  - `busy` GATES ADMISSION. It is what it has always been, the lane shut
 *    (`slots.accelerated.acceptsWork` false) with the holder named, plus ONE
 *    addition: an open lease that is not ours. Crucible holds one lease per
 *    server and refuses a second (`crucible/leases.py`, `open`), and a job that
 *    would move the leased model is refused `leased` too. So a foreign lease is
 *    a refusal waiting to happen, and asking the door every cool-off while it
 *    is open is the "tries to take the lease" Owen wants only AFTER it ends.
 *  - `shadow` IS DRAWN, never scheduled on: the foreign holder, with its
 *    progress when it has one.
 *
 * ── Ours, by id ────────────────────────────────────────────────────────────
 *
 * Our own jobs and leases are never a shadow and never make the card busy on
 * the lease rule. They are told apart by ID (the in-flight ledger, which also
 * carries the hosted Foundry's leases, and the lease module's own set), never
 * by client name: the Mac's BookForge sends the same `bookforge` User-Agent,
 * and its lease on this card is somebody else's.
 */
import type { CrucibleActivityView } from '../../shared/crucible/settings-wire';
import type { ServerShadow } from '../../shared/queue/engine-types';
import { busyLineFor } from '../../shared/queue/wait-for';

/** This app's own ids on one server. */
export interface OwnCardIds {
  /** Job ids from the in-flight ledger (jobs, and Foundry's leases). */
  readonly jobs: ReadonlySet<string>;
  /** Lease ids this process holds, or released a moment ago. */
  readonly leases: ReadonlySet<string>;
}

export interface CardReading {
  /**
   * The card is shut to us, in the holder's one busy line; null when it is not.
   * `queueDepth` is the server's `slots.accelerated.queue_depth` (lane + every
   * waiting job), or null where it did not say — what an `any` step that waits
   * in the server's line compares (`shared/queue/wait-for.ts`).
   */
  readonly busy: { line: string; queueDepth: number | null } | null;
  /** Somebody else's work on the card; null when there is none. */
  readonly shadow: ServerShadow | null;
}

/**
 * A User-Agent's product name: `foundry crucible-client/1.0.38` → `foundry`.
 * Null stays null; the server did not say, and nothing is guessed.
 */
export function holderName(client: string | null): string | null {
  if (client === null) return null;
  const first = client.trim().split(/\s+/)[0] ?? '';
  const name = first.split('/')[0] ?? '';
  return name.length > 0 ? name : client;
}

export function readCard(activity: CrucibleActivityView, ours: OwnCardIds): CardReading {
  const isOurs = (id: string): boolean => ours.jobs.has(id) || ours.leases.has(id);
  const resident = activity.resident === null ? null : activity.resident.id;

  // ── The shadow: the first foreign holder, in the order the card is held ──
  let shadow: ServerShadow | null = null;
  const job = activity.running.find((row) => !isOurs(row.jobId));
  if (job !== undefined) {
    shadow = {
      kind: 'job',
      holder: holderName(job.client),
      what: job.model === null ? job.type : `${job.type} ${job.model}`,
      progress: job.progress,
      message: job.message,
      since: job.started,
    };
  } else if (activity.streaming !== null) {
    shadow = {
      kind: 'streaming',
      holder: holderName(activity.streaming.client),
      what: `a streaming session (${activity.streaming.voice})`,
      progress: null,
      message: null,
      since: activity.streaming.since,
    };
  }
  const lease = activity.lease;
  const foreignLease = lease !== null && !isOurs(lease.leaseId) ? lease : null;
  if (shadow === null && foreignLease !== null) {
    const act = foreignLease.act ?? 'a run';
    shadow = {
      kind: 'lease',
      holder: holderName(foreignLease.client),
      what: resident === null ? act : `${act} on ${resident}`,
      progress: null,
      message: null,
      since: foreignLease.since,
    };
  }
  /*
   * THE LANE IS SHUT AND NOTHING ABOVE NAMED A STRANGER. If any of our own jobs
   * is on this server, that is what shut it and there is no shadow. Otherwise
   * it is a load or a claim the server could only name by its holder.
   */
  const oursOnLane = [...activity.running, ...activity.queued].some((row) => isOurs(row.jobId));
  if (shadow === null && !activity.slot.acceptsWork && !oursOnLane) {
    shadow = {
      kind: 'claim',
      holder: activity.claimedBy,
      what: activity.warming === null ? 'the card' : `loading ${activity.warming}`,
      progress: null,
      message: null,
      since: null,
    };
  }

  // ── Busy: the lane's own refusal, then a foreign lease ──────────────────
  let busy: { line: string; queueDepth: number | null } | null = null;
  const queueDepth = activity.slot.queueDepth;
  if (!activity.slot.acceptsWork) {
    busy = { line: laneLine(activity), queueDepth };
  } else if (foreignLease !== null) {
    const act = foreignLease.act ?? 'a run';
    busy = {
      line: busyLineFor({
        holder: foreignLease.client,
        what: `a lease for ${resident === null ? act : `${act} on ${resident}`}`,
        progress: null,
        message: null,
      }),
      queueDepth,
    };
  }
  return { busy, shadow };
}

/**
 * WHO IS IN THE WAY OF THE LANE, in the order the server can name them. A job
 * is the ordinary case; a streaming session holds the engine's exclusive claim
 * and has NO denominator by contract, which is why the line composer takes a
 * nullable progress rather than printing `0% done`.
 *
 * The holder may be one of OUR jobs, and that is deliberate: the scheduler's
 * own-card rule (`holdsThisCard`) keeps a run from being parked on its own
 * render's line, and any OTHER of our books bound for this card is correctly
 * waiting on it.
 */
function laneLine(activity: CrucibleActivityView): string {
  const job = activity.running[0];
  if (job !== undefined) {
    return busyLineFor({
      holder: job.client,
      what: job.model === null ? job.type : `${job.type} ${job.model}`,
      progress: job.progress,
      message: job.message,
    });
  }
  const streaming = activity.streaming;
  if (streaming !== null) {
    return busyLineFor({
      holder: streaming.client,
      what: `a streaming session (${streaming.voice})`,
      progress: null,
      message: null,
    });
  }
  /*
   * THE LANE IS SHUT AND THE SERVER NAMED NOBODY: a claim with no session yet,
   * a model being warmed, a shutdown in progress. The holder is reported as
   * what it is rather than guessed at (PHASE7-LANES §5).
   */
  return busyLineFor({
    holder: activity.claimedBy,
    what: activity.warming === null
      ? 'its accelerated slot is not taking work'
      : `loading ${activity.warming}`,
    progress: null,
    message: null,
  });
}
