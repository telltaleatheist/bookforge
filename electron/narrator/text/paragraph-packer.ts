/**
 * One EPUB document to the chunks a Higgs render will generate. A port of the block policy in
 * `narrator/text/paragraph_packer.py`, which also carries the measurements behind each rule.
 *
 * Python measures and indexes strings in code points, and a cap is compared against those
 * numbers, so `pyLen` stands in for `.length` wherever a length decides something. The `regex`
 * module's `\s`, `\d`, `\w` and `\b` are Unicode here and ASCII in JavaScript, so each is
 * spelled out.
 */

import { PY_REGEX_SPACE, isPySpace, pyLen, pyRegexCollapseSpace, pyRepr, pyRstrip, pySplit, pyStrip } from '../py-compat';
import { foldCapsRun } from './caps';
import { parseSoup, SoupString, SoupTag } from './html/soup';
import { splitSentences } from './sentences';
import { smlToken } from './sml';
import { spoken, stripNarratorGlyphs } from './spoken';

export const PARAGRAPH = 'paragraph';
export const HEADING = 'heading';
export const ITEM = 'item';
export const TABLE = 'table';
export const SCENE_BREAK = 'scene-break';
export const CHAPTER_START = 'chapter-start';
export type BlockKind =
  | typeof PARAGRAPH | typeof HEADING | typeof ITEM | typeof TABLE | typeof SCENE_BREAK | typeof CHAPTER_START;

export const DEFAULT_WALLS: ReadonlySet<BlockKind> = new Set<BlockKind>([HEADING, TABLE, SCENE_BREAK, CHAPTER_START]);
export const DEFAULT_FLOOR_CHARS = 300;
export const EPUB_NATIVE = 'epub-native';
export const PDF_DERIVED = 'pdf-derived';
export type SourceKind = typeof EPUB_NATIVE | typeof PDF_DERIVED;

/** Front matter by `epub:type`: a document of one of these is skipped. `chapters.py`'s list. */
export const EXCLUDED_EPUB_TYPES = ['frontmatter', 'backmatter', 'toc', 'titlepage', 'colophon', 'acknowledgments', 'dedication', 'glossary', 'index', 'appendix', 'bibliography', 'copyright-page', 'landmark'];

export class UnknownProvenance extends Error {}

/** One sentence is longer than any chunk may be and no clause boundary divides it. */
export class SentenceOverCapUnsplittable extends Error {}

export interface Block {
  readonly text: string;
  readonly kind: BlockKind;
  readonly doc: string;
  readonly index: number;
}

export interface Chunk {
  readonly text: string;
  readonly kind: 'prose' | 'heading' | 'item';
  readonly blocks: readonly number[];
  readonly sentenceSplit: boolean;
  readonly droppedJoinTokens: number;
}

export interface PackReport {
  chunks: Chunk[];
  paragraphsSentenceSplit: number;
  merges: number;
  droppedJoinTokens: number;
  overBudgetSentences: number;
  sentencesClauseSplit: number;
  overCapChunks: number;
}

export type Log = (line: string) => void;

const S = `[${PY_REGEX_SPACE}]`;
const D = String.raw`\p{Nd}`;
const W = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}]`;
const WORD_EDGE = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

const TERMINAL = new RegExp(String.raw`[.!?…]["'’”»)\]]*${S}*$`, 'u');
const HAS_LETTER = /\p{L}/u;
const HAS_LOWER = /\p{Ll}/u;
const HAS_WORD = new RegExp(W, 'u');
const CITATION_TAIL = new RegExp(
  String.raw`(?:${WORD_EDGE}(?:m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))\.${S}*${D}+(?:[-–]${D}+)?`
  + String.raw`|${WORD_EDGE}(?:pp?|fol|vol|no)\.${S}*${D}+(?:[-–]${D}+)?)`
  + String.raw`[)\]]?${S}*$`,
  'iu',
);
const CELL_SPLIT = new RegExp(String.raw`\t+|[  ]{2,}|${S}*\|${S}*`, 'u');
const NUMERIC_CELL = new RegExp(
  String.raw`^(?:${S}|[–—\-+(\[])*[$£€]?${D}(?:${D}|${S}|[,.–—\-/:%])*[)\]%]?(?:${S}|\.)*$`,
  'u',
);
const HAS_DIGIT = new RegExp(D, 'u');
const CLAUSE_DASH = new RegExp(String.raw`(?<![${D}–—-])[–—](?![${D}–—-])`, 'gu');

const LABEL_MAX_WORDS = 8;
const TABLE_CELL_MAX_CHARS = 24;
const TABLE_CELL_FRACTION = 0.6;
const TABLE_BARE_MIN_TOKENS = 3;
const TABLE_BARE_MAX_TOKENS = 12;
const TABLE_BARE_MIN_NUMERIC = 2;
const TABLE_BARE_NUMERIC_FRACTION = 0.6;
const TABLE_CELL_JOIN = ' — ';
const BOLD_TITLE_MAX_WORDS = 12;
const BOLD_TAGS = new Set(['strong', 'b']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const PARAGRAPH_TAGS = new Set(['p', 'div', 'blockquote', 'pre']);
const BLOCK_CHILD_TAGS = new Set([...HEADING_TAGS, ...PARAGRAPH_TAGS, 'li', 'ul', 'ol', 'table', 'hr']);

const CLAUSE_TIERS = [';', ':', 'dash', ','] as const;
type ClauseTier = (typeof CLAUSE_TIERS)[number];
const CLAUSE_TIER_LABEL: Readonly<Record<ClauseTier, string>> = { ';': "';'", ':': "':'", dash: 'an em/en dash', ',': "','" };

// Python's `str.isdigit` beyond the decimal digits: superscripts, circled numbers and the like.
const PY_DIGIT = /^[\p{Nd}\u{b2}-\u{b3}\u{b9}\u{1369}-\u{1371}\u{19da}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247c}\u{2488}-\u{2490}\u{24ea}\u{24f5}-\u{24fd}\u{24ff}\u{2776}-\u{277e}\u{2780}-\u{2788}\u{278a}-\u{2792}\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]$/u;
const PY_UPPER = /^\p{Uppercase}$/u;
const PY_ALNUM = /^[\p{L}\p{N}]$/u;
const PY_LOWER = /^\p{Lowercase}$/u;

const firstChar = (text: string): string => String.fromCodePoint(text.codePointAt(0) as number);
function lastChar(text: string): string {
  const units = text.length >= 2 && /[\udc00-\udfff]/.test(text[text.length - 1]) ? 2 : 1;
  return text.slice(-units);
}
const collapse = (text: string): string => pyStrip(pyRegexCollapseSpace(text));

export const endsAThought = (text: string | null | undefined): boolean => TERMINAL.test(text ?? '');

export function endsACitation(text: string | null | undefined): boolean {
  const stripped = pyRstrip(text ?? '');
  const match = CITATION_TAIL.exec(stripped);
  if (!match) return false;
  const head = stripped.slice(match.index).split('.')[0];
  return HAS_LETTER.test(head);
}

export function isLabelLine(text: string | null | undefined): boolean {
  const words = pySplit(text ?? '');
  if (words.length === 0 || words.length > LABEL_MAX_WORDS) return false;
  if (!HAS_LETTER.test(text as string)) return false;
  return !HAS_LOWER.test(text as string);
}

function continuesLowercase(blocks: readonly Block[], index: number): boolean {
  if (index + 1 >= blocks.length) return false;
  const next = blocks[index + 1];
  if (next.kind !== PARAGRAPH) return false;
  const match = HAS_LETTER.exec(next.text);
  return match !== null && PY_LOWER.test(match[0]);
}

/** Tier 2: a paragraph that does not end a thought joins the block after it. */
export function joinProvisionalFragments(blocks: readonly Block[]): Block[] {
  const out: Block[] = [];
  let pending: Block[] = [];
  blocks.forEach((original, index) => {
    let block = original;
    if (pending.length > 0) {
      block = {
        text: `${pending.map((p) => p.text).join(' ')} ${block.text}`,
        kind: pending[0].kind,
        doc: pending[0].doc,
        index: pending[0].index,
      };
      pending = [];
    }
    if (block.kind === PARAGRAPH && block.text && !endsAThought(block.text)
      && !isLabelLine(block.text) && !endsACitation(block.text)) {
      pending.push(block);
      return;
    }
    if (block.kind === ITEM && block.text && !endsAThought(block.text)
      && !isLabelLine(block.text) && continuesLowercase(blocks, index)) {
      pending.push(block);
      return;
    }
    if (block.kind === PARAGRAPH && block.text && isLabelLine(block.text) && !endsAThought(block.text)) {
      block = { ...block, text: `${block.text}.` };
    }
    out.push(block);
  });
  if (pending.length > 0) {
    out.push({ text: pending.map((p) => p.text).join(' '), kind: pending[0].kind, doc: pending[0].doc, index: pending[0].index });
  }
  return out;
}

const isNumericCell = (cell: string): boolean => NUMERIC_CELL.test(cell) && HAS_DIGIT.test(cell);

/** The shape detector, for PDF-derived sources, on the text before its whitespace collapses. */
export function looksTableLike(raw: string | null | undefined): boolean {
  const text = pyStrip(raw ?? '');
  if (!text) return false;
  const cells = text.split(CELL_SPLIT).map(pyStrip).filter((cell) => cell);
  if (cells.length >= 2) {
    const good = cells.filter((cell) => pyLen(cell) <= TABLE_CELL_MAX_CHARS || isNumericCell(cell)).length;
    return good / cells.length >= TABLE_CELL_FRACTION;
  }
  const tokens = pySplit(text);
  if (tokens.length < TABLE_BARE_MIN_TOKENS || tokens.length > TABLE_BARE_MAX_TOKENS) return false;
  if (endsAThought(text)) return false;
  const numeric = tokens.filter(isNumericCell).length;
  if (numeric < TABLE_BARE_MIN_NUMERIC) return false;
  return numeric / tokens.length >= TABLE_BARE_NUMERIC_FRACTION;
}

function clauseBoundaries(text: string, tier: ClauseTier): number[] {
  const pattern = tier === 'dash' ? new RegExp(CLAUSE_DASH.source, 'gu') : new RegExp(`${tier}(?=${S})`, 'gu');
  const points: number[] = [];
  for (const match of text.matchAll(pattern)) {
    const point = (match.index as number) + match[0].length;
    if (pyStrip(text.slice(0, point)) && pyStrip(text.slice(point))) points.push(point);
  }
  return points;
}

interface ClauseSplit {
  readonly pieces: readonly string[];
  readonly boundaries: readonly ClauseTier[];
}

function splitOverCapSentence(
  sentence: string,
  budget: number,
  firstBudget: number,
  tiers: readonly ClauseTier[] = CLAUSE_TIERS,
  memo: Map<string, ClauseSplit | null> = new Map(),
): ClauseSplit | null {
  const text = pyStrip(sentence);
  if (!text) return { pieces: [], boundaries: [] };
  const key = `${firstBudget}\u0000${tiers.join('')}\u0000${text}`;
  if (memo.has(key)) return memo.get(key) as ClauseSplit | null;
  memo.set(key, null);
  if (pyLen(spoken(text)) <= firstBudget) {
    const whole = { pieces: [text], boundaries: [] };
    memo.set(key, whole);
    return whole;
  }
  const middle = pyLen(text) / 2;
  for (let depth = 0; depth < tiers.length; depth += 1) {
    const tier = tiers[depth];
    const points = clauseBoundaries(text, tier);
    if (points.length === 0) continue;
    const ranked = points
      .map((point) => ({ point, at: pyLen(text.slice(0, point)) }))
      .sort((a, b) => Math.abs(a.at - middle) - Math.abs(b.at - middle) || a.at - b.at);
    for (const { point } of ranked) {
      const left = splitOverCapSentence(text.slice(0, point), budget, firstBudget, tiers.slice(depth), memo);
      if (left === null) continue;
      const right = splitOverCapSentence(text.slice(point), budget, budget, tiers.slice(depth), memo);
      if (right === null) continue;
      const split = { pieces: [...left.pieces, ...right.pieces], boundaries: [tier, ...left.boundaries, ...right.boundaries] };
      memo.set(key, split);
      return split;
    }
  }
  return null;
}

function markerFor(kind: BlockKind): string {
  if (kind === HEADING) return smlToken('heading');
  if (kind === ITEM || kind === TABLE) return smlToken('item');
  return '';
}

function chunkKind(kind: BlockKind): Chunk['kind'] {
  if (kind === HEADING) return 'heading';
  if (kind === ITEM || kind === TABLE) return 'item';
  return 'prose';
}

function closedBlockText(block: Block): string {
  const text = pyStrip(block.text);
  if ((block.kind === ITEM || block.kind === HEADING) && text && !endsAThought(text)) return `${text}.`;
  return text;
}

function cutToFit(text: string, prefix: string, cap: number, report: PackReport, log: Log): string[] {
  report.paragraphsSentenceSplit += 1;
  const pieces = splitSentences(text);
  const firstBudget = cap - prefix.length;
  const expanded: string[] = [];
  pieces.forEach((piece, n) => {
    const budgetHere = n === 0 ? firstBudget : cap;
    if (pyLen(spoken(piece)) <= budgetHere) {
      expanded.push(piece);
      return;
    }
    const split = splitOverCapSentence(piece, cap, budgetHere);
    if (split === null) {
      expanded.push(piece);
      return;
    }
    report.sentencesClauseSplit += 1;
    const head = Array.from(spoken(piece)).slice(0, 80).join('');
    log(`pack_paragraphs: chunk ${report.chunks.length} of this document is ONE SENTENCE of ${pyLen(spoken(piece))} chars against a ${budgetHere}-char budget, so no chunk can hold it. LAST RESORT (Owen, 2026-09-15): cut at ${split.boundaries.map((b) => CLAUSE_TIER_LABEL[b]).join(' then ')} into ${split.pieces.length} piece(s) of ${split.pieces.map((p) => String(pyLen(spoken(p)))).join(', ')} chars: ${pyRepr(head)}...`);
    expanded.push(...split.pieces);
  });

  const parts: string[] = [];
  for (const piece of expanded) {
    const limit = parts.length <= 1 ? cap - prefix.length : cap;
    if (parts.length > 0 && pyLen(spoken(parts[parts.length - 1])) + 1 + pyLen(spoken(piece)) <= limit) {
      parts[parts.length - 1] = `${parts[parts.length - 1]} ${piece}`;
    } else {
      parts.push(piece);
    }
  }
  return parts;
}

function emitBounded(
  report: PackReport,
  log: Log,
  options: {
    text: string;
    prefix: string;
    kind: Chunk['kind'];
    blocks: readonly number[];
    cap: number;
    splitOverCap: boolean;
    droppedJoinTokens?: number;
  },
): void {
  const { text, prefix, kind, blocks, cap, splitOverCap } = options;
  const dropped = options.droppedJoinTokens ?? 0;
  if (!text) return;
  if (prefix.length + pyLen(spoken(text)) <= cap) {
    report.chunks.push({ text: `${prefix}${text}`, kind, blocks, sentenceSplit: false, droppedJoinTokens: dropped });
    return;
  }
  if (!splitOverCap) {
    report.overCapChunks += 1;
    log(`pack_paragraphs: a chunk is ${pyLen(spoken(text))} chars against a ${cap}-char cap and is kept WHOLE - the caller packs one chunk per source row, so the row is the chunk that was asked for; the engine's truncation guard answers for it at render time.`);
    report.chunks.push({ text: `${prefix}${text}`, kind, blocks, sentenceSplit: false, droppedJoinTokens: dropped });
    return;
  }
  cutToFit(text, prefix, cap, report, log).forEach((part, n) => {
    const carried = n === 0 ? prefix.length : 0;
    if (carried + pyLen(spoken(part)) > cap) {
      report.overBudgetSentences += 1;
      throw new SentenceOverCapUnsplittable(
        `sentence_over_cap_unsplittable: chunk ${report.chunks.length} of this document is ONE SENTENCE of ${carried + pyLen(spoken(part))} characters (the lead marker included) against a ${cap}-character cap, and it carries no clause boundary - no ";", no ":", no em/en dash and no comma - that divides it into pieces that fit. This packer never cuts mid-clause and never truncates, so the book stops here rather than rendering a chunk nobody wrote. Break the sentence in the text pass, or render on a machine whose cap covers it. The sentence: ${pyRepr(spoken(part))}`,
      );
    }
    report.chunks.push({
      text: `${n === 0 ? prefix : ''}${part}`,
      kind,
      blocks,
      sentenceSplit: true,
      droppedJoinTokens: n === 0 ? dropped : 0,
    });
  });
}

/** Tier 1. Blocks in reading order to the chunks a render will generate. */
export function packParagraphs(
  input: readonly Block[],
  cap: number,
  options: { floorChars?: number; walls?: ReadonlySet<BlockKind>; splitOverCap?: boolean; log?: Log } = {},
): PackReport {
  const floorChars = options.floorChars ?? DEFAULT_FLOOR_CHARS;
  const walls = options.walls ?? DEFAULT_WALLS;
  const splitOverCap = options.splitOverCap ?? true;
  const log = options.log ?? (() => undefined);
  if (walls.has(PARAGRAPH)) throw new Error('paragraph cannot be a wall: nothing would ever merge');
  const blocks = input.map((block) => ({ ...block, text: foldCapsRun(block.text) }));
  if (floorChars < 0) throw new Error(`floor_chars must be >= 0, got ${floorChars}`);
  if (cap <= 0) throw new Error(`Budget.max_chars(None) must be positive, got ${cap}`);

  const lead = smlToken('break');
  const startsWithHeading = (group: readonly Block[]): boolean =>
    group.length > 0 && walls.has(HEADING) && group[0].kind === HEADING;
  const prefixFor = (group: readonly Block[]): string => (startsWithHeading(group) ? `${lead}${markerFor(HEADING)}` : lead);

  const report: PackReport = {
    chunks: [],
    paragraphsSentenceSplit: 0,
    merges: 0,
    droppedJoinTokens: 0,
    overBudgetSentences: 0,
    sentencesClauseSplit: 0,
    overCapChunks: 0,
  };
  let run: Block[] = [];

  const emitProse = (group: readonly Block[]): void => {
    const head = startsWithHeading(group);
    const marker = head ? markerFor(HEADING) : '';
    const text = group.map((b) => pyStrip(b.text)).filter((t) => t).join(' ');
    if (!text) return;
    const indices = group.map((b) => b.index);
    if (head && group.length === 1) {
      emitBounded(report, log, { text, prefix: `${lead}${marker}`, kind: chunkKind(HEADING), blocks: indices, cap, splitOverCap });
      return;
    }
    const dropped = Math.max(0, group.length - 1);
    if (group.length > 1) report.merges += 1;
    report.droppedJoinTokens += dropped;
    emitBounded(report, log, { text, prefix: `${lead}${marker}`, kind: 'prose', blocks: indices, cap, splitOverCap, droppedJoinTokens: dropped });
  };

  const flush = (): void => {
    if (run.length === 0) return;
    let group: Block[] = [];
    for (const block of run) {
      if (group.length === 0) {
        group = [block];
        continue;
      }
      const groupLen = pyLen(spoken(group.map((b) => b.text).join(' ')));
      const mergedLen = prefixFor(group).length + pyLen(spoken([...group, block].map((b) => b.text).join(' ')));
      if (groupLen < floorChars && mergedLen <= cap) {
        group.push(block);
        continue;
      }
      emitProse(group);
      group = [block];
    }
    if (group.length > 0) emitProse(group);
    run = [];
  };

  for (const block of blocks) {
    if (walls.has(block.kind)) {
      flush();
      if (block.kind === HEADING && pyStrip(block.text)) {
        run.push({ ...block, text: closedBlockText(block) });
        continue;
      }
      if ((block.kind === ITEM || block.kind === TABLE) && pyStrip(block.text)) {
        emitBounded(report, log, {
          text: closedBlockText(block),
          prefix: `${lead}${markerFor(block.kind)}`,
          kind: chunkKind(block.kind),
          blocks: [block.index],
          cap,
          splitOverCap,
        });
      }
      continue;
    }
    run.push(block.kind === ITEM ? { ...block, text: closedBlockText(block) } : block);
  }
  flush();
  return report;
}

/** A tag's text with its line breaks read as spaces, and nothing else joined. */
export function markupText(tag: SoupTag): string {
  const out: string[] = [];
  let last = '';
  for (const node of tag.descendants()) {
    if (node instanceof SoupTag) {
      if (node.name === 'br') {
        out.push(' ');
        last = ' ';
      }
      continue;
    }
    const piece = node.value;
    if (!piece) continue;
    const first = firstChar(piece);
    if (last && !isPySpace(last) && !isPySpace(first) && PY_ALNUM.test(last) && (PY_UPPER.test(first) || PY_DIGIT.test(first))) {
      out.push(' ');
    }
    out.push(piece);
    last = lastChar(piece);
  }
  return collapse(out.join(''));
}

const collapseCell = (cell: SoupTag): string => collapse(stripNarratorGlyphs(markupText(cell)));

function tableHeaderRow(table: SoupTag): SoupTag | null {
  if (pyStrip(table.get('role') ?? '').toLowerCase() === 'presentation') return null;
  const head = table.find('thead');
  if (head !== null) return head.find('tr');
  const first = table.find('tr');
  if (first !== null && first.findAll('th').length > 0) return first;
  return null;
}

function tableRows(table: SoupTag): string[] {
  const rows = table.findAll('tr');
  if (rows.length === 0) return [];
  const headerRow = tableHeaderRow(table);
  const headers = headerRow !== null ? headerRow.findAll(['td', 'th']).map(collapseCell) : [];
  const lines: string[] = [];
  for (const row of rows) {
    if (row === headerRow) continue;
    const cells = row.findAll('td').map(collapseCell);
    if (cells.length === 0) continue;
    const joined = cells.length === headers.length && headers.length > 0
      ? cells.map((cell, i) => `${headers[i]}: ${cell}`).join(TABLE_CELL_JOIN)
      : cells.join(TABLE_CELL_JOIN);
    const line = pyStrip(joined);
    if (line) lines.push(line);
  }
  return lines;
}

function normTitle(raw: string): string {
  const folded = pyStrip(raw)
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-');
  return pyStrip(pyRegexCollapseSpace(folded).replace(/[.!?…:]+$/, '').toLowerCase());
}

/** A `<p>` that is all bold, short, and does not end the way a sentence does. */
function boldTitle(tag: SoupTag): string {
  if (tag.name !== 'p') return '';
  let words = 0;
  for (const piece of tag.allStrings()) {
    if (!pyStrip(piece.value)) continue;
    let bold = false;
    for (const parent of piece.parents()) {
      if (parent === tag) break;
      if (parent.name && BOLD_TAGS.has(parent.name)) {
        bold = true;
        break;
      }
    }
    if (!bold) return '';
    words += pySplit(piece.value).length;
  }
  if (words === 0 || words > BOLD_TITLE_MAX_WORDS) return '';
  const title = pyStrip(markupText(tag));
  if (!title || '.,;:'.includes(lastChar(title))) return '';
  return title;
}

function rawBlockText(tag: SoupTag): string {
  const parts: string[] = [];
  for (const node of tag.descendants()) {
    if (node instanceof SoupTag) {
      if (node.name === 'br') parts.push(' ');
    } else if (node instanceof SoupString) {
      parts.push(node.value);
    }
  }
  return parts.join('');
}

const hasBlockChild = (tag: SoupTag): boolean => {
  for (const descendant of tag.tags()) if (BLOCK_CHILD_TAGS.has(descendant.name)) return true;
  return false;
};

/** One spine document's parsed body to its blocks, in reading order. Removes scripts and styles from `soup`. */
export function extractBlocks(soup: SoupTag, docName: string, sourceKind: SourceKind | null, log: Log): Block[] {
  const root = soup.find('body') ?? soup;
  for (const tag of soup.findAll(['script', 'style'])) tag.decompose();

  const blocks: Block[] = [];
  let counter = 0;
  const recentTitles = new Set<string>();
  const add = (text: string, kind: BlockKind): void => {
    blocks.push({ text, kind, doc: docName, index: counter });
    counter += 1;
  };
  const blockText = (tag: SoupTag): string => collapse(stripNarratorGlyphs(rawBlockText(tag)));

  const walk = (tag: SoupTag): void => {
    for (const child of tag.contents) {
      if (!(child instanceof SoupTag)) continue;
      const name = child.name;
      if (HEADING_TAGS.has(name) || boldTitle(child)) {
        let text = blockText(child);
        const norm = normTitle(text);
        if (text && norm && recentTitles.has(norm)) {
          log(`[HEADING] Skipping repeated heading: "${text}"`);
          continue;
        }
        if (norm) recentTitles.add(norm);
        if (text) {
          if (!endsAThought(text)) text += '.';
          add(text, HEADING);
        }
        continue;
      }
      if (name === 'li') {
        recentTitles.clear();
        const text = blockText(child);
        const inner = child.contents.filter((c): c is SoupTag => c instanceof SoupTag && (c.name === 'ul' || c.name === 'ol'));
        if (text) add(text, ITEM);
        for (const nested of inner) walk(nested);
        continue;
      }
      if (name === 'table') {
        recentTitles.clear();
        for (const row of tableRows(child)) add(endsAThought(row) ? row : `${row}.`, TABLE);
        continue;
      }
      if (name === 'hr') {
        recentTitles.clear();
        add('', SCENE_BREAK);
        continue;
      }
      if (PARAGRAPH_TAGS.has(name) && !hasBlockChild(child)) {
        const raw = rawBlockText(child);
        const printed = collapse(raw);
        if (!printed) continue;
        const text = collapse(stripNarratorGlyphs(raw));
        const hasWord = HAS_WORD.test(printed);
        if (hasWord && recentTitles.has(normTitle(text))) {
          log(`[HEADING] Skipping body text that repeats a heading: "${text}"`);
          continue;
        }
        recentTitles.clear();
        if (!hasWord) add('', SCENE_BREAK);
        else if (sourceKind === PDF_DERIVED && looksTableLike(raw)) add(text, TABLE);
        else add(text, PARAGRAPH);
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return blocks;
}

export interface ChunkerOptions {
  readonly cap: number;
  readonly floorChars: number;
  readonly sourceKind: SourceKind;
  readonly walls?: ReadonlySet<BlockKind>;
  readonly skipHeadings: boolean;
  readonly sentencePerParagraph: boolean;
  readonly log: Log;
}

/** `make_chapter_chunker`'s callable: the document's chunks, or `[]` to skip it. */
export function chunkDocument(idx: number, html: string, docName: string, options: ChunkerOptions): string[] {
  const { log, sourceKind, cap, floorChars } = options;
  const onePerRow = options.sentencePerParagraph;
  log(`----------\nParsing doc ${idx} (paragraph policy${onePerRow ? ', one chunk per row' : ''})`);
  const soup = parseSoup(html);
  const body = soup.find('body') ?? soup;
  if (!body.getText({ strip: true })) {
    log('No body found. Skip to next doc...');
    return [];
  }
  let epubType = (body.get('epub:type') ?? '').toLowerCase();
  if (!epubType) {
    const section = soup.find('section');
    if (section) epubType = (section.get('epub:type') ?? '').toLowerCase();
  }
  if (EXCLUDED_EPUB_TYPES.some((part) => epubType.includes(part))) {
    log('No body part. Skip to next doc...');
    return [];
  }

  let blocks = extractBlocks(soup, docName, sourceKind, log);
  if (blocks.length === 0) {
    log('No blocks in this document. Skip to next doc...');
    return [];
  }
  const shaped = blocks.filter((b) => b.kind === TABLE).length;
  if (shaped) log(`[tables] ${shaped} table row block(s) in this document`);
  if (sourceKind === PDF_DERIVED && !onePerRow) {
    const before = blocks.length;
    blocks = joinProvisionalFragments(blocks);
    log(`[tier 2] PDF-derived source: ${before} blocks -> ${blocks.length} after joining provisional fragments`);
  } else if (sourceKind === PDF_DERIVED) {
    log('[sentence_per_paragraph] tier 2 (joining provisional fragments) NOT run: the rows are the chunks, so nothing may merge two of them.');
  }

  if (options.skipHeadings) {
    blocks = blocks.map((b) => (b.kind === HEADING ? { text: '', kind: CHAPTER_START, doc: b.doc, index: b.index } : b));
  }

  const report = packParagraphs(blocks, cap, {
    floorChars: onePerRow ? 0 : floorChars,
    walls: options.walls,
    splitOverCap: !onePerRow,
    log,
  });
  if (onePerRow) {
    log(`[sentence_per_paragraph] one chunk per source row: ${blocks.length} block(s) -> ${report.chunks.length} chunk(s); the ${floorChars}-char merge floor and the cap split were NOT applied (${report.overCapChunks} chunk(s) over the cap, kept whole)`);
  } else {
    log(`[paragraph policy] ${blocks.length} block(s) -> ${report.chunks.length} chunk(s); ${report.merges} merge(s), ${report.droppedJoinTokens} join token(s) dropped, ${report.paragraphsSentenceSplit} paragraph(s) sentence-split`);
  }
  return report.chunks.map((chunk) => chunk.text);
}
