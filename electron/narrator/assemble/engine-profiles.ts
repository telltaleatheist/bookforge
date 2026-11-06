/**
 * WHAT COUNTS AS SAYING AN ENGINE'S TEXT, AND THE EDGES OLD SESSIONS WERE RENDERED UNDER. A
 * port of `assemble/engine_profiles.py`'s table.
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
  readonly coverage: CoveragePolicy;
}

/** How a session's chunks join. */
export interface SessionEdges {
  /** True when the engine bakes the inter-chunk silence and its own edges into the audio. */
  readonly pads: boolean;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
}

export const ENGINE_PROFILES: Readonly<Record<string, EngineProfile>> = {
  orpheus: { id: 'orpheus', coverage: coverage(false) },
  'higgs-v3': { id: 'higgs-v3', coverage: coverage(true) },
};

/**
 * WHAT SESSIONS WITH NO RECORDED EDGES WERE RENDERED UNDER: a named record of the past, never
 * a default and never a check. A voice's edges are Crucible's fact, and a session begun since
 * 2.0.35 carries them (`crucible/session-edges.ts`). This table validates nothing: a session
 * that lost its record reads as pre-flip here, and the render door's refusal is the only guard.
 */
export const PRE_FLIP_EDGES: Readonly<Record<string, SessionEdges>> = {
  orpheus: { pads: true, fadeInMs: 0, fadeOutMs: 0 },
  'higgs-v3': { pads: false, fadeInMs: 10, fadeOutMs: 25 },
};

/** Refuses an id this app has no coverage policy or pre-flip record for. */
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
