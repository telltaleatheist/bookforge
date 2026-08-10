/**
 * The banner queue — one window, several things worth saying.
 *
 * A session notice is the shape used for "this worked, and here is what it
 * cost", and for background conditions a modal must never interrupt (a layout
 * migration on open, an autosave that could not reach the disk). There is one
 * banner, so the notices have to take turns: a second `.set()` over the first
 * deleted a sentence the user had not read yet.
 *
 * Repeats are DROPPED rather than stacked. Every writer of this is either a
 * retry loop or a per-project announcement, and the same sentence four times
 * reads as four separate failures.
 */

/** Add `text` to the queue unless it is already in it. Returns a new array. */
export function queueSessionNotice(queue: readonly string[], text: string): string[] {
  if (queue.includes(text)) return [...queue];
  return [...queue, text];
}

/** The user dismissed the front notice; the next one comes forward. */
export function dropFrontNotice(queue: readonly string[]): string[] {
  return queue.slice(1);
}

/** What the banner shows, or null when there is nothing to say. */
export function frontNotice(queue: readonly string[]): string | null {
  return queue.length > 0 ? queue[0] : null;
}
