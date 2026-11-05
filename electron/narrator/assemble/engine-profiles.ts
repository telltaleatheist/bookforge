/**
 * HOW ASSEMBLY MUST TREAT ONE ENGINE'S CHUNKS. A port of `assemble/engine_profiles.py`'s
 * table, without its coverage policy (that comes with the align step).
 *
 * TEMPORARY OWNER of the numbers: they are a voice's facts, and Crucible is gaining them
 * as `edges: {pads, fade_in_ms, fade_out_ms}` on `GET /v1/voices`. This table and its
 * keeper stand until a real release carries that.
 *
 * `orpheus` stays as data, for a finished Orpheus session a person reassembles.
 */

export interface EngineProfile {
  readonly id: string;
  /** True when the engine bakes the inter-chunk silence and its own edges into the audio. */
  readonly pads: boolean;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
}

export const ENGINE_PROFILES: Readonly<Record<string, EngineProfile>> = {
  orpheus: { id: 'orpheus', pads: true, fadeInMs: 0, fadeOutMs: 0 },
  'higgs-v3': { id: 'higgs-v3', pads: false, fadeInMs: 10, fadeOutMs: 25 },
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
