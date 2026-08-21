/**
 * Ebook render worker — the mupdf half of the Bookshelf web reader.
 *
 * This file is the body of what `electron/ebook-render.ts` used to do IN THE
 * MAIN PROCESS. Every call here is synchronous WASM work over a whole PDF:
 * reading the file, `openDocument`, `toPixmap`, `asPNG`. Run on the main thread
 * it froze the desktop window for the duration — opening a book on the phone
 * locked up the app on the PC for several seconds (Owen, 2026-08-21). Nothing
 * about the work changed; only which thread it happens on.
 *
 * It is a SEPARATE worker from `pdf-worker.ts` on purpose. That one holds the
 * desktop editor's analyzer state, and mupdf's WASM heap is single-threaded and
 * corrupts under concurrent use — so a reader request must never share an
 * instance with an editing session. Two workers, two heaps, two locks.
 *
 * Protocol (parentPort messages), the same shape pdf-worker speaks:
 *   Receive: { type: 'call', requestId: string, method: 'info' | 'page', args: any[] }
 *   Send:    { type: 'result', requestId: string, result: any }
 *          | { type: 'error',  requestId: string, error: string }
 */

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

if (!parentPort) {
  throw new Error('ebook-render-worker.ts must be run as a worker_threads Worker');
}

// mupdf's TypeScript surface varies between versions; the calls used here
// (openDocument / countPages / loadPage / getBounds / toPixmap / asPNG) are
// stable across 1.2x. Type the module loosely to avoid version-coupling.
type Mupdf = typeof import('mupdf');

let mupdfPromise: Promise<Mupdf> | null = null;
function getMupdf(): Promise<Mupdf> {
  // Memoize the dynamic import (mupdf is an ESM module).
  return (mupdfPromise ??= import('mupdf'));
}

// Same benign-abort suppression main.ts and pdf-worker.ts use: mupdf's
// FinalizationRegistry throws a WASM RuntimeError during GC on a destroyed
// object, and it means nothing.
process.on('uncaughtException', (err) => {
  if (err instanceof WebAssembly.RuntimeError && err.stack?.includes('FinalizationRegistry')) {
    return;
  }
  console.error('[ebook-render-worker] Uncaught exception:', err);
});

// ── Serialization lock ─────────────────────────────────────────────────────────
//
// Kept even though the worker handles one message at a time: `withDoc` awaits
// the mupdf import, so two calls that arrive during that first await would
// otherwise interleave inside the WASM heap.
let lockChain: Promise<unknown> = Promise.resolve();
function runLocked<T>(fn: () => Promise<T> | T): Promise<T> {
  const result = lockChain.then(() => fn());
  // Keep the chain alive even if this task rejects.
  lockChain = result.then(() => undefined, () => undefined);
  return result;
}

// ── One-document cache (keyed by path + mtime) ───────────────────────────────────
interface OpenDoc {
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any;
}
let openDoc: OpenDoc | null = null;

/** Run `fn` with the (cached) open document, holding the WASM lock throughout. */
async function withDoc<T>(absPath: string, key: string, fn: (mupdf: Mupdf, doc: any) => T): Promise<T> {
  const mupdf = await getMupdf();
  return runLocked(() => {
    if (!openDoc || openDoc.key !== key) {
      if (openDoc) {
        try { openDoc.doc.destroy(); } catch { /* already gone */ }
        openDoc = null;
      }
      const data = fs.readFileSync(absPath);
      openDoc = { key, doc: mupdf.Document.openDocument(data, mimeFor(absPath)) };
    }
    return fn(mupdf, openDoc.doc);
  });
}

function mimeFor(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.xps') return 'application/oxps';
  if (ext === '.cbz') return 'application/x-cbz';
  return 'application/pdf';
}

export interface PdfOutlineItem {
  title: string;
  page: number; // 0-indexed target page
  depth: number;
}

/** Flatten mupdf's nested outline into { title, page, depth }. Best-effort. */
function readOutline(doc: any): PdfOutlineItem[] {
  let raw: any[] | null = null;
  try { raw = doc.loadOutline(); } catch { raw = null; }
  if (!raw || !Array.isArray(raw)) return [];

  const out: PdfOutlineItem[] = [];
  const walk = (items: any[], depth: number): void => {
    for (const it of items) {
      const title = typeof it?.title === 'string' ? it.title.trim() : '';
      // mupdf exposes the target as a 0-indexed `page` number on the item.
      const page = Number.isInteger(it?.page) && it.page >= 0 ? it.page : 0;
      if (title) out.push({ title, page, depth });
      if (Array.isArray(it?.down) && it.down.length) walk(it.down, depth + 1);
    }
  };
  walk(raw, 0);
  return out;
}

type Dispatcher = (args: any[]) => Promise<any>;

const dispatch: Record<string, Dispatcher> = {
  /** Page count, first-page aspect, and the outline. */
  async info(args) {
    const [absPath, key] = args as [string, string];
    return withDoc(absPath, key, (_mupdf, doc) => {
      const pages: number = doc.countPages();
      let aspect = 0.7727; // ≈ US Letter, until we read page 1's real bounds
      if (pages > 0) {
        const page = doc.loadPage(0);
        try {
          const [x0, y0, x1, y1] = page.getBounds();
          const w = x1 - x0;
          const h = y1 - y0;
          if (w > 0 && h > 0) aspect = w / h;
        } finally {
          try { page.destroy(); } catch { /* ignore */ }
        }
      }
      return { pages, aspect, outline: readOutline(doc) };
    });
  },

  /**
   * One page as PNG bytes.
   *
   * Returned as a Uint8Array and COPIED by structured clone rather than
   * transferred: `Buffer.from` can hand back a view into Node's shared 8 KB
   * pool, and transferring that ArrayBuffer would detach memory other Buffers
   * are still using. A page PNG is a few hundred KB — the copy is not the cost
   * that mattered here.
   */
  async page(args) {
    const [absPath, key, pageNum, scale] = args as [string, string, number, number];
    return withDoc(absPath, key, (mupdf, doc) => {
      let page: any = null;
      let pixmap: any = null;
      try {
        page = doc.loadPage(pageNum);
        const matrix = mupdf.Matrix.scale(scale, scale);
        pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
        return Uint8Array.from(pixmap.asPNG());
      } finally {
        try { pixmap?.destroy(); } catch { /* ignore */ }
        try { page?.destroy(); } catch { /* ignore */ }
      }
    });
  },
};

parentPort.on('message', (msg: any) => {
  if (msg?.type !== 'call') return;
  const { requestId, method, args } = msg;
  const handler = dispatch[method];
  if (!handler) {
    parentPort!.postMessage({ type: 'error', requestId, error: `Unknown method: ${method}` });
    return;
  }
  void handler(args ?? [])
    .then((result) => parentPort!.postMessage({ type: 'result', requestId, result }))
    .catch((err: unknown) => parentPort!.postMessage({
      type: 'error',
      requestId,
      error: err instanceof Error ? err.message : String(err),
    }));
});
