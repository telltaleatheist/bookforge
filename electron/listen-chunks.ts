/**
 * THE LISTEN PACKER: how many sentences go into one Higgs row.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-11, after the first fast-start Higgs Listen in the extension:
 * "its actually really good. very fast. although the pausing between chunks is
 * pretty slow. and prosody between sentences can be rough too. i assume thats
 * because we're sending it in one sentence at a time. instead of sending it in
 * one sentence at a time can we send it in chunks in the safe band, or in
 * paragraphs/blocks? … i know thatll slow it down a bit but itll make prosody
 * better."
 *
 * Both diagnoses are the same fact. A row is one inference: the model reads it
 * whole, so every sentence boundary INSIDE a row is prosody the model chose,
 * and every boundary BETWEEN rows is a hard seam with a render's worth of
 * latency parked on it. One sentence per row makes every boundary the bad kind.
 *
 * So on Higgs a "sentence" on the wire becomes a CHUNK of one or more
 * sentences. Orpheus is untouched: packing its streaming rows to the cap was
 * A/B'd and came out 2.3x slower, because Orpheus buys throughput with batch
 * WIDTH, not with row length.
 *
 * ── THE RAMP, which is why this is not just "pack to the band" ──────────────
 *
 * Higgs on MLX renders at 2.0x realtime — solo or batched alike, which is why
 * Listen dispatches it one row at a time in reading order
 * (HIGGS_STREAM_BATCH_WIDTH, orpheus-worker-pool.ts). A row is only emitted
 * when it retires, so while row k renders, the listener is playing rows 0..k-1.
 * At 2x, rendering row k costs half of row k's duration, and the audio in hand
 * when it starts is the sum of everything before it. Playback therefore never
 * stalls exactly while
 *
 *     len(chunk_k) <= len(chunk_0) + Σ_{i<k} len(chunk_i)
 *
 * (chars standing in for seconds — the voice's chars/s is roughly constant, and
 * the extra len(chunk_0) is the head start the opener buys by being played
 * while chunk 1 renders). For k = 1 that is simply "no more than twice the
 * opener".
 *
 * Pack to the band from the first chunk and the opener alone is 400 chars of
 * silence before a word is heard. Pack to the ramp and the first chunk is short
 * (fast start), the second may be twice it, and by the third the cap is the
 * band's own — prosody for everything but the opening line, which is the trade
 * Owen asked for.
 *
 * THE ONE HOLE the ramp cannot close: a single sentence longer than everything
 * played before it. A sentence is never split here (splitForTts already capped
 * it at the band, and cutting one again would put a seam mid-clause), so such a
 * chunk overruns its cap by construction. It is the same hole width-1 dispatch
 * left, and it is the extension's projection gate that reasons about it.
 *
 * Nothing here is engine state or session state: same (sentences, band) in,
 * same chunks out, forever. The extension resumes a partly-cached block by
 * index into this list, so a non-deterministic split would splice one chunk's
 * audio onto another chunk's text.
 */

/**
 * The opener's cap: how much is rendered before the first word is heard.
 *
 * 300 chars is ~18 s of audio and, at 2.0x realtime, ~9 s to first word. It is
 * also above the median block in the measured corpora (221-263 chars — see the
 * header of python/narrator/text/paragraph_packer.py), so MOST PARAGRAPHS ARE
 * ONE CHUNK from the very first one, which is the prosody half of the ask.
 *
 * The ramp reaches an 800-char band by the third chunk: 300 -> 600 -> 800.
 */
export const LISTEN_OPENER_CHARS = 300;

/**
 * A piece shorter than this is not worth its own inference — the model gets no
 * context and the listener hears a fragment with a pause on each side of it.
 *
 * MIRRORS `MIN_SEGMENT_CHARS` in electron/text-ai.ts (25), which is itself e2a's
 * `SENTENCE_MIN_CHARS`. Not imported, because text-ai.ts pulls in ai-bridge and
 * with it the Electron app object; tools/test-listen-chunks.js reads the number
 * out of text-ai.ts's source and fails if the two ever drift.
 */
export const LISTEN_MIN_CHUNK_CHARS = 25;

/** The length band one Higgs row may occupy, for one voice on one arm. */
export interface ListenChunkBand {
  /** Cap for chunk 0 — the only chunk with no audio in front of it. */
  openerChars: number;
  /**
   * The catalog's `safeMinChars`, or null. ADVISORY: chunks under it are more
   * prone to an early stop, so the packer prefers to reach it, but it never
   * splits or pads to satisfy it. Greedy fill already reaches it whenever the
   * ramp allows.
   */
  minChars: number | null;
  /** The catalog's `safeMaxChars ?? maxChars` — the ceiling the ramp climbs to. */
  maxChars: number;
}

/**
 * Pack consecutive sentences into ramped chunks, joined with a single space.
 *
 * `sentences` must already be capped at `band.maxChars` (splitForTts does it) —
 * a sentence is never split here, so an over-long one would simply become an
 * over-long chunk. Chunks never cross the call: one `speak` is one block, and
 * one block is one paragraph or selection.
 */
export function packListenChunks(sentences: string[], band: ListenChunkBand): string[] {
  const units = sentences.map((s) => s.trim()).filter((s) => s.length > 0);
  if (units.length === 0) return [];
  if (!(band.maxChars > 0)) {
    throw new Error(`packListenChunks needs a positive maxChars, got ${band.maxChars}`);
  }
  // A voice whose whole band is under the opener (a 250-char cap) gets an opener
  // of its band — the cap is a truncation guard and outranks the ramp.
  const opener = Math.max(1, Math.min(band.openerChars, band.maxChars));

  const chunks: string[] = [];
  let delivered = 0; // chars of audio already in the listener's hands
  let buf = '';
  let cap = opener;

  const close = () => {
    if (!buf) return;
    chunks.push(buf);
    // The head start is the opener's length, counted once, plus everything
    // emitted so far — see THE RAMP above.
    delivered += buf.length;
    cap = Math.min(band.maxChars, chunks[0].length + delivered);
    buf = '';
  };

  for (const unit of units) {
    if (!buf) { buf = unit; continue; }
    const joined = `${buf} ${unit}`;
    // Below the floor, take the next sentence WHATEVER the cap says: closing a
    // 3-char chunk would both speak a fragment alone and set the ramp's first
    // step to 6 chars, which no following sentence could fit under.
    if (joined.length <= cap || buf.length < LISTEN_MIN_CHUNK_CHARS) { buf = joined; continue; }
    close();
    buf = unit;
  }
  close();

  // Starvation floor at the tail, the same trade `capSegment` makes in
  // text-ai.ts: the greedy fill leaves whatever is left over, so a block can end
  // in a scrap. Absorb it into its neighbour even though that exceeds the cap by
  // that much — nothing plays after the last chunk, so it can stall nothing.
  if (chunks.length > 1 && chunks[chunks.length - 1].length < LISTEN_MIN_CHUNK_CHARS) {
    const scrap = chunks.pop() as string;
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${scrap}`;
  }
  return chunks;
}

/**
 * The band for one Higgs voice, from that voice's catalog caps.
 *
 * `safeMaxChars` is the MEASURED band (the training-clip IQR — chunks outside it
 * early-stop more often); `maxChars` is the truncation cap. The safe ceiling
 * wins when the catalog states one.
 *
 * A voice that declares NEITHER is refused by name. There is no fallback to
 * `orpheusStreamMaxChars` — both catalogs ship a `deathstalker`, so the Orpheus
 * number for a Higgs voice is a real number for the wrong engine, and it would
 * be applied silently.
 */
export function listenBandFromCaps(
  voice: string,
  caps: { safeMinChars?: number | null; safeMaxChars?: number | null; maxChars?: number | null },
  openerChars: number = LISTEN_OPENER_CHARS,
): ListenChunkBand {
  const maxChars = caps.safeMaxChars ?? caps.maxChars ?? null;
  if (typeof maxChars !== 'number' || !(maxChars > 0)) {
    throw new Error(
      `Higgs voice '${voice}' declares no chunk length in the catalog (neither safeMaxChars nor `
      + 'maxChars), so Listen has no band to pack its text into. Refusing to render — the Orpheus '
      + 'cap for a same-named voice is a number for the wrong engine. See '
      + 'electron/data/higgs-models.json.',
    );
  }
  return { openerChars, minChars: caps.safeMinChars ?? null, maxChars };
}

/** The one-line log both Listen doors print for a Higgs speak. */
export function describeListenChunks(
  sentenceCount: number,
  chunks: string[],
  band: ListenChunkBand,
): string {
  return (
    `${sentenceCount} sentence${sentenceCount === 1 ? '' : 's'} → ${chunks.length} chunk`
    + `${chunks.length === 1 ? '' : 's'} [${chunks.map((c) => c.length).join(', ')}] `
    + `(ramp from ${Math.min(band.openerChars, band.maxChars)}, band `
    + `${band.minChars ?? '-'}..${band.maxChars})`
  );
}
