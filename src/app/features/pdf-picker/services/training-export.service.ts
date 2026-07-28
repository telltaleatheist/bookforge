/**
 * Training-data export.
 *
 * Turns a labelled document into one JSONL record per page. The page is the
 * training unit rather than the block: a block's category depends heavily on
 * its neighbours (footnotes cluster, headings precede body, captions follow
 * images), and a per-block example throws that context away. A page is also
 * large enough for a model to infer the book's paragraph convention from the
 * other paragraph starts around it — which matters because some books mark
 * paragraphs with an indent and others with extra leading.
 *
 * Geometry is emitted as page fractions and font size as a ratio to the
 * document's body size. Raw pixels would leak DPI and trim size, and a model
 * trained on them would not transfer between books.
 */

import { Injectable } from '@angular/core';
import { TextBlock, PageDimension } from './pdf.service';
import { computeBaselines } from './category-learner';

/** One block within a page record. */
export interface TrainingBlockRecord {
  /** 1-based index within the page, used to key the labels. */
  i: number;
  /** [x0, y0, x1, y1] as fractions of page width/height, 3dp. */
  bbox: [number, number, number, number];
  /** font_size / document body size. */
  fsize: number;
  /** 1 when the block's font matches the document's dominant font. */
  bodyFont: number;
  bold: number;
  italic: number;
  lines: number;
  chars: number;
  /** Vertical gap above, in body-line units. */
  gap: number;
  /** Left offset from the body margin, as a page-width fraction. */
  indent: number;
  /** How much of the body measure the block's last line fills, 0..1. */
  fill: number;
  caps: number;
  /** Fraction of pages carrying near-identical text at this position. */
  repeat: number;
  /** The heuristic's own guess, for the model to correct. */
  guess: string;
  /** Truncated text — enough to recognise structure, not to re-read the book. */
  text: string;
}

export interface TrainingPageRecord {
  book: string;
  page: number;
  pages: number;
  pageWidth: number;
  pageHeight: number;
  bodySize: number;
  bodyFont: string;
  /** Fraction of this book's paragraph starts that are indented. */
  indentStyle: number;
  blocks: TrainingBlockRecord[];
  /** Block index → category. The training target. */
  labels: Record<number, string>;
  /** Indices whose label was set by hand rather than inferred. */
  human: number[];
}

const TEXT_LIMIT = 90;

@Injectable({ providedIn: 'root' })
export class TrainingExportService {

  /**
   * Build page records for a labelled document.
   *
   * Only pages carrying at least one hand-set label are emitted. A page whose
   * every block came from the heuristic teaches the model nothing except to
   * agree with the heuristic, and would swamp the genuine corrections.
   */
  buildRecords(
    bookId: string,
    blocks: TextBlock[],
    pageDimensions: PageDimension[],
    labels: Map<string, string>,
  ): TrainingPageRecord[] {
    const visible = blocks.filter(b => !b.is_image);
    if (visible.length === 0) return [];

    const baselines = computeBaselines(blocks);
    const bodySize = baselines.bodySize || 1;
    const repeats = this.computeRepeatRates(visible, pageDimensions);
    const indentStyle = this.computeIndentStyle(visible, baselines.bodyMarginX);
    const totalPages = pageDimensions.length;

    const byPage = new Map<number, TextBlock[]>();
    for (const block of visible) {
      if (!byPage.has(block.page)) byPage.set(block.page, []);
      byPage.get(block.page)!.push(block);
    }

    const records: TrainingPageRecord[] = [];

    for (const [pageNum, pageBlocks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      if (!pageBlocks.some(b => labels.has(b.id))) continue;

      const dim = pageDimensions[pageNum];
      const pageWidth = dim?.width || 612;
      const pageHeight = dim?.height || 792;
      const sorted = [...pageBlocks].sort((a, b) => a.y - b.y || a.x - b.x);

      const blockRecords: TrainingBlockRecord[] = [];
      const pageLabels: Record<number, string> = {};
      const human: number[] = [];

      sorted.forEach((block, index) => {
        const i = index + 1;
        const previous = index > 0 ? sorted[index - 1] : null;
        const gapAbove = previous
          ? Math.max(0, block.y - (previous.y + previous.height))
          : block.y;

        blockRecords.push({
          i,
          bbox: [
            this.round(block.x / pageWidth),
            this.round(block.y / pageHeight),
            this.round((block.x + block.width) / pageWidth),
            this.round((block.y + block.height) / pageHeight),
          ],
          fsize: this.round(block.font_size / bodySize),
          bodyFont: block.font_name === baselines.bodyFont ? 1 : 0,
          bold: block.is_bold ? 1 : 0,
          italic: block.is_italic ? 1 : 0,
          lines: block.line_count || 1,
          chars: block.char_count,
          gap: this.round(gapAbove / bodySize),
          indent: this.round((block.x - baselines.bodyMarginX) / pageWidth),
          fill: this.round(Math.min(1, block.width / (baselines.bodyWidth || block.width || 1))),
          caps: this.isAllCaps(block.text) ? 1 : 0,
          repeat: this.round(repeats.get(block.id) ?? 0),
          guess: block.category_id,
          text: this.truncate(block.text),
        });

        const label = labels.get(block.id);
        if (label !== undefined) {
          pageLabels[i] = label;
          human.push(i);
        } else {
          // Blocks the classifier assigned still need a target, otherwise the
          // model only ever sees the corrected minority and learns a badly
          // skewed prior. They are marked as non-human so their weight can be
          // lowered at training time.
          pageLabels[i] = block.category_id;
        }
      });

      records.push({
        book: bookId,
        page: pageNum,
        pages: totalPages,
        pageWidth: Math.round(pageWidth),
        pageHeight: Math.round(pageHeight),
        bodySize: this.round(bodySize),
        bodyFont: baselines.bodyFont,
        indentStyle: this.round(indentStyle),
        blocks: blockRecords,
        labels: pageLabels,
        human,
      });
    }

    return records;
  }

  /**
   * How often each block's text recurs at the same vertical position across
   * pages. This is the signal that identifies running heads and feet, and it
   * cannot be computed from a single page — which is why it is precomputed
   * here and passed to the model rather than left for it to rediscover.
   */
  private computeRepeatRates(
    blocks: TextBlock[],
    pageDimensions: PageDimension[],
  ): Map<string, number> {
    const pageCount = Math.max(1, new Set(blocks.map(b => b.page)).size);
    const buckets = new Map<string, Set<number>>();
    const keyOf = (block: TextBlock) => {
      const height = pageDimensions[block.page]?.height || 792;
      const band = Math.round((block.y / height) * 20);   // 5% vertical bands
      const norm = block.text
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return `${band}|${norm}`;
    };

    for (const block of blocks) {
      const key = keyOf(block);
      if (!buckets.has(key)) buckets.set(key, new Set());
      buckets.get(key)!.add(block.page);
    }

    const rates = new Map<string, number>();
    for (const block of blocks) {
      rates.set(block.id, (buckets.get(keyOf(block))?.size ?? 1) / pageCount);
    }
    return rates;
  }

  /**
   * Fraction of this book's likely paragraph starts that are indented, so a
   * model can tell an indent-marked book from a gap-marked one before it looks
   * at any individual line.
   */
  private computeIndentStyle(blocks: TextBlock[], bodyMarginX: number): number {
    const candidates = blocks.filter(b => b.char_count > 80);
    if (candidates.length === 0) return 0;
    const indented = candidates.filter(b => b.x - bodyMarginX > 2).length;
    return indented / candidates.length;
  }

  private isAllCaps(text: string): boolean {
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (letters.length < 3) return false;
    return letters.replace(/[^A-Z]/g, '').length > letters.length * 0.8;
  }

  private truncate(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length <= TEXT_LIMIT ? clean : `${clean.slice(0, TEXT_LIMIT)}…`;
  }

  private round(value: number): number {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
  }
}
