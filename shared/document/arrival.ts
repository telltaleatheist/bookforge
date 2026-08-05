/**
 * What happens the moment a book is OPENED.
 *
 * RULED 2026-08-04 (docs/PIPELINE_V2_PLAN.md, Owen's first real session):
 * "instead of opening the book in read only mode, lets just have it create a
 * working copy and open that instead, preserving the original."
 *
 * You never START on a read-only book. The picker used to land on the archive
 * for anything that had not been cast, and the archive is where curation is
 * locked — so a freshly imported book opened with every gesture refused and
 * nothing on screen saying why. A book that answers no gesture reads as a broken
 * picker.
 *
 * But minting the working copy IS the cast, and what the cast costs is a fact
 * about the book rather than a preference:
 *
 *  - class **text** — `foundry scan --pdf` reads the publisher's own layer in
 *    one pass. Owen's Kershaw book cast AND detected in 34 seconds. That is
 *    inside the time it takes to look at page one, so it happens on open, with
 *    nothing asked.
 *  - class **scanned** — every page rendered to PGM at 200 dpi (~1.4 GB for a
 *    book), Tesseract over all of them, then the text written back in. Minutes.
 *    That is never spent behind the user's back: opening the book OFFERS the run
 *    instead, and until it lands the archive is what is on screen and says so.
 *
 * This module is the whole of that decision and it is pure, so the two costs
 * cannot drift apart from the condition that picks between them, and so the rule
 * can be tested without a PDF, a project or a window.
 */

import type { DocumentClass } from './pipeline-types';
import type { BookDocuments } from './stations';

/** Everything the decision reads. Nothing here is a preference. */
export interface Arrival {
  /**
   * This window is showing a BookForge project.
   *
   * A loose file opened from the library has no project, and the working copy is
   * cast INTO a project directory and named after its primary — so there is
   * nowhere for one to go. Not a failure: those books are curated through the
   * editor's own block list.
   */
  readonly hasProject: boolean;
  /**
   * This is a training-corpus book, which is deliberately not a project and must
   * never become one. Kept separate from `hasProject` because the reason matters:
   * a corpus book is not a project by design, not by omission.
   */
  readonly isCorpusBook: boolean;
  /** The book's documents as the ladder measures them. */
  readonly book: BookDocuments;
  /**
   * The ARCHIVE ORIGINAL's measured class, or null when nothing measured it.
   *
   * Null is a real state and not a missing value: main is asked
   * (`document:measure-class`) and can refuse — a damaged PDF, a project whose
   * original has moved. NO FALLBACK is possible here, because both guesses cost
   * the user something real: guessing `text` spends a book's worth of GPU on the
   * wrong pipeline, and guessing `scanned` puts a modal in front of a book that
   * would have been ready before they finished reading it.
   */
  readonly documentClass: DocumentClass | null;
  /** A stage is already working on this book. Never fight one. */
  readonly stageRunning: boolean;
}

/**
 * What the picker does on arrival.
 *
 *  - `stand-on-working` — the working copy exists; show it. The ordinary case
 *    for every book after its first open.
 *  - `cast-now` — mint the working copy silently and land on it. Text PDFs only.
 *  - `offer-cast` — put the OCR dialog up, with the run one press away and its
 *    progress inline. Until it lands the archive is what is on screen.
 *  - `stand-on-archive` — there is nothing else to stand on, and nothing to
 *    offer that would not refuse the user when they pressed it.
 */
export type ArrivalAction =
  | 'stand-on-working'
  | 'cast-now'
  | 'offer-cast'
  | 'stand-on-archive';

export function decideArrival(arrival: Arrival): ArrivalAction {
  // Already cast. Nothing to decide and nothing to spend: the working copy is
  // where the book is curated, so that is where the window stands.
  if (arrival.book.workingStages?.getText === true) return 'stand-on-working';

  // A book that can never have a working copy is not "not yet" — it is a book
  // curated at its own station, and offering it a cast would be offering a
  // button that refuses. `hasPdfOriginal` is false for a project that arrived as
  // an EPUB; main refuses to cast a working PDF from a book, by name.
  if (arrival.isCorpusBook || !arrival.hasProject || !arrival.book.hasPdfOriginal) {
    return 'stand-on-archive';
  }

  // Something is already writing into this book's documents — a queue job, or
  // another window. Casting on top of it is refused by the stage registry
  // anyway; the honest thing is to show what there is and let the run land.
  if (arrival.stageRunning) return 'stand-on-archive';

  switch (arrival.documentClass) {
    case 'text':
      return 'cast-now';
    case 'scanned':
      return 'offer-cast';
    case null:
      // Nobody measured it, so nobody knows what casting would cost. Standing
      // still is the only answer that spends nothing and claims nothing; the
      // Archive station's OCR / Cast button is still there to press.
      return 'stand-on-archive';
  }
}
