/**
 * quire, run where a browser exists.
 *
 * The main-thread half of `quire-page-map.ts`. It is deliberately tiny and
 * deliberately separate: everything in here reaches `BrowserWindow` and
 * `session` through the quire package, so importing it from a worker thread
 * would fail before a line of it ran. Nothing imports it — it is `require`d, on
 * the main thread, at the moment it is needed.
 */
import { Quire, QuireError, type QuireDocument } from '../packages/quire/src';
import type { QuireReport } from '../packages/quire/src/types';
import type {
  QuireAnalysisGeometry, QuirePageMap, QuirePageMapReuse, StampedSpine,
} from './quire-page-map';

/**
 * A laid-out document's whole page map, as plain data.
 *
 * Held apart from the open/measure/close below because the VIEWER holds its
 * document open across an incremental relayout and has to write the same map
 * the analysis path would have written — one description of the map, so a map
 * saved after a relayout cannot differ in shape from one saved after a full
 * pagination.
 *
 * `hashes` is the caller's, not quire's: the map records which BOOK BYTES each
 * document was laid out from, and quire was handed stamped markup and never saw
 * the book's own. A document with no hash is a refusal rather than an unrecorded
 * one, because a map with a gap in its freshness record would be believed fresh
 * exactly where it is least entitled to be.
 */
export function pageMapOfDocument(
  doc: QuireDocument,
  geometry: QuireAnalysisGeometry,
  hashes: ReadonlyMap<string, string>,
): QuirePageMap {
  const report = doc.getReport();
  const pageCount = doc.countPages();
  const pages = [];
  for (let p = 0; p < pageCount; p++) pages.push(doc.loadPage(p).getBlocks());
  const documentHashes = report.documents.map((entry) => {
    const hash = hashes.get(entry);
    if (hash === undefined) {
      throw new Error(
        `[quire-service] the page map for ${doc.epubPath} would record no content hash for the `
        + `spine document ${entry}, so nothing later could tell whether that document had been `
        + 'edited. The caller must hash every document it stamped.',
      );
    }
    return hash;
  });
  return {
    strategyName: doc.strategyName,
    geometry,
    pageCount,
    pages,
    documents: report.documents,
    documentHashes,
    documentPageOffsets: report.documentPageOffsets,
    unplaced: report.unplaced,
    overflows: report.overflows,
    spineWarnings: report.spineWarnings,
    layoutMs: report.layoutMs,
  };
}

/**
 * Lay a book out and hand back its whole page map as plain data.
 *
 * The document is opened, measured and closed inside this call. Holding one open
 * would keep a BrowserWindow, a session and an in-memory partition alive for a
 * book nobody is looking at, and the map is the only thing analysis wants from
 * it — the display path opens its own.
 *
 * `reuse` is a map of this same book that is stale in only some of its
 * documents. Given one, the document is stood up from it and those documents are
 * measured again; given none, the whole book is measured. The two produce the
 * same map — `relayoutDocument` runs the same shell, the same layout CSS and the
 * same measure script `layout()` does, verification included — and the saving is
 * the documents that did not move.
 *
 * A `reuse` map that does not describe this book's spine is refused by
 * `hydrateFromPageMap`, and that refusal is not caught here: a caller offering a
 * map for a different shape of book has made a mistake worth hearing about.
 */
export async function paginateInThisProcess(
  bookPath: string,
  spine: StampedSpine,
  geometry: QuireAnalysisGeometry,
  reuse: QuirePageMapReuse | null = null,
): Promise<QuirePageMap> {
  const sources = new Map<string, Buffer>();
  const hashes = new Map<string, string>();
  for (const [entry, document] of spine) {
    sources.set(entry, document.stamped);
    hashes.set(entry, document.hash);
  }

  const doc = await Quire.openDocument(bookPath, { sources });
  try {
    if (reuse === null) {
      await doc.layout({
        width: geometry.width, height: geometry.height, fontSize: geometry.fontSize,
      });
    } else if (await standUpFromMap(doc, reuse, geometry, bookPath) === null) {
      await doc.layout({
        width: geometry.width, height: geometry.height, fontSize: geometry.fontSize,
      });
    } else {
      for (const entry of reuse.stale) {
        const document = spine.get(entry);
        if (document === undefined) {
          throw new Error(
            `[quire-service] ${bookPath}: ${entry} was named as stale but is not one of the `
            + 'stamped spine documents, so there is nothing to lay it out from.',
          );
        }
        await doc.relayoutDocument(entry, document.stamped.toString('utf8'));
      }
    }
    return pageMapOfDocument(doc, geometry, hashes);
  } finally {
    await doc.close();
  }
}

/**
 * Stand `doc` up from a cached map, or say that this map cannot describe this
 * book — `true` if it was hydrated, `false` if the caller must lay the book out.
 *
 * Two things get here. One is a book that GAINED a spine document: the caller's
 * freshness check compares the map's documents against the book's bytes and can
 * only see the documents the map already names, so adding a chapter leaves a map
 * that is right about everything it mentions and silent about a new document
 * with real pages in it. The other is a map that is internally inconsistent —
 * page ranges that are not ranges of the book, a fragment whose split run leaves
 * its own document — which is the poison a build that paginated differently
 * leaves behind.
 *
 * quire refuses both under `PAGE_MAP_MISMATCH` and its contract is that a
 * refusal leaves the document exactly as it was opened, so `layout()` is still
 * available and is the honest answer to both. The map is not deleted: the layout
 * that follows overwrites it, which retires it without a window in which the
 * book has no map at all. Anything quire says that is NOT that refusal is a
 * defect in this code rather than in the cache, and is thrown.
 */
export async function standUpFromMap(
  doc: QuireDocument,
  reuse: QuirePageMapReuse,
  geometry: QuireAnalysisGeometry,
  bookPath: string,
): Promise<QuireReport | null> {
  try {
    return await doc.hydrateFromPageMap(reuse.map, {
      width: geometry.width, height: geometry.height, fontSize: geometry.fontSize,
    });
  } catch (err) {
    if (!(err instanceof QuireError) || err.code !== 'PAGE_MAP_MISMATCH') throw err;
    console.warn(
      `[quire-service] ${bookPath}: the cached page map cannot be stood up — ${err.message} `
      + 'Laying the book out in full; the map that follows replaces it.',
    );
    return null;
  }
}
