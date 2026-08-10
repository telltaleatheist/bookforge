/**
 * What a window does with a save that FAILED.
 *
 * The picker's autosave is edge-triggered: an effect fires when
 * `hasUnsavedChanges` goes true, schedules a debounced write, and the write
 * clears the flag. A failed write leaves the flag true, so the effect never
 * fires again — one transient error (a locked manifest, a drive that blinked)
 * disarmed autosave for the whole session, invisibly, and every edit after it
 * lived only in the window's memory.
 *
 * The answer is to re-arm from the failure itself, which needs exactly two
 * decisions and both of them are here rather than inline: how long to wait, and
 * when to stop waiting and say so. Pure because they are the part that can be
 * reasoned about without a window — see tools/test-picker-session-state.js.
 */

/** The retry ladder's length. Five attempts spans roughly twenty minutes. */
export const MAX_AUTOSAVE_RETRIES = 5;

/**
 * How long before attempt `attempt` (1-based), or null when the ladder is spent.
 *
 * Quartic backoff off the ordinary debounce: 4s, 16s, 64s, ~4min, ~17min. The
 * first rung is deliberately short — most failures are a moment's contention and
 * the user is still typing — and the last is long enough that a genuinely
 * unwritable project is not being hammered for the rest of the session.
 *
 * A null is not silence: it is the point at which the window owes the user a
 * sentence, because "it will be tried again" has stopped being true.
 */
export function autosaveRetryDelay(attempt: number, baseDelayMs: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`autosaveRetryDelay: attempt must be a positive integer, got ${attempt}`);
  }
  if (attempt > MAX_AUTOSAVE_RETRIES) return null;
  return baseDelayMs * Math.pow(4, attempt);
}
