/**
 * The sentences a finished pass owes the user — one collector, three callers.
 *
 * `PassJobResult` carries three fields that exist ONLY to be read by a person:
 * what the pass did beyond "it worked" (`summary`), why it recorded no ledger
 * row (`ledgerRefusal`), and why the narration strikes were not carried onto the
 * book it wrote (`narrationCarryNote`). The interface has always said a caller
 * with a user in front of it is expected to pass those on — and until 2026-08-12
 * not one of them did. That day a simplify diverged structurally from its base,
 * recorded no ledger row, and so offered no "Review changes" / "Compare books";
 * the sentence explaining exactly that was a `console.warn` nobody had a reason
 * to open. The pass told the truth. Nothing repeated it, so a correct refusal
 * arrived as a missing-button bug.
 *
 * So every consumption point builds its notes HERE — the queue runner, the
 * run-now door, and main's `queue:job-complete` broadcast — in one order with
 * one meaning, rather than each deciding for itself which of the three matter.
 *
 * A pass with nothing to say yields an empty array. That is a real state and not
 * a failure: most passes' whole result is the book they wrote.
 *
 * This is a pure function over a plain object, which is why it may sit beside
 * `pass-types.ts` and still be imported by both programs — it reaches for
 * nothing, least of all `electron`.
 */

import type { PassJobResult } from './pass-types';

/** The user-facing part of a pass result: the fields that are sentences. */
export type PassResultNotesSource = Pick<
  PassJobResult,
  'summary' | 'ledgerRefusal' | 'narrationCarryNote'
>;

/**
 * Every sentence this result owes the user, in the order they are worth reading:
 * what happened, then why it is not undoable on its own, then what was not
 * carried. Never truncated and never paraphrased — the whole point is that these
 * are already the finished sentences main wrote.
 */
export function passResultNotes(result: PassResultNotesSource | undefined | null): string[] {
  if (!result) return [];
  const notes: string[] = [];
  if (result.summary) notes.push(result.summary);
  if (result.ledgerRefusal) notes.push(result.ledgerRefusal);
  if (result.narrationCarryNote) notes.push(result.narrationCarryNote);
  return notes;
}
