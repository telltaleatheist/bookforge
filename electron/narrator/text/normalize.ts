/**
 * What a TOC title goes through. Higgs and the retired Orpheus read book-exact text, so this strips
 * emojis, romanizes a non-Latin word and folds the punctuation that makes a model hallucinate.
 */

import { PY_REGEX_SPACE, pyRegexCollapseSpace, pySplit } from '../py-compat';
import { CHARS_REMOVE, EMOJI_RUN, PUNCTUATION_SWITCH, languageScript } from './lang';
import { SCRIPT_RANGES, UNIDECODE_PAGES } from './romanize-data';
import { TTS_SML, smlToken } from './sml';

const WORD_CLASS = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}`;
const TOKENS = new RegExp(`[${WORD_CLASS}]+|[${PY_REGEX_SPACE}]+|[^${WORD_CLASS}${PY_REGEX_SPACE}]`, 'gu');
const WORD = new RegExp(`^[${WORD_CLASS}]+$`, 'u');
const SP = `[${PY_REGEX_SPACE}]*`;
const smlTags = (): RegExp => new RegExp(
  String.raw`\[${SP}(/)?${SP}(?:${Object.keys(TTS_SML).join('|')})(?:${SP}:${SP}[\s\S]*?)?${SP}\]`, 'gu');

function scriptOf(cp: number): string | null {
  let lo = 0;
  let hi = SCRIPT_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end, script] = SCRIPT_RANGES[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return script;
  }
  return null;
}

/** The script of a word's first alphabetic character whose Unicode name says one. */
const wordScript = (word: string): string => {
  for (const ch of word) {
    const script = scriptOf(ch.codePointAt(0) as number);
    if (script !== null && script !== 'o') return script;
  }
  return 'o';
};

const decodedPages = new Map<number, readonly string[]>();

export function unidecode(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) { out += ch; continue; }
    const page = cp >> 8;
    const raw = UNIDECODE_PAGES[page];
    if (raw === undefined) continue;
    let row = decodedPages.get(page);
    if (!row) { row = raw.split(String.fromCharCode(0x1f)); decodedPages.set(page, row); }
    out += row[cp & 255];
  }
  return out;
}

/**
 * The Python tried pypinyin for a Chinese word, pykakasi for Japanese and espeak for Arabic and
 * Cyrillic, falling to Unidecode whenever one failed. In the app's env pykakasi and espeak always
 * failed, so only Chinese differs here: Unidecode's spaced `Bei Jing` for pypinyin's `beijing`.
 */
const romanize = (word: string): string => (wordScript(word) === 'l' ? word : unidecode(word));

export function foreign2latin(input: string): string {
  let text = input;
  const protectedTags = new Map<string, string>();
  let index = 0;
  for (const m of input.matchAll(smlTags())) {
    const key = `__TTS_MARKER_${index}__`;
    index += 1;
    protectedTags.set(key, m[0]);
    text = text.split(m[0]).join(key);
  }
  let out = (text.match(TOKENS) ?? [])
    .map((token) => (!protectedTags.has(token) && WORD.test(token) ? romanize(token) : token))
    .join('');
  for (const [key, tag] of protectedTags) out = out.split(key).join(tag);
  return out;
}

export function normalizeText(input: string, lang: string): string {
  let text = input.replace(EMOJI_RUN, '');
  if (languageScript(lang) === 'latin') text = foreign2latin(text);
  text = text.replace(/(?:\r\n|\r|\n){2,}/g, ` ${smlToken('pause')} `).replace(/\r\n|\r|\n/g, ' ');
  text = Array.from(text, (ch) => PUNCTUATION_SWITCH.get(ch) ?? ch).join('');
  text = text.replace(CHARS_REMOVE, ' ');
  return pySplit(pyRegexCollapseSpace(text)).join(' ');
}
