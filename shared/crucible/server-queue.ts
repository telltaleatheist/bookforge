/**
 * BOOKFORGE'S ONE POLICY FOR CRUCIBLE'S SERVER-SIDE QUEUE — which doors wait in
 * a server's line, for how long, and what a `queued` / `removed` frame means
 * here. PURE (no Electron, no SDK runtime) so the app, the extension and the
 * keepers read the same numbers.
 *
 * ── The contract (crucible docs/QUEUE.md, ARCHITECTURE.md §3.3, v1.0.71) ────
 *
 * `POST /v1/jobs` with `"queue": {"max_wait_s": N}` turns the BUSY refusals
 * (`server_busy`, `leased`, `engine_in_use`) into a place in a FIFO, one per
 * server. Everything else is still refused at submit (`400`, `409 installing`,
 * `409 queue_full`). The job's own event stream adds `queued {position, of}`
 * (re-sent on every move), `started {waited_s}` and the TERMINAL `removed
 * {reason, message, waited_s, at}` — which is NOT a failure. A waiting job
 * expires after 300 s if its client has no open event stream on any of its
 * jobs, no GET on it and no heartbeat. Leases, chat/decide and TTS stream
 * sessions are NOT queued.
 *
 * ── Why the policy is stated here and not inherited from the SDK ────────────
 *
 * @crucible/client 1.0.71's high-level helpers (`render`, `asr`, `loadVoice`,
 * every load/unload…) QUEUE BY DEFAULT with the server's hour. A book row, a
 * person pressing Load in Listen, and a Settings probe are three different
 * waits, and none of them should be decided by a library default. So every
 * `CrucibleClient` this app builds says {@link CRUCIBLE_CLIENT_QUEUE_DEFAULT}
 * (`false`: nothing queues unless its door asks), and the doors that queue ask
 * by name with one of the two choices below.
 */

/**
 * What every `CrucibleClient` BookForge constructs is built with: NOTHING
 * QUEUES BY ACCIDENT. A door that wants the line passes its own choice.
 */
export const CRUCIBLE_CLIENT_QUEUE_DEFAULT = false as const;

/**
 * QUEUE ROWS — a narration render, an align, an asr, a denoise, an RVC pass:
 * work the BookForge queue already decided to send to that server.
 *
 * 24 h (the server's maximum), not the hour default, because the wait this
 * replaces had NO limit: before the server queue the row parked app-side and
 * re-asked until the card was free, however long another client's work took. A
 * book behind another client's eight-hour render must keep its place, and an
 * hour cap would throw it to the back of the line seven times. What reclaims a
 * job nobody wants any more is not this number but the server's PRESENCE rule
 * (300 s with no open stream, no GET, no heartbeat): this app follows every job
 * it submits, so a quit or a crash lets the line forget it within five minutes.
 * And if 24 h does pass, `removed {expired}` is weather — the row parks and
 * submits again ({@link crucibleRemovalDisposition}).
 */
export const CRUCIBLE_BATCH_QUEUE = { maxWaitS: 86_400 } as const;

/**
 * A PERSON IS WAITING — Listen's / the extension's Load, a text act's model
 * load. 10 minutes: long enough to sit behind an image job or a page read
 * without being refused, short enough that a person who walked away is not
 * still holding a place at lunch. Their screen shows "waiting, #N of M" the
 * whole time and Stop/Cancel takes it out at once (`DELETE /v1/jobs/{id}`,
 * answered `removed`).
 */
export const CRUCIBLE_INTERACTIVE_QUEUE = { maxWaitS: 600 } as const;

/**
 * How often a door that follows a WAITING job asks `POST /v1/queue/{id}/heartbeat`.
 *
 * Not for presence — the open event stream already is that (QUEUE.md "Stay
 * present") — but because a job at position 1 behind a four-hour render gets
 * no frame at all until it moves, and the doors' stall clock (10 min, ruling 3)
 * would read that silence as a wedged server and cancel it. The heartbeat's
 * answer is the server talking about THIS job, so it beats the clock, and it
 * carries the current position for the row. A server that does not answer it
 * leaves the clock running, which is exactly the case the clock is for.
 */
export const CRUCIBLE_QUEUE_HEARTBEAT_MS = 60_000;

/**
 * A CHAT OR DECISION WAITING IN THE LINE (crucible 1.0.72, docs/QUEUE.md "Chats
 * and decisions can wait too"). Owen, 2026-09-30: they wait "if there is a line".
 *
 * A queued call has no job record and no event stream: the server HOLDS THE HTTP
 * REQUEST OPEN until the answer, and the open request is its presence. So the wait
 * is per ATTEMPT, an hour, not the batch day — a request held open for a day is a
 * socket nobody can reason about. `expired` is asked again (weather), so a longer
 * line costs more attempts, never the run. The client's deadline for a queued
 * attempt is this wait plus the act's own answer budget.
 */
export const CRUCIBLE_CHAT_QUEUE = { maxWaitS: 3_600 } as const;

/** "waiting, #2 of 5 in crucible "shift"'s line" — what a waiting row reads. */
export function crucibleQueuedLine(server: string, position: number, of: number | null): string {
  const place = of === null || of < position ? `#${position}` : `#${position} of ${of}`;
  return `waiting, ${place} in crucible "${server}"'s line`;
}

/**
 * WHAT A `removed` MEANS TO THIS APP — by its reason, and nothing else.
 *
 *  - `expired`, `server_restart`: WEATHER. Nobody decided against this job; the
 *    line timed it out or the server went down. The queue row parks with a
 *    sentence and submits again on its admission tick (Code Principles §2:
 *    retried, then waits with a sentence).
 *  - `operator`: A PERSON took it out on purpose (Crucible's Queue section,
 *    `DELETE /v1/queue/{id}`). It is never resubmitted by itself; the row goes
 *    back to Pending with the server's sentence on it (QUEUE.md: "do not
 *    resubmit by yourself on operator").
 *  - `client`: OUR cancel (`DELETE /v1/jobs/{id}` on a waiting job answers
 *    `removed`) — the same ending as a `cancelled` frame after a Stop.
 *  - anything else (a newer server's reason): treated as `operator` — the
 *    conservative reading, because resubmitting work somebody may have removed
 *    on purpose is the one mistake a person cannot see coming.
 */
export type CrucibleRemovalDisposition = 'weather' | 'operator' | 'ours';

export function crucibleRemovalDisposition(reason: string): CrucibleRemovalDisposition {
  if (reason === 'expired' || reason === 'server_restart') return 'weather';
  if (reason === 'client') return 'ours';
  return 'operator';
}

/** The sentence a row shows after a `removed`, built from the server's own message. */
export function crucibleRemovedLine(server: string, reason: string, message: string): string {
  const said = message.trim() === '' ? '' : `: ${message.trim()}`;
  switch (crucibleRemovalDisposition(reason)) {
    case 'weather':
      return `crucible "${server}" let this job go from its line (${reason})${said} — sending it again`;
    case 'ours':
      return `crucible "${server}" took this job out of its line at this app's request${said}`;
    case 'operator':
      return `removed from crucible "${server}"'s line by an operator (${reason})${said}. `
        + 'The run was removed from BookForge\'s queue too and not sent again; nothing on disk was deleted.';
  }
}
