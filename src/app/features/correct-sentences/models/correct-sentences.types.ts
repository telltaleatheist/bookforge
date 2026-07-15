/**
 * Renderer-side mirror of electron/correct-sentences-bridge.ts types. Kept in sync by
 * hand (the renderer can't import from the main-process bridge).
 */

export interface SentenceCue {
  /** 0-based sentence index — same ordinal as {index}.flac. */
  index: number;
  /** Spoken text (the e2a VTT cue payload). */
  text: string;
  /** Whole-book absolute cue bounds, milliseconds. */
  startMs: number;
  endMs: number;
}

export interface CorrectSentencesSession {
  available: boolean;
  reason?: string;
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  sentencesDir?: string;
  vttPath?: string;
  cues?: SentenceCue[];
  totalSentences?: number;
  sampleFmt?: string;
  ttsEngine?: string;
  voice?: string;
}

export interface CandidateSet {
  index: number;
  /** Current cache file (the "Original", audition option #1). */
  originalPath: string;
  /** Freshly generated takes (already matched to the book's sample_fmt). */
  takePaths: string[];
  failed?: boolean;
}

export interface GenerateCandidatesResult {
  success: boolean;
  candidates: CandidateSet[];
  error?: string;
}

/** One flagged sentence's evolving state through the review loop. */
export interface ReviewRow {
  index: number;
  text: string;
  originalPath: string;
  /** Audition options in order: [original, take0, take1, take2]. */
  options: { label: string; path: string; isOriginal: boolean }[];
  /** Index into `options` the user currently has selected (0 = original). */
  selected: number;
  /** True when the user asked for a fresh set of takes for this row. */
  reroll: boolean;
  /** True once committed to the cache (drops off the list). */
  resolved: boolean;
  /** True when regeneration produced no takes for this index (keep original). */
  failed?: boolean;
}
