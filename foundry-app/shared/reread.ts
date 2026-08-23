/**
 * What reading this book again would COST, named before the job exists.
 *
 * ── The fact this file is the answer to ─────────────────────────────────────
 *
 * The OCR dialog enqueues, and nothing tells anybody what they have just spent.
 * A second reading of a book that has already been read REPLACES the first one:
 * the new bank swaps in when the run completes, the old one is destroyed by the
 * rename, and every save and every translation made from the old reading goes
 * stale — because a curation names blocks by `(page, order)` and those numbers
 * mean different blocks after the pages are read again. The ledger can name every
 * one of those casualties (`subtree`, `markStale`). The dialog just never asked.
 *
 * So this asks, and it asks the SAME QUESTION THE LANDING WILL ASK — `reRunTarget`
 * against the ask, normalised by `askedOf` — because a confirm that decided
 * replace-or-branch by any other rule would be a sentence about a job the engine
 * then files the other way.
 *
 * ── Three answers, and two of them are not a dialog ─────────────────────────
 *
 * REPLACE is the only one that gets a box, because it is the only one where
 * something the user has is at stake. A BRANCH — a re-read with different pages
 * or a different language — destroys nothing and stales nothing; it costs GPU,
 * and the queue is where expense happens, so enqueueing it IS the deliberate act
 * (the row is held, and Start is a second one). What it gets is one line of fact
 * beside the button, because a person asking for different pages may genuinely
 * believe they are replacing. A statement, not a question. And a project with NO
 * READING YET gets neither: there is nothing to say.
 *
 * ── Why the wording lives in `shared/`, and who owns the rest of the card ───
 *
 * Because the sentences are ARITHMETIC OVER THE LEDGER and the renderer is the
 * side already holding one. The counts and the names in them are read off that
 * mirror and nowhere else — a dialog that said "your 2 saved corrections" over a
 * project with three of them would be the app inventing a fact about somebody's
 * work — so the composition is a pure function with the ledger as its only input,
 * called from the OCR dialog as it decides whether to ask at all
 * (`ocr-dialog.component.ts`). Main asking the disk for what the renderer is
 * already looking at would be a round trip for a decision that is already made.
 *
 * WHAT MAIN OWNS IS THE QUESTION, NOT THE PROSE, and this is the only question in
 * the app where that line falls here. `reading:confirm-re-read` (electron/ipc.ts) takes
 * these two strings and dresses them as an `AppQuestion`: the two choices, the
 * key each one answers with, which of them a dismissal means. It draws nothing —
 * no process does but the renderer, whose `ConfirmDialogComponent` paints this in
 * the app's own idiom exactly as it paints every other question asked here.
 *
 * ── The last sentence, and why it may be said at all ────────────────────────
 *
 * "Nothing is destroyed if the run fails" is only true because the engine writes
 * a re-read into a pending bank beside the real one and swaps on success
 * (`docs/BANK-LIFECYCLE.md` §2). It is a promise about the disk, made here, kept
 * there. If that ever stops being true this sentence has to go with it.
 */

import { askedOf, documentOriginOf, reRunTarget, subtree, type ReadAsk } from './ledger';
import type { LedgerStep, ProjectLedger } from './types';

/**
 * The buttons, written once and read back by their own words.
 *
 * NEVER "OK". The question is "Read this book again?" and the answer to it is
 * either reading it again or leaving the reading alone — a box whose affirmative
 * says "OK" makes the user re-read the question to find out what they are
 * agreeing to, at the one moment in this dialog where that matters.
 *
 * THE LABEL IS NOT THE ANSWER, and nothing here reads one back. Main dresses
 * these two words as the choices of an `AppQuestion` (`reading:confirm-re-read`,
 * electron/ipc.ts) and what a press sends back is that choice's own KEY — 'again' or
 * 'leave' (`ReReadAnswer`, shared/types.ts) — never a label, and never the index
 * a native box would have answered with. So the wording above can be rewritten
 * without a single branch anywhere changing with it.
 *
 * THEY LIVE HERE even though main is the only importer, because the buttons are
 * the last line of the question and the question is composed in this file. A
 * proceed label kept in the process that draws no dialogs is a word nobody
 * rereads on the day the sentence above it is rewritten.
 */
export const RE_READ_PROCEED = 'Read it again';
export const RE_READ_CANCEL = 'Leave the reading as it is';

/** The sentence the dialog prints beside its own button when a re-read branches. */
export const BRANCH_SENTENCE = 'This will be a second reading beside the current one.';

/**
 * The two halves of the question, composed from the ledger: the line that is read
 * first, and the one that is read after it.
 *
 * `message` and `detail` were Electron's own field names for a message box's bold
 * line and its body, from when this crossed the seam as one. They still name the
 * same two jobs, but the slots they land in have moved: main dresses `message` as
 * the card's TITLE and `detail` as its message (`reading:confirm-re-read`,
 * electron/ipc.ts), because a card carries a heading of its own where the box had window
 * chrome — and the box's title and message were this same sentence, twice.
 */
export interface ReReadPrompt {
  /** The headline: the question itself. */
  message: string;
  /** §3.2's sentences, with every count and every name read off the ledger. */
  detail: string;
}

/** A re-read that would branch: nothing at stake, one line of fact. */
export interface BranchAhead {
  kind: 'branch';
  /** `BRANCH_SENTENCE`, carried so a caller never re-spells it. */
  sentence: string;
}

/** A re-read that would replace a reading, and everything that costs. */
export interface ReplaceAhead {
  kind: 'replace';
  /** The reading this run would swap its bank into. */
  target: LedgerStep;
  /**
   * Everything made from that reading — `subtree` minus the target itself — in
   * creation order, which is the order the user watched them appear.
   *
   * NOT DELETED AND NOT AT RISK: these are the steps `markStale` will mark. They
   * are named because a person who has saved corrections against a reading is
   * owed the list before they replace it, not after.
   */
  casualties: readonly LedgerStep[];
  message: ReReadPrompt;
}

/** What re-reading this book would do, or null when there is nothing to say. */
export type ReReadAhead = BranchAhead | ReplaceAhead | null;

/**
 * The question, asked of the ledger the renderer is already holding.
 *
 * ── Why the parent is the ORIGIN and not the position ───────────────────────
 *
 * A reading is parented at the import, wherever the pointer happens to be
 * standing — it reads the PIXELS, which live in `archive/`, and `planReading`
 * resolves that source itself for exactly this reason. `recordReading` states the
 * rule (job-queue.ts) and `originOf`'s header spells out what asking the position
 * instead would cost: standing on the reading and pressing OCR again is the
 * ordinary way somebody re-reads a book, and parented at the position it would
 * never match the reading it was meant to replace. This function has to ask the
 * same question the landing will, or it names a cost the run does not pay.
 *
 * ── And why "no reading yet" is asked of the ledger, not of the target ──────
 *
 * `reRunTarget` returning null means "this ask matches no existing reading", and
 * that is true both of a project nobody has read AND of a project read with
 * different pages. Those are the two answers that are not the same: one is a
 * branch and one is silence. So the reading steps are counted first, and only a
 * project that already holds one can be told about a second.
 */
export function reReadAhead(ledger: ProjectLedger | null, asked: ReadAsk): ReReadAhead {
  if (ledger === null) return null;
  // The DOCUMENT origin — on a captured project the mint, not the
  // photographs — because this must ask the exact question the landing
  // records, or the preview names a branch the run will not take.
  const origin = documentOriginOf(ledger);
  // No import means no project history at all; nothing has been read and nothing
  // can have been. The ledger mirror is simply not there yet for a book on its
  // first pass through this dialog, which is the ordinary case.
  if (origin === null) return null;
  if (!ledger.steps.some((step) => step.action === 'read')) return null;

  const target = reRunTarget(ledger, {
    action: 'read',
    parent: origin.id,
    params: askedOf(asked),
  });
  // A DIFFERENT ASK BRANCHES, and a stale reading of the SAME ask does not: a
  // re-read of a branch that went stale is somebody saying "make this one current
  // again", which is a replace and is what `reRunTarget` deliberately answers.
  if (target === null) return { kind: 'branch', sentence: BRANCH_SENTENCE };

  const casualties = subtree(ledger, target.id).filter((step) => step.id !== target.id);
  return { kind: 'replace', target, casualties, message: promptFor(target, casualties) };
}

/**
 * §3.2's wording, adapted to what this particular ledger actually says.
 *
 * ── The rule every clause here obeys ────────────────────────────────────────
 *
 * NEVER INVENT A NUMBER THE LEDGER DID NOT GIVE YOU. The spec's example reads
 * "the 17-page reading" and "your 2 saved corrections and the English
 * translation", and those are not templates to fill in from nothing: a reading
 * whose page count nobody recorded is called "Read", and `labelFor` already made
 * that decision once. So every step in these sentences is named by ITS OWN LABEL,
 * quoted, exactly as the delete confirm names its casualties — which also means a
 * person who reads one of this app's two destructive confirms recognises the
 * other.
 *
 * The count of casualties is a fact the ledger gave us (`subtree`), so it is
 * stated as a numeral, in the delete confirm's own idiom.
 */
function promptFor(target: LedgerStep, casualties: readonly LedgerStep[]): ReReadPrompt {
  const named = casualties.map((step) => `“${step.label}”`).join(', ');
  const madeFromIt = casualties.length === 0
    ? ''
    // KEPT, LISTED AND DIMMED — said in that order and said plainly, because the
    // word "stale" on its own reads like a deletion to anybody who has not read
    // the design document, and the one thing this sentence must not do is
    // frighten somebody about work that is not going anywhere.
    : ` ${casualties.length === 1 ? 'One step was' : `${casualties.length} steps were`} made from it `
      + `and will be marked stale — kept, listed, and dimmed: ${named}.`;
  return {
    message: 'Read this book again?',
    detail: `This replaces “${target.label}”.${madeFromIt}`
      // THE PROMISE THE PENDING BANK MAKES. See the header: this sentence is only
      // honest because a re-read fills a pending file and swaps on success.
      + ' Nothing is destroyed if the run fails: the current reading stays until the'
      + ' new one finishes.',
  };
}
