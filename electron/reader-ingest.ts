/**
 * Reader ingestion — turns a URL or a document (PDF/EPUB/TXT/HTML) into an ordered
 * list of readable text blocks for the Bookshelf "Listen to anything" surface.
 *
 * Everything here reuses extractors that already exist in BookForge; this module is
 * just the thin router that produces `{ title, blocks[] }` for the Reader stream,
 * WITHOUT creating a library project (the read is ephemeral). A "block" is a
 * paragraph / heading / list item — the same unit the extension read.
 *
 * Formats:
 *   - URL  → jsdom + Mozilla Readability (strip nav/ads) → block text
 *   - PDF  → PDFAnalyzer (mupdf), dropping header/footer regions
 *   - EPUB → EpubProcessor chapters → paragraph blocks
 *   - TXT  → blank-line split
 *   - HTML → cheerio block extraction
 */

import * as fs from 'fs/promises';

export interface IngestResult {
  title?: string;
  blocks: string[];
}

/** Normalize whitespace and drop empties from a candidate block list. */
function cleanBlocks(raw: string[]): string[] {
  const out: string[] = [];
  let prev = '';
  for (const r of raw) {
    const t = (r ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t === prev) continue; // skip empties + consecutive dupes (nested tags)
    out.push(t);
    prev = t;
  }
  return out;
}

/** Extract block text (p / h1–h6 / li / blockquote / figcaption) from an HTML string. */
async function blocksFromHtml(html: string): Promise<string[]> {
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  const blocks: string[] = [];
  $('p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption').each((_, el) => {
    // Skip a container that wraps another matched block (avoids reading li>p twice).
    if ($(el).find('p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption').length > 0) return;
    blocks.push($(el).text());
  });
  return cleanBlocks(blocks);
}

export async function ingestFromUrl(url: string): Promise<IngestResult> {
  // Extraction runs in a hidden Electron BrowserWindow (real Chromium DOM) — jsdom
  // is broken under Electron's module loader here, and the BrowserWindow path also
  // renders JS-heavy pages the way the existing web-fetch feature already does.
  const { extractArticleBlocks } = await import('./web-fetch-bridge.js');
  const { title, blocks } = await extractArticleBlocks(url);
  const clean = cleanBlocks(blocks);
  if (clean.length === 0) throw new Error('the article had no readable text');
  return { title: title || undefined, blocks: clean };
}

export async function ingestFromEpub(epubPath: string): Promise<IngestResult> {
  const { EpubProcessor } = await import('./epub-processor.js');
  const proc = new EpubProcessor();
  const structure = await proc.open(epubPath);
  const blocks: string[] = [];
  for (const chapter of structure.chapters) {
    const text = await proc.getChapterText(chapter.id);
    for (const para of text.split(/\n\s*\n/)) blocks.push(para);
  }
  return { title: structure.metadata?.title, blocks: cleanBlocks(blocks) };
}

export async function ingestFromPdf(pdfPath: string): Promise<IngestResult> {
  const { PDFAnalyzer } = await import('./pdf-analyzer.js');
  const analyzer = new PDFAnalyzer();
  await analyzer.analyzeQuick(pdfPath);
  const result = await analyzer.analyzeText(pdfPath);
  const blocks = result.blocks
    .filter((b) => b.region !== 'header' && b.region !== 'footer' && !b.is_image && b.text.trim().length > 0)
    .sort((a, b) => (a.page - b.page) || (a.y - b.y))
    .map((b) => b.text);
  if (blocks.length === 0) throw new Error('no readable text found in that PDF');
  return { blocks: cleanBlocks(blocks) };
}

export async function ingestFromText(text: string): Promise<IngestResult> {
  const blocks = cleanBlocks(text.split(/\n\s*\n/));
  if (blocks.length === 0) throw new Error('no text found');
  return { blocks };
}

/**
 * Dispatch a saved file to the right extractor by extension. `origName` is the
 * original filename (for the extension); `filePath` is where the bytes were written.
 */
export async function ingestFromFile(filePath: string, origName: string): Promise<IngestResult> {
  const ext = (origName.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'pdf': return ingestFromPdf(filePath);
    case 'epub': return ingestFromEpub(filePath);
    case 'txt': return ingestFromText(await fs.readFile(filePath, 'utf-8'));
    case 'htm':
    case 'html': return { blocks: await blocksFromHtml(await fs.readFile(filePath, 'utf-8')) };
    default:
      throw new Error(`unsupported file type ".${ext}" — try PDF, EPUB, TXT, or HTML (or paste the text)`);
  }
}
