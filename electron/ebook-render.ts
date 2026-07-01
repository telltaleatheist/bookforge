/**
 * Ebook page rendering for the Bookshelf web reader.
 *
 * PDFs are rasterized to PNG here (server-side) via mupdf and streamed to the
 * phone browser, which keeps the client light. EPUBs are NOT handled here — the
 * web reader renders those reflowably with epub.js on the client.
 *
 * This is deliberately DECOUPLED from the desktop PDF editor's mupdf worker
 * (electron/pdf-worker-proxy + pdf-analyzer): it uses its own mupdf instance in
 * the main process and its own serialization lock, so a reader request can never
 * disturb (or be disturbed by) an active editing session.
 *
 * mupdf's WASM state is single-threaded and corrupts under concurrent calls, so
 * every WASM operation runs behind `runLocked` (a promise chain). A one-document
 * cache avoids re-reading a large PDF from disk on every page, and a small PNG
 * LRU smooths scrolling back over already-rendered pages.
 */

import * as fs from 'fs';
import * as path from 'path';

// mupdf's TypeScript surface varies between versions; the calls used here
// (openDocument / countPages / loadPage / getBounds / toPixmap / asPNG) are
// stable across 1.2x. Type the module loosely to avoid version-coupling.
type Mupdf = typeof import('mupdf');

let mupdfPromise: Promise<Mupdf> | null = null;
function getMupdf(): Promise<Mupdf> {
  // Memoize the dynamic import (mupdf is an ESM module).
  return (mupdfPromise ??= import('mupdf'));
}

// ── Serialization lock ─────────────────────────────────────────────────────────
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

function docKey(absPath: string, mtimeMs: number): string {
  return `${absPath}::${mtimeMs}`;
}

/** Run `fn` with the (cached) open document, holding the WASM lock throughout. */
async function withDoc<T>(absPath: string, fn: (mupdf: Mupdf, doc: any) => T): Promise<T> {
  const mupdf = await getMupdf();
  const st = fs.statSync(absPath);
  const key = docKey(absPath, st.mtimeMs);
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

// ── PNG LRU (keyed by doc key + page + scale) ────────────────────────────────────
const PNG_CACHE_MAX = 24;
const pngCache = new Map<string, Buffer>();

function pngCacheGet(key: string): Buffer | null {
  const hit = pngCache.get(key);
  if (!hit) return null;
  pngCache.delete(key); // refresh recency
  pngCache.set(key, hit);
  return hit;
}

function pngCacheSet(key: string, buf: Buffer): void {
  pngCache.set(key, buf);
  while (pngCache.size > PNG_CACHE_MAX) {
    const oldest = pngCache.keys().next().value;
    if (oldest === undefined) break;
    pngCache.delete(oldest);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface PdfOutlineItem {
  title: string;
  page: number; // 0-indexed target page
  depth: number;
}

export interface PdfInfo {
  pages: number;
  /** width / height of the first page, so the client can size page placeholders. */
  aspect: number;
  /** Flattened document outline (chapters), empty when the PDF has none. */
  outline: PdfOutlineItem[];
}

export async function getPdfInfo(absPath: string): Promise<PdfInfo> {
  return withDoc(absPath, (_mupdf, doc) => {
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

/**
 * Render one page (0-indexed) to a PNG buffer at the given scale (1 = 72 DPI).
 * Scale is clamped to a sane range to bound memory/CPU per request.
 */
export async function renderPdfPage(absPath: string, pageNum: number, scale: number): Promise<Buffer> {
  const safeScale = Math.min(Math.max(scale, 0.5), 4);
  const st = fs.statSync(absPath);
  const cacheKey = `${docKey(absPath, st.mtimeMs)}::${pageNum}::${safeScale}`;
  const cached = pngCacheGet(cacheKey);
  if (cached) return cached;

  const buf = await withDoc(absPath, (mupdf, doc) => {
    let page: any = null;
    let pixmap: any = null;
    try {
      page = doc.loadPage(pageNum);
      const matrix = mupdf.Matrix.scale(safeScale, safeScale);
      pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      return Buffer.from(pixmap.asPNG());
    } finally {
      try { pixmap?.destroy(); } catch { /* ignore */ }
      try { page?.destroy(); } catch { /* ignore */ }
    }
  });
  pngCacheSet(cacheKey, buf);
  return buf;
}
