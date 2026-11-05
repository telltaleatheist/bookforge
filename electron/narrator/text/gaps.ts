/**
 * How much silence sits either side of one chunk. A port of `narrator/text/gaps.py`.
 *
 * There are no per-kind tiers: a heading, a paragraph break, an item and a bare sentence end
 * all return `[0, sentenceGap]`. The paragraph and section tiers came out on 2026-07-17,
 * measured as dead air on top of a model that already reproduces the narrator's own pausing
 * (dialogue turns at 2.0-2.5 s against the narrator's 0.6-1.0 s). Only an explicit `[pause:X]`
 * still moves the answer. So a gaps.json is mostly one repeated value, and that is correct.
 *
 * `sentenceGap` is the number a voice declares, already net of its own tail, because a join
 * is the model's trailing silence plus this. Zero is meaningful: chunks butt together on the
 * model's own pauses. The Python read it from `NARRATOR_SENTENCE_GAP`; here the caller states it.
 */

import { pyRepr, pyStrip } from '../py-compat';

/** Ear-approved on rohan (2026-07-12). */
export const DEFAULT_SENTENCE_GAP = 0.6;

/** `float()` on what `[0-9.]+` can match: `1.2.3` and `.` get past the pattern and refuse here. */
function pauseSeconds(text: string): number {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text)) throw new Error(`could not convert string to float: ${pyRepr(text)}`);
  return Number(text);
}

/** `[before, after]` in seconds. */
export function classifyGap(sentence: string | null | undefined, sentenceGap: number = DEFAULT_SENTENCE_GAP): [number, number] {
  const raw = pyStrip(sentence ?? '');
  const m = /\[pause:([0-9.]+)\]/iu.exec(raw);
  if (m) {
    const token = pauseSeconds(m[1]);
    if (raw.toLowerCase().startsWith('[pause:')) return [token, sentenceGap];
    return [0, Math.max(token, sentenceGap)];
  }
  return [0, sentenceGap];
}
