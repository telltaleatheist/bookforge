/**
 * CUE EDGES IN SILENCE — where a sentence's cue starts and ends, from the waveform.
 *
 * The word times say where the words are; they do not say where to CUT. The old
 * library VTTs put a cue's end at the NEXT sentence's first word, and every
 * training cut taken from them started or ended inside a word (orpheus-finetune
 * HIGGS_FIELD_NOTES 4n.75 / 4n.87 / 4n.89; 95 percent of the Adobe upload
 * regions built from them started on speech). Owen: "move the cut marks to the
 * center of pauses so we arent cutting off the edges of words anymore".
 *
 * Rule, per edge and independent of the other edge:
 *  - a cue STARTS at the centre of the pause just before its first word, and
 *    ENDS at the centre of the pause just after its last word;
 *  - a pause is a run of 20 ms frames within SIL_DB of the local floor, at least
 *    MIN_PAUSE_S long, found within SEARCH_S of the word (the aligner's word
 *    edges step in 80 ms, so the pause may begin a frame or two inside them);
 *  - the local floor is the room tone over 10 s of context around the edge
 *    (5th percentile, digital zeros ignored), never below speech - 55 dB — a
 *    narrow window of unbroken speech has no silence to measure, and its
 *    quietest frames are speech (orpheus-finetune build_adobe_upload, HoA 20784);
 *  - the edge never moves more than MAX_REACH_S from its word, so a chapter
 *    gap's long silence does not hand a cue seconds of nothing;
 *  - the edge frame itself must be within CUT_DB of the floor (a pause can hold
 *    a breath; the cut goes beside it, never through it).
 * Two sentences sharing one pause get the same centre, so their cues meet there.
 * An edge with NO pause (the reader ran straight on) is placed half-way between
 * the two words and FLAGGED — never silently.
 */

export const FRAME_S = 0.02;
export const SIL_DB = 10;
export const CUT_DB = 6;
export const MIN_PAUSE_S = 0.1;
export const SEARCH_S = 0.3;
export const MAX_REACH_S = 1.0;
const CONTEXT_S = 5;

/** 20 ms RMS levels in dBFS for the whole book, frame k covering [k*FRAME_S, (k+1)*FRAME_S). */
export interface LevelEnvelope {
  readonly db: Float32Array;
}

function floorAt(env: LevelEnvelope, t: number): number {
  const k0 = Math.max(0, Math.floor((t - CONTEXT_S) / FRAME_S));
  const k1 = Math.min(env.db.length, Math.ceil((t + CONTEXT_S) / FRAME_S));
  const v: number[] = [];
  for (let k = k0; k < k1; k++) if (env.db[k] > -150) v.push(env.db[k]);
  if (v.length < 5) return -150;
  v.sort((a, b) => a - b);
  const pct = (q: number): number => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))];
  return Math.max(pct(0.05), pct(0.95) - 55);
}

interface Pause { readonly a: number; readonly b: number }

function pausesIn(env: LevelEnvelope, t0: number, t1: number, fl: number): Pause[] {
  const k0 = Math.max(0, Math.floor(t0 / FRAME_S));
  const k1 = Math.min(env.db.length, Math.ceil(t1 / FRAME_S));
  const need = Math.max(1, Math.round(MIN_PAUSE_S / FRAME_S));
  const out: Pause[] = [];
  for (let k = k0; k < k1;) {
    if (env.db[k] < fl + SIL_DB) {
      let j = k; while (j < k1 && env.db[j] < fl + SIL_DB) j++;
      if (j - k >= need) out.push({ a: k * FRAME_S, b: j * FRAME_S });
      k = j;
    } else k++;
  }
  return out;
}

/** The frame nearest `target` inside [lo, hi] whose level is within CUT_DB of the floor, as a time; null if none. */
function silentFrameNear(env: LevelEnvelope, lo: number, hi: number, target: number, fl: number): number | null {
  const k0 = Math.max(0, Math.floor(lo / FRAME_S));
  const k1 = Math.min(env.db.length - 1, Math.floor(hi / FRAME_S));
  let best: number | null = null; let bestD = Infinity;
  for (let k = k0; k <= k1; k++) {
    if (env.db[k] > fl + CUT_DB) continue;
    const t = (k + 0.5) * FRAME_S; const d = Math.abs(t - target);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

export interface EdgeResult {
  readonly t: number;
  /** false when no pause was found and the edge is a midpoint guess. */
  readonly inSilence: boolean;
}

/**
 * The start of a cue whose first word begins at `wordStart`. `prevWordEnd` is the
 * end of the word before it in the audio, when known; the edge never goes past it.
 */
export function startEdge(env: LevelEnvelope, wordStart: number, prevWordEnd: number | null): EdgeResult {
  const fl = floorAt(env, wordStart);
  const lo = Math.max(prevWordEnd ?? -Infinity, wordStart - MAX_REACH_S, 0);
  const cand = pausesIn(env, lo, wordStart + SEARCH_S, fl).filter((p) => p.a < wordStart + SEARCH_S);
  const p = cand[cand.length - 1];
  if (p) {
    const a = Math.max(p.a, lo); const b = Math.min(p.b, wordStart + SEARCH_S);
    const t = silentFrameNear(env, a, b, (a + b) / 2, fl);
    if (t !== null) return { t, inSilence: true };
  }
  const guess = prevWordEnd !== null && prevWordEnd < wordStart ? (prevWordEnd + wordStart) / 2 : Math.max(0, wordStart - 0.02);
  return { t: guess, inSilence: false };
}

/** The end of a cue whose last word ends at `wordEnd`; never past `nextWordStart`. */
export function endEdge(env: LevelEnvelope, wordEnd: number, nextWordStart: number | null): EdgeResult {
  const fl = floorAt(env, wordEnd);
  const hi = Math.min(nextWordStart ?? Infinity, wordEnd + MAX_REACH_S, env.db.length * FRAME_S);
  const cand = pausesIn(env, wordEnd - SEARCH_S, hi, fl).filter((p) => p.b > wordEnd - SEARCH_S);
  const p = cand[0];
  if (p) {
    const a = Math.max(p.a, wordEnd - SEARCH_S); const b = Math.min(p.b, hi);
    const t = silentFrameNear(env, a, b, (a + b) / 2, fl);
    if (t !== null) return { t, inSilence: true };
  }
  const guess = nextWordStart !== null && nextWordStart > wordEnd ? (wordEnd + nextWordStart) / 2 : wordEnd + 0.02;
  return { t: guess, inSilence: false };
}
