/**
 * A SOCKET THAT DIED MID-ANSWER IS A WAIT, NOT A FAILURE — the round-2 half of
 * Contract 1 (docs/BUG-HUNT-2026-09-20.md §E, 2026-09-20).
 *
 * The SDK maps a connection it never got onto `CrucibleUnreachable`, and PK2
 * made that transient in every door. What it does NOT map is a socket
 * destroyed AFTER the response started: undici surfaces that as a bare
 * `TypeError: terminated` (and a connect that failed inside `fetch` as
 * `TypeError: fetch failed` with the real errno on `cause.code`). Both fell
 * through the describers' SDK table and came back UNCHANGED, so `settleStep`
 * saw no `transient` pair and the row went red — for a server that was
 * rebooting, a tailnet that blipped, or a Crucible restarting its engine.
 * Exactly the failure Contract 1 exists to stop, arriving by a different door.
 *
 * ONE OWNER, because both describers ask the same question and must answer it
 * the same way: `job.ts describeCrucibleJobRefusal` and `render.ts
 * describeCrucibleRefusal` each call this, and each mints the SAME
 * `crucible_unreachable` refusal PK2 marks transient. A third door (align)
 * forwards the pair and needs no arm of its own.
 *
 * DELIBERATELY NARROW. A `TypeError` is also what `x is not a function` throws,
 * and parking a row on a programming mistake is a row that waits forever with
 * nobody told. So a `TypeError` qualifies only on undici's two exact
 * messages, and anything else qualifies only by carrying a real transport
 * errno on `cause.code`. Everything else stays an unexpected exception and
 * comes back with its stack.
 *
 * Since 2026-09-20 this module also owns the WIDER question — "was the server
 * available at all" — for the callers that hold a raw error and never went
 * through a describer. See {@link crucibleUnavailableCause}.
 */

import { CrucibleServerError, CrucibleUnreachable } from '@crucible/client';

/**
 * The errnos that mean "the wire, not the work". `ECONNRESET` and
 * `UND_ERR_SOCKET` are a socket that died under a live request;
 * `ECONNREFUSED` is nothing listening; `ETIMEDOUT`/`EHOSTUNREACH`/`ENETUNREACH`
 * are a host that is off or unrouted; `EPIPE` is a write onto a closed socket.
 * None of them is a run that needs repairing.
 */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  /*
   * UNDICI'S OWN THREE CLOCKS, ADDED 2026-09-20 AFTER THEY COST A BOOK.
   *
   * At 14:27 a TCP connect to the render host took longer than undici's 10 s
   * connect timeout — one network blip, on a server that had been up eleven
   * hours — and the align step of a 2,267-chunk book went RED at chunk 1901.
   * The errno is `UND_ERR_CONNECT_TIMEOUT` and it was not in this set, so the
   * only thing that recognised the blip was the SDK's own `CrucibleUnreachable`
   * wrapper, which the door that threw it did not build.
   *
   * All three are a clock that ran out on the WIRE — a connect that never
   * completed, headers that never arrived, a body that stopped — and not one of
   * them is a run that needs repairing. They are the exact shape of a wait.
   */
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * undici's own words for a transport death. `terminated` is a socket destroyed
 * mid-response; `fetch failed` is everything that went wrong before a response
 * existed, with the errno on `cause`.
 */
const UNDICI_MESSAGES: ReadonlySet<string> = new Set(['terminated', 'fetch failed']);

interface MaybeCause {
  readonly message?: unknown;
  readonly code?: unknown;
}

function causeOf(err: unknown): MaybeCause | null {
  if (typeof err !== 'object' || err === null) return null;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return null;
  return cause as MaybeCause;
}

/**
 * The server's OWN words for why the wire died, or null when this was not the
 * wire — a cause string fit to hand straight to `crucibleTransientLine`, never
 * a category invented here.
 *
 * Returns the errno where there is one (`terminated (ECONNRESET)`), because
 * that is the sentence a person can act on; the bare message where there is
 * not, because inventing one would say more than is known.
 */
export function transportFailureCause(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const cause = causeOf(err);
  const code = typeof cause?.code === 'string' ? cause.code : null;
  const codeIsTransport = code !== null && TRANSPORT_CODES.has(code);
  const messageIsUndici = err.name === 'TypeError' && UNDICI_MESSAGES.has(err.message);
  if (!codeIsTransport && !messageIsUndici) return null;

  // The errno is the most specific true thing; the cause's message is next;
  // the bare `terminated` is the least, and is all undici gives for a
  // mid-response destroy.
  const detail = code
    ?? (typeof cause?.message === 'string' && cause.message !== '' ? cause.message : null);
  return detail === null || detail === err.message ? err.message : `${err.message} (${detail})`;
}

/**
 * Was this the wire rather than the work? The predicate half; the describers
 * want the cause string and read {@link transportFailureCause} directly.
 */
export function isTransportFailure(err: unknown): boolean {
  return transportFailureCause(err) !== null;
}

/**
 * "NOT NOW" IN THE SERVER'S OWN WORDS — the whole membership test for Contract
 * 1, for a caller holding a RAW error rather than a door's refusal object.
 *
 * ── Why this exists beside {@link transportFailureCause} ───────────────────
 *
 * The two describers (`job.ts describeCrucibleJobRefusal`, `render.ts
 * describeCrucibleRefusal`) already know this set: an unreachable server, a
 * 5xx, and a socket that died mid-answer are the three things a row WAITS out
 * rather than goes red for. But a door only gets a described refusal if it went
 * through a describer, and two callers do not:
 *
 *  - `coverage-align-job.ts`'s generic catch. On 2026-09-20 at 14:27 it caught
 *    the SDK's own `CrucibleUnreachable` ("connect timeout, 10000ms") from a
 *    plain SDK call and returned a plain fail — no `transient` pair — so the
 *    align of a book at 1901 of 2267 chunks went red on ONE network blip while
 *    the identical wait on a busy card would have parked;
 *  - {@link module:./stream-reconnect}, which has to decide whether a stream
 *    that ended badly is worth re-opening. That question is "was this the wire"
 *    and it must be answered the same way the refusal is classified, or a row
 *    could be told to wait for something nothing will retry (or the reverse).
 *
 * ── It does not compose the sentence ───────────────────────────────────────
 *
 * The line a parked row shows is composed by ONE function, `job.ts
 * crucibleTransientLine`, so a wait reads the same whichever door hit the
 * socket. This answers only what the CAUSE was, in the server's own words, and
 * hands it there. It never invents a category.
 *
 * ── The describers keep their own arms ─────────────────────────────────────
 *
 * Each of them mints a refusal whose PROSE is per class (a 5xx names the
 * status, an unreachable server names the url), and folding those into one arm
 * would lose sentences a person acts on. What must not drift is the SET, and
 * `tools/test-crucible-transient-refusals.js` pins that the describers and this
 * agree on every member — the agreement is checked rather than assumed.
 */
export function crucibleUnavailableCause(err: unknown): string | null {
  if (err instanceof CrucibleUnreachable) return err.message;
  if (err instanceof CrucibleServerError) return `HTTP ${err.status}: ${err.serverMessage}`;
  return transportFailureCause(err);
}
