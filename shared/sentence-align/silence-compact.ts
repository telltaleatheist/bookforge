/**
 * NEVER SEND SILENCE TO THE ASR (Owen, 2026-09-25: "we should never send silence to the ASR tool").
 *
 * Qwen3-ASR has no VAD and transcribes silence: a partial recording's empty stretches (Adobe website spans laid on a
 * whole book's timeline) came back as 83 minutes of an invented sentence on repeat. So before the ASR, the audio is
 * COMPACTED: every stretch of digital silence longer than MIN_SILENT_S is cut out, the pieces that remain are joined
 * with KEEP_GAP_S of silence between them (enough that no ASR segment spans two pieces), and every heard word's time
 * is mapped back to the original timeline. A whole audiobook has no digital silence and passes through unchanged.
 *
 * Pure: the keep regions come from the 20 ms level envelope; the audio work is in electron/crucible/sentence-align.ts.
 */

import type { HeardWord } from './book-diff';
import { FRAME_S, type LevelEnvelope } from './cue-edges';

/** A frame at or below this is digital silence (no recording's room tone is this quiet). */
export const SILENT_DB = -80;
/** Only silence at least this long is cut out; a shorter quiet is a pause and stays. */
export const MIN_SILENT_S = 2.0;
/** Silence left between two kept pieces in the compacted audio. */
export const KEEP_GAP_S = 1.0;
/** Audio kept on each side of a piece, so a word at its edge is never clipped. */
export const KEEP_PAD_S = 0.3;

/** One kept piece: `src` seconds on the original timeline, placed at `dst` seconds in the compacted audio. */
export interface KeptPiece { readonly srcStart: number; readonly srcEnd: number; readonly dstStart: number }

/**
 * The pieces worth transcribing. Null when there is nothing to cut (no silent stretch >= MIN_SILENT_S): the caller
 * sends the original audio as it is.
 */
export function keepPieces(env: LevelEnvelope, durationS: number): KeptPiece[] | null {
  const db = env.db; const minFrames = Math.round(MIN_SILENT_S / FRAME_S);
  const silent: [number, number][] = [];
  let run = -1;
  for (let f = 0; f <= db.length; f++) {
    const q = f < db.length && db[f] <= SILENT_DB;
    if (q && run < 0) run = f;
    if (!q && run >= 0) { if (f - run >= minFrames) silent.push([run * FRAME_S, f * FRAME_S]); run = -1; }
  }
  if (silent.length === 0) return null;
  const pieces: KeptPiece[] = []; let dst = 0; let from = 0;
  const add = (a: number, b: number): void => {
    const s = Math.max(0, a - KEEP_PAD_S); const e = Math.min(durationS, b + KEEP_PAD_S);
    if (e - s <= KEEP_PAD_S * 2 + 0.05) return;                 // nothing but padding
    if (pieces.length) dst += KEEP_GAP_S;
    pieces.push({ srcStart: s, srcEnd: e, dstStart: dst }); dst += e - s;
  };
  for (const [a, b] of silent) { add(from, a); from = b; }
  add(from, durationS);
  return pieces;
}

/** Total seconds of compacted audio (the ASR's input length). */
export function compactedLength(pieces: readonly KeptPiece[]): number {
  const p = pieces[pieces.length - 1]; return p ? p.dstStart + (p.srcEnd - p.srcStart) : 0;
}

/**
 * Heard words, compacted timeline -> original timeline. A word whose midpoint falls in a gap between pieces was heard
 * in the inserted silence and is dropped (counted).
 */
export function mapWordsBack(words: readonly HeardWord[], pieces: readonly KeptPiece[]): { words: HeardWord[]; dropped: number } {
  const out: HeardWord[] = []; let dropped = 0;
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    let lo = 0; let hi = pieces.length - 1; let k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (pieces[m].dstStart <= mid) { k = m; lo = m + 1; } else hi = m - 1; }
    const p = k >= 0 ? pieces[k] : null;
    if (!p || mid > p.dstStart + (p.srcEnd - p.srcStart)) { dropped++; continue; }
    const shift = p.srcStart - p.dstStart;
    out.push({ word: w.word, start: w.start + shift, end: w.end + shift });
  }
  return { words: out, dropped };
}
