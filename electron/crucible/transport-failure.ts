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
 */

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
