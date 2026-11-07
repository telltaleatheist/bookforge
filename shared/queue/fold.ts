/**
 * fold — whether a book's step ladder is open on the queue page.
 *
 * The default follows the book: open while one of its steps is running, because the
 * ladder is then the live progress; folded otherwise, because a column of waiting books
 * is read one line each. A chevron press turns that default the other way.
 *
 * ── A press holds only in the state it was made in ─────────────────────────
 *
 * Owen, 2026-11-07: a run dragged onto his PC's lane drew no step list during its
 * triage and cleanup, while TTS on another book drew the whole ladder. The lane's
 * chevron was drawn closed on a step main had running. The press had been recorded as
 * a bare FLIP: opening a waiting book's card to look at its steps flipped it, and the
 * same flip read as CLOSED the moment the book started, so the book that was running
 * was the one card whose live progress was folded away. So each press now remembers
 * whether the book was running when it was made, and counts only while that is still
 * so. Once the book starts or stops, the card follows the book again.
 */

/** The presses: plan key → whether that book was running when its chevron was pressed. */
export type FoldPresses = ReadonlyMap<string, boolean>;

/** Open or folded, for a book that is `running` (or not) now. */
export function foldOpen(presses: FoldPresses, key: string, running: boolean): boolean {
  const pressed = presses.get(key) === running;
  return running ? !pressed : pressed;
}

/** The presses after one more press on `key`, made while the book is `running` (or not). */
export function pressFold(presses: FoldPresses, key: string, running: boolean): FoldPresses {
  const next = new Map(presses);
  if (next.get(key) === running) next.delete(key);
  else next.set(key, running);
  return next;
}
