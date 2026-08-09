/**
 * Where an EPUB's pages come from, and where the answer is kept.
 *
 * ── Two processes, one browser ─────────────────────────────────────────────
 *
 * `PDFAnalyzer` runs inside a `worker_threads` Worker (electron/pdf-worker.ts),
 * and a worker thread cannot reach Electron's `app` — the spawn site says so in
 * as many words. quire paginates in a real `BrowserWindow`, so it can only run
 * on the MAIN thread.
 *
 * That is not a problem to be worked around, it is a fact to be routed around:
 * this module asks for a page map and knows which of the two places it is
 * standing in. In the worker it posts the request to the main thread and waits;
 * on the main thread it does the work. Nothing else changes — all the analyzer's
 * state stays in one place, and only the pagination hop crosses.
 *
 * There is no third answer. Outside Electron entirely — a plain `node` harness —
 * the main-thread branch throws from quire, naming the missing browser, rather
 * than producing a book with no pages. Harnesses that analyze EPUBs re-launch
 * themselves under Electron, exactly as `tools/test-quire.js` does.
 *
 * ── Why the map is cached ─────────────────────────────────────────────────
 *
 * Gate G0 measured Paged.js as deterministic: three consecutive runs of Killing
 * America produced an identical page count and an identical id→page map. So a
 * map may be kept — keyed by the book's own sha, the page geometry, and the name
 * of the paginator that made it. A map made by another paginator, another
 * version of it, or another geometry is a MISS. It is never adapted and never
 * reused: a page number believed on the strength of a different layout is worse
 * than no page number.
 */
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { parentPort } from 'worker_threads';
import { getRenderCacheBaseDir } from './render-cache';
import type {
  QuireBlock, QuireOverflow, QuireSpineWarning, QuireUnplaced,
} from '../packages/quire/src/types';

/**
 * Bump when the STAMPS or the shape of a cached map change.
 *
 * The stamped copy and the page map are one artifact in two files — the map's
 * ids are the stamps — so they share a version and are invalidated together.
 */
export const QUIRE_ANALYSIS_VERSION = 1;

export interface QuireAnalysisGeometry {
  width: number;
  height: number;
  fontSize: number;
}

/**
 * The page box every EPUB is analyzed at.
 *
 * The same three numbers mupdf was given (`layout(600, 900, 18)`), so a book's
 * pages stay roughly the size they have always been, and the geometry quire's
 * own test battery measures. Page MARGIN is zero — quire forces `html`/`body`
 * margin, padding and border to 0, so the page box is the content box — which is
 * why quire's page count for a book is lower than mupdf's: mupdf adds margins of
 * its own and therefore fits less on a page.
 */
export const QUIRE_ANALYSIS_GEOMETRY: QuireAnalysisGeometry = {
  width: 600, height: 900, fontSize: 18,
};

/** A whole book's pagination, as plain data that can cross a thread boundary. */
export interface QuirePageMap {
  /** The paginator that made this, version included. A different one is a MISS. */
  strategyName: string;
  geometry: QuireAnalysisGeometry;
  pageCount: number;
  /** Blocks per page, page 0 first. */
  pages: QuireBlock[][];
  documents: string[];
  documentPageOffsets: number[];
  /** Stamped elements that rendered nothing at all. */
  unplaced: QuireUnplaced[];
  /** Fragments that ran past a page edge — a display fidelity fact, not a refusal. */
  overflows: QuireOverflow[];
  spineWarnings: QuireSpineWarning[];
  layoutMs: number;
}

/** The per-book cache directory: the same one the analysis payload lives in. */
export function quireCacheDir(fileHash: string): string {
  return path.join(getRenderCacheBaseDir(), fileHash);
}

/**
 * Where this book's STAMPED copy lives.
 *
 * A copy, never the book. The working copy `[archive].working.epub` is the sole
 * editable artifact and stamps are not part of it — they are an analysis detail
 * with a lifetime of one cache entry. Stamping is deterministic (the same walk
 * over the same book writes the same keys), so re-stamping on a cache miss
 * produces the same file rather than a different one.
 */
export function stampedEpubPath(fileHash: string): string {
  return path.join(quireCacheDir(fileHash), `quire-v${QUIRE_ANALYSIS_VERSION}-stamped.epub`);
}

/** Where a page map for this book, geometry and paginator lives. */
export function pageMapPath(
  fileHash: string,
  strategyName: string,
  geometry: QuireAnalysisGeometry,
): string {
  const safe = strategyName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(
    quireCacheDir(fileHash),
    `quire-v${QUIRE_ANALYSIS_VERSION}-${safe}`
    + `-${geometry.width}x${geometry.height}x${geometry.fontSize}.json`,
  );
}

/**
 * Lay a stamped book out, wherever this code happens to be running.
 *
 * The worker branch is a request/response over `parentPort`; the main-thread
 * branch loads the service and does it here. `quire-service` is required lazily
 * and never imported, because importing it drags `BrowserWindow` into the
 * worker's module graph where `require('electron')` is not resolvable at all in
 * a packaged build.
 */
export function paginateStampedEpub(
  stampedPath: string,
  geometry: QuireAnalysisGeometry,
): Promise<QuirePageMap> {
  if (parentPort) return requestPaginationFromMainThread(stampedPath, geometry);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const service = require('./quire-service') as typeof import('./quire-service');
  return service.paginateInThisProcess(stampedPath, geometry);
}

// ── The worker half of the hop ──────────────────────────────────────────────

interface QuireResponse {
  type: 'quire-response';
  quireId: string;
  result?: QuirePageMap;
  error?: string;
}

let quireRequestCounter = 0;
const awaitingPagination = new Map<string, {
  resolve: (map: QuirePageMap) => void;
  reject: (err: Error) => void;
}>();
let responseListenerAttached = false;

function requestPaginationFromMainThread(
  stampedPath: string,
  geometry: QuireAnalysisGeometry,
): Promise<QuirePageMap> {
  const port = parentPort;
  if (!port) {
    throw new Error(
      '[quire-page-map] requestPaginationFromMainThread was reached with no parentPort — '
      + 'this is a bug: the worker branch is chosen by the presence of that port.',
    );
  }
  if (!responseListenerAttached) {
    responseListenerAttached = true;
    port.on('message', (msg: QuireResponse) => {
      if (!msg || msg.type !== 'quire-response') return;
      const waiting = awaitingPagination.get(msg.quireId);
      if (!waiting) return;
      awaitingPagination.delete(msg.quireId);
      if (msg.error !== undefined) waiting.reject(new Error(msg.error));
      else if (msg.result !== undefined) waiting.resolve(msg.result);
      else {
        waiting.reject(new Error(
          `[quire-page-map] the main thread answered request ${msg.quireId} with neither a page `
          + 'map nor an error.',
        ));
      }
    });
  }
  const quireId = `q${++quireRequestCounter}`;
  return new Promise<QuirePageMap>((resolve, reject) => {
    awaitingPagination.set(quireId, { resolve, reject });
    port.postMessage({ type: 'quire-request', quireId, stampedPath, geometry });
  });
}

// ── The cache ───────────────────────────────────────────────────────────────

/**
 * A cached map for this book at this geometry made by this paginator, or null.
 *
 * The stored map is re-checked against what was asked for rather than trusted
 * because it was found at the expected path: a file left behind by a build whose
 * strategy name or geometry differed is a miss, not a near-enough answer.
 */
export async function loadCachedPageMap(
  fileHash: string,
  strategyName: string,
  geometry: QuireAnalysisGeometry,
): Promise<QuirePageMap | null> {
  const at = pageMapPath(fileHash, strategyName, geometry);
  let raw: string;
  try {
    raw = await fsPromises.readFile(at, 'utf-8');
  } catch {
    return null;
  }
  const map = JSON.parse(raw) as QuirePageMap;
  if (
    map.strategyName !== strategyName
    || map.geometry?.width !== geometry.width
    || map.geometry?.height !== geometry.height
    || map.geometry?.fontSize !== geometry.fontSize
  ) {
    throw new Error(
      `[quire-page-map] ${at} holds a map made by ${map.strategyName} at `
      + `${map.geometry?.width}x${map.geometry?.height}x${map.geometry?.fontSize}, but it was `
      + `asked for as ${strategyName} at ${geometry.width}x${geometry.height}x${geometry.fontSize}. `
      + 'A page map is only valid for the paginator and page box that produced it. Delete that '
      + 'file and re-open the book.',
    );
  }
  if (map.pages.length !== map.pageCount) {
    throw new Error(
      `[quire-page-map] ${at} says the book has ${map.pageCount} pages but carries `
      + `${map.pages.length} page(s) of blocks.`,
    );
  }
  return map;
}

export async function saveCachedPageMap(fileHash: string, map: QuirePageMap): Promise<void> {
  const at = pageMapPath(fileHash, map.strategyName, map.geometry);
  await fsPromises.mkdir(path.dirname(at), { recursive: true });
  await fsPromises.writeFile(at, JSON.stringify(map), 'utf-8');
}
