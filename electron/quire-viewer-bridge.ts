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
  enumerateNarrationElements, stampSpineDocuments, verifyStampedDocuments,
} from './quire-stamp';
import { blockId, bookFileHash, stampedCopyForViewer } from './epub-quire-analysis';
import {
  markupCategoriesForUnits, readEpubTocTargets, type MarkupUnit,
} from './epub-processor';
import { createEpubSink, openEpubSource } from './epub-container';
import { moveIntoPlace } from './processing-passes';
import {
  loadCachedPageMap, pageMapPath, quireCacheDir, saveCachedPageMap, stampedEpubPath,
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
  stampedPath: string;
  /** The box it was laid out into — the page map's cache key, so it is kept. */
  geometry: QuireViewerGeometry;
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

  // The book's ONE stamped copy — the same file the analysis path stamps, keyed
  // by the book's own bytes. Not a second copy of its own: two stampers meant
  // two files, and on Windows it meant that opening a book a second time while
  // the first was still open failed with EPERM, because the stamp is written by
  // rename and the open session holds the target.
  const stampStartedAt = Date.now();
  const { stampedPath, fileHash, reused } = await stampedCopyForViewer(epubPath);
  const stampMs = Date.now() - stampStartedAt;
  console.log(`[quire-viewer] ${path.basename(epubPath)}: stamp `
    + `${reused ? 'reused' : 'written'} in ${stampMs} ms`);

  // The categories and the element list come off the SAME walk — one
  // enumeration, three consumers, which is the rule the whole quire identity
  // story rests on. `stampEpubForQuire` writes exactly this list onto the copy
  // (it walks with this same function), so reading it here rather than taking
  // the stamper's return is what lets an already-stamped copy be reused.
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

  const doc = await Quire.openDocument(stampedPath);
  let opening: QuireViewerOpening;
  try {
    // ── The layout: the cached page map when it is valid, live otherwise ────
    // The SAME cache the analysis path reads and writes (`pageMap` in
    // epub-quire-analysis.ts): the same sha-derived key, the same strategy name,
    // the same geometry in the file name. A valid hit hydrates the document
    // without paginating anything; a miss paginates ONCE and saves the map, so
    // whichever of the viewer and the analysis reaches a book first pays for
    // the layout and the other reads it back. One map under both halves is also
    // what retired the "analyzed as X but opens as Y" disagreement this
    // function used to police by re-paginating on every open.
    //
    // A map that loads but fails validation — wrong strategy, wrong geometry,
    // wrong spine, internally inconsistent — is a MISS, not an error: it is
    // retired loudly together with the analysis payloads built from it, and the
    // book is laid out for real.
    let report: QuireReport | null = null;
    let cachedMap: QuirePageMap | null = null;
    try {
      cachedMap = await loadCachedPageMap(fileHash, doc.strategyName, geometry);
    } catch (err) {
      await discardPoisonedPageMap(fileHash, doc.strategyName, geometry, (err as Error).message);
    }
    if (cachedMap !== null) {
      try {
        report = await doc.hydrateFromPageMap(cachedMap, geometry);
        console.log(`[quire-viewer] ${path.basename(epubPath)}: hydrated from the cached `
          + `page map in ${Math.round(report.layoutMs)} ms`);
      } catch (err) {
        report = null;
        await discardPoisonedPageMap(fileHash, doc.strategyName, geometry, (err as Error).message);
      }
    }
    if (report === null) {
      report = await doc.layout(geometry);
      // Saved through the same writer the analysis path uses
      // (`saveCachedPageMap` of `pageMapOfDocument`), so `epub-quire-analysis`
      // finds this layout instead of paginating the same book a second time.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const service = require('./quire-service') as typeof import('./quire-service');
      await saveCachedPageMap(fileHash, service.pageMapOfDocument(doc, geometry));
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
    open.set(handle, { doc, stampedPath, geometry });
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
 * Retire a cached page map that failed to load or to validate against the book
 * being opened.
 *
 * Such a map is poison from a stale build: no future run of THIS build will
 * ever produce it, so no future run should ever read it. (Measured 2026-08-09:
 * a v2-named map paginated without the v2 margin said 183 pages against a live
 * 235, and nothing would ever have retired it.) The analysis payloads in the
 * same directory embed page-keyed blocks derived from some map, so they go
 * with it — all of them pure cache, rebuilt from the book on the next analysis.
 */
async function discardPoisonedPageMap(
  fileHash: string,
  strategyName: string,
  geometry: QuireViewerGeometry,
  why: string,
): Promise<void> {
  const mapAt = pageMapPath(fileHash, strategyName, geometry);
  console.warn(
    `[quire-viewer] the cached page map at ${mapAt} is a MISS: ${why} — a leftover of a build `
    + 'that paginated differently. Deleting it and the analysis payloads built from it, so the '
    + 'next analysis re-paginates.',
  );
  await fsPromises.rm(mapAt, { force: true });
  const dir = quireCacheDir(fileHash);
  for (const entry of await fsPromises.readdir(dir)) {
    if (/^analysis-v\d+\.json$/.test(entry)) {
      await fsPromises.rm(path.join(dir, entry), { force: true });
    }
  }
}

// ── Relaying an edited book out again, without re-opening it ────────────────

/** What the window is owed after an edit to a book it already has open. */
export interface QuireRelayoutResult {
  /** The digest the edited book is now cached under — its new analysis key. */
  fileHash: string;
  /** Spine documents that were measured again, in the order they were done. */
  relaid: string[];
  /**
   * Rewritten entries that are NOT in the spine — a navigation document, an NCX
   * — whose new bytes went into the stamped copy and which have no pages, so
   * nothing was measured for them.
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
 * function is the disk half of that: it re-derives the stamped copy, keeps the
 * page-map cache in step, and hands back what the window has to redraw.
 *
 * ── The three files that have to end up agreeing ──────────────────────────
 *
 *  1. THE BOOK — `bookPath`, the working copy, already rewritten by the caller.
 *     This function does not write it and never edits it.
 *  2. THE STAMPED COPY — keyed by the book's own bytes, so the rewrite gives it
 *     a NEW name (`stampedEpubPath(newHash)`) and the old one is left exactly as
 *     it is: it is still a truthful stamp of the book as it WAS, and the open
 *     document is still reading its images and stylesheets out of it. The new
 *     one is composed rather than re-stamped whole — the rewritten spine
 *     documents are stamped again (`stampSpineDocuments`, the same walk and the
 *     same keys, narrowed to those documents), every other spine document is
 *     carried across from the old stamped copy, and everything else comes from
 *     the book. That is sound because an element's key is
 *     `<zip entry>#<index within that entry>`: what one document's elements are
 *     called does not depend on any other document. Verified before it is used.
 *  3. THE PAGE MAP — written under the new digest, so the next full open of this
 *     book reads the map this relayout produced instead of paginating again.
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

  const { doc, stampedPath: oldStampedPath, geometry } = held;
  const spine = new Set(doc.spine);
  const relaidEntries = entries.filter((e) => spine.has(e));
  const restampedOnly = entries.filter((e) => !spine.has(e));

  // ── The new stamped copy ────────────────────────────────────────────────
  const fileHash = await bookFileHash(bookPath);
  const newStampedPath = stampedEpubPath(fileHash);
  const restamped = relaidEntries.length === 0
    ? { documents: new Map<string, Buffer>(), stamped: [] }
    : await stampSpineDocuments(bookPath, relaidEntries, path.basename(bookPath));

  if (fs.existsSync(newStampedPath)) {
    // These bytes already have a stamped copy — the same book was opened at this
    // digest before. It is keyed by the bytes, so it IS this one; writing it
    // again would only risk a rename onto a file some other session holds.
    console.log(`[quire-viewer] ${path.basename(bookPath)}: stamped copy for ${fileHash} reused`);
  } else {
    await composeStampedCopy(bookPath, oldStampedPath, spine, restamped.documents, newStampedPath);
    if (restamped.stamped.length > 0) {
      await verifyStampedDocuments(newStampedPath, restamped.stamped, path.basename(bookPath));
    }
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

  // ── The page map, under the book's new name ─────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const service = require('./quire-service') as typeof import('./quire-service');
  await saveCachedPageMap(fileHash, service.pageMapOfDocument(doc, geometry));

  held.stampedPath = newStampedPath;
  const report = doc.getReport();
  const pageCount = doc.countPages();
  return {
    fileHash,
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

/**
 * Write the stamped copy of the edited book: freshly stamped bytes for the
 * documents that changed, the previous stamped copy's bytes for every other
 * spine document, and the book's own for everything else.
 *
 * Composed rather than re-stamped whole because re-stamping is a parse of every
 * document in the book, which is the cost this whole path exists to avoid. The
 * result is the same file: stamping is per-document (see
 * `stampSpineDocuments`), and every document whose source did not change was
 * stamped from those same source bytes when the old copy was written.
 */
async function composeStampedCopy(
  bookPath: string,
  oldStampedPath: string,
  spine: ReadonlySet<string>,
  freshlyStamped: ReadonlyMap<string, Buffer>,
  outputPath: string,
): Promise<void> {
  if (!fs.existsSync(oldStampedPath)) {
    throw new Error(
      `The stamped copy this book was opened from (${oldStampedPath}) is gone, so the stamps of `
      + 'the documents the edit did NOT touch cannot be carried across. Close and re-open the book '
      + 'to stamp it again.',
    );
  }

  const staged = `${outputPath}.staging-${crypto.randomBytes(6).toString('hex')}`;
  const bookZip = await openEpubSource(bookPath);
  let stampedZip;
  try {
    stampedZip = await openEpubSource(oldStampedPath);
  } catch (err) {
    bookZip.close();
    throw err;
  }
  try {
    const carried = new Set(stampedZip.getEntries());

    const writer = await createEpubSink(staged, 'zip');
    for (const name of bookZip.getEntries()) {
      const fresh = freshlyStamped.get(name);
      let data: Buffer;
      if (fresh !== undefined) {
        data = fresh;
      } else if (spine.has(name)) {
        if (!carried.has(name)) {
          throw new Error(
            `${path.basename(bookPath)}: ${name} is a spine document the edit did not touch, and `
            + 'the stamped copy it was opened from does not contain it. The two files are not the '
            + 'same book, so no stamped copy is written.',
          );
        }
        data = await stampedZip.readEntry(name);
      } else {
        data = await bookZip.readEntry(name);
      }
      // `mimetype` is stored, never deflated — the EPUB spec requires it.
      writer.addFile(name, data, name !== 'mimetype');
    }
    await fsPromises.mkdir(path.dirname(staged), { recursive: true });
    await writer.write(staged);
  } finally {
    bookZip.close();
    stampedZip.close();
  }
  await moveIntoPlace(staged, outputPath);
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
