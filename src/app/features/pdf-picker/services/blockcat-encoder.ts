import { TextBlock, PageDimension } from './pdf.service';

/**
 * blockcat-encoder — turn a book's OCR blocks into the exact prompt the
 * block-category model was fine-tuned on.
 *
 * THIS FILE IS A CONTRACT, not a convenience. The model was trained by
 * `tools/aligner/build-sft-dataset.mjs`, and a fine-tune only performs on the
 * format it saw: a renamed field or a decimal place in the wrong position
 * degrades it in ways that look exactly like a bad model. The two encoders are
 * kept honest by a golden fixture — `blockcat-encoder.spec.ts` replays real
 * corpus pages through this code and asserts the prompt matches the builder's
 * output byte for byte. If you change the format here, change it there, and
 * regenerate the fixture; a red test means the model is about to get input it
 * has never seen.
 *
 * Two formats are supported because two adapters exist. v1 is the first run's
 * checkpoint (geometry, font ratio, gap above); v2 adds the features that run
 * built to fix — gap below, envelope-relative position, the width/centre
 * decomposition, and cross-page repetition — and encodes every quantity as a
 * small integer, since decimals cost three to four tokens apiece.
 *
 * EVERY NORMALIZER IS DERIVED WITHOUT LABELS, which is what makes inference
 * possible at all: the book is OCR'd in full before anything is classified, so
 * the modal type size, the modal leading, the text envelope, the body measure
 * and the repetition rates are all available up front — the same quantities,
 * computed the same way, as during training.
 */

export type BlockcatVersion = 1 | 2;

export const BLOCKCAT_CATEGORIES = [
  'body', 'title', 'chapter', 'heading', 'subheading', 'quote', 'caption',
  'footnote', 'footnote_ref', 'header', 'footer', 'image', 'front_matter',
  'back_matter', 'table', 'list',
] as const;

export type BlockcatCategory = typeof BLOCKCAT_CATEGORIES[number];

/** One page's prompt, plus the mapping back to the caller's block ids. */
export interface EncodedPage {
  readonly page: number;
  /** Block ids in prompt order; the model answers "<1-based index> <category>". */
  readonly blockIds: readonly string[];
  readonly system: string;
  readonly user: string;
}

const HEAD = 200;
const TAIL = 60;
const TEXT_BUDGET = 4000;
const MIN_HEAD = 40;

const SYSTEM_V1 = `You classify text blocks on a scanned book page so an EPUB can be rebuilt with correct structure.

You receive the page's position in the book, its dimensions, and one line per OCR block:
  <id> <x0,y0,x1,y1> fs<size vs book body text> g<blank lines above> l<lines> c<chars> q<ocr confidence> | <text>
Coordinates are fractions of the page (0-1), origin top-left. fs1.00 is normal
body type; fs2.10 is roughly double. Long text is shown as head … tail.

Label every block with exactly one of:
${BLOCKCAT_CATEGORIES.join(', ')}

Reply with one line per block, "<id> <category>", in the order given. No other text.`;

const SYSTEM_V2 = `You classify text blocks on a scanned book page so an EPUB can be rebuilt with correct structure.

You receive the page's position in the book, its dimensions, and one line per OCR block:
  <id> <x0,y0,x1,y1> fs<size vs book body text> g<blank lines above> d<blank lines below> t<position in text block> il<left inset> w<width> cx<offset from centre> r<repeats across book> l<lines> c<chars> q<ocr confidence> | <text>
Coordinates are percent of the page, origin top-left, so 12,86,90,94 is a wide
strip near the bottom. fs1.00 is normal body type; fs2.10 is roughly double.
g and d are in lines of body leading.
t is vertical position within the book's text block: t0 is where body text
starts, t100 where it ends, NEGATIVE is above the running text (running heads)
and over 100 is below it (folios, running feet).
il, w and cx describe the block horizontally against the book's body measure:
il0 is flush with the left margin, w100 spans the full measure, and cx is how
far the block's centre sits from the measure's centre, negative to the left.
A short centred line is w40 cx0; the same line indented is w40 cx-20; a short
flush-left line is il0 w40 cx-30.
r is the percent of the book's pages carrying the same text at the same height:
r80 is page furniture, r0 is unique to this page.
q is OCR confidence in percent. Long text is shown as head … tail.

Label every block with exactly one of:
${BLOCKCAT_CATEGORIES.join(', ')}

Reply with one line per block, "<id> <category>", in the order given. No other text.`;

/** Percent as a small integer — decimals are a tokenizer tax (see the builder). */
const ipct = (v: number): string => String(Math.round(v * 100));

const pct = (sorted: readonly number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

/**
 * Repetition key, byte-identical to `computeRepeatRates` in
 * training-export.service.ts and to the builder's: a 5% vertical band plus the
 * text with digits collapsed to `#`. The digit collapse is the whole trick —
 * it makes a page number the SAME string on every page, which is the only way
 * a bare folio is detectable as furniture at all.
 */
function repeatKey(b: TextBlock, pageHeight: number): string {
  const band = Math.round((b.y / (pageHeight || 1)) * 20);
  const text = (b.text || '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${band}|${text}`;
}

interface BookNorm {
  modalFsize: number;
  modalLeading: number;
  bodyTop: number;
  bodyBot: number;
  bodyLeft: number;
  bodyRight: number;
  envHeight: number;
  measure: number;
  repeats: Map<string, Set<number>>;
  pageCount: number;
}

/**
 * Whole-book statistics. Computed once over every block in the book — never
 * per page — because that is how they were computed for training, and because
 * a single page cannot tell you what this book's body type looks like.
 */
function computeBookNorm(
  blocks: readonly TextBlock[],
  pageDimensions: readonly PageDimension[],
): BookNorm {
  const fsWeight = new Map<number, number>();
  const leading: number[] = [];
  const tops: number[] = [];
  const bots: number[] = [];
  const lefts: number[] = [];
  const rights: number[] = [];
  const repeats = new Map<string, Set<number>>();
  const pages = new Set<number>();

  for (const b of blocks) {
    const dim = pageDimensions[b.page];
    if (!dim) continue;
    pages.add(b.page);
    const lines = b.line_count ?? 1;

    // Char-weighted so body type wins the mode even on pages dominated by
    // short furniture blocks.
    const bucket = Math.round(b.font_size * 2) / 2;
    fsWeight.set(bucket, (fsWeight.get(bucket) ?? 0) + (b.char_count || 1));
    if (lines >= 2) leading.push(b.height / lines);

    // The text envelope and body measure come from RUNNING TEXT only. Three
    // or more lines is the label-free proxy for prose: furniture is one line,
    // headings are one or two.
    if (lines >= 3) {
      tops.push(b.y / dim.height);
      bots.push((b.y + b.height) / dim.height);
      lefts.push(b.x / dim.width);
      rights.push((b.x + b.width) / dim.width);
    }

    const rk = repeatKey(b, dim.height);
    if (!repeats.has(rk)) repeats.set(rk, new Set());
    repeats.get(rk)!.add(b.page);
  }

  const modalFsize = [...fsWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 1;
  const lead = leading.sort((a, b) => a - b);
  const modalLeading = lead.length ? lead[Math.floor(lead.length / 2)] : 1;

  // Percentiles, not min/max: one skewed OCR box should not redefine the page.
  const bodyTop = pct(tops.sort((a, b) => a - b), 0.05);
  const bodyBot = pct(bots.sort((a, b) => a - b), 0.95);
  const bodyLeft = pct(lefts.sort((a, b) => a - b), 0.5);
  const bodyRight = pct(rights.sort((a, b) => a - b), 0.5);

  return {
    modalFsize, modalLeading, bodyTop, bodyBot, bodyLeft, bodyRight,
    envHeight: (bodyBot - bodyTop) || 1,
    measure: (bodyRight - bodyLeft) || 1,
    repeats,
    pageCount: Math.max(1, pages.size),
  };
}

interface TextBudget { head: number; tail: number; }

/**
 * Per-page text budget, v2 ONLY. v1 was trained with a flat 200/60 clip, and
 * feeding its checkpoint the shorter v2 text would hand it prompts unlike
 * anything it saw — the kind of mismatch that reads as a bad model.
 *
 * Dense endnote pages run to 80-odd blocks, and there the
 * geometry alone fills the context window; a full 200-char head on every block
 * would push one page past max_seq_length. Text shrinks, never geometry — those
 * pages are almost entirely footnote/back_matter, whose class comes from
 * position and repetition rather than from prose. Ordinary pages are untouched:
 * at the median 7 blocks the share is 570 chars, well over the 200 cap.
 */
function textBudget(nBlocks: number): TextBudget {
  const share = Math.floor(TEXT_BUDGET / Math.max(1, nBlocks));
  const head = Math.max(MIN_HEAD, Math.min(HEAD, share));
  return { head, tail: Math.max(12, Math.min(TAIL, Math.floor(head * 0.3))) };
}

/** Long text -> head … tail. The middle of a body paragraph carries no class
 *  signal; the two ends carry nearly all of it. */
function clipText(t: string, budget: TextBudget): string {
  const text = (t || '').replace(/\s+/g, ' ').trim();
  if (text.length <= budget.head + budget.tail + 3) return text;
  return `${text.slice(0, budget.head)} … ${text.slice(-budget.tail)}`;
}

function blockLine(
  version: BlockcatVersion,
  b: TextBlock,
  prev: TextBlock | null,
  next: TextBlock | null,
  index: number,
  dim: PageDimension,
  n: BookNorm,
  budget: TextBudget,
): string {
  const x0 = b.x / dim.width;
  const y0 = b.y / dim.height;
  const x1 = (b.x + b.width) / dim.width;
  const y1 = (b.y + b.height) / dim.height;
  const lines = b.line_count ?? 1;
  const conf = b.ocr_confidence ?? 1;
  const fsRatio = (b.font_size / n.modalFsize).toFixed(2);

  // Gap above, in blank lines. The first block on a page measures from the top
  // edge — "how deep does the text start" is the drop that marks a chapter
  // opener. Negative means the block sits beside its predecessor, not below.
  const prevBottom = prev ? prev.y + prev.height : 0;
  const gap = ((b.y - prevBottom) / n.modalLeading).toFixed(1);

  if (version === 1) {
    const bbox = [x0, y0, x1, y1].map(v => v.toFixed(3)).join(',');
    return `${index} ${bbox} fs${fsRatio} g${gap} l${lines} c${b.char_count} q${conf}`
      + ` | ${clipText(b.text, budget)}`;
  }

  // Gap below — the half that actually separates subheading from heading. The
  // last block on the page measures to the bottom edge, mirroring the first.
  const nextTop = next ? next.y : dim.height;
  const gapBelow = ((nextTop - (b.y + b.height)) / n.modalLeading).toFixed(1);
  const t = ipct((y0 - n.bodyTop) / n.envHeight);
  const il = ipct((x0 - n.bodyLeft) / n.measure);
  const w = ipct((x1 - x0) / n.measure);
  const cx = ipct(((x0 + x1) / 2 - (n.bodyLeft + n.bodyRight) / 2) / n.measure);
  const r = ipct((n.repeats.get(repeatKey(b, dim.height))?.size ?? 1) / n.pageCount);
  const bbox = [x0, y0, x1, y1].map(ipct).join(',');

  return `${index} ${bbox} fs${fsRatio} g${gap} d${gapBelow} t${t} il${il} w${w} cx${cx} r${r}`
    + ` l${lines} c${b.char_count} q${ipct(conf)} | ${clipText(b.text, budget)}`;
}

export interface EncodeOptions {
  readonly version: BlockcatVersion;
  /** Total pages in the book — the "% through the book" the model was given. */
  readonly totalPages: number;
}

/**
 * Encode every page that has blocks. One conversation per PAGE, because a
 * block's class depends on its neighbours (a lone line is a heading or a footer
 * depending on what sits above it) but not on the rest of the book.
 *
 * Blocks are taken in the order given, which is the reading order the viewer
 * already maintains — the same order the training data was written in.
 */
export function encodeBook(
  blocks: readonly TextBlock[],
  pageDimensions: readonly PageDimension[],
  options: EncodeOptions,
): EncodedPage[] {
  const norm = computeBookNorm(blocks, pageDimensions);
  const system = options.version === 1 ? SYSTEM_V1 : SYSTEM_V2;

  const byPage = new Map<number, TextBlock[]>();
  for (const b of blocks) {
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page)!.push(b);
  }

  const out: EncodedPage[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageBlocks = byPage.get(page)!;
    const dim = pageDimensions[page];
    if (!dim || pageBlocks.length === 0) continue;

    const budget = options.version === 1
      ? { head: HEAD, tail: TAIL }
      : textBudget(pageBlocks.length);
    const lines = pageBlocks.map((b, j) => blockLine(
      options.version, b,
      j ? pageBlocks[j - 1] : null,
      pageBlocks[j + 1] ?? null,
      j + 1, dim, norm, budget,
    ));

    const through = options.totalPages
      ? Math.round((page / options.totalPages) * 100) : 0;
    const user = [
      `page ${page + 1} of ${options.totalPages} (${through}% through the book), `
        + `${dim.width}x${dim.height}, ${pageBlocks.length} blocks`,
      '',
      ...lines,
    ].join('\n');

    out.push({ page, blockIds: pageBlocks.map(b => b.id), system, user });
  }
  return out;
}

const ANSWER_LINE = /^\s*(\d+)\s+([a-z_]+)\s*$/;

/**
 * Parse the model's reply into {blockId: category}.
 *
 * Unparseable lines and illegal categories are DROPPED rather than guessed at:
 * this drives a visual overlay, and a silently invented label would be
 * indistinguishable from a real prediction. A later duplicate id wins — a
 * repeated id is the model correcting itself mid-answer.
 */
export function parseAnswer(
  text: string,
  blockIds: readonly string[],
): Map<string, BlockcatCategory> {
  const out = new Map<string, BlockcatCategory>();
  const legal = new Set<string>(BLOCKCAT_CATEGORIES);
  for (const raw of (text || '').trim().split('\n')) {
    const m = ANSWER_LINE.exec(raw);
    if (!m) continue;
    const index = Number(m[1]) - 1;
    const category = m[2];
    if (index < 0 || index >= blockIds.length) continue;
    if (!legal.has(category)) continue;
    out.set(blockIds[index], category as BlockcatCategory);
  }
  return out;
}
