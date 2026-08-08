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
 *  - **The ladder does not go backwards** (RULED 2026-08-04). Reflow is the gate
 *    into the EPUB world; once the book exists, Next from the book is narration
 *    and never "back to the working copy". Going back is a TAB press —
 *    navigation — not forward progress.
 *
 * A third rule arrived with the second real session, and it is about the window
 * rather than the book: **the station is a fact about what is ON SCREEN**. See
 * `viewedArtifactOf` / `stationForArtifact` at the bottom of this file.
 */

import { samePath } from './same-path';
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

/**
 * Why this book cannot be narrated, or null when it can.
 *
 * The versions page's per-row **Process** button and the picker's Next both ask
 * this, and they must get the SAME sentence: one lock explained two ways is two
 * locks as far as the user is concerned. So the answer is the ladder's own —
 * `stationPresence('tts', …)` for the fact, `MISSING_REASONS.tts` for the words.
 *
 * The input is narrowed to the one field the TTS branch of `stationPresence`
 * reads, and that narrowing is exact rather than partial: narration takes the
 * book and nothing else (e2a accepts nothing but an EPUB — docs/PIPELINE_V2_PLAN.md
 * "Gates"), so a caller that knows only whether the book exists knows everything
 * this question needs. `tools/test-station-ladder.js` holds the two to each other.
 */
export function narrationRefusal(book: Pick<BookDocuments, 'bookEpubExists'>): string | null {
  return book.bookEpubExists ? null : MISSING_REASONS.tts;
}

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
  return walkForward(from, book);
}

/**
 * Where Next goes from the station ON SCREEN, whether or not the book has it.
 *
 * The walk is positional — it reads STATIONS from `at` onwards and never before
 * it — which is the whole of "the ladder does not go backwards". That property
 * is why this exists as its own entry point rather than being a `nextStation`
 * the picker guards: the picker used to answer a not-present station by asking
 * `nextStation('archive', book)`, and from the EPUB station that came back
 * "Next: Working" — the rung the user had already climbed, offered as progress.
 *
 * A station the book does not have is a REAL state and not a caller bug here: a
 * reset can remove the working copy while it is open, and a round trip to main
 * can leave the book's own EPUB unmeasured for a moment. Neither is a reason to
 * point the user back down the ladder.
 */
export function nextStationFromViewed(at: StationId, book: BookDocuments): NextStep {
  return walkForward(at, book);
}

function walkForward(from: StationId, book: BookDocuments): NextStep {
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
// ─── The station is a fact about what is on screen ──────────────────────────
//
// Found the hard way in the second real session (2026-08-04): the picker showed
// the built book while its station said "Working", so Next offered the working
// copy as forward progress, curation read as unlocked over an EPUB, and the
// working PDF's block layer was painted onto the book. Every one of those is the
// same mistake — a station REMEMBERED rather than derived from the viewer.
//
// So the window asks for a station and this module answers with the one that
// agrees with the artifact. Nothing downstream has to check again.

/**
 * What the file in the viewer IS to this book.
 *
 * `source` is the book's own original and its working copy — the same PAGES,
 * with and without the annotations painted, which is why one artifact carries
 * two stations. `book` is the built EPUB.
 */
export type ViewedArtifact = 'source' | 'book';

/** The stations that can be stood on while each artifact is in the viewer. */
export const ARTIFACT_STATIONS: Record<ViewedArtifact, readonly StationId[]> = {
  source: ['archive', 'working'],
  book: ['epub', 'tts'],
};

/**
 * Which artifact the viewer is showing — measured from the paths, never
 * remembered.
 *
 * Three questions, in this order, and each is exact rather than a guess:
 *
 *  1. **Is it the project's PDF?** Then it is the source, and which of the two
 *     source stations the window is on is the window's own business (archive and
 *     working render the same file).
 *  2. **Is it the project's book?** Then it is the book. This is the branch an
 *     EPUB-NATIVE project needs: such a book has no PDF at all, so its original
 *     is an EPUB too and only its export path tells the two apart.
 *  3. **Is it an EPUB, in a project that HAS a PDF original?** Then it is the
 *     book. A PDF book's source is a PDF, so an EPUB on screen can only be what
 *     reflow wrote — and this answer needs no round trip to main, which is why
 *     it is here: `bookEpubPath` is main's answer and arrives a moment late, and
 *     for that moment (2) cannot fire.
 *
 * Anything else — a loose file, a corpus book, a project's EPUB original before
 * it has ever been built — is `source`. That is not a fallback: those books have
 * exactly one station, the archive, and it is where they are curated.
 */
export function viewedArtifactOf(args: {
  /** The path in the viewer. Empty while nothing is loaded. */
  readonly displayedPath: string;
  /** The project's PDF original, or null when the book has none. */
  readonly curatedPdfPath: string | null;
  /** Main's answer for where this project's book is, or null. */
  readonly bookEpubPath: string | null;
}): ViewedArtifact {
  const { displayedPath, curatedPdfPath, bookEpubPath } = args;
  if (displayedPath === '') return 'source';
  if (curatedPdfPath !== null && samePath(displayedPath, curatedPdfPath)) return 'source';
  if (bookEpubPath !== null && samePath(displayedPath, bookEpubPath)) return 'book';
  if (curatedPdfPath !== null && /\.epub$/i.test(displayedPath)) return 'book';
  return 'source';
}

/**
 * The station that agrees with the artifact on screen.
 *
 * A request the artifact cannot carry is not an error — the window asks for a
 * station and the artifact arrives a moment later, in either order — so it
 * resolves to that artifact's FIRST station, which is where a viewer that has
 * just been handed a new file is standing.
 */
export function stationForArtifact(requested: StationId, artifact: ViewedArtifact): StationId {
  const allowed = ARTIFACT_STATIONS[artifact];
  return allowed.includes(requested) ? requested : allowed[0];
}

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
    // The other route to a book mints the same artifact — it just gets there
    // without a working copy. `VLM_CONVERT_STAGE` in shared/vlm/conversion.ts is
    // where this string is declared; it is spelled out here for the same reason
    // every other name in this switch is, because these are the strings that
    // actually travel on `document:stage-finished`.
    case 'Convert to EPUB':
    case 'vlm-convert':
      return 'epub';
    default:
      return null;
  }
}
