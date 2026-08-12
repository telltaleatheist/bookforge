/**
 * Opening a book FOR THE VIEWER.
 *
 * The renderer cannot open an EPUB: the bytes are served by `quire://` on a
 * session the main process owns, the fragmenter runs in a window the main
 * process owns, and the stamping walk is `epub-processor`'s. So this file does
 * the whole opening and hands the renderer two things — the book as a
 * {@link LaidOutBook}, and one mount per spine document, which is everything the
 * `epub-viewer` component needs to SHOW it.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * It is not the analysis path. `pdf-analyzer.ts` keeps that, and Phase A of the
 * quire plan is what moves the EPUB half of it onto quire — cache keys,
 * provenance records, warning plumbing and all. This bridge exists so the viewer
 * can be built and driven against a real book before that lands, and it takes
 * the SAME two walks the rest of the app takes (`enumerateNarrationElements` for
 * identity, `markupCategoriesForUnits` for categories) rather than inventing a
 * third description of a book.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { ipcMain } from 'electron';
import { Quire, type QuireDocument } from '../packages/quire/src';
import type { QuirePageMount, QuireReport } from '../packages/quire/src/types';
import {
  enumerateNarrationElements, stampSpineDocuments, verifyStampedSources,
} from './quire-stamp';
import {
  blockId, spineDocumentHashes, stampedSpineFromWalk,
} from './epub-quire-analysis';
import {
  markupCategoriesForUnits, readEpubTocTargets, type MarkupUnit,
} from './epub-processor';
import {
  bookCacheKey, loadCachedPageMap, pageMapPath, saveCachedPageMap, staleDocuments,
  type QuirePageMap,
} from './quire-page-map';
import type { LaidOutBlock, LaidOutBook } from '../shared/document/laid-out-book';

/** The page box a book is laid out into. The viewer scales it; it never reflows. */
export interface QuireViewerGeometry {
  width: number;
  height: number;
  fontSize: number;
}

/** Everything the renderer needs, in one answer. */
export interface QuireViewerOpening {
  /** Handle for closing it again. */
  handle: string;
  book: LaidOutBook;
  source: {
    partition: string;
    documents: QuirePageMount[];
    pageWidth: number;
    pageHeight: number;
    /** Root font size the book was laid out at — the flow presentation must set the same one. */
    fontSize: number;
  };
  /** Facts worth showing in a harness and worth logging in the app. */
  stats: {
    documents: number;
    pages: number;
    blocks: number;
    stampedElements: number;
    unplaced: number;
    overflows: number;
    layoutMs: number;
    stampMs: number;
    totalMs: number;
    strategy: string;
  };
}

const DEFAULT_GEOMETRY: QuireViewerGeometry = { width: 600, height: 900, fontSize: 18 };

const open = new Map<string, {
  doc: QuireDocument;
  /** The book this document reads — the working copy itself, not a copy of it. */
  bookPath: string;
  /** Where this book's page map lives. Stable across every edit to the book. */
  cacheKey: string;
  /** The box it was laid out into — part of the page map's name, so it is kept. */
  geometry: QuireViewerGeometry;
  /**
   * Per spine document, the hash of the BOOK BYTES the open document is
   * currently laid out from.
   *
   * Held rather than re-read because it is what the next saved map has to
   * record: a relayout replaces the entries it relaid and leaves the rest, so
   * the map that lands after an edit says exactly which bytes each of its
   * documents was measured from — including the ones nobody touched.
   */
  hashes: Map<string, string>;
}>();

/**
 * Open `epubPath` and describe it.
 *
 * Every step names what it could not do rather than carrying on with less: a
 * stamp that did not survive, an element with no page, a block with no category.
 */
export async function openBookForViewer(
  epubPath: string,
  geometry: QuireViewerGeometry = DEFAULT_GEOMETRY,
): Promise<QuireViewerOpening> {
  const startedAt = Date.now();
  if (!fs.existsSync(epubPath)) {
    throw new Error(`There is no book at ${epubPath}, so there is nothing to show.`);
  }

  // The categories, the element list and the STAMPS all come off the SAME walk
  // — one enumeration, which is the rule the whole quire identity story rests
  // on, and one parse of the book, which is what makes opening it affordable.
  const stampStartedAt = Date.now();
  const walked = await enumerateNarrationElements(epubPath, path.basename(epubPath));
  const units: MarkupUnit[] = [];
  const imageKeys = new Set<string>();
  const seqByKey = new Map<string, number>();
  const stampedElements: Array<{ key: string; kind: 'text' | 'image' }> = [];
  for (const doc of walked) {
    for (const entry of doc.entries) {
      seqByKey.set(entry.key, seqByKey.size);
      stampedElements.push({ key: entry.key, kind: entry.kind });
      if (entry.unit) units.push(entry.unit);
      else imageKeys.add(entry.key);
    }
  }
  // The book's navigation goes in with the units because a chapter opening is
  // part of what the markup says. Reading the units without it would give this
  // bridge a book in which no chapter is a `chapter` — the same elements the
  // analysis path calls chapters, called headings here — and the two would
  // disagree about the book they are both showing.
  const { categoryByKey: categoriesByKey } =
    markupCategoriesForUnits(units, await readEpubTocTargets(epubPath));

  // Stamped AFTER the categories are read, because stamping writes onto the very
  // elements the walk returned and there is no reason for the markup classifier
  // to see an attribute it has no rule for. The stamped documents never reach
  // the disk: quire is opened on the BOOK — its pictures, stylesheets and fonts
  // are read straight out of the working copy — and takes the stamped markup as
  // `sources`. There is no stamped copy any more.
  const spine = await stampedSpineFromWalk(epubPath, walked);
  const sources = new Map<string, Buffer>();
  const hashes = new Map<string, string>();
  for (const [entry, document] of spine) {
    sources.set(entry, document.stamped);
    hashes.set(entry, document.hash);
  }
  const stampMs = Date.now() - stampStartedAt;
  console.log(`[quire-viewer] ${path.basename(epubPath)}: walked and stamped `
    + `${spine.size} document(s) in ${stampMs} ms`);

  const cacheKey = bookCacheKey(epubPath);
  const doc = await Quire.openDocument(epubPath, { sources });
  let opening: QuireViewerOpening;
  try {
    // ── The layout: as much of the cached page map as still describes the book ─
    // The SAME cache the analysis path reads and writes (`pageMap` in
    // epub-quire-analysis.ts): the same key, the same strategy name, the same
    // geometry in the file name. So whichever of the viewer and the analysis
    // reaches a book first pays for the layout and the other reads it back. One
    // map under both halves is also what retired the "analyzed as X but opens as
    // Y" disagreement this function used to police by re-paginating every open.
    //
    // The map is no longer all-or-nothing. It records what each spine document
    // was laid out FROM, so an edit costs the documents it touched: everything
    // else keeps its pages. That is the difference between renaming a chapter
    // and re-paginating a book.
    //
    // A map that will not LOAD — wrong strategy, wrong geometry, not the shape
    // of a map — is retired here by name. A map that loads but cannot be stood
    // up against this book is `standUpFromMap`'s to report, and the layout that
    // follows replaces it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const service = require('./quire-service') as typeof import('./quire-service');
    let report: QuireReport | null = null;
    let cachedMap: QuirePageMap | null = null;
    try {
      cachedMap = await loadCachedPageMap(cacheKey, doc.strategyName, geometry);
    } catch (err) {
      await discardUnusablePageMap(cacheKey, doc.strategyName, geometry, (err as Error).message);
    }
    if (cachedMap !== null) {
      const stale = staleDocuments(cachedMap, hashes);
      const hydrated = await service.standUpFromMap(
        doc, { map: cachedMap, stale }, geometry, epubPath);
      if (hydrated !== null) {
        const hydratedMs = Math.round(hydrated.layoutMs);
        // Only reachable once the map's documents ARE this book's spine —
        // hydration compares the two and refuses otherwise — so every stale
        // entry is one this walk stamped.
        for (const entry of stale) {
          const stamped = sources.get(entry);
          if (stamped === undefined) {
            throw new Error(
              `${path.basename(epubPath)}: ${entry} was laid out from the cached map and has since `
              + 'been edited, but the walk of this book stamped no document by that name.',
            );
          }
          await doc.relayoutDocument(entry, stamped.toString('utf8'));
        }
        report = doc.getReport();
        console.log(
          `[quire-viewer] ${path.basename(epubPath)}: stood up from the cached page map in `
          + `${hydratedMs} ms`
          + (stale.length === 0
            ? ' — nothing had changed'
            : `, then laid out ${stale.length} edited document(s) in `
              + `${Math.round(report.layoutMs)} ms: ${stale.join(', ')}`),
        );
        if (stale.length > 0) {
          await saveCachedPageMap(cacheKey, service.pageMapOfDocument(doc, geometry, hashes));
        }
      }
    }
    if (report === null) {
      report = await doc.layout(geometry);
      // Saved through the same writer the analysis path uses
      // (`saveCachedPageMap` of `pageMapOfDocument`), so `epub-quire-analysis`
      // finds this layout instead of paginating the same book a second time.
      await saveCachedPageMap(cacheKey, service.pageMapOfDocument(doc, geometry, hashes));
    }
    if (report.unplaced.length > 0) {
      const names = report.unplaced.slice(0, 5).map((u) => `${u.id} (${u.tag}, ${u.display})`);
      throw new Error(
        `${report.unplaced.length} of ${stampedElements.length} elements of `
        + `${path.basename(epubPath)} got no page — e.g. ${names.join('; ')}. The viewer can show `
        + 'them but could never point at them, so the book is not opened.',
      );
    }
    const pageCount = doc.countPages();

    // One block per page FRAGMENT — the same shape the analysis emits, with the
    // same id derivation, so the harness drives the viewer with exactly the
    // book the app will hand it. An element that spans a page break yields one
    // block per page it touches, all sharing its element key; folding them into
    // one block was this bridge's original shape, and it is precisely how the
    // split-element refusal bug got past the harness while the real app hit it.
    const byKey = new Map<string, Map<number, { text: string[]; isImage: boolean }>>();
    for (let page = 0; page < pageCount; page++) {
      for (const block of doc.loadPage(page).getBlocks()) {
        let pages = byKey.get(block.id);
        if (!pages) { pages = new Map(); byKey.set(block.id, pages); }
        const fragment = pages.get(page);
        if (fragment) {
          if (block.text) fragment.text.push(block.text);
          continue;
        }
        pages.set(page, {
          text: block.text ? [block.text] : [],
          isImage: block.type === 'image',
        });
      }
    }

    const blocks: LaidOutBlock[] = [];
    for (const stamped of stampedElements) {
      const fragments = byKey.get(stamped.key);
      if (!fragments) {
        throw new Error(
          `${stamped.key} was stamped on the book but quire reported no block for it, so the `
          + 'viewer would show an element it cannot name. This is a bug in the stamp/pagination '
          + 'agreement, not a book problem.',
        );
      }
      const category = stamped.kind === 'image' || imageKeys.has(stamped.key)
        ? 'image'
        : categoriesByKey.get(stamped.key);
      if (category === undefined) {
        throw new Error(
          `${stamped.key} is a text unit with no markup category. The unit walk and the stamp `
          + 'walk have gone out of step.',
        );
      }
      for (const page of [...fragments.keys()].sort((a, b) => a - b)) {
        const fragment = fragments.get(page)!;
        blocks.push({
          id: blockId(stamped.key, page),
          page,
          text: fragment.text.join(' '),
          category_id: category,
          is_image: fragment.isImage,
          // Reading order IS the enumeration order here — the order the export
          // writer walks the book in. Not inferred from geometry.
          seq: seqByKey.get(stamped.key),
          // The block IS the element, so its narration key is its own key —
          // shared by every fragment of a split element, by design.
          bf_element: stamped.key,
        });
      }
    }

    const documents: QuirePageMount[] = report.documentPageOffsets.map(
      (firstPage) => doc.getPageMount(firstPage));
    if (documents.length === 0) {
      throw new Error(`${path.basename(epubPath)} paginated into no documents at all.`);
    }
    const partition = `quire-${new URL(documents[0].url).host}`;

    const book: LaidOutBook = {
      blocks,
      pages: Array.from({ length: pageCount }, (_, index) => ({
        index, width: geometry.width, height: geometry.height,
      })),
      // The book's own markup said what these are — the same reading
      // `readEpubMarkupCategories` performs, off the same units.
      categoryProvenance: 'markup',
    };

    const handle = crypto.randomBytes(8).toString('hex');
    open.set(handle, { doc, bookPath: epubPath, cacheKey, geometry, hashes });
    opening = {
      handle,
      book,
      source: {
        partition,
        documents,
        pageWidth: geometry.width,
        pageHeight: geometry.height,
        fontSize: geometry.fontSize,
      },
      stats: {
        documents: report.documents.length,
        pages: pageCount,
        blocks: blocks.length,
        stampedElements: stampedElements.length,
        unplaced: report.unplaced.length,
        overflows: report.overflows.length,
        layoutMs: Math.round(report.layoutMs),
        stampMs,
        totalMs: Date.now() - startedAt,
        strategy: doc.strategyName,
      },
    };
  } catch (err) {
    await doc.close();
    throw err;
  }
  return opening;
}

/**
 * Retire a cached page map that would not LOAD — one that is not the shape of a
 * map, or that was made by another paginator or at another page box.
 *
 * Such a map is a leftover of a build that wrote something this one cannot read,
 * and no future run of THIS build will ever produce it, so no future run should
 * read it. (Measured 2026-08-09: a v2-named map paginated without the v2 margin
 * said 183 pages against a live 235, and nothing would ever have retired it.)
 *
 * A map that loads and then cannot be stood up against the book is NOT this
 * function's business — `standUpFromMap` reports it and the layout that follows
 * overwrites it, so there is never a moment when the book has no map.
 *
 * The analysis payloads this used to delete alongside are not here any more.
 * They are keyed by the book's CONTENT (`PDFAnalyzer.analysisCacheKey`) and a
 * page map is keyed by which book it IS, so the two no longer share a directory
 * — deliberately, since that is exactly what stopped an edited book from finding
 * its own map. What still guards an analysis payload built from a bad layout is
 * `QUIRE_ANALYSIS_VERSION`, which must be bumped by any change to the layout
 * and which is in every payload's and every map's file name.
 */
async function discardUnusablePageMap(
  cacheKey: string,
  strategyName: string,
  geometry: QuireViewerGeometry,
  why: string,
): Promise<void> {
  const mapAt = pageMapPath(cacheKey, strategyName, geometry);
  console.warn(
    `[quire-viewer] the cached page map at ${mapAt} is a MISS: ${why} — a leftover of a build `
    + 'that paginated differently. Deleting it, so the book is laid out for real.',
  );
  await fsPromises.rm(mapAt, { force: true });
}

// ── Relaying an edited book out again, without re-opening it ────────────────

/** What the window is owed after an edit to a book it already has open. */
export interface QuireRelayoutResult {
  /**
   * Where this book's page map lives. The SAME value it had before the edit —
   * a book being edited is one book — and reported because the window logs it.
   */
  cacheKey: string;
  /** Spine documents that were measured again, in the order they were done. */
  relaid: string[];
  /**
   * Rewritten entries that are NOT in the spine — a navigation document, an NCX.
   * They have no pages, so nothing was measured for them, and since the stamps
   * no longer live in a copy of the book there is nothing to re-derive for them
   * either. Reported so the caller can see its whole edit accounted for.
   */
  restampedOnly: string[];
  /** One mount per spine document, re-derived from the relaid layout. */
  documents: QuirePageMount[];
  pageCount: number;
  /**
   * One entry per page, all the same box — quire lays every page into one.
   * Stated here rather than rebuilt by the window, so the analysis path and this
   * one describe a page the same way (`pageDimensionsOf` in
   * `electron/epub-quire-analysis.ts`).
   */
  pageDimensions: Array<{ width: number; height: number; originX: number; originY: number }>;
  /** Pages the book gained (or, negative, lost) across this relayout. */
  pageDelta: number;
  relayoutMs: number;
  totalMs: number;
}

/**
 * Lay the documents an edit rewrote out again, in the book that is already open.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * Renaming a chapter rewrites the book (`electron/book-chapters.ts`): every
 * table of contents it carries, the chapter document's `<head><title>`, and —
 * through the naming pass — the heading the chapter opens with. Before this
 * existed, the window's only way to agree with the file again was to close the
 * document and open it, which re-stamped the whole book, paginated every spine
 * document a second time and threw the reader back to page 1 for the sake of a
 * dozen changed characters. Owen, 2026-08-10: "every time i change chapter name,
 * it reloads the whole book."
 *
 * A rename touches ONE spine document's markup. `QuireDocument.relayoutDocument`
 * measures exactly that one, with the same shell, the same layout CSS and the
 * same verification a full layout runs, and re-numbers the book around it. This
 * function is the disk half of that: it re-stamps those documents, keeps the
 * page-map cache in step, and hands back what the window has to redraw.
 *
 * ── The two things that have to end up agreeing ───────────────────────────
 *
 *  1. THE BOOK — `bookPath`, the working copy, already rewritten by the caller.
 *     This function does not write it and never edits it. Its rewritten
 *     documents are stamped again (`stampSpineDocuments`, the same walk and the
 *     same keys, narrowed to those documents) and handed to quire, which is
 *     sound because an element's key is `<entry>#<index within that entry>`:
 *     what one document's elements are called does not depend on any other.
 *  2. THE PAGE MAP — rewritten in place, under the key this book has always had,
 *     with the edited documents' new content hashes and everything else's
 *     unchanged. So the next open of this book stands straight up from it.
 *
 * There used to be a third: a stamped COPY of the whole book in the cache,
 * re-composed on every edit because it was named after the book's bytes. It is
 * gone. Twenty-five megabytes were rewritten to alter eighty-four kilobytes, and
 * the only thing it bought was somewhere for quire to read stamps from — which
 * `Quire.openDocument(book, { sources })` now does without the copy.
 *
 * ── Partial failure is named, not hidden ──────────────────────────────────
 *
 * Each `relayoutDocument` is atomic in itself. When several entries are relaid
 * and a later one refuses, the earlier ones have landed, and this says so in the
 * refusal rather than pretending the book was untouched: the document on screen
 * is coherent and usable, it simply is not the whole of the file any more, and
 * re-opening the book is what ends that.
 */
export async function relayoutBookEntries(
  handle: string,
  bookPath: string,
  entries: readonly string[],
): Promise<QuireRelayoutResult> {
  const startedAt = Date.now();
  const held = open.get(handle);
  if (!held) {
    throw new Error(
      `There is no book open under handle ${handle}, so there is nothing to lay out again. The `
      + 'window and the main process disagree about which books are open.',
    );
  }
  if (!fs.existsSync(bookPath)) {
    throw new Error(`There is no book at ${bookPath}, so its new bytes cannot be read.`);
  }
  if (entries.length === 0) {
    throw new Error(
      `${path.basename(bookPath)} was reported as edited but no entry was named, so there is `
      + 'nothing to lay out again. A caller that cannot say what it rewrote cannot ask for this.',
    );
  }

  const { doc, cacheKey, geometry, hashes } = held;
  // Compared through `bookCacheKey`, which is where "the same book by a
  // differently-spelled path" is already decided — one normalization, so this
  // cannot refuse a path the cache would have accepted.
  if (bookCacheKey(bookPath) !== cacheKey) {
    throw new Error(
      `Handle ${handle} holds ${held.bookPath}, but a relayout was asked for ${bookPath}. A `
      + 'document lays out the book it was opened on and no other.',
    );
  }
  const spine = new Set(doc.spine);
  const relaidEntries = entries.filter((e) => spine.has(e));
  const restampedOnly = entries.filter((e) => !spine.has(e));

  // ── The rewritten documents, stamped ────────────────────────────────────
  // The same stamp over fewer documents, verified exactly as the whole-book
  // stamp is. Nothing is written: these bytes go to quire and to nowhere else.
  const restamped = relaidEntries.length === 0
    ? { documents: new Map<string, Buffer>(), stamped: [] }
    : await stampSpineDocuments(bookPath, relaidEntries, path.basename(bookPath));
  if (restamped.stamped.length > 0) {
    await verifyStampedSources(
      restamped.documents, restamped.stamped, path.basename(bookPath));
  }

  // ── The layout ──────────────────────────────────────────────────────────
  const relayoutStartedAt = Date.now();
  const pagesBefore = doc.countPages();
  const relaid: string[] = [];
  for (const entry of relaidEntries) {
    const bytes = restamped.documents.get(entry);
    if (bytes === undefined) {
      throw new Error(
        `${path.basename(bookPath)}: ${entry} is in the spine but the stamper produced no bytes `
        + 'for it, so there is nothing to lay it out from.'
        + partialSentence(relaid, bookPath),
      );
    }
    try {
      await doc.relayoutDocument(entry, bytes.toString('utf8'));
    } catch (err) {
      throw new Error(`${(err as Error).message}${partialSentence(relaid, bookPath)}`);
    }
    relaid.push(entry);
  }
  const relayoutMs = Date.now() - relayoutStartedAt;

  // ── The page map, in place, under the key this book has always had ──────
  // The relaid documents get the hashes of the bytes the book now holds for
  // them; every other document keeps the hash it was laid out under. That is
  // what makes the saved map say, per document, exactly which bytes it
  // describes — so the next open of this book stands straight up from it and
  // measures nothing.
  for (const [entry, hash] of await spineDocumentHashes(bookPath, relaid)) {
    hashes.set(entry, hash);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const service = require('./quire-service') as typeof import('./quire-service');
  await saveCachedPageMap(cacheKey, service.pageMapOfDocument(doc, geometry, hashes));

  const report = doc.getReport();
  const pageCount = doc.countPages();
  return {
    cacheKey,
    relaid,
    restampedOnly,
    documents: report.documentPageOffsets.map((firstPage) => doc.getPageMount(firstPage)),
    pageCount,
    pageDimensions: Array.from({ length: pageCount }, () => ({
      width: geometry.width, height: geometry.height, originX: 0, originY: 0,
    })),
    pageDelta: pageCount - pagesBefore,
    relayoutMs,
    totalMs: Date.now() - startedAt,
  };
}

/** The half-done state, said out loud, for a refusal that arrives after one landed. */
function partialSentence(relaid: readonly string[], bookPath: string): string {
  if (relaid.length === 0) return '';
  return (
    ` ${relaid.length} document(s) of ${path.basename(bookPath)} — ${relaid.join(', ')} — were `
    + 'already laid out again before this refusal, so the book on screen is part way between the '
    + 'file it was opened from and the file on disk. Close and re-open it.'
  );
}

export async function closeBookForViewer(handle: string): Promise<void> {
  const entry = open.get(handle);
  if (!entry) return;
  open.delete(handle);
  await entry.doc.close();
}

export async function closeAllBooksForViewer(): Promise<void> {
  for (const handle of [...open.keys()]) await closeBookForViewer(handle);
}

let wired = false;

/** Wire the two channels. Idempotent, like the app's other IPC setups. */
export function setupQuireViewerIpc(): void {
  if (wired) return;
  wired = true;

  ipcMain.handle('quire:open-book', async (_event, epubPath: string, geometry?: QuireViewerGeometry) => {
    try {
      return { success: true, data: await openBookForViewer(epubPath, geometry ?? DEFAULT_GEOMETRY) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * The book on screen caught up with the book on disk, without re-opening it.
   *
   * `entries` is what the edit REWROTE, named by the code that rewrote it —
   * never inferred here from a count or a timestamp, because "which documents
   * changed" is the whole input and a guess at it would relayout the wrong
   * chapter.
   */
  ipcMain.handle('quire:relayout-entries', async (
    _event, handle: string, bookPath: string, entries: string[]) => {
    try {
      return { success: true, data: await relayoutBookEntries(handle, bookPath, entries) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('quire:close-book', async (_event, handle: string) => {
    try {
      await closeBookForViewer(handle);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
