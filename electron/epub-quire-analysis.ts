/**
 * An EPUB's blocks, from the book's own DOM.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 *
 * mupdf rasterized an EPUB and reported blocks as bounding boxes with no link
 * back to the markup. "Which element is this block?" then had to be recovered by
 * matching the laid-out text against the source text — `alignBlocksToEpub`, a
 * thousand lines of anchors, banded Levenshtein, list-marker retries and a
 * clipped-line bridge — and every deletion bug of the last year came from that
 * matching being a guess that was sometimes wrong and never said so.
 *
 * quire paginates the real DOM, so the link is never lost: BookForge stamps each
 * element with the key it already knows it by (`electron/quire-stamp.ts`, which
 * CALLS the narration writer's own enumeration rather than describing it), and
 * quire hands that exact string back on every block. A block IS an element. The
 * matcher is not improved here, it is gone from this path — and with it the
 * whole class of "N block(s) could not be matched to the markup" warnings, which
 * are now structurally impossible for an EPUB rather than merely rare.
 *
 * ── What is still read the old way ─────────────────────────────────────────
 *
 * Everything about what an element MEANS. `readEpubElementCategories` asks the
 * same four questions in the same order `assignCategories` always asked them —
 * our reflow's stamps, vlm-convert's stamps, the publisher's own markup — using
 * the same rules and the same walk. Only the JOIN changed: it is keyed by
 * element now instead of found by geometry.
 *
 * ── No fallbacks ───────────────────────────────────────────────────────────
 *
 * An id quire reports that the element walk does not know is an error naming the
 * id, not a block with a default category. The two enumerations are the same two
 * functions called in the same order, so a disagreement means one of them moved,
 * and that has to stop the analysis rather than quietly degrade it.
 */
import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
// The ANALYZER's own block declaration, not `shared/ocr/text-block`'s. The two
// describe the same thing and the shared one is what the picker and the manifest
// use, but the analyzer's requires every flag to be stated rather than optional
// — which is the right contract for the program that PRODUCES blocks, and is
// what `PDFAnalyzer.blocks` is. Type-only, so nothing circular reaches runtime.
import type { TextBlock, PageDimension } from './pdf-analyzer';
import type { BlockCategoryProvenance } from '../shared/ocr/text-block';
import {
  readEpubElementCategories,
  type EpubElementFact,
  type EpubElementReading,
} from './epub-processor';
import { stampEpubForQuire } from './quire-stamp';
import {
  loadCachedPageMap, paginateStampedEpub, saveCachedPageMap, stampedEpubPath,
  QUIRE_ANALYSIS_GEOMETRY, type QuirePageMap,
} from './quire-page-map';

/**
 * What an EPUB analysis produces, before categories are generated.
 *
 * `stated` is block id → the category the BOOK states, which
 * `PDFAnalyzer.generateCategories` uses verbatim; blocks absent from it are
 * classified, which on this path means the pictures (whose category is their own
 * `is_image` flag) and the elements a stamped book left unstamped.
 */
export interface EpubQuireAnalysis {
  blocks: TextBlock[];
  pageCount: number;
  pageDimensions: PageDimension[];
  stated: Map<string, string>;
  categoryProvenance: BlockCategoryProvenance;
  /** One line for the console, so a run's shape is legible in the log. */
  summary: string;
}

/** A block id that is a function of what the block IS, so it survives re-analysis. */
function blockId(elementKey: string, page: number): string {
  return crypto.createHash('md5').update(`quire:${elementKey}:${page}`).digest('hex').substring(0, 12);
}

/**
 * The stamped copy of this book, made if it is not already there.
 *
 * Kept beside the analysis payload, keyed by the book's own sha, and NEVER the
 * book itself: `archive/` is immutable and `[archive].working.epub` is the sole
 * editable artifact. A stamp is an analysis detail with the lifetime of a cache
 * entry.
 */
async function stampedCopy(epubPath: string, fileHash: string): Promise<string> {
  const at = stampedEpubPath(fileHash);
  try {
    await fsPromises.access(at);
    return at;
  } catch { /* not stamped yet */ }
  await stampEpubForQuire(epubPath, at, path.basename(epubPath));
  return at;
}

/**
 * This book's stamped copy, made if it is not there, for a caller that has no
 * digest of its own.
 *
 * The analysis path already knows the book's sha256 — the analyzer computed it
 * for its own cache key and passes it down. The VIEWER does not: it is handed a
 * path by a picker that is about to show it. So the digest is computed here,
 * the same way and to the same 16 hex characters, and the SAME stamped file is
 * reached.
 *
 * One stamp per book, keyed by the book's own bytes, is the point rather than a
 * saving. Keyed by anything else — a path, a session — the same book gets two
 * stamped copies, and on Windows the second open of a book the first still has
 * open fails outright: `stampEpubForQuire` writes a temp file and renames it
 * over the target, and a rename over a file another quire session holds is
 * EPERM. Reusing the existing stamp never writes it twice, so that cannot
 * happen (measured: tools/phasec-gesture-matrix.js, which opens a book twice).
 */
export async function stampedCopyForViewer(
  epubPath: string,
): Promise<{ stampedPath: string; fileHash: string; reused: boolean }> {
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(epubPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
  const fileHash = digest.substring(0, 16);
  const at = stampedEpubPath(fileHash);
  let reused = true;
  try {
    await fsPromises.access(at);
  } catch {
    reused = false;
  }
  return { stampedPath: await stampedCopy(epubPath, fileHash), fileHash, reused };
}

/** This book's page map — cached if it is there for this paginator and geometry. */
async function pageMapFor(epubPath: string, fileHash: string): Promise<QuirePageMap> {
  const stamped = await stampedCopy(epubPath, fileHash);
  const fresh = await paginateStampedEpub(stamped, QUIRE_ANALYSIS_GEOMETRY);
  // Read back through the same door a cache hit comes through, so a map that
  // would be rejected on the next open is rejected on this one.
  await saveCachedPageMap(fileHash, fresh);
  return fresh;
}

/**
 * The cached map for this book, or a fresh one.
 *
 * The cache is keyed by the paginator's own name — which carries its version —
 * so a build with a different fragmenter never reads a map it did not make. It
 * cannot be consulted before the paginator is known, and the paginator is only
 * known once a document is open; so the lookup is by the ONE strategy this app
 * analyzes with, named here, and a map made by anything else is a miss.
 */
async function pageMap(
  epubPath: string,
  fileHash: string,
  strategyName: string,
): Promise<{ map: QuirePageMap; cached: boolean }> {
  const hit = await loadCachedPageMap(fileHash, strategyName, QUIRE_ANALYSIS_GEOMETRY);
  if (hit) return { map: hit, cached: true };
  return { map: await pageMapFor(epubPath, fileHash), cached: false };
}

/**
 * The paginator this build analyzes with, by name — the cache key, known without
 * opening a book.
 *
 * `PagedStrategy.name` is this string; it is rebuilt here from the same constant
 * rather than read off an instance because the cache has to be consulted BEFORE
 * a document exists, and in the worker thread, where no document can. The
 * strategy module itself is safe to load anywhere: it imports `fs`, `path` and
 * types, and nothing from Electron.
 */
function analysisStrategyName(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PAGEDJS_VERSION } = require('../packages/quire/src/paginate/paged') as {
    PAGEDJS_VERSION: string;
  };
  return `pagedjs-${PAGEDJS_VERSION}`;
}

/**
 * Just the pages: how many, and how big.
 *
 * What `analyzeQuick` needs and all it needs. For an EPUB the page COUNT is the
 * pagination — there is no cheaper way to know it — so the first open of a book
 * pays for the layout, and every later one reads the map back off disk. The
 * blocks are then a lookup rather than a second pagination.
 */
export async function epubPageGeometryWithQuire(
  epubPath: string,
  sourceSha256: string,
): Promise<{ pageCount: number; pageDimensions: PageDimension[] }> {
  const { map } = await pageMap(epubPath, sourceSha256.substring(0, 16), analysisStrategyName());
  return { pageCount: map.pageCount, pageDimensions: pageDimensionsOf(map) };
}

/** One entry per page, all the same size: quire lays every page into one box. */
function pageDimensionsOf(map: QuirePageMap): PageDimension[] {
  return Array.from({ length: map.pageCount }, () => ({
    width: map.geometry.width,
    height: map.geometry.height,
    originX: 0,
    originY: 0,
  }));
}

/**
 * Lay an EPUB out with quire and turn its pages into the blocks the picker edits.
 *
 * `sourceSha256` is the digest the analyzer already computed for its own cache
 * key; it is passed in rather than recomputed so that one file has one identity
 * across the whole analysis.
 */
export async function analyzeEpubWithQuire(
  epubPath: string,
  sourceSha256: string,
  onProgress: (phase: string, message: string) => void = () => {},
): Promise<EpubQuireAnalysis> {
  const fileHash = sourceSha256.substring(0, 16);
  const book = path.basename(epubPath);

  onProgress('extracting', 'Laying the book out…');
  const { map, cached } = await pageMap(epubPath, fileHash, analysisStrategyName());

  onProgress('processing', `Reading the markup of ${map.documents.length} document(s)…`);
  const reading = await readEpubElementCategories(epubPath);

  const factByKey = new Map<string, EpubElementFact>();
  for (const element of reading.elements) factByKey.set(element.key, element);

  const blocks: TextBlock[] = [];
  const stated = new Map<string, string>();
  // Reading order for `seq`: the enumeration order of the walk (per document,
  // text units then pictures), and within one element the pages it runs across.
  // Numbered over the blocks actually EMITTED, because two blocks claiming one
  // place in the order is an error rather than a tiebreak.
  const seqOfElement = new Map<string, number>();
  reading.elements.forEach((element, at) => seqOfElement.set(element.key, at));

  let stampedBlocks = 0;
  let unstampedElementBlocks = 0;
  let imageBlocks = 0;
  let splitFragments = 0;
  const placed = new Set<string>();

  for (let page = 0; page < map.pageCount; page++) {
    for (const quireBlock of map.pages[page]) {
      const fact = factByKey.get(quireBlock.id);
      if (fact === undefined) {
        throw new Error(
          `${book}: quire reported a block stamped "${quireBlock.id}" on page ${page}, and the `
          + 'element walk knows no element by that key. The stamper and the walk call the same two '
          + 'enumerations in the same order, so this means one of them has moved — '
          + 'electron/quire-stamp.ts and walkEpubElements in electron/epub-processor.ts. Nothing '
          + 'may be analyzed from a book whose identity the two halves disagree about.',
        );
      }
      placed.add(quireBlock.id);

      // An element that holds a picture and no words of its own is enumerated in
      // BOTH namespaces — the wrapper and the picture inside it, and a bare
      // <img> under <body> is both at once. The PICTURE gets the block, so one
      // plate is one rectangle. See EpubElementFact.imageOnly.
      if (fact.kind === 'text' && fact.imageOnly) continue;

      const isImage = quireBlock.type === 'image';
      const text = isImage
        ? `[Image ${Math.round(quireBlock.bbox.w)}x${Math.round(quireBlock.bbox.h)}]`
        : (quireBlock.text ?? '');
      if (!isImage && text.trim().length === 0) {
        // A fragment of a split element that carries none of its words — the
        // continuation of a paragraph whose text ended exactly at the break.
        // quire reports the element as present on that page, which is true, but
        // there is no block to edit there.
        continue;
      }
      if (quireBlock.splitFrom !== null) splitFragments++;
      if (isImage) imageBlocks++;

      const font = quireBlock.font;
      if (!isImage && font === null) {
        throw new Error(
          `${book}: quire reported the text block stamped "${quireBlock.id}" on page ${page} with `
          + 'no computed type. A text block\'s font size is a fact of the layout and this app does '
          + 'not invent one.',
        );
      }

      const id = blockId(quireBlock.id, page);
      const block: TextBlock = {
        id,
        page,
        x: quireBlock.bbox.x,
        y: quireBlock.bbox.y,
        width: quireBlock.bbox.w,
        height: quireBlock.bbox.h,
        text,
        // A picture is set in no type at all, which is what mupdf's image blocks
        // said too (`font_size: 0, font_name: 'image'`).
        font_size: font === null ? 0 : font.size,
        font_name: font === null ? 'image' : font.family,
        char_count: text.length,
        // An EPUB has no page furniture. mupdf reflowed it onto pages of its own
        // invention and this analyzer then read `header`/`footer` off where a
        // block happened to land — which is how ordinary prose came back
        // `footer` on Killing America. There is no running head and no folio in
        // a book with no paper, so every block is body: `generateCategories`
        // already skips every position rule for a reflow, and this stops the
        // one remaining reader of `region` from being told a fiction.
        region: 'body',
        category_id: '',
        seq: seqOfElement.get(quireBlock.id),
        is_bold: font !== null && font.weight >= 600,
        is_italic: font !== null && font.style !== 'normal',
        is_superscript: false,
        is_image: isImage,
        // No marker blocks on this path. mupdf split them out of its own SPAN
        // analysis, which a DOM paginator does not do — and a marker is inside
        // the paragraph element, so it was never separately strikeable anyway
        // (the export strips `<sup>` markers by rule).
        is_footnote_marker: false,
        // Measured by quire from the client rects of a Range over the fragment,
        // and load-bearing rather than decorative: the picker auto-segments a
        // freshly-ingested EPUB by merging blocks it reads as SINGLE LINES
        // (`(b.line_count ?? 1) <= 1` in category-learner.ts), which exists to
        // undo mupdf's one-block-per-visual-line fragmentation. A block that is
        // already a whole paragraph must say how many lines it set, or the
        // merger would run adjacent paragraphs together.
        line_count: quireBlock.lines,
        bf_element: quireBlock.id,
      };

      const provenance = reading.provenanceByElement.get(quireBlock.id);
      if (provenance !== undefined) {
        block.bf_group = provenance.group;
        block.bf_blocks = provenance.sourceBlockIds;
      }
      const conversion = reading.conversionByElement.get(quireBlock.id);
      if (conversion !== undefined) {
        block.bf_cat = conversion.statedCategory;
        block.bf_source_page = conversion.sourcePage;
      }

      const category = reading.categoryByElement.get(quireBlock.id);
      if (category !== undefined) {
        stated.set(id, category);
        stampedBlocks++;
      } else if (!isImage) {
        // A text element of a STAMPED book that carries no stamp — the nav TOC,
        // hand-added markup. Its category is the classifier's, exactly as on the
        // old path, and it is counted so that cannot happen invisibly.
        unstampedElementBlocks++;
      }

      blocks.push(block);
    }
  }

  // `seq` is a total order over the BLOCKS, not over the elements: two fragments
  // of one paragraph would otherwise claim one place, and `mergeRefusal`
  // (shared/document/block-merge.ts) treats that as an error rather than a
  // tiebreak. It also refuses a merge whose members have a GAP in `seq`, so the
  // order has to run page by page: page first, then the walk's own enumeration
  // index, which makes one page's blocks a contiguous run of `seq` by
  // construction. Within a page that index is document order, which is flow
  // order — with a document's pictures after its text, because that is what the
  // enumeration says and nothing merges a picture.
  blocks.sort((a, b) => (a.page - b.page) || (a.seq! - b.seq!) || (a.y - b.y));
  blocks.forEach((block, at) => { block.seq = at; });

  const pageDimensions = pageDimensionsOf(map);

  const categoryProvenance: BlockCategoryProvenance = {
    source: reading.source,
    stampedBlocks,
    unstampedElementBlocks,
    // ZERO, and not as a matter of luck. A block is an element here, so there is
    // no matching to fail and nothing to leave unplaced. The field survives
    // because a PDF has no such guarantee.
    unalignedBlocks: 0,
  };

  const unplacedElements = reading.elements.length - placed.size;
  const summary =
    `[quire] ${book}: ${map.pageCount} page(s) from ${map.documents.length} document(s) in `
    + `${map.layoutMs}ms (${map.strategyName}${cached ? ', from the cached map' : ''}); `
    + `${blocks.length} block(s) from `
    + `${placed.size}/${reading.elements.length} element(s) — ${imageBlocks} picture(s), `
    + `${splitFragments} fragment(s) of split elements; categories from ${reading.source} `
    + `(${stampedBlocks} stated, ${unstampedElementBlocks} left to the classifier); `
    + `${unplacedElements} element(s) rendered nothing; ${map.overflows.length} fragment(s) `
    + 'ran past a page edge.';

  return { blocks, pageCount: map.pageCount, pageDimensions, stated, categoryProvenance, summary };
}

export type { EpubElementReading };
