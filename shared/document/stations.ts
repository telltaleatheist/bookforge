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
 * Which stations a book HAS, measured.
 *
 * Archive is always among them — a project is its archive original, and a book
 * with no primary is not a book this function is ever asked about. Working
 * exists once the cast has run; the EPUB exists once reflow has written one the
 * binding still vouches for. TTS is never in this set: it is a station you go
 * to, not an artifact this pipeline mints.
 */
export function existingStations(stages: DocumentPipelineStages): StationId[] {
  const present: StationId[] = ['archive'];
  if (stages.getText) present.push('working');
  if (stages.reflow) present.push('epub');
  return present;
}

/**
 * The sentence that names what is missing between a station and the next one.
 *
 * Each one names the BUTTON that makes the missing thing, because "you cannot go
 * on" is not information — the user already knows that from the disabled
 * control. Which button is on which station is the thing they cannot see.
 */
const LOCKED_REASONS: Record<StationId, string> = {
  archive: 'Next needs a working copy — press OCR / Cast.',
  working: 'Next needs the book built — press Build the book.',
  epub: 'Next needs the book built — press Build the book.',
  // The ladder stops here, so this is never read through `nextStation`. It is
  // declared so that adding a station cannot silently leave one unexplained.
  tts: 'Narration is the last station of the picker.',
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
 * `present` is what `existingStations` measured. A station that is not itself
 * present cannot be stood on, and asking about it is a bug in the caller rather
 * than a state to smooth over — it throws.
 */
export function nextStation(from: StationId, present: readonly StationId[]): NextStep {
  if (!present.includes(from)) {
    throw new Error(
      `The picker is showing the ${from} station, and this book does not have one. `
      + 'The station list is measured off the documents, so the window is looking at '
      + 'something the project no longer carries — reopen the book.'
    );
  }
  const at = STATIONS.indexOf(from);
  if (at === STATIONS.length - 1) {
    return { next: null, lockedReason: null };
  }
  const next = STATIONS[at + 1];
  // TTS is not an artifact — it is where the picker hands the finished book on —
  // so it is reachable exactly when the EPUB it needs exists.
  const reachable = next === 'tts' ? present.includes('epub') : present.includes(next);
  return reachable
    ? { next, lockedReason: null }
    : { next, lockedReason: LOCKED_REASONS[from] };
}

/**
 * The station to show after a stage finished, or null when it minted nothing.
 *
 * This is what "open when finished" opens. It is keyed to the stage rather than
 * to what changed on disk, because the user asked for a stage and the artifact
 * it writes is the answer to that question.
 */
export function stationMintedBy(stage: string): StationId | null {
  switch (stage) {
    // The cast and the detect both write into the working document.
    case 'Get Text':
    case 'Blocks':
      return 'working';
    case 'Reflow':
      return 'epub';
    default:
      return null;
  }
}
