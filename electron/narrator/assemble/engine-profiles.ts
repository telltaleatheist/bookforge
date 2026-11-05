/**
 * HOW ASSEMBLY MUST TREAT ONE ENGINE'S CHUNKS, AND WHAT COUNTS AS SAYING ITS TEXT. A port of
 * `assemble/engine_profiles.py`'s table.
 *
 * TEMPORARY OWNER of the numbers: they are a voice's facts, and Crucible is gaining them
 * as `edges: {pads, fade_in_ms, fade_out_ms}` on `GET /v1/voices`. This table and its
 * keeper stand until a real release carries that.
 *
 * `orpheus` stays as data, for a finished Orpheus session a person reassembles.
 */

/** What the alignment audit calls a failed chunk. Reported on; it refuses nothing. */
export interface CoveragePolicy {
  /** True when this engine's books are audited as a matter of policy. Stamped into every report. */
  readonly audited: boolean;
  readonly minWordScore: number;
  readonly minAlignedRatio: number;
  readonly minUncredibleWords: number;
  readonly droppedRunWords: number;
  readonly maxDroppedSpans: number;
  readonly minInsertedAudioS: number;
  readonly maxInsertedSpeechFraction: number;
}

const coverage = (audited: boolean): CoveragePolicy => ({
  audited,
  minWordScore: 0.4,
  minAlignedRatio: 0.9,
  minUncredibleWords: 3,
  droppedRunWords: 6,
  maxDroppedSpans: 0,
  minInsertedAudioS: 1,
  maxInsertedSpeechFraction: 0.35,
});

export interface EngineProfile {
  readonly id: string;
  /** True when the engine bakes the inter-chunk silence and its own edges into the audio. */
  readonly pads: boolean;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly coverage: CoveragePolicy;
}

export const ENGINE_PROFILES: Readonly<Record<string, EngineProfile>> = {
  orpheus: { id: 'orpheus', pads: true, fadeInMs: 0, fadeOutMs: 0, coverage: coverage(false) },
  'higgs-v3': { id: 'higgs-v3', pads: false, fadeInMs: 10, fadeOutMs: 25, coverage: coverage(true) },
};

/**
 * Refuses an id with no edge contract. Guessing `pads` either way ships a book that clicks
 * at every join and has no gaps, or fades and re-spaces audio that was already correct.
 */
export function profileFor(engineId: string): EngineProfile {
  const profile = Object.prototype.hasOwnProperty.call(ENGINE_PROFILES, engineId) ? ENGINE_PROFILES[engineId] : undefined;
  if (profile === undefined) {
    throw new EngineProfileError(
      `no assembly profile for engine '${engineId}' - assembly does not know whether its chunks carry their own pads or need fades and gaps `
      + `(known: ${Object.keys(ENGINE_PROFILES).sort().join(', ')})`,
    );
  }
  return profile;
}

export class EngineProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineProfileError';
  }
}
