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
import * as path from 'path';
// The ANALYZER's own block declaration, not `shared/ocr/text-block`'s. The two
// describe the same thing and the shared one is what the picker and the manifest
// use, but the analyzer's requires every flag to be stated rather than optional
// — which is the right contract for the program that PRODUCES blocks, and is
// what `PDFAnalyzer.blocks` is. Type-only, so nothing circular reaches runtime.
import type { TextBlock, PageDimension, OutlineItem } from './pdf-analyzer';
import type { BlockCategoryProvenance } from '../shared/ocr/text-block';
import {
  readEpubElementCategories,
  readEpubTocTargets,
  type EpubElementFact,
  type EpubElementReading,
} from './epub-processor';
import {
  enumerateNarrationElements, stampWalkedDocuments, verifyStampedSources,
} from './quire-stamp';
import { openEpubSource } from './epub-container';
import {
  bookCacheKey, loadCachedPageMap, paginateBook, saveCachedPageMap, staleDocuments,
  QUIRE_ANALYSIS_GEOMETRY, type QuirePageMap, type StampedSpine,
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

/**
 * A block id that is a function of what the block IS, so it survives
 * re-analysis. Exported because the viewer bridge derives ITS block ids the
 * same way — one derivation, two callers, so the harness's book and the app's
 * book can never disagree about what a block is called.
 */
export function blockId(elementKey: string, page: number): string {
  return crypto.createHash('md5').update(`quire:${elementKey}:${page}`).digest('hex').substring(0, 12);
}

/**
 * The book's spine documents, stamped, each beside the hash of the bytes it was
 * stamped FROM.
 *
 * There is no stamped copy on disk any more. Stamps are markup, they are a
 * deterministic function of the book, and quire will take them as `sources` —
 * so they are made here, checked here, and handed straight over. What used to
 * happen instead was that a 25.7 MB zip of the same book was written into the
 * cache so that a few hundred kilobytes of `data-quire-id` could be read back
 * out of it, and then written AGAIN, whole, every time one chapter was edited.
 *
 * The hashes are taken with {@link spineDocumentHashes}, the same function that
 * later asks whether a cached map is still fresh. One function on both sides is
 * the point: hashing the decoded markup here and the raw bytes there would put
 * every document permanently out of date.
 */
export async function stampSpineOf(epubPath: string): Promise<StampedSpine> {
  const whatFor = path.basename(epubPath);
  const walked = await enumerateNarrationElements(epubPath, whatFor);
  return stampedSpineFromWalk(epubPath, walked, whatFor);
}

/**
 * The same thing, for a caller that has ALREADY walked the book.
 *
 * The viewer walks the book for its categories before it lays anything out, and
 * a walk is a parse of every document in it. Handing that walk back rather than
 * doing a second one is the difference between opening a book once and opening
 * it twice.
 */
export async function stampedSpineFromWalk(
  epubPath: string,
  walked: Awaited<ReturnType<typeof enumerateNarrationElements>>,
  whatFor = path.basename(epubPath),
): Promise<StampedSpine> {
  const { replacements, stamped } = stampWalkedDocuments(walked, whatFor);
  // The same promise `stampEpubForQuire` keeps about the copy it writes: every
  // key survived serialization, on exactly one element, in the document it
  // belongs to. Bytes that stay in memory are not exempt from it.
  await verifyStampedSources(replacements, stamped, whatFor);

  const hashes = await spineDocumentHashes(epubPath, [...replacements.keys()]);
  const spine = new Map<string, { stamped: Buffer; hash: string }>();
  for (const [entry, markup] of replacements) {
    const hash = hashes.get(entry);
    if (hash === undefined) {
      throw new Error(
        `${whatFor}: ${entry} was walked and stamped, but the book has no entry by that name to `
        + 'hash. The walk and the container disagree about what this book contains.',
      );
    }
    spine.set(entry, { stamped: markup, hash });
  }
  return spine;
}

/**
 * sha256 of each named entry's bytes AS THE BOOK HOLDS THEM.
 *
 * The one authority for "has this document changed": used when a map is written,
 * to record what each document was laid out from, and used on every open after
 * that, to ask which of them moved. Raw bytes, so nothing about parsing,
 * encoding or serialization can make a document look edited when it is not.
 *
 * An entry the book does not have is ABSENT from the result rather than a
 * refusal. That is not leniency — the caller asking is comparing against a map
 * that may name a document the book has since lost, and "the book no longer has
 * it" is the answer it needs, not an exception.
 */
export async function spineDocumentHashes(
  bookPath: string,
  entries: readonly string[],
): Promise<Map<string, string>> {
  const source = await openEpubSource(bookPath);
  try {
    const out = new Map<string, string>();
    for (const entry of entries) {
      if (!source.hasEntry(entry)) continue;
      const bytes = await source.readEntry(entry);
      out.set(entry, crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    return out;
  } finally {
    source.close();
  }
}

/**
 * The cached map for this book, or as much of one as still holds.
 *
 * The cache is keyed by the paginator's own name — which carries its version —
 * so a build with a different fragmenter never reads a map it did not make. It
 * cannot be consulted before the paginator is known, and the paginator is only
 * known once a document is open; so the lookup is by the ONE strategy this app
 * analyzes with, named here, and a map made by anything else is a miss.
 *
 * Three outcomes, and the middle one is the whole reason this phase exists:
 *
 *  - **Nothing moved.** Every document still hashes to what the map recorded.
 *    The map IS the answer; no book is opened and no page is measured.
 *  - **Some documents moved.** The book is stamped and laid out again FROM the
 *    cached map, measuring only those documents. Renaming a chapter costs the
 *    chapter.
 *  - **No map at all.** The book is stamped and laid out in full.
 */
async function pageMap(
  epubPath: string,
  cacheKey: string,
  strategyName: string,
): Promise<{ map: QuirePageMap; cached: boolean }> {
  const hit = await loadCachedPageMap(cacheKey, strategyName, QUIRE_ANALYSIS_GEOMETRY);
  let reuse: { map: QuirePageMap; stale: string[] } | null = null;
  if (hit !== null) {
    const stale = staleDocuments(hit, await spineDocumentHashes(epubPath, hit.documents));
    if (stale.length === 0) return { map: hit, cached: true };
    console.log(
      `[quire] ${path.basename(epubPath)}: ${stale.length} of ${hit.documents.length} document(s) `
      + `have been edited since the cached page map was made — ${stale.slice(0, 3).join(', ')}`
      + `${stale.length > 3 ? `, +${stale.length - 3} more` : ''}. Laying out those and keeping `
      + 'the rest.',
    );
    reuse = { map: hit, stale };
  }
  const fresh = await paginateBook(
    epubPath, await stampSpineOf(epubPath), QUIRE_ANALYSIS_GEOMETRY, reuse);
  // Read back through the same door a cache hit comes through, so a map that
  // would be rejected on the next open is rejected on this one.
  await saveCachedPageMap(cacheKey, fresh);
  return { map: fresh, cached: false };
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
): Promise<{ pageCount: number; pageDimensions: PageDimension[] }> {
  const { map } = await pageMap(epubPath, bookCacheKey(epubPath), analysisStrategyName());
  return { pageCount: map.pageCount, pageDimensions: pageDimensionsOf(map) };
}

/**
 * The book's table of contents as outline items, with pages in QUIRE's page
 * space — the pages the picker actually shows for an EPUB.
 *
 * This replaces mupdf's `loadOutline` for EPUBs. mupdf resolved each nav target
 * against ITS OWN reflow of the book, which is a different pagination than
 * quire's under the same page numbers — so every outline page was a page of a
 * layout nothing displays. Here a target resolves to the page its document
 * STARTS on: quire lays every spine document out as its own flow, so a chapter
 * document's first page IS its chapter opening. A target with a fragment deeper
 * inside a document also lands on that document's first page — quire has no
 * anchor→page index — which is stated here rather than approximated with a
 * number from the wrong layout.
 *
 * Returned flat, in navigation order, exactly as `readEpubTocTargets` reads
 * them. A target pointing outside the spine names no pages and is skipped, the
 * same rule `markupCategoriesForUnits` applies to the same list.
 */
export async function epubOutlineFromQuire(
  epubPath: string,
): Promise<OutlineItem[]> {
  const { map } = await pageMap(epubPath, bookCacheKey(epubPath), analysisStrategyName());
  const startPageOf = new Map<string, number>();
  map.documents.forEach((entry, at) => startPageOf.set(entry, map.documentPageOffsets[at]));

  const outline: OutlineItem[] = [];
  for (const target of await readEpubTocTargets(epubPath)) {
    const entry = target.entryCandidates.find((candidate) => startPageOf.has(candidate));
    if (entry === undefined) continue; // navigation points outside the spine
    outline.push({ title: target.label, page: startPageOf.get(entry)! });
  }
  return outline;
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
 * The analyzer's own cache key is not used here. Its payload is keyed by the
 * book's CONTENT, because an analysis describes bytes and must never be read
 * back for different ones; a page map is keyed by which BOOK it is, because a
 * book being edited is one book and its map carries its own per-document
 * freshness. Two questions, two keys — see `bookCacheKey`.
 */
export async function analyzeEpubWithQuire(
  epubPath: string,
  onProgress: (phase: string, message: string) => void = () => {},
): Promise<EpubQuireAnalysis> {
  const book = path.basename(epubPath);

  onProgress('extracting', 'Laying the book out…');
  const { map, cached } = await pageMap(epubPath, bookCacheKey(epubPath), analysisStrategyName());

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
  // of one paragraph would otherwise claim one place, and the picker's merge
  // rule treated that as an error rather than a tiebreak. It also refused a
  // merge whose members had a GAP in `seq`, so the order has to run page by
  // page: page first, then the walk's own enumeration
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
