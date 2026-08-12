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
 * map may be kept — keyed by WHICH BOOK it is, the page geometry, and the name
 * of the paginator that made it. A map made by another paginator, another
 * version of it, or another geometry is a MISS. It is never adapted and never
 * reused: a page number believed on the strength of a different layout is worse
 * than no page number.
 *
 * ── Which book, and how fresh — two different questions ───────────────────
 *
 * They used to be one question, answered by hashing the whole file: the cache
 * directory was named after the book's bytes, so editing anything at all put
 * the book in a NEW directory and every page of it was laid out from scratch.
 * That is correct and it is ruinous. A working copy is one book being edited,
 * not a stream of unrelated books; ten label changes left ten cache directories
 * and 340 MB.
 *
 * So the two questions are separated. WHICH BOOK is {@link bookCacheKey}, the
 * book's LOCATION — stable across every edit, because editing a book does not
 * make it a different book. HOW FRESH is {@link QuirePageMap.documentHashes},
 * one content hash per spine document, carried inside the map: on open, the
 * documents whose hash still matches keep their pages and the ones that moved
 * are laid out again. A changed chapter costs a chapter.
 *
 * The consequence worth stating: a book that MOVES gets a cold cache, and a
 * different book written to the same path finds a map whose every document
 * disagrees and is laid out in full. Both are correct; neither is silent.
 */
import * as crypto from 'crypto';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { parentPort } from 'worker_threads';
import { getRenderCacheBaseDir } from './render-cache';
import type {
  QuireBlock, QuireOverflow, QuireSpineWarning, QuireUnplaced,
} from '../packages/quire/src/types';

/**
 * Bump when the STAMPS or the LAYOUT ITSELF change — anything that would make an
 * old map disagree with what this build lays out.
 *
 * ── This number is not only a cache key ───────────────────────────────────
 *
 * It is also the `version` of a project's recorded editor layout
 * (`electron/editor-layout.ts` → `currentEpubEditorLayout`), and a project whose
 * stamp does not match the current one is `foreign`: every page number and block
 * id the user's editing produced is REFUSED, because resolving them against a
 * different pagination strikes out paragraphs nobody touched. So bumping this
 * throws away real work in every existing EPUB project, and it is right to do
 * that exactly when the pagination moved and wrong to do it for any other
 * reason. **The shape of a cached map is not a reason.** A map whose shape this
 * build cannot use is refused by `loadCachedPageMap`, by name, which costs a
 * re-layout and nothing else.
 *
 * v2: pages gained an inner margin (`PAGE_MARGIN` in quire's Paged strategy),
 * so less content fits a page and every v1 page number means a different page.
 * v3: the Paged strategy holds the book's own elements to `overflow: visible`
 * inside a page box (`MONOLITHIC_OVERFLOW_RULE`), so a box the book made scroll
 * is now fragmented instead of being pushed off the page whole. Any book with
 * one breaks in different places than it did under v2 — and the v2 maps for
 * those books are maps of a layout with blank pages in it.
 * v4: the page box widened 600 → 900 (Owen, 2026-08-12: "can we expand the
 * page width about 50%"). Wider lines fit more words, so every book holds
 * fewer pages and every v3 page number names a different page.
 *
 * The move to per-document freshness did NOT bump this, and did not need to: it
 * changed no pagination, and every map written before it is unreachable anyway
 * because the cache key stopped being the book's content hash.
 */
export const QUIRE_ANALYSIS_VERSION = 4;

export interface QuireAnalysisGeometry {
  width: number;
  height: number;
  fontSize: number;
}

/**
 * The page box every EPUB is analyzed at.
 *
 * 600 wide was mupdf's number (`layout(600, 900, 18)`), inherited so pages
 * stayed the size they had always been; 900 is Owen's (2026-08-12: "can we
 * expand the page width about 50%"). The page MARGIN is not a fourth number
 * here: it is a constant of the Paged strategy itself (`PAGE_MARGIN`, 48px
 * since v2 — before that, zero), because every consumer of quire's page
 * numbers must lay books out identically. Changing ANY of these numbers
 * changes pagination, which is a `QUIRE_ANALYSIS_VERSION` bump by definition —
 * the width change was v4.
 */
export const QUIRE_ANALYSIS_GEOMETRY: QuireAnalysisGeometry = {
  width: 900, height: 900, fontSize: 18,
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
  /**
   * One sha256 per entry of {@link documents}, of the bytes THAT DOCUMENT HELD
   * IN THE BOOK when this map was made.
   *
   * The book's own bytes, not the stamped markup they were laid out from: the
   * stamp is a deterministic function of the book, so hashing the book answers
   * the same question and answers it without parsing or serializing anything.
   * Checking freshness is then 34 file reads, which is what makes it worth doing
   * on every open.
   */
  documentHashes: string[];
  documentPageOffsets: number[];
  /** Stamped elements that rendered nothing at all. */
  unplaced: QuireUnplaced[];
  /** Fragments that ran past a page edge — a display fidelity fact, not a refusal. */
  overflows: QuireOverflow[];
  spineWarnings: QuireSpineWarning[];
  layoutMs: number;
}

/**
 * The per-book cache directory.
 *
 * A sibling of the analyzer's payload directories under the same render cache,
 * and — since `bookCacheKey` is not a content hash — no longer the same
 * directory as the payload for the same book. Both are evicted by age by
 * `evictStaleRenderCache`, which is why reading a map touches this directory.
 */
export function quireCacheDir(cacheKey: string): string {
  return path.join(getRenderCacheBaseDir(), cacheKey);
}

/**
 * WHICH BOOK a cached map belongs to: the book's location, as 16 hex characters.
 *
 * The same width as the analyzer's own cache key (`PDFAnalyzer.analysisCacheKey`
 * truncates a sha256 to 16) and deliberately NOT the same value. The analyzer's
 * key is the book's CONTENT, because an analysis payload describes bytes and
 * must never be read for different ones. A page map is the opposite kind of
 * thing: it is a record about a book that is being edited, and it carries its
 * own freshness per document, so keying it by content would throw the whole map
 * away to learn that one chapter of it moved.
 *
 * The path is resolved and case-folded first, so the same book reached as
 * `E:\Shared\...` and `e:/shared/...` is one book. Case-folding is right on
 * Windows and wrong nowhere BookForge runs — the alternative, two cache
 * directories for one file, is a cost with no upside.
 */
export function bookCacheKey(bookPath: string): string {
  const normalized = path.resolve(bookPath).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(`quire-book:${normalized}`).digest('hex').substring(0, 16);
}

/** Where a page map for this book, geometry and paginator lives. */
export function pageMapPath(
  cacheKey: string,
  strategyName: string,
  geometry: QuireAnalysisGeometry,
): string {
  const safe = strategyName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(
    quireCacheDir(cacheKey),
    `quire-v${QUIRE_ANALYSIS_VERSION}-${safe}`
    + `-${geometry.width}x${geometry.height}x${geometry.fontSize}.json`,
  );
}

/**
 * One spine document as the paginator needs it.
 *
 * The stamped markup and the hash of the bytes it was stamped FROM, in one
 * record, because the map records the second and is laid out from the first and
 * the two going out of step would make a map that lies about its own freshness.
 */
export interface StampedSpineDocument {
  /** The document's markup with `data-quire-id` on every walked element. */
  stamped: Buffer;
  /** sha256 of the bytes the BOOK holds for this document. */
  hash: string;
}

/** A book's whole spine, in spine order having been walked. */
export type StampedSpine = ReadonlyMap<string, StampedSpineDocument>;

/**
 * A cached map and the documents it has gone out of date about — what
 * {@link paginateBook} needs in order to lay out only what moved.
 */
export interface QuirePageMapReuse {
  map: QuirePageMap;
  /** Spine documents whose bytes no longer hash to what the map recorded. */
  stale: string[];
}

/**
 * Lay a book out, wherever this code happens to be running.
 *
 * `sources` is the book's spine documents WITH THEIR STAMPS ON — quire reports
 * the caller's ids and mints none, so the stamped markup has to reach it, and
 * this is how it does now that there is no stamped copy on disk to read it from.
 * Every other entry of the book comes from `bookPath` itself.
 *
 * `reuse`, when given, is a map of this same book that has gone stale in only
 * some of its documents: the layout is stood up from it and those documents —
 * and only those — are measured again.
 *
 * The worker branch is a request/response over `parentPort`; the main-thread
 * branch loads the service and does it here. `quire-service` is required lazily
 * and never imported, because importing it drags `BrowserWindow` into the
 * worker's module graph where `require('electron')` is not resolvable at all in
 * a packaged build.
 */
export function paginateBook(
  bookPath: string,
  spine: StampedSpine,
  geometry: QuireAnalysisGeometry,
  reuse: QuirePageMapReuse | null = null,
): Promise<QuirePageMap> {
  if (parentPort) return requestPaginationFromMainThread(bookPath, spine, geometry, reuse);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const service = require('./quire-service') as typeof import('./quire-service');
  return service.paginateInThisProcess(bookPath, spine, geometry, reuse);
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
  bookPath: string,
  spine: StampedSpine,
  geometry: QuireAnalysisGeometry,
  reuse: QuirePageMapReuse | null,
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
    // A Map of Buffers crosses a worker port by structured clone, which is a
    // copy of the stamped markup — the book's XHTML, some megabytes, and a
    // rounding error beside the layout it is asking for. The PICTURES do not
    // cross: they stay in the book, which the main thread opens by path.
    port.postMessage({ type: 'quire-request', quireId, bookPath, spine, geometry, reuse });
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
  cacheKey: string,
  strategyName: string,
  geometry: QuireAnalysisGeometry,
): Promise<QuirePageMap | null> {
  const at = pageMapPath(cacheKey, strategyName, geometry);
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
  if (!Array.isArray(map.documentHashes) || map.documentHashes.length !== map.documents.length) {
    throw new Error(
      `[quire-page-map] ${at} describes ${map.documents.length} document(s) but carries `
      + `${Array.isArray(map.documentHashes) ? map.documentHashes.length : 'no'} document hash(es). `
      + 'A map that cannot say which bytes each document was laid out from cannot be checked '
      + 'against the book, and a page number that cannot be checked is not one to believe.',
    );
  }
  // The render cache evicts by directory mtime, and this directory only ever
  // gets written on a MISS — so a book read from cache every day would look
  // thirty days untouched and be thrown away. Reading it counts as using it.
  await fsPromises.utimes(quireCacheDir(cacheKey), new Date(), new Date()).catch(() => {
    /* the directory was evicted between the read and now; the map is still good */
  });
  return map;
}

/**
 * Which of a map's documents no longer match the book, given the book's current
 * per-document hashes.
 *
 * A document the book no longer has at all counts as stale, but the caller
 * cannot fix that by laying it out again — the SPINE changed, and that is a
 * different book shape than the map describes. `hydrateFromPageMap` refuses such
 * a map by name, which is where that case is meant to land.
 */
export function staleDocuments(
  map: QuirePageMap,
  hashNow: ReadonlyMap<string, string>,
): string[] {
  return map.documents.filter((entry, at) => hashNow.get(entry) !== map.documentHashes[at]);
}

export async function saveCachedPageMap(cacheKey: string, map: QuirePageMap): Promise<void> {
  const at = pageMapPath(cacheKey, map.strategyName, map.geometry);
  await fsPromises.mkdir(path.dirname(at), { recursive: true });
  await fsPromises.writeFile(at, JSON.stringify(map), 'utf-8');
}
