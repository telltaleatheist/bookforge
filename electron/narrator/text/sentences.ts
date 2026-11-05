/**
 * One paragraph to its sentences. A port of `split_sentences` in
 * `narrator/text/paragraph_packer.py`, so an estimated cue and a measured one agree about what a
 * sentence is.
 *
 * Never splits inside an abbreviation, and always splits AFTER a closing quote. Text-preserving:
 * the pieces rejoin to the input's words. The rules, each from a measured book:
 *   - A lone letter's dot does not end anything (`R.L. Dabney`).
 *   - A dot followed by a digit does not (`Col. 2:1`). Known cost: `in 1994. 1995 was worse.`
 *   - An ellipsis ends a sentence only when a capital follows, and `I` is not a signal.
 *
 * JavaScript's `\b`, `\s` and `\d` are ASCII here and the Python's are Unicode, so each is
 * spelled out. The row and code-point comparison against the Python is what proves it.
 */

import { SENTENCE_ABBREVIATION_STEMS } from '../../../shared/text/sentence-abbreviations';
import { PY_REGEX_SPACE, pyStrip } from '../py-compat';

const WORD = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}]`;
const SP = `[${PY_REGEX_SPACE}]`;
const CLOSING_RUN = String.raw`["'’”»)\]]*`;
const END = `(?=${SP}|$)`;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

function hardSentencePattern(): RegExp {
  const guards = SENTENCE_ABBREVIATION_STEMS.map((stem) => `(?<!(?<!${WORD})${escapeRe(stem)})`).join('');
  const ellipsis = String.raw`(?:…|\.(?:${SP}?\.){2,})${CLOSING_RUN}(?=${SP}+["“‘'(\[]?(?!I(?!${WORD}))[A-Z])`;
  const notInARun = String.raw`(?<!\.)(?<!\.${SP})`;
  const notStartingARun = String.raw`(?!${SP}?\.)`;
  const guardedDot = String.raw`(?<!(?<!${WORD})[A-Za-z])${guards}${notInARun}\.${notStartingARun}(?!${SP}+\p{Nd})${CLOSING_RUN}${END}`;
  const others = ['!', '?', '؟', '।', '॥', '།', '።', '፧', '។', '៕', '—', '‽', '。', '！', '？']
    .map((p) => `${escapeRe(p)}${CLOSING_RUN}${END}`);
  return new RegExp([ellipsis, guardedDot, ...others].join('|'), 'gsu');
}

const HARD_SENTENCE = hardSentencePattern();

export function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  let last = 0;
  for (const m of text.matchAll(HARD_SENTENCE)) {
    const end = m.index + m[0].length;
    const piece = pyStrip(text.slice(last, end));
    if (piece) pieces.push(piece);
    last = end;
  }
  const tail = pyStrip(text.slice(last));
  if (tail) pieces.push(tail);
  if (pieces.length > 0) return pieces;
  const whole = pyStrip(text);
  return whole ? [whole] : [];
}
