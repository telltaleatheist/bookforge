/**
 * text-blocks — characters on a PDF page, gathered into lines and lines into
 * blocks, exactly as the app's PDF analysis does it.
 *
 * ONE builder for two readers of the same structured text:
 *   - the app (`electron/mutool-bridge.ts`), which gets the characters from
 *     `mutool draw -F stext` XML, and
 *   - the BookForge Reader extension's PDF viewer (`extension/src/pdf-text.ts`),
 *     which gets them from mupdf.js `StructuredText.walk()` in the browser.
 * Both feed characters, fonts and line/block boundaries in; both get the same
 * block text, geometry, dominant font and page region out. Then
 * `classifyBlocks` (`./block-classify.ts`) decides what each block is.
 *
 * Pure: no fs, no process, no mupdf handle.
 */

import { isWrapHyphenBreak } from '../text/line-join';

/** One laid-out line of a block: its text and the box its characters cover. */
export interface LaidOutLine {
  text: string;
  fontName: string;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page geometry. `originX/Y` is a non-zero MediaBox's offset, subtracted from every coordinate. */
export interface PageGeometry {
  width: number;
  height: number;
  originX?: number;
  originY?: number;
}

/** A text block, before the caller gives it an id. Field names match the app's `TextBlock`. */
export interface PdfTextBlock {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
  font_name: string;
  char_count: number;
  region: 'header' | 'footer' | 'lower' | 'body';
  is_bold: boolean;
  is_italic: boolean;
  is_superscript: boolean;
  is_image: boolean;
  is_footnote_marker: boolean;
  line_count: number;
  /**
   * The lines joined with NEWLINES — what a block's text used to be. The app
   * hashes its persisted block id from this, so ids never shift when the join
   * character changes (see mutool-bridge).
   */
  idText: string;
  /** The lines themselves, page coordinates, origin applied. */
  lines: LaidOutLine[];
}

/** Bold/italic read from a font NAME — the only style signal mutool's XML carries. */
export function fontStyleOf(fontName: string): { isBold: boolean; isItalic: boolean } {
  const lower = fontName.toLowerCase();
  return {
    isBold: lower.includes('bold'),
    isItalic: lower.includes('italic') || lower.includes('oblique'),
  };
}

/**
 * Join the laid-out lines of ONE block into flowing prose.
 *
 * A block is a paragraph-shaped group of lines that MuPDF found on the page, so
 * the breaks between them are line-wrap artifacts of the page geometry, not
 * authored structure. Joining them with a newline carried that geometry
 * straight through `<p>${text}</p>` into exported.epub and on into TTS, which
 * reads the ragged wrap as if it were meant. Measured across the 103 archived
 * exported.epub files: 381,746 in-paragraph newlines, 72.5% of them sitting
 * mid-word and only 7.2% after terminal punctuation.
 *
 * EXCEPTION — a wrap hyphen KEEPS its newline. `word-\nword` is the exact shape
 * the cleanup hyphen pre-pass matches (HYPHEN_SPLIT), and that pre-pass resolves
 * the pair from the book's own corpus: "inter-\nests" → interests, but
 * "seven-\nyear" → seven-year. The cheap "next char is lowercase ⇒ dehyphenate"
 * rule gets the second one wrong, so it is NOT decided here.
 *
 * Whitespace is otherwise left exactly as emitted: `\n` and ` ` are both one
 * character, so `char_count` is unchanged by this join.
 *
 * Caller guarantees a non-empty array.
 */
export function joinBlockLines(lines: string[]): string {
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const next = lines[i];
    out += isWrapHyphenBreak(out, next) ? `\n${next}` : ` ${next}`;
  }
  return out;
}

/**
 * Gathers one page's characters into lines and blocks. Drive it in document
 * order: `font` whenever the font changes, `char` for every character,
 * `endLine` at each line boundary, `endBlock` at each block boundary. A font
 * persists across lines and blocks until the next `font` call, as it does in
 * mutool's XML.
 */
export class PageBlockBuilder {
  private readonly blocks: PdfTextBlock[] = [];
  private blockLines: LaidOutLine[] = [];
  private bx0 = Infinity;
  private by0 = Infinity;
  private bx1 = 0;
  private by1 = 0;

  private text = '';
  private x0 = Infinity;
  private x1 = 0;
  private y0 = Infinity;
  private h = 0;

  private fontName = '';
  private fontSize = 0;
  private bold = false;
  private italic = false;

  constructor(private readonly page: number, private readonly geometry: PageGeometry) {}

  font(name: string, size: number): void {
    this.fontName = name;
    this.fontSize = size;
    const style = fontStyleOf(name);
    this.bold = style.isBold;
    this.italic = style.isItalic;
  }

  /** One character and its quad: [ulx, uly, urx, ury, llx, lly, lrx, lry] (any corner order). */
  char(c: string, quad: ArrayLike<number>): void {
    if (quad.length < 8) return;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const x2 = Math.max(...xs);
    const y2 = Math.max(...ys);
    this.text += c;
    this.x0 = Math.min(this.x0, x);
    this.x1 = Math.max(this.x1, x2);
    this.y0 = Math.min(this.y0, y);
    this.h = Math.max(this.h, y2 - y);
  }

  endLine(): void {
    if (this.text.trim()) {
      this.blockLines.push({
        text: this.text,
        fontName: this.fontName,
        fontSize: this.fontSize,
        isBold: this.bold,
        isItalic: this.italic,
        y: this.y0,
        height: this.h,
        x: this.x0,
        width: this.x1 - this.x0,
      });
      this.bx0 = Math.min(this.bx0, this.x0);
      this.by0 = Math.min(this.by0, this.y0);
      this.bx1 = Math.max(this.bx1, this.x1);
      this.by1 = Math.max(this.by1, this.y0 + this.h);
    }
    this.text = '';
    this.x0 = Infinity;
    this.x1 = 0;
    this.y0 = Infinity;
    this.h = 0;
  }

  endBlock(): void {
    this.endLine();
    if (this.blockLines.length > 0) {
      this.blocks.push(blockFromLines(this.page, this.geometry, this.blockLines,
        { x0: this.bx0, y0: this.by0, x1: this.bx1, y1: this.by1 }));
    }
    this.blockLines = [];
    this.bx0 = Infinity;
    this.by0 = Infinity;
    this.bx1 = 0;
    this.by1 = 0;
  }

  /** Closes any open block and returns the page's blocks. */
  finish(): PdfTextBlock[] {
    this.endBlock();
    return this.blocks;
  }
}

function blockFromLines(
  page: number,
  geometry: PageGeometry,
  rawLines: LaidOutLine[],
  box: { x0: number; y0: number; x1: number; y1: number },
): PdfTextBlock {
  const ox = geometry.originX || 0;
  const oy = geometry.originY || 0;
  const x = box.x0 - ox;
  const y = box.y0 - oy;
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;

  const text = joinBlockLines(rawLines.map(l => l.text));

  // Dominant font and size, by characters
  const fontCounts = new Map<string, number>();
  const sizeCounts = new Map<number, number>();
  let totalBold = 0;
  let totalItalic = 0;
  let totalChars = 0;
  for (const line of rawLines) {
    const len = line.text.length;
    totalChars += len;
    fontCounts.set(line.fontName, (fontCounts.get(line.fontName) || 0) + len);
    sizeCounts.set(line.fontSize, (sizeCounts.get(line.fontSize) || 0) + len);
    if (line.isBold) totalBold += len;
    if (line.isItalic) totalItalic += len;
  }
  const dominantFont = [...fontCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  const dominantSize = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

  return {
    page,
    x,
    y,
    width,
    height,
    text,
    font_size: dominantSize,
    font_name: dominantFont,
    char_count: text.length,
    region: pdfRegion({ y, height, text, lineCount: rawLines.length }, geometry.height),
    is_bold: totalBold > totalChars / 2,
    is_italic: totalItalic > totalChars / 2,
    is_superscript: false,
    is_image: false,
    is_footnote_marker: false,
    line_count: rawLines.length,
    idText: rawLines.map(l => l.text).join('\n'),
    lines: rawLines.map(l => ({ ...l, x: l.x - ox, y: l.y - oy })),
  };
}

/**
 * Where on the sheet a block sits, from its position and shape alone. Evidence
 * for `classifyBlocks`, never the answer.
 */
export function pdfRegion(
  b: { y: number; height: number; text: string; lineCount: number },
  pageHeight: number,
): PdfTextBlock['region'] {
  const bottomPct = (b.y + b.height) / pageHeight;
  const trimmedText = b.text.trim();
  const textLen = trimmedText.length;

  const looksLikeBodyText = textLen > 100 ||
    /[.!?]["']?\s+[A-Z]/.test(trimmedText) ||
    (trimmedText.endsWith('.') && textLen > 60);

  // Entirely within the top 15% with 1-2 lines = header
  // (headers often have title + page number on separate lines)
  if (b.lineCount <= 2 && bottomPct < 0.15 && !looksLikeBodyText) return 'header';
  if (bottomPct > 0.92 || (bottomPct > 0.88 && textLen < 50)) return 'footer';
  if (bottomPct > 0.70) return 'lower';
  return 'body';
}
