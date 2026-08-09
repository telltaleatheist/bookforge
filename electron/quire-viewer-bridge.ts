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
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { Quire, type QuireDocument } from '../packages/quire/src';
import type { QuirePageMount } from '../packages/quire/src/types';
import { enumerateNarrationElements, stampEpubForQuire } from './quire-stamp';
import { markupCategoriesForUnits, type MarkupUnit } from './epub-processor';
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

const open = new Map<string, { doc: QuireDocument; stampedPath: string }>();

/** Where stamped copies go. Never beside the book — `archive/` is immutable. */
function stampDirectory(): string {
  return path.join(app.getPath('temp'), 'bookforge-quire-viewer');
}

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

  const digest = crypto.createHash('sha1').update(path.resolve(epubPath)).digest('hex').slice(0, 12);
  fs.mkdirSync(stampDirectory(), { recursive: true });
  const stampedPath = path.join(stampDirectory(), `${digest}.stamped.epub`);

  const stampStartedAt = Date.now();
  const stamp = await stampEpubForQuire(epubPath, stampedPath, path.basename(epubPath));
  const stampMs = Date.now() - stampStartedAt;

  // The categories come off the SAME walk the stamps came off — one enumeration,
  // two consumers, which is the rule the whole quire identity story rests on.
  const walked = await enumerateNarrationElements(epubPath, path.basename(epubPath));
  const units: MarkupUnit[] = [];
  const imageKeys = new Set<string>();
  const seqByKey = new Map<string, number>();
  for (const doc of walked) {
    for (const entry of doc.entries) {
      seqByKey.set(entry.key, seqByKey.size);
      if (entry.unit) units.push(entry.unit);
      else imageKeys.add(entry.key);
    }
  }
  const categoriesByKey = markupCategoriesForUnits(units);

  const doc = await Quire.openDocument(stampedPath);
  let opening: QuireViewerOpening;
  try {
    const report = await doc.layout(geometry);
    if (report.unplaced.length > 0) {
      const names = report.unplaced.slice(0, 5).map((u) => `${u.id} (${u.tag}, ${u.display})`);
      throw new Error(
        `${report.unplaced.length} of ${stamp.stamped.length} elements of `
        + `${path.basename(epubPath)} got no page — e.g. ${names.join('; ')}. The viewer can show `
        + 'them but could never point at them, so the book is not opened.',
      );
    }
    const pageCount = doc.countPages();

    // One block per stamped ELEMENT, not per page fragment. quire reports an
    // element that spans a page break once per page it touches; the picker's
    // idea of a block is the element, so the fragments are folded back together
    // in page order and the block keeps the FIRST page it appears on — the same
    // tiebreak every other reader in this app uses.
    const byKey = new Map<string, { page: number; text: string[]; isImage: boolean }>();
    for (let page = 0; page < pageCount; page++) {
      for (const block of doc.loadPage(page).getBlocks()) {
        const already = byKey.get(block.id);
        if (already) {
          if (block.text) already.text.push(block.text);
          continue;
        }
        byKey.set(block.id, {
          page,
          text: block.text ? [block.text] : [],
          isImage: block.type === 'image',
        });
      }
    }

    const blocks: LaidOutBlock[] = [];
    for (const stamped of stamp.stamped) {
      const found = byKey.get(stamped.key);
      if (!found) {
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
      blocks.push({
        id: stamped.key,
        page: found.page,
        text: found.text.join(' '),
        category_id: category,
        is_image: found.isImage,
        // Reading order IS the enumeration order here — the order the export
        // writer walks the book in. Not inferred from geometry.
        seq: seqByKey.get(stamped.key),
        // The block IS the element, so its narration key is its own key.
        bf_element: stamped.key,
      });
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
    open.set(handle, { doc, stampedPath });
    opening = {
      handle,
      book,
      source: {
        partition,
        documents,
        pageWidth: geometry.width,
        pageHeight: geometry.height,
      },
      stats: {
        documents: report.documents.length,
        pages: pageCount,
        blocks: blocks.length,
        stampedElements: stamp.stamped.length,
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

  ipcMain.handle('quire:close-book', async (_event, handle: string) => {
    try {
      await closeBookForViewer(handle);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
