/**
 * pdf-text — a PDF document read into a book's worth of blocks, with the app's
 * own rules.
 *
 * mupdf.js walks each page's structured text. Every character goes to TWO
 * places at once:
 *   - the app's builder (`shared/pdf/text-blocks.ts` PageBlockBuilder), which
 *     decides the blocks, their text, font and page region exactly as the app's
 *     PDF analysis does, and then `shared/pdf/block-classify.ts` says what each
 *     block IS (body, running head, folio, footnote, caption, heading…);
 *   - a rich copy kept here, line by line, that knows which characters were SET
 *     SMALL AND RAISED — footnote reference numbers — so the reader view can
 *     mark them `<sup>` and the content script's shared predicate
 *     (`shared/text/sup-markers.ts`) leaves them unread, as the TTS export does.
 * Both keep a line only when it has visible text and a block only when it has a
 * line, so the n-th block of one is the n-th block of the other.
 *
 * Wrap hyphens are settled the app's way, from the document's own evidence
 * (`proveHyphenVerdict`): "ques-|tion" joins because "question" appears
 * elsewhere, "non-|Aryan" keeps its hyphen because "non-Aryan" does, and an
 * unproven pair keeps the hyphen and loses the line break — the least
 * destructive reading, the same one the app's cleanup takes.
 */

import type * as Mupdf from 'mupdf';
import { PageBlockBuilder, type PdfTextBlock } from '../../shared/pdf/text-blocks';
import { classifyBlocks } from '../../shared/pdf/block-classify';
import { isWrapHyphenBreak } from '../../shared/text/line-join';
// The app's hyphen evidence rule. Pure (no imports of its own), so the
// extension bundles the one definition rather than a copy.
import {
  addTextToHyphenAttestation,
  createHyphenAttestation,
  proveHyphenVerdict,
  type HyphenAttestation,
} from '../../electron/ai-cleanup-prepass';

/** A run of one line's characters: raised small type, or not. */
export interface Segment { text: string; sup: boolean }

/** What the reader view does with a block. */
export type ViewRole =
  | 'title' | 'heading' | 'subheading' | 'body' | 'quote' | 'caption'
  | 'note'      // a footnote: shown small, never read
  | 'omit';     // running head, folio, a stray reference number, a picture

export interface ViewBlock {
  page: number;
  role: ViewRole;
  /** The classifier's answer, kept for the page's data attributes. */
  category: string;
  /** The block as lines of segments, in order. */
  lines: Segment[][];
}

export interface ReadDocument {
  title: string;
  pageCount: number;
  blocks: ViewBlock[];
  /** The document's own words and compounds, for settling wrap hyphens (`joinLines`). */
  attestation: HyphenAttestation;
}

interface RichChar { c: string; size: number; baseline: number }

/** One page: the builder's blocks plus the rich lines of each. */
interface PageRead {
  blocks: PdfTextBlock[];
  rich: RichChar[][][];
}

function readPage(page: Mupdf.Page, pageIndex: number): PageRead {
  const [x0, y0, x1, y1] = page.getBounds();
  // The walk reports page coordinates already, so no origin to subtract.
  const builder = new PageBlockBuilder(pageIndex, { width: x1 - x0, height: y1 - y0 });

  const rich: RichChar[][][] = [];
  let block: RichChar[][] = [];
  let line: RichChar[] = [];
  const endLine = () => {
    if (line.map((r) => r.c).join('').trim()) block.push(line);
    line = [];
  };
  const endBlock = () => {
    endLine();
    if (block.length > 0) rich.push(block);
    block = [];
  };

  let fontName: string | null = null;
  let fontSize = -1;
  const stext = page.toStructuredText('');
  try {
    stext.walk({
      beginTextBlock() { builder.endBlock(); endBlock(); },
      beginLine() { builder.endLine(); endLine(); },
      onChar(c, origin, font, size, quad) {
        // mutool's XML prints a font without its subset tag ("ABCDEF+") and its
        // size to six significant digits; so does this, so a block's dominant
        // font compares the way the app's does.
        const name = font.getName().replace(/^[A-Z]{6}\+/, '');
        const sz = Number(size.toPrecision(6));
        if (name !== fontName || sz !== fontSize) {
          builder.font(name, sz);
          fontName = name;
          fontSize = sz;
        }
        builder.char(c, quad);
        line.push({ c, size: sz, baseline: origin[1] });
      },
    });
  } finally {
    stext.destroy();
  }
  const blocks = builder.finish();
  endBlock();
  if (blocks.length !== rich.length) {
    // The two keep the same rule; if they ever disagree the view would pair the
    // wrong text with a category, so say so rather than render it.
    throw new Error(`page ${pageIndex + 1}: ${blocks.length} blocks but ${rich.length} rich blocks`);
  }
  return { blocks, rich };
}

/**
 * Split a line into runs, marking characters set at under 80% of the line's
 * body size AND lifted above its baseline — a reference mark, not a small
 * capital or a subscript.
 */
function segmentLine(chars: RichChar[]): Segment[] {
  const bySize = new Map<number, number>();
  for (const r of chars) if (r.c.trim()) bySize.set(r.size, (bySize.get(r.size) || 0) + 1);
  const bodySize = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const baselines = chars.filter((r) => r.size === bodySize).map((r) => r.baseline).sort((a, b) => a - b);
  const baseline = baselines[Math.floor(baselines.length / 2)] ?? 0;

  const out: Segment[] = [];
  for (const r of chars) {
    const sup = bodySize > 0 && r.size < bodySize * 0.8 && r.baseline < baseline - bodySize * 0.2 && r.c.trim() !== '';
    const last = out[out.length - 1];
    if (last && last.sup === sup) last.text += r.c;
    else out.push({ text: r.c, sup });
  }
  return out;
}

const ROLE_OF: Record<string, ViewRole> = {
  title: 'title',
  chapter: 'title',
  heading: 'heading',
  subheading: 'subheading',
  body: 'body',
  quote: 'quote',
  caption: 'caption',
  footnote: 'note',
  header: 'omit',
  footer: 'omit',
  footnote_ref: 'omit',
  image: 'omit',
};

/**
 * Read the whole document. `onPage` reports progress after each page; the walk
 * yields to the event loop between pages so the page can paint it.
 */
export async function readDocument(
  doc: Mupdf.Document,
  fallbackTitle: string,
  onPage: (done: number, total: number) => void,
): Promise<ReadDocument> {
  const total = doc.countPages();
  const pages: PageRead[] = [];
  const heights: number[] = [];
  for (let i = 0; i < total; i++) {
    const page = doc.loadPage(i);
    try {
      const [, y0, , y1] = page.getBounds();
      heights.push(y1 - y0);
      pages.push(readPage(page, i));
    } finally {
      page.destroy();
    }
    onPage(i + 1, total);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }

  const all = pages.flatMap((p) => p.blocks.map((b, i) => ({ b, rich: p.rich[i] })));
  const ided = all.map(({ b }, i) => ({ ...b, id: String(i) }));
  const categories = classifyBlocks(ided, (page) => heights[page], 'pdf-page');

  const att = createHyphenAttestation();
  for (const { b } of all) addTextToHyphenAttestation(att, b.text);

  const blocks: ViewBlock[] = all.map(({ b, rich }, i) => {
    const category = categories.get(String(i)) ?? 'body';
    return { page: b.page, role: ROLE_OF[category] ?? 'body', category, lines: rich.map(segmentLine) };
  });

  const meta = doc.getMetaData('info:Title')?.trim();
  return { title: meta || fallbackTitle, pageCount: total, blocks: joinPageTurns(blocks), attestation: att };
}

/**
 * A paragraph the page turn cut in two is one paragraph: when the last body
 * block before a turn does not end a sentence and the first body block after it
 * starts in lower case, the second is folded into the first. Furniture and
 * notes between them are left where they are.
 */
function joinPageTurns(blocks: ViewBlock[]): ViewBlock[] {
  const out: ViewBlock[] = [];
  let lastBody: ViewBlock | null = null;
  for (const b of blocks) {
    if (b.role === 'body' && lastBody && b.page === lastBody.page + 1) {
      const tail = plainOf(lastBody).trimEnd();
      const head = plainOf(b).trimStart();
      if (!/[.!?:;"”’)\]]$/.test(tail) && /^[a-zà-ÿ]/.test(head)) {
        lastBody.lines.push(...b.lines);
        continue;
      }
    }
    out.push(b);
    if (b.role === 'body') lastBody = b;
    else if (b.role !== 'omit' && b.role !== 'note') lastBody = null;
  }
  return out;
}

function plainOf(b: ViewBlock): string {
  return b.lines.map((l) => l.map((s) => s.text).join('')).join(' ');
}

/**
 * A block's lines as one paragraph of segments, the way the app joins them: a
 * space between lines, except at a wrap hyphen, which the document's evidence
 * settles.
 */
export function joinLines(lines: Segment[][], att: HyphenAttestation): Segment[] {
  const out: Segment[] = [];
  let soFar = '';
  for (const line of lines) {
    const text = line.map((s) => s.text).join('');
    if (out.length > 0) {
      if (isWrapHyphenBreak(soFar, text)) {
        const a = /([A-Za-zÀ-ÿ]+)-[ \t]*$/.exec(soFar)?.[1] ?? '';
        const b = /^[ \t]*([A-Za-zÀ-ÿ]+)/.exec(text)?.[1] ?? '';
        const last = out[out.length - 1];
        last.text = last.text.replace(/[ \t]+$/, '');
        if (proveHyphenVerdict(a, b, att) === 'join') last.text = last.text.replace(/-$/, '');
        line[0] = { ...line[0], text: line[0].text.replace(/^[ \t]+/, '') };
      } else {
        out.push({ text: ' ', sup: false });
      }
    }
    for (const s of line) {
      const last = out[out.length - 1];
      if (last && last.sup === s.sup) last.text += s.text;
      else out.push({ ...s });
    }
    soFar += (soFar ? ' ' : '') + text;
  }
  return out;
}
