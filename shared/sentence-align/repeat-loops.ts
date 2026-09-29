/**
 * A LOOP IN AN OLD TRANSCRIPT, FOUND BY ITS REPETITION (2026-09-28).
 *
 * Crucible 1.0.58 reports a stretch its ASR looped on (`decode_loop`) and returns no words there. Before 1.0.57 it
 * had no loop guard at all: a looped piece came back as the same phrase over and over (WoA's website master: one
 * sentence for 83 minutes). Long-pass transcript caches from that era are reused by later runs, so on reading one
 * that predates `decode_loop`, a run of back-to-back repeats is treated as the loop it almost certainly is.
 *
 * THE THRESHOLDS LEAVE REAL SPEECH ALONE. Books repeat on purpose - "Heil Hitler! Heil Hitler! Heil Hitler!", "no,
 * no, no" - so a phrase of 2-8 words must repeat at least PHRASE_REPEATS times in a row, and a single word at least
 * WORD_REPEATS times. The Third Reich, Mistborn and Deathstalker long passes scanned at a looser 3/5 found none.
 */

/** A phrase of 2..8 words repeated this many times back to back is a loop. */
export const PHRASE_REPEATS = 4;
/** One word repeated this many times back to back is a loop. */
export const WORD_REPEATS = 8;

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Every looped run in `words`, as a time span (first word's start to last word's end), in the words' own time. */
export function repeatedRuns(
  words: readonly { readonly word: string; readonly start: number; readonly end: number }[],
): { start: number; end: number }[] {
  const keys = words.map((w) => norm(w.word));
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < keys.length) {
    let best: { n: number; r: number } | null = null;
    for (let n = 1; n <= 8; n++) {
      const need = n === 1 ? WORD_REPEATS : PHRASE_REPEATS;
      if (i + n * need > keys.length) break;
      const unit = keys.slice(i, i + n);
      if (unit.some((k) => k === '')) continue;
      let r = 1;
      while (i + (r + 1) * n <= keys.length && keys.slice(i + r * n, i + (r + 1) * n).every((k, j) => k === unit[j])) r++;
      if (r >= need && (best === null || r * n > best.r * best.n)) best = { n, r };
    }
    if (best === null) { i++; continue; }
    const last = i + best.n * best.r - 1;
    out.push({ start: words[i].start, end: words[last].end });
    i = last + 1;
  }
  return out;
}
