/**
 * SML: the in-band markup that rides through the text. A port of `narrator/text/sml.py`.
 *
 * `[heading]` means "never merge this row into anything" and `[item]` means "start a fresh
 * pack here, and never merge this row away". Both sit on a row's leading edge, because a
 * closing half would never land on the row it belongs to: a row ENDS at the next escaped token.
 *
 * "Escaped" means one character at or above U+E000 standing in for a tag, and the Python
 * asks that of whole characters. So everything here walks code points: an emoji's surrogate
 * halves sit below U+E000 and would read as plain text, where the emoji itself reads as a tag.
 */

import { PY_REGEX_SPACE, isPySpace, pyStrip } from '../py-compat';

interface SmlTag {
  readonly static?: string;
  readonly paired: boolean;
}

export const TTS_SML: Readonly<Record<string, SmlTag>> = {
  break: { static: '[break]', paired: false },
  pause: { static: '[pause]', paired: false },
  voice: { paired: true },
  heading: { static: '[heading]', paired: false },
  item: { static: '[item]', paired: false },
};

const UNSPOKEN_SOURCE = String.raw`\[/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]`;

/** The tags no engine ever speaks. A new one each call, because a global regex keeps its place. */
export const smlUnspokenPattern = (): RegExp => new RegExp(UNSPOKEN_SOURCE, 'giu');

/** "This row is a section heading". Anywhere in the row: rows like `[break][heading]Chapter 8.` exist. */
export const SML_HEADING_PATTERN = /\[\/?heading\]/iu;

export const SML_ITEM_PATTERN = /\[\/?item\]/iu;

export const SML_ESCAPE_TAG = 0xe000;

const SP = `[${PY_REGEX_SPACE}]*`;
const TAG_SOURCE = String.raw`\[${SP}(?<close>/)?${SP}(?<tag>break|pause|voice|heading|item)(?:${SP}:${SP}(?<value>.*?))?${SP}\]`;

const tagPattern = (): RegExp => new RegExp(TAG_SOURCE, 'gsu');

export function smlToken(tag: string, value: string | null = null, close = false): string {
  if (close) return `[/${tag}]`;
  if (value !== null) return `[${tag}:${value}]`;
  return `[${tag}]`;
}

/** A prefix, so the caller's own last-character test still sees the row's own last character. */
export const smlHeading = (title: string): string => `${smlToken('heading')}${title}`;

/** A prefix on the item's first text only: token-free rows are what stay inside the item's pack. */
export const smlItem = (text: string): string => `${smlToken('item')}${text}`;

/** Every well-formed tag in its canonical spelling, or the reason one is malformed. */
export function normalizeSmlTags(text: string): [true, string] | [false, string] {
  const out: string[] = [];
  const stack: string[] = [];
  let last = 0;
  for (const m of text.matchAll(tagPattern())) {
    const start = m.index;
    out.push(text.slice(last, start));
    const tag = m.groups!['tag'];
    const close = m.groups!['close'] !== undefined;
    const value = m.groups!['value'];
    const info = TTS_SML[tag];
    if (info.paired) {
      if (close) {
        if (stack.length === 0 || stack[stack.length - 1] !== tag) {
          return [false, `normalize_sml_tags() error: unmatched closing tag [/${tag}]`];
        }
        stack.pop();
        out.push(`[/${tag}]`);
      } else {
        stack.push(tag);
        if (value === undefined) return [false, `normalize_sml_tags() error: paired tag [${tag}] requires a value`];
        out.push(`[${tag}:${pyStrip(value)}]`);
      }
    } else {
      if (close) return [false, `normalize_sml_tags() error: non-paired tag [/${tag}] is invalid`];
      out.push(info.static!);
    }
    last = start + m[0].length;
  }
  out.push(text.slice(last));
  if (stack.length > 0) return [false, `normalize_sml_tags() error: unclosed tag(s): ${stack.join(', ')}`];
  return [true, out.join('')];
}

/** Each tag becomes one character, and that character's distance from U+E000 is its table index. */
export function escapeSml(text: string): [string, string[]] {
  const blocks: string[] = [];
  const escaped = text.replace(tagPattern(), (match) => {
    blocks.push(match);
    return String.fromCodePoint(SML_ESCAPE_TAG + blocks.length - 1);
  });
  return [escaped, blocks];
}

export function restoreSml(text: string, blocks: readonly string[]): string {
  let out = text;
  blocks.forEach((block, i) => {
    out = out.split(String.fromCodePoint(SML_ESCAPE_TAG + i)).join(block);
  });
  return out;
}

const isEscaped = (ch: string): boolean => ch.codePointAt(0)! >= SML_ESCAPE_TAG;

export function stripEscapedSml(row: string): string {
  return [...row].filter((ch) => !isEscaped(ch)).join('');
}

export function hasEscapedSml(row: string): boolean {
  return [...row].some(isEscaped);
}

/**
 * (leading tokens, plain core, trailing tokens). The core keeps any mid-row token, so a caller
 * can refuse it: only a row's edges are ever realized as silence.
 */
export function splitSmlEdges(row: string): [string, string, string] {
  const chars = [...row];
  let i = 0;
  let j = chars.length;
  while (i < j && (isPySpace(chars[i]) || isEscaped(chars[i]))) i += 1;
  while (j > i && (isPySpace(chars[j - 1]) || isEscaped(chars[j - 1]))) j -= 1;
  const lead = chars.slice(0, i).filter(isEscaped).join('');
  const trail = chars.slice(j).filter(isEscaped).join('');
  return [lead, pyStrip(chars.slice(i, j).join('')), trail];
}

/** The one predicate every merge pass asks before it glues a row to a neighbour. */
export function markerRowTest(blocks: readonly string[], tag: string): (row: string) => boolean {
  const marks = new Set<string>();
  const whole = new RegExp(`^(?:${TAG_SOURCE})$`, 'su');
  blocks.forEach((block, i) => {
    if (whole.exec(block)?.groups?.['tag'] === tag) marks.add(String.fromCodePoint(SML_ESCAPE_TAG + i));
  });
  return (row: string): boolean => marks.size > 0 && [...row].some((ch) => marks.has(ch));
}

export const headingRowTest = (blocks: readonly string[]): ((row: string) => boolean) => markerRowTest(blocks, 'heading');

/** The set a chapter filter tests a row against to know it is a bare token. */
export function staticTokens(): Set<string> {
  return new Set(Object.values(TTS_SML).flatMap((row) => (row.static === undefined ? [] : [row.static])));
}
