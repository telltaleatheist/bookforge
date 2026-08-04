/**
 * The ladder — which station a book is standing at, and what Next needs next.
 *
 * Pipeline V2 (docs/PIPELINE_V2_PLAN.md) makes processing a place you walk
 * rather than a run you compose: Archive → Working → EPUB → TTS, one press at a
 * time, each step producing a visible artifact. This module is the whole of the
 * arithmetic for that walk, and it is pure so the picker cannot grow a second,
 * subtly different, copy of it in a component.
 *
 * The two rules it exists to enforce:
 *
 *  - **A station exists when its ARTIFACT exists.** Not when a run reported
 *    success, not when a flag was set — the document on disk is the result
 *    (docs/DOCUMENT_PIPELINE.md), so every answer here is derived from the
 *    binding record's measured stages and nothing else. There is no state to
 *    store, and therefore nothing that can disagree with the files.
 *  - **Next is navigation and never work.** It lights when the next station
 *    exists. When it does not, it says which button makes it — a disabled
 *    control that cannot say what would enable it is a dead end.
 */

import type { DocumentPipelineStages } from './pipeline-types';

/**
 * The stations, in the order the ladder is climbed.
 *
 * Assembly is deliberately absent: it is not an artifact of the DOCUMENT
 * pipeline, and the picker hands off at TTS.
 */
export const STATIONS = ['archive', 'working', 'epub', 'tts'] as const;
export type StationId = (typeof STATIONS)[number];

/** What each station is called in front of the user. */
export const STATION_LABELS: Record<StationId, string> = {
  archive: 'Archive',
  working: 'Working',
  epub: 'EPUB',
  tts: 'Narration',
};

/**
 * A book's documents, as the ladder needs to know them.
 *
 * Three facts, kept apart because they are answered by three different things
 * and conflating any two of them produced a bug this file now exists to prevent.
 */
export interface BookDocuments {
  /**
   * This book has a PDF original, so a working document is possible AT ALL.
   *
   * A project that arrived as an EPUB has none: the document pipeline casts a
   * working PDF from the book's ORIGINAL, and main refuses an EPUB there by
   * name. For such a book the Working station is not "not yet", it is **not
   * applicable** — and the difference matters, because "not yet" points at a
   * button and that button would refuse the user.
   */
  readonly hasPdfOriginal: boolean;
  /**
   * The measured stages of the working document, or null when none has been
   * read. For a book with no PDF original this is always null and never
   * consulted.
   */
  readonly workingStages: DocumentPipelineStages | null;
  /**
   * The project's book EPUB is on disk.
   *
   * ONE measure for both kinds of book — main's existence-checked manifest
   * record (`readExportEpub`) — rather than the binding's `stages.reflow`, which
   * only a book with a PDF ancestor has. A book with no binding at all still has
   * a book once it has been exported, and a station that could not see it would
   * strand it.
   */
  readonly bookEpubExists: boolean;
}

/**
 * What a station IS for this book.
 *
 * `absent` is "not yet, and here is the button". `not-applicable` is "this book
 * never has one" — the distinction the Working station needs, and the reason
 * this is three values rather than a boolean.
 */
export type StationPresence = 'present' | 'absent' | 'not-applicable';

export function stationPresence(id: StationId, book: BookDocuments): StationPresence {
  switch (id) {
    case 'archive':
      // A book on screen has an original by construction — it is what was
      // imported, and it is what every other document is bound to.
      return 'present';
    case 'working':
      if (!book.hasPdfOriginal) return 'not-applicable';
      return book.workingStages?.getText === true ? 'present' : 'absent';
    case 'epub':
      return book.bookEpubExists ? 'present' : 'absent';
    case 'tts':
      // Not an artifact this pipeline mints: it is where the finished book is
      // handed on, so it is reachable exactly when there is a book to hand.
      return book.bookEpubExists ? 'present' : 'absent';
  }
}

/**
 * Which stations a book HAS, measured.
 *
 * TTS is never in this list even when it is reachable: the list is what the
 * ladder can STAND on, and narration is a hand-off rather than a document the
 * picker shows.
 */
export function existingStations(book: BookDocuments): StationId[] {
  const present: StationId[] = [];
  for (const id of STATIONS) {
    if (id === 'tts') continue;
    if (stationPresence(id, book) === 'present') present.push(id);
  }
  return present;
}

/**
 * The sentence for a station that is MISSING — keyed to the missing thing, not
 * to where the user is standing.
 *
 * Each one names the BUTTON that makes it, because "you cannot go on" is not
 * information: the user already knows that from the disabled control. Which
 * button is on which station is the thing they cannot see. Keying it to the
 * missing station rather than the current one is what lets a book with no PDF
 * original be told about the book, having skipped a working copy it will never
 * have.
 */
const MISSING_REASONS: Record<StationId, string> = {
  // A book on screen always has its original, so this is unreachable. Declared
  // so that adding a station cannot silently leave one unexplained.
  archive: 'This book has no archived original, which should be impossible.',
  working: 'Next needs a working copy — press OCR / Cast.',
  epub: 'Next needs the book built — press Build the book.',
  // Narration needs the book and nothing else, so a walk that reached here
  // already passed a present EPUB station. Declared for the same reason.
  tts: 'Narration needs the book built — press Build the book.',
};

export interface NextStep {
  /** The station Next goes to, or null at the top of the ladder. */
  readonly next: StationId | null;
  /**
   * Null when Next is live. Otherwise the sentence naming what is missing and
   * which button makes it — the SAME sentence the disabled button carries, so a
   * user is never told two things about one lock.
   */
  readonly lockedReason: string | null;
}

/**
 * Where Next goes from `from`, and why it will not go there.
 *
 * A station that is not itself present cannot be stood on, and asking about it
 * is a bug in the caller rather than a state to smooth over — it throws.
 *
 * A **not-applicable** station is walked straight past. For a book that arrived
 * as an EPUB, Next at the archive goes to the book, because a working copy is
 * not a rung it has not climbed yet — it is a rung that does not exist for it,
 * and stopping there would offer a button that refuses.
 */
export function nextStation(from: StationId, book: BookDocuments): NextStep {
  if (stationPresence(from, book) !== 'present') {
    throw new Error(
      `The picker is showing the ${from} station, and this book does not have one. `
      + 'The station list is measured off the documents, so the window is looking at '
      + 'something the project no longer carries — reopen the book.'
    );
  }
  for (let at = STATIONS.indexOf(from) + 1; at < STATIONS.length; at += 1) {
    const candidate = STATIONS[at];
    const presence = stationPresence(candidate, book);
    if (presence === 'not-applicable') continue;
    return presence === 'present'
      ? { next: candidate, lockedReason: null }
      : { next: candidate, lockedReason: MISSING_REASONS[candidate] };
  }
  return { next: null, lockedReason: null };
}

/**
 * The station to show after a stage finished, or null when it minted nothing.
 *
 * This is what "open when finished" opens. It is keyed to the stage rather than
 * to what changed on disk, because the user asked for a stage and the artifact
 * it writes is the answer to that question.
 *
 * Three vocabularies reach this function, and all three are listed rather than
 * normalized somewhere upstream, because they are what actually travels on
 * `document:stage-finished`: the picker-initiated path names its stages
 * ('Get Text', 'Blocks', 'Reflow' — `electron/document-ipc.ts`), the queue path
 * names them with its own bar labels ('Read the pages', 'Detect blocks',
 * 'Build the book' — `electron/processing-passes.ts`), and the pass KINDS are
 * what a caller holding a job config has. A name none of them use returns null,
 * which is the honest answer: nothing has been proved to exist, so nothing is
 * opened.
 */
export function stationMintedBy(stage: string): StationId | null {
  switch (stage) {
    // The cast and the detect both write into the working document.
    case 'Get Text':
    case 'Read the pages':
    case 'get-text':
    case 'Blocks':
    case 'Detect blocks':
    case 'blocks':
      return 'working';
    case 'Reflow':
    case 'Build the book':
    case 'reflow':
      return 'epub';
    default:
      return null;
  }
}
