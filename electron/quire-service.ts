/**
 * quire, run where a browser exists.
 *
 * The main-thread half of `quire-page-map.ts`. It is deliberately tiny and
 * deliberately separate: everything in here reaches `BrowserWindow` and
 * `session` through the quire package, so importing it from a worker thread
 * would fail before a line of it ran. Nothing imports it — it is `require`d, on
 * the main thread, at the moment it is needed.
 */
import { Quire, type QuireDocument } from '../packages/quire/src';
import type { QuireAnalysisGeometry, QuirePageMap } from './quire-page-map';

/**
 * A laid-out document's whole page map, as plain data.
 *
 * Held apart from the open/measure/close above because the VIEWER holds its
 * document open across an incremental relayout and has to write the same map
 * the analysis path would have written — one description of the map, so a map
 * saved after a relayout cannot differ in shape from one saved after a full
 * pagination.
 */
export function pageMapOfDocument(
  doc: QuireDocument,
  geometry: QuireAnalysisGeometry,
): QuirePageMap {
  const report = doc.getReport();
  const pageCount = doc.countPages();
  const pages = [];
  for (let p = 0; p < pageCount; p++) pages.push(doc.loadPage(p).getBlocks());
  return {
    strategyName: doc.strategyName,
    geometry,
    pageCount,
    pages,
    documents: report.documents,
    documentPageOffsets: report.documentPageOffsets,
    unplaced: report.unplaced,
    overflows: report.overflows,
    spineWarnings: report.spineWarnings,
    layoutMs: report.layoutMs,
  };
}

/**
 * Lay a STAMPED book out and hand back its whole page map as plain data.
 *
 * The document is opened, measured and closed inside this call. Holding one open
 * would keep a BrowserWindow, a session and an in-memory partition alive for a
 * book nobody is looking at, and the map is the only thing analysis wants from
 * it — the display path (Phase B) opens its own.
 */
export async function paginateInThisProcess(
  stampedPath: string,
  geometry: QuireAnalysisGeometry,
): Promise<QuirePageMap> {
  const doc = await Quire.openDocument(stampedPath);
  try {
    await doc.layout({
      width: geometry.width, height: geometry.height, fontSize: geometry.fontSize,
    });
    return pageMapOfDocument(doc, geometry);
  } finally {
    await doc.close();
  }
}
