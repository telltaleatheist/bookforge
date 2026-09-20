/**
 * A BROKEN STREAM IS NOT A BROKEN JOB — re-open it before giving up on an hour
 * of somebody else's GPU.
 *
 * ── What went wrong (bug hunt 2026-09-20, S13; the deferred C4 attach arm) ──
 *
 * At 14:27 ET a TCP connect to the render host took longer than undici's 10 s
 * connect timeout. One blip: the server never restarted (uptime eleven hours),
 * the job was alive and 1,901 of 2,267 chunks through an align. What BookForge
 * did with that blip was cancel it.
 *
 * Two fixes landed the night before, and together they made this worse rather
 * than better. Q7 taught both doors to run the one-server in-flight sweep when
 * a stream ends with no terminal frame — right, because a stream that drops
 * leaves the server RUNNING a job nobody is watching, which then 409s the next
 * book. But "the stream dropped" was being read as "the job is lost", and it is
 * not: the job was fine, the SOCKET died, and the server had already been
 * replaying-from-`lastEventId` since C4's ledger row started carrying one.
 * `attachTo` — the documented resume — had two writers and no caller.
 *
 * So this is the arm that was missing between them: **reconnect first, sweep
 * last.** Only a ladder that runs out, with the server still not answering,
 * means the job is unreachable and the DELETE is worth sending.
 *
 * ── The shape ──────────────────────────────────────────────────────────────
 *
 * The caller hands in one `attempt(resumeFrom)` — its own stream loop, opened
 * at the event id it has already acted on — and two questions it alone can
 * answer: where it is (`resumeFrom`) and whether this stream has anything left
 * to give (`nothingLeftToRead`). Everything else is here, once, because
 * `job.ts` and `render.ts` would otherwise grow two ladders that drift.
 *
 * What is retried is ONLY the wire: {@link crucibleUnavailableCause}, the same
 * membership test that decides whether a row parks. A protocol violation, a
 * refused token, a job that ran and failed — none of those get better by asking
 * again, and every one of them comes straight back out with its own class.
 *
 * ── What the server does on a reconnect ────────────────────────────────────
 *
 * `GET /v1/jobs/{id}/events` with `Last-Event-ID` replays above that id and no
 * further, so a reconnect costs the frames since the break and nothing else.
 * Artifacts announced below it are ones the caller already has: a render lands
 * `<index>.flac` per frame through the SDK's write-sidecar-then-rename, so a
 * frame seen twice is a file written twice with identical bytes, never a
 * duplicate and never a half file (`render-artifacts.ts`).
 *
 * That idempotence is also what lets a reconnect resume BELOW where the caller
 * got to: an artifact whose fetch failed is re-asked for by re-opening the
 * stream under the frame that announced it (`artifacts-owed.ts` owns that
 * number), and the files already on disk are written again with the same bytes.
 *
 * Two answers end the ladder early:
 *
 *  - **`unknown_job`** — the server restarted and has no such job. There is
 *    nothing running there and nothing to cancel, so the caller must NOT sweep.
 *    That is {@link CrucibleStreamLost.jobMayStillRun} = false.
 *  - **the ladder running out** — the server is still not answering. The job may
 *    well still be running, so the caller sweeps exactly as it did before this
 *    module existed, then reports the wait.
 *
 * ── The clock this runs under ──────────────────────────────────────────────
 *
 * The ladder sits INSIDE `withStreamStallClock`'s `consume`, which is what
 * keeps C2's stall clock running across it: a reconnect that never produces a
 * frame is still silence, and silence is what that clock measures. The ladder's
 * whole budget ({@link CRUCIBLE_RECONNECT_TOTAL_MS}) is deliberately shorter
 * than the stall window, so in practice the ladder is always the one that
 * answers first and the stall clock remains the backstop for a socket that is
 * open and mute. `tools/test-crucible-stall-clock.js` pins that ordering.
 */

import { CrucibleRefused } from '@crucible/client';
import { crucibleUnavailableCause } from './transport-failure';

/**
 * The first wait after a stream breaks.
 *
 * Five seconds because the failure this exists for is a blip — a DHCP renewal,
 * a tailnet re-key, a proxy recycling a socket — and the server is usually back
 * before the first rung. Immediately would be worse: a connect timeout means
 * the path is not there yet, and hammering it makes the next attempt land in
 * the same hole.
 */
export const CRUCIBLE_RECONNECT_FIRST_DELAY_MS = 5_000;

/**
 * How long the ladder may spend in total.
 *
 * Five minutes against an hour of GPU is a trade with an obvious direction, and
 * it must stay UNDER `stream-stall.ts`'s `CRUCIBLE_STREAM_STALL_MS` (ten
 * minutes, Owen's ruling 3) so the two clocks cannot argue: the ladder gives up
 * first and says why, and the stall clock keeps its own job — a socket that is
 * open and producing nothing at all.
 */
export const CRUCIBLE_RECONNECT_TOTAL_MS = 5 * 60 * 1000;

/**
 * The waits between reconnect attempts: doubling from `firstMs`, clipped so the
 * whole ladder fits `totalMs`.
 *
 * Pure, and exported, because the schedule is the policy — "how long do we wait
 * for a server before deciding its job is gone" — and a policy that can only be
 * read by running a render for five minutes is a policy nobody checks. The last
 * rung is short by design: what is left of the budget is spent rather than
 * rounded away, so the ladder uses its whole five minutes.
 *
 * Doubling rather than a fixed interval because the two failures underneath are
 * different lengths: a blip is over in seconds and a reboot takes a minute or
 * two, and a schedule tuned for one is wasteful or hopeless for the other.
 */
export function reconnectDelaysMs(
  totalMs: number = CRUCIBLE_RECONNECT_TOTAL_MS,
  firstMs: number = CRUCIBLE_RECONNECT_FIRST_DELAY_MS,
): readonly number[] {
  if (!(totalMs > 0) || !(firstMs > 0)) return [];
  const delays: number[] = [];
  let spent = 0;
  let next = firstMs;
  while (spent < totalMs) {
    const delay = Math.min(next, totalMs - spent);
    delays.push(delay);
    spent += delay;
    next *= 2;
  }
  return delays;
}

/**
 * A Crucible event stream that could not be re-opened.
 *
 * Its own class rather than one of the doors' refusal types, for the reason
 * `CrucibleStreamWentQuiet` is: the refusal vocabulary belongs to each door
 * (`CrucibleJobRefused`, `CrucibleRenderRefused`) and a second module minting
 * one of those would be a second owner of it. Each door catches this, decides
 * whether to sweep from {@link jobMayStillRun}, and mints its own transient
 * refusal.
 */
export class CrucibleStreamLost extends Error {
  readonly code = 'crucible_stream_lost';
  readonly server: string;
  readonly jobId: string;
  /** Why the ladder stopped. */
  readonly reason: 'ladder_exhausted' | 'job_unknown';
  /** The last thing the wire said — what the door's refusal is described from. */
  readonly lastError: unknown;
  /** How many times the stream was re-opened before this. */
  readonly attempts: number;
  /**
   * IS OUR JOB PERHAPS STILL RUNNING OVER THERE — the only question the caller
   * asks this object, and the one that decides whether a DELETE is sent.
   *
   * A server that stopped answering may well still be rendering: that orphan
   * holds the card and 409s the next book, so it is swept. A server that
   * answered `unknown_job` has told us there is nothing there — sweeping it
   * would DELETE nothing and poll a server for no reason.
   */
  readonly jobMayStillRun: boolean;

  constructor(
    server: string,
    jobId: string,
    reason: 'ladder_exhausted' | 'job_unknown',
    lastError: unknown,
    attempts: number,
    message: string,
  ) {
    super(message);
    this.name = 'CrucibleStreamLost';
    this.server = server;
    this.jobId = jobId;
    this.reason = reason;
    this.lastError = lastError;
    this.attempts = attempts;
    this.jobMayStillRun = reason !== 'job_unknown';
  }
}

/**
 * Did the server say it has no such job?
 *
 * Narrower than `cancelCrucibleJobById`'s `gone`, deliberately: that one also
 * counts `job_not_cancellable`, because its question is "is the card free" and
 * a job too far gone to cancel is not holding it. Here the question is "can
 * this stream be re-opened", and a job that exists but has ended is one whose
 * events can still be read — only a job the server does not KNOW ends the
 * ladder.
 */
function isUnknownJobRefusal(err: unknown): boolean {
  return err instanceof CrucibleRefused
    && (err.code === 'unknown_job' || err.code === 'not_found' || err.status === 404);
}

export interface StreamReconnectOptions<T> {
  /** For the log lines and the refusal. A registry name, never a URL. */
  readonly server: string;
  /** The job being followed. A reconnect without one is not a reconnect. */
  readonly jobId: string;
  /**
   * One run of the caller's own stream loop, opened above `resumeFrom` (0 means
   * "from the beginning", which is what a fresh submit wants). Whatever it
   * resolves with is what this resolves with.
   */
  readonly attempt: (resumeFrom: number) => Promise<T>;
  /**
   * The highest event id the caller has ACTED ON — read fresh before every
   * attempt, including the first, because only the caller knows how far its own
   * loop got before the socket died.
   */
  readonly resumeFrom: () => number;
  /**
   * IS THERE ANYTHING LEFT FOR THIS STREAM TO GIVE US?
   *
   * True when the server has sent a terminal frame AND the caller has
   * everything that frame announced — then a throw is a throw (a file that
   * would not write to a full disk, a protocol disagreement) and re-opening the
   * stream would replay a finished job's tail for nothing.
   *
   * It is deliberately NOT "did we see the terminal frame" (which is what this
   * asked until PK15). `writeArtifactsTo` starts each download as its frame
   * lands and raises the first failure at the next yield boundary, so a single
   * `500` on one artifact of a job that RAN can arrive on either side of the
   * `done` frame — and in both cases the right answer is to ask again, from
   * below the frame that announced the file (`artifacts-owed.ts`). A ladder
   * that stopped at the terminal frame threw an hour of finished GPU away over
   * one failed fetch.
   */
  readonly nothingLeftToRead: () => boolean;
  /**
   * The caller's cancel. An abort during a wait ends the ladder at once with
   * the error that started it — a person who pressed Stop is not waiting five
   * minutes for a server to come back.
   */
  readonly signal?: AbortSignal;
  /** Free text for the job log. Every attempt announces itself by number. */
  readonly onLog?: (line: string) => void;
  /**
   * OVERRIDES the schedule.
   *
   * **Only a keeper passes this.** The shipped ladder is five minutes and that
   * is the policy; a caller that shortened it would be deciding on behalf of
   * every book how long a server may be away. It exists because the behaviour
   * worth pinning is what happens at each rung and when the budget runs out,
   * and a suite must not spend five minutes per check proving it.
   */
  readonly delaysMs?: readonly number[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never the reason a headless process stays alive after its work is done.
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** How long a wait is worth saying out loud. Sub-second stays in ms for keepers. */
function describeWait(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

/**
 * Follow a Crucible event stream, re-opening it from the last event acted on
 * whenever the WIRE breaks.
 *
 * Resolves with `attempt`'s value the first time a run of the stream completes.
 * Throws {@link CrucibleStreamLost} when the ladder runs out or the server no
 * longer knows the job, and rethrows anything that was not the wire — unchanged,
 * on the first attempt, exactly as if this module were not here.
 */
export async function withStreamReconnect<T>(options: StreamReconnectOptions<T>): Promise<T> {
  const log = options.onLog ?? (() => undefined);
  const delays = options.delaysMs ?? reconnectDelaysMs();
  let attempts = 0;

  for (;;) {
    try {
      return await options.attempt(options.resumeFrom());
    } catch (err) {
      // The stream has nothing left to give: the job ended and everything it
      // announced is here. A throw now is a throw, not a stream to re-open.
      if (options.nothingLeftToRead()) throw err;
      if (isUnknownJobRefusal(err)) {
        throw new CrucibleStreamLost(
          options.server, options.jobId, 'job_unknown', err, attempts,
          `crucible "${options.server}" no longer has job ${options.jobId}: the stream dropped and `
          + 'on reconnect the server did not know it, which is what a server that restarted looks '
          + 'like. Nothing was cancelled — there is nothing there to cancel.',
        );
      }
      const cause = crucibleUnavailableCause(err);
      // NOT THE WIRE. A protocol disagreement, a refused token, a job that ran
      // and failed: none of those is re-openable and asking again would only
      // delay the sentence that names them.
      if (cause === null) throw err;
      if (options.signal?.aborted) throw err;
      const delay = delays[attempts];
      if (delay === undefined) {
        const spent = delays.reduce((sum, ms) => sum + ms, 0);
        throw new CrucibleStreamLost(
          options.server, options.jobId, 'ladder_exhausted', err, attempts,
          `crucible "${options.server}" job ${options.jobId} could not be re-opened after `
          + `${attempts} attempt(s) over ${describeWait(spent)}: ${cause}. The job may still be `
          + 'running there.',
        );
      }
      attempts += 1;
      log(`crucible "${options.server}" job ${options.jobId}: the event stream broke (${cause}); `
        + `re-opening it from event ${options.resumeFrom()} in ${describeWait(delay)} `
        + `(attempt ${attempts} of ${delays.length})`);
      await sleep(delay, options.signal);
      if (options.signal?.aborted) throw err;
    }
  }
}
