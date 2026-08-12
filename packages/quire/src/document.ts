/**
 * `QuireDocument` / `QuirePage` — the surface that stands where mupdf stands.
 *
 * The shape mirrors the slice of mupdf `electron/pdf-analyzer.ts` drives, with
 * one deliberate difference and one unavoidable one:
 *
 *  - DELIBERATE: {@link QuireBlock.id}. mupdf hands back a bounding box and
 *    leaves "which element was that?" to be guessed from geometry. quire hands
 *    back the caller's own stamp. That is the entire reason the package exists.
 *  - UNAVOIDABLE: `layout()` is async. A browser lays out asynchronously and
 *    there is no honest way to pretend otherwise. `countPages()` and
 *    `loadPage()` refuse to answer before it has resolved rather than answer
 *    from a stale layout.
 *
 * And one thing mupdf has no counterpart for: {@link QuireDocument.getPageMount}
 * and {@link QuireDocument.presentPage}, which put a page in front of the user
 * as LIVE DOM — selectable text, real fonts, working internal links. That is the
 * product. `toPng` exists for thumbnails and for comparing against mupdf's
 * raster during the changeover; it is not the display path.
 */
import * as crypto from 'crypto';
import { quireFail } from './errors';
import { QuireArchive } from './epub/archive';
import { buildPaginationShell } from './epub/shell';
import { assertQuireSchemeRegistered, attachQuireProtocol, type AttachedProtocol } from './host/protocol';
import { OffscreenWindowHost } from './host/offscreen-host';
import type { QuireHost } from './host/host';
import { PagedStrategy } from './paginate/paged';
import type { QuireStrategy, StrategyMeasurement } from './paginate/strategy';
import {
  QUIRE_COLUMN_GAP,
  type QuireBlock,
  type QuireGeometry,
  type QuireLayoutOptions,
  type QuireOverflow,
  type QuirePageMapSnapshot,
  type QuirePageMount,
  type QuireReport,
  type QuireUnplaced,
} from './types';

export interface QuireOpenOptions {
  /**
   * The pagination strategy. Defaults to {@link PagedStrategy} — Paged.js 0.4.3,
   * vendored — which is what quire paginates with; see the README's "Strategy —
   * SETTLED (gate G0)".
   *
   * Passing one is for tests that need a fragmenter whose arithmetic can be
   * doctored, not for choosing between candidates at run time. There is no
   * fallback: if the strategy cannot paginate a book, the open fails naming why.
   */
  strategy?: QuireStrategy;

  /**
   * The spine documents' XHTML, handed in by the caller instead of read out of
   * the book.
   *
   * quire does not mint ids — it answers "which page did that id land on" for
   * documents that already carry `data-quire-id`. The caller therefore has to
   * put the stamps somewhere quire will read them. Writing a whole STAMPED COPY
   * of the book to disk was one way to do that, and it was the expensive way: a
   * book is mostly pictures, and re-deflating twenty-five megabytes of unchanged
   * JPEGs to alter one chapter's markup is the cost, not the layout.
   *
   * So the book is opened where it lives and the stamped markup is passed
   * through here. Every other entry — the pictures, the stylesheets, the fonts —
   * is read from the book itself, which is the point: they are the bulk and they
   * never needed copying.
   *
   * `sources` must name EXACTLY the spine, no more and no less. Not a
   * convenience check: a spine document with no stamps carries no ids at all, so
   * every element in it would go unreported and the caller would be told its
   * book has elements with no pages — a true statement about a situation with a
   * completely different cause. A key that is not a spine document means the
   * caller's idea of the book and this one's have diverged, which is worth
   * knowing at the open rather than at the first page.
   *
   * The strings are the SOURCE, in the sense `relayoutDocument` uses the word:
   * they are re-shelled on a geometry change and served to the `quire://`
   * handler in place of the book's own bytes.
   */
  sources?: ReadonlyMap<string, string | Buffer>;
}

/**
 * One spine document's contribution to the book, in DOCUMENT-LOCAL terms:
 * `localPages[n]` are the blocks of the document's own page `n`, and every page
 * number inside (`splitFrom`/`splitTo`, `overflows[].page`) is local too. Global
 * numbers are applied by `buildPageIndex`/`buildReport` from `pageOffset` — kept
 * local here so an entry can come from a live measurement OR from a cached page
 * map ({@link QuireDocument.hydrateFromPageMap}) and be indistinguishable to
 * everything downstream, `relayoutDocument` included.
 */
interface DocumentLayout {
  entry: string;
  pageOffset: number;
  pageCount: number;
  /** Blocks per LOCAL page, in flow order within each page. */
  localPages: QuireBlock[][];
  /** Every stamped id in this document, placed first (flow order), then unplaced. */
  stampedIds: string[];
  unplaced: QuireUnplaced[];
  /** `page` is LOCAL to this document's flow. */
  overflows: QuireOverflow[];
}

/**
 * Fold a strategy's raw measurement into the document-local layout shape.
 *
 * The block objects built here are exactly the ones `buildPageIndex` used to
 * build inline — same field derivations, same push order (placement, then
 * fragment, then id) — only without the page offset, which is applied later.
 */
function layoutFromMeasurement(
  entry: string,
  pageOffset: number,
  measurement: StrategyMeasurement,
): DocumentLayout {
  const localPages: QuireBlock[][] = Array.from(
    { length: measurement.pageCount }, () => [] as QuireBlock[]);
  const stampedIds: string[] = [];
  for (const placement of measurement.placed) {
    for (const id of placement.ids) stampedIds.push(id);
    const pages = placement.fragments.map((f) => f.page);
    const spans = pages.length > 1;
    const splitFrom = spans ? Math.min(...pages) : null;
    const splitTo = spans ? Math.max(...pages) : null;
    for (const fragment of placement.fragments) {
      for (const id of placement.ids) {
        localPages[fragment.page].push({
          type: placement.type,
          bbox: { x: fragment.x, y: fragment.y, w: fragment.w, h: fragment.h },
          text: placement.type === 'image' ? null : (fragment.text ?? ''),
          id,
          splitFrom,
          splitTo,
          font: placement.font,
          lines: fragment.lines,
        });
      }
    }
  }
  const unplaced: QuireUnplaced[] = [];
  for (const miss of measurement.unplaced) {
    for (const id of miss.ids) {
      stampedIds.push(id);
      unplaced.push({
        id, document: entry, tag: miss.tag,
        reason: 'not-rendered', display: miss.display, hasText: miss.hasText,
      });
    }
  }
  const overflows: QuireOverflow[] = [];
  for (const over of measurement.overflows) {
    for (const id of over.ids) {
      overflows.push({
        id, document: entry, page: over.page, axis: over.axis, overshoot: over.overshoot,
      });
    }
  }
  return { entry, pageOffset, pageCount: measurement.pageCount, localPages, stampedIds, unplaced, overflows };
}

export class QuirePage {
  constructor(
    private readonly doc: QuireDocument,
    /** Global page index. */
    readonly number: number,
    private readonly blocks: QuireBlock[],
  ) {}

  /**
   * Every stamped element with a footprint on this page, in document order.
   *
   * An element that spans a page break appears on each page it touches, with the
   * box and the words that are actually there, and with `splitFrom`/`splitTo`
   * naming the whole run.
   */
  getBlocks(): QuireBlock[] {
    return this.blocks.map((b) => ({ ...b, bbox: { ...b.bbox } }));
  }

  /** What a display surface needs to show this page as live DOM. */
  getMount(): QuirePageMount {
    return this.doc.getPageMount(this.number);
  }

  /**
   * A raster of this page, for thumbnails and for diffing against mupdf during
   * the changeover. Not the display path: a picture of a page cannot be selected,
   * searched, or clicked, and this package exists so that it does not have to be.
   */
  async toPng(scale: number): Promise<Buffer> {
    return this.doc.renderPageToPng(this.number, scale);
  }
}

export class QuireDocument {
  private readonly strategy: QuireStrategy;
  private readonly archive: QuireArchive;
  private readonly sessionId: string;
  private readonly overrides = new Map<string, { body: Buffer; contentType: string }>();

  /**
   * Spine documents whose source is NOT the archive's any more, entry → the
   * XHTML {@link relayoutDocument} was given.
   *
   * Consulted everywhere a spine document's source is read, so a second
   * `layout()` — a geometry change — re-shells the relaid document from the
   * bytes it was relaid with rather than silently reverting to the file the
   * archive was opened on. Without it a relayout would hold only until the next
   * time the reader resized, which is the kind of correctness that expires.
   */
  private readonly sourceOverrides = new Map<string, string>();

  private ses: Electron.Session | null = null;
  private attached: AttachedProtocol | null = null;
  private analysisHost: OffscreenWindowHost | null = null;

  private geometry: QuireGeometry | null = null;
  private layouts: DocumentLayout[] = [];
  private pageIndex: QuireBlock[][] = [];
  private report: QuireReport | null = null;
  private closed = false;

  /** Which spine document the analysis host currently has loaded, or -1. */
  private loadedDocument = -1;
  private presentedPage = -1;
  private presentedScale = 1;

  private constructor(readonly epubPath: string, options: QuireOpenOptions) {
    this.strategy = options.strategy ?? new PagedStrategy();
    // `epubPath` is a path the caller has already decided is a book, so the book
    // is read out of whichever container is at it — a zipped `.epub` or an
    // exploded working directory. That is one `stat`, not a search: a path that
    // is not there is refused by name rather than looked for nearby.
    this.archive = QuireArchive.fromBookPath(epubPath);
    this.sessionId = `q${crypto.randomBytes(12).toString('hex')}`;
  }

  /**
   * The fragmenter this document was opened with, by name. Worth reporting
   * anywhere a page map is: a cached map is only valid for the paginator that
   * produced it.
   */
  get strategyName(): string {
    return this.strategy.name;
  }

  /**
   * The book's spine, as zip entry names in reading order.
   *
   * What {@link relayoutDocument} will accept, said before it is asked, so a
   * caller that has rewritten some of a book's files can tell which of them have
   * pages and which are only bytes.
   */
  get spine(): readonly string[] {
    return this.archive.spine.map((s) => s.entry);
  }

  /** The Electron session the book is confined to. A display surface must use it. */
  get session(): Electron.Session {
    if (!this.ses) quireFail('NOT_OPEN', 'the document is not open');
    return this.ses;
  }

  /** Requests the sandbox refused, newest last. Empty is the expected state. */
  get refusals(): ReadonlyArray<{ url: string; reason: string }> {
    return this.attached ? this.attached.refusals : [];
  }

  /** Console messages the book's own markup produced — CSP violations land here. */
  get consoleMessages(): readonly string[] {
    return this.analysisHost ? this.analysisHost.consoleMessages : [];
  }

  static async open(epubPath: string, options: QuireOpenOptions = {}): Promise<QuireDocument> {
    assertQuireSchemeRegistered();
    const { session, app } = require('electron') as typeof Electron;
    if (!app.isReady()) {
      quireFail('APP_NOT_READY', 'Quire.openDocument() must be called after app.whenReady()');
    }

    const doc = new QuireDocument(epubPath, options);
    try {
      await doc.archive.open();
      if (options.sources !== undefined) doc.seedSources(options.sources);
      // A partition with no `persist:` prefix is in-memory: the book gets no
      // cookies, no cache and no storage that outlives it, and it shares none of
      // BookForge's own.
      doc.ses = session.fromPartition(`quire-${doc.sessionId}`, { cache: false });
      doc.attached = attachQuireProtocol(doc.ses, doc.sessionId, doc.archive, doc.overrides);
      return doc;
    } catch (err) {
      await doc.close();
      throw err;
    }
  }

  /**
   * Lay the book out at a page geometry and measure it. Must be awaited before
   * anything asks about pages.
   *
   * Each spine document is laid out as its own flow and its pages are appended,
   * so a chapter always starts a page — the same thing mupdf does to an EPUB,
   * and the thing a reader expects.
   */
  async layout(options: QuireLayoutOptions): Promise<QuireReport> {
    this.assertOpen();
    const geometry = this.resolveGeometry(options, 'layout()');
    this.geometry = geometry;

    const started = Date.now();
    const layoutCss = this.strategy.layoutCss(geometry);

    // Build every shell up front so the protocol handler can answer for any
    // document — the display surface may ask for a page in a chapter the
    // analysis host never got to.
    for (const spineDoc of this.archive.spine) {
      const source = await this.sourceFor(spineDoc.entry);
      const shell = buildPaginationShell(source, spineDoc.entry, layoutCss);
      this.overrides.set(spineDoc.entry, {
        body: Buffer.from(shell.xhtml, 'utf8'),
        contentType: 'application/xhtml+xml',
      });
    }

    // Laying the same document out again is a fresh analysis surface, and the
    // previous one goes first. Leaving it alive would leak a BrowserWindow per
    // re-layout and — worse — leave a second frame holding a page map for a
    // geometry nobody is asking about any more.
    if (this.analysisHost) { this.analysisHost.destroy(); this.analysisHost = null; }
    this.analysisHost = await OffscreenWindowHost.create({
      session: this.session, width: geometry.width, height: geometry.height,
    });

    const measureScript = this.strategy.measureScript(geometry);
    this.layouts = [];
    let pageOffset = 0;
    for (const spineDoc of this.archive.spine) {
      await this.loadInto(this.analysisHost, spineDoc.entry);
      const raw = await this.analysisHost.evaluate(measureScript);
      const parsed = JSON.parse(raw) as StrategyMeasurement & { error?: string; stack?: string };
      if (parsed.error) {
        quireFail(
          'MEASUREMENT_FAILED',
          `${spineDoc.entry}: ${parsed.error}\n${parsed.stack ?? ''}`.trim(),
        );
      }
      this.layouts.push(layoutFromMeasurement(spineDoc.entry, pageOffset, parsed));
      pageOffset += parsed.pageCount;
    }
    this.loadedDocument = this.archive.spine.length - 1;
    this.presentedPage = -1;

    this.buildPageIndex(pageOffset);
    this.report = this.buildReport(Date.now() - started);
    return this.report;
  }

  /**
   * Stand the document up from a page map a previous layout of the SAME book at
   * the SAME geometry produced, instead of paginating it again.
   *
   * Pagination is deterministic (gate G0), so a map made by this strategy, at
   * this geometry, for this spine, IS what `layout(options)` would measure —
   * and everything `layout()` establishes is established here from the map:
   * the per-document layouts, the page index, the report, the shells the
   * `quire://` protocol serves, and the analysis surface. The one difference is
   * that the analysis surface has NOTHING loaded — `relayoutDocument` and
   * `toPng` load the single document they need on first use, which is the whole
   * saving: a hydrated open never navigates the offscreen window at all.
   *
   * The map is VALIDATED, never adapted: a strategy, geometry or spine that
   * does not match this document is a refusal naming the disagreement, so the
   * caller can retire the cache entry and lay out for real. A refusal leaves
   * the document exactly as opened — `layout()` may still be called.
   *
   * `stampedIds` in the report is rebuilt as each document's placed ids in
   * first-appearance page order followed by its unplaced ids — flow order for
   * everything a fragmenting strategy produces (fragments ascend pages), and
   * nothing consumes the order today. Every other report field is the map's.
   *
   * `layoutMs` afterwards is the time hydration took — the truthful cost of
   * THIS standing-up, exactly as `relayoutDocument` reports its own time.
   */
  async hydrateFromPageMap(
    map: QuirePageMapSnapshot,
    options: QuireLayoutOptions,
  ): Promise<QuireReport> {
    this.assertOpen();
    if (this.report) {
      quireFail(
        'ALREADY_LAID_OUT',
        'hydrateFromPageMap() stands up a freshly opened document; this one already has a '
        + 'layout, and a cached map cannot be reconciled with live state it did not produce.',
      );
    }
    const geometry = this.resolveGeometry(options, 'hydrateFromPageMap()');
    const started = Date.now();

    // ── The map must be THIS book's, at THIS geometry, by THIS paginator ────
    const refuse = (why: string): never => quireFail(
      'PAGE_MAP_MISMATCH',
      `the page map offered for ${this.epubPath} ${why} — it was made from a different layout, `
      + 'so no page number in it may be believed. Retire it and lay the book out.',
    );
    if (map.strategyName !== this.strategy.name) {
      refuse(`was made by ${map.strategyName}, but this document paginates with ${this.strategy.name}`);
    }
    if (
      map.geometry.width !== geometry.width
      || map.geometry.height !== geometry.height
      || map.geometry.fontSize !== geometry.fontSize
    ) {
      refuse(
        `was made at ${map.geometry.width}x${map.geometry.height}x${map.geometry.fontSize}, `
        + `but this layout is ${geometry.width}x${geometry.height}x${geometry.fontSize}`,
      );
    }
    const spine = this.archive.spine.map((s) => s.entry);
    if (
      map.documents.length !== spine.length
      || map.documents.some((entry, at) => entry !== spine[at])
    ) {
      refuse(
        `describes the spine [${map.documents.join(', ')}], but this book's spine is `
        + `[${spine.join(', ')}]`,
      );
    }
    if (map.pages.length !== map.pageCount) {
      refuse(`says ${map.pageCount} page(s) but carries ${map.pages.length} page(s) of blocks`);
    }
    if (map.documentPageOffsets.length !== map.documents.length) {
      refuse(
        `carries ${map.documentPageOffsets.length} page offset(s) for ${map.documents.length} document(s)`,
      );
    }
    if (map.documents.length > 0 && map.documentPageOffsets[0] !== 0) {
      refuse(`starts its first document on page ${map.documentPageOffsets[0]}, leaving earlier pages unowned`);
    }

    // ── Per-document layouts, sliced back out of the global map ─────────────
    const layouts: DocumentLayout[] = [];
    let claimedUnplaced = 0;
    let claimedOverflows = 0;
    for (let at = 0; at < map.documents.length; at++) {
      const entry = map.documents[at];
      const pageOffset = map.documentPageOffsets[at];
      const end = at + 1 < map.documentPageOffsets.length
        ? map.documentPageOffsets[at + 1]
        : map.pageCount;
      if (!Number.isInteger(pageOffset) || pageOffset < 0 || end < pageOffset || end > map.pageCount) {
        refuse(`gives ${entry} the page range [${pageOffset}, ${end}), which is not a range of the book`);
      }
      const localPages: QuireBlock[][] = [];
      for (let page = pageOffset; page < end; page++) {
        localPages.push(map.pages[page].map((block) => {
          if (
            (block.splitFrom !== null && (block.splitFrom < pageOffset || block.splitFrom >= end))
            || (block.splitTo !== null && (block.splitTo < pageOffset || block.splitTo >= end))
          ) {
            refuse(
              `puts a fragment of ${block.id} on page ${page} of ${entry} with a split run `
              + `${block.splitFrom}–${block.splitTo} outside that document's pages`,
            );
          }
          return {
            ...block,
            bbox: { ...block.bbox },
            splitFrom: block.splitFrom === null ? null : block.splitFrom - pageOffset,
            splitTo: block.splitTo === null ? null : block.splitTo - pageOffset,
          };
        }));
      }
      const unplaced = map.unplaced.filter((u) => u.document === entry);
      const overflows = map.overflows.filter((o) => o.document === entry).map((over) => {
        if (over.page < pageOffset || over.page >= end) {
          refuse(`reports an overflow of ${over.id} on page ${over.page}, outside ${entry}'s pages`);
        }
        return { ...over, page: over.page - pageOffset };
      });
      claimedUnplaced += unplaced.length;
      claimedOverflows += overflows.length;
      const placedIds = new Set<string>();
      const stampedIds: string[] = [];
      for (const blocks of localPages) {
        for (const block of blocks) {
          if (placedIds.has(block.id)) continue;
          placedIds.add(block.id);
          stampedIds.push(block.id);
        }
      }
      for (const miss of unplaced) stampedIds.push(miss.id);
      layouts.push({
        entry, pageOffset, pageCount: end - pageOffset, localPages, stampedIds, unplaced, overflows,
      });
    }
    if (claimedUnplaced !== map.unplaced.length || claimedOverflows !== map.overflows.length) {
      refuse('names documents in its unplaced/overflow records that are not in the spine');
    }

    // ── The same surfaces layout() leaves behind ────────────────────────────
    // Built into locals first: a refusal anywhere above or a shell that cannot
    // be built leaves the document exactly as opened.
    const layoutCss = this.strategy.layoutCss(geometry);
    const overrides = new Map<string, { body: Buffer; contentType: string }>();
    for (const spineDoc of this.archive.spine) {
      const source = await this.sourceFor(spineDoc.entry);
      const shell = buildPaginationShell(source, spineDoc.entry, layoutCss);
      overrides.set(spineDoc.entry, {
        body: Buffer.from(shell.xhtml, 'utf8'),
        contentType: 'application/xhtml+xml',
      });
    }
    const host = await OffscreenWindowHost.create({
      session: this.session, width: geometry.width, height: geometry.height,
    });

    // ── Commit ──────────────────────────────────────────────────────────────
    this.geometry = geometry;
    for (const [entry, body] of overrides) this.overrides.set(entry, body);
    if (this.analysisHost) this.analysisHost.destroy();
    this.analysisHost = host;
    this.loadedDocument = -1;
    this.presentedPage = -1;
    this.layouts = layouts;
    this.buildPageIndex(map.pageCount);
    this.report = this.buildReport(Date.now() - started);
    return this.report;
  }

  /**
   * Lay ONE spine document out again from new bytes, and re-number the book
   * around it.
   *
   * ── Why this can be one document ──────────────────────────────────────────
   *
   * `layout()` already measures every spine document as its own flow: a chapter
   * always starts a page, so what a document does to the book is entirely
   * described by its page COUNT. Change one document's bytes and the pages of
   * every earlier document are untouched, the pages of every later one shift by
   * the same delta, and nothing about any of them has to be measured again. This
   * is that arithmetic, and it is the whole difference from a full relayout —
   * the measurement of the changed document is the same shell, the same
   * `layoutCss` from the same geometry, the same prelude and the SAME measure
   * script, verification included. There is no cheaper path through the checks
   * and none is offered: `SPLIT_DISAGREEMENT`, `CONTENT_REPEATED` and
   * `PAGE_BOX_MISMATCH` all live inside that script and all still fire here.
   *
   * ── What the caller owes, and what it is owed ─────────────────────────────
   *
   * The document was opened on a stamped EPUB on disk. Relaying an entry out
   * from bytes that are not in that file puts the two into disagreement, so the
   * contract is one-directional and the caller keeps it: `newSourceXhtml` MUST
   * be what the book on disk now says for `entry` — already written, or about to
   * be, by the caller in the same operation. quire then holds the BOOK's state,
   * and re-deriving the stale stamped file is the caller's (see
   * `electron/quire-viewer-bridge.ts`, which re-stamps just these entries and
   * writes the page map under the book's new digest).
   *
   * `getReport().layoutMs` afterwards is the time THIS relayout took, not the
   * book's. Everything else the report says is exactly what a full `layout()` of
   * the same bytes would say — proved in `tools/test-quire.js` against a fresh
   * open of the edited book, block for block.
   *
   * ── Failure ───────────────────────────────────────────────────────────────
   *
   * Nothing is committed until the measurement is in hand. A refusal — an
   * unparseable document, a prelude that would not load, any verification the
   * measure script performs — leaves the document answering exactly what it
   * answered before the call, page map included.
   */
  async relayoutDocument(entry: string, newSourceXhtml: string): Promise<QuireReport> {
    this.assertLaidOut();
    const geometry = this.geometry as QuireGeometry;

    if (typeof newSourceXhtml !== 'string' || newSourceXhtml.trim().length === 0) {
      quireFail(
        'EMPTY_RELAYOUT_SOURCE',
        `relayoutDocument(${entry}) was given no source. A spine document laid out from nothing `
        + 'would be a book with a blank chapter in it, which is not what an edit to that chapter '
        + 'means.',
      );
    }
    if (this.archive.spine.findIndex((s) => s.entry === entry) < 0) {
      quireFail(
        'NOT_A_SPINE_DOCUMENT',
        `${entry} is not a spine document of ${this.epubPath}, so it has no pages to lay out `
        + `again. The spine is: ${this.archive.spine.map((s) => s.entry).join(', ')}.`,
      );
    }
    const at = this.layouts.findIndex((l) => l.entry === entry);
    if (at < 0) {
      quireFail(
        'NOT_LAID_OUT',
        `${entry} is in the spine of ${this.epubPath} but carries no layout, so this document was `
        + 'laid out from a different spine than the one it is being asked about.',
      );
    }
    const host = this.analysisHost;
    if (!host) {
      quireFail('NOT_LAID_OUT', 'relayoutDocument() needs the analysis surface, which is gone');
    }

    const started = Date.now();
    const shell = buildPaginationShell(newSourceXhtml, entry, this.strategy.layoutCss(geometry));

    // The served bytes have to move BEFORE the host loads them — the shell is
    // what `quire://` answers with — so the pre-relayout override is held here
    // and put back by hand on every way out that is not success.
    const heldOverride = this.overrides.get(entry);
    const heldSource = this.sourceOverrides.get(entry);
    this.overrides.set(entry, {
      body: Buffer.from(shell.xhtml, 'utf8'),
      contentType: 'application/xhtml+xml',
    });
    // Whatever happens next, the analysis surface no longer holds the document
    // it was holding: a failed load leaves it on the rejected bytes, and a
    // successful one leaves it on `entry`. Saying "nothing" is true in both.
    this.loadedDocument = -1;
    this.presentedPage = -1;

    let measured: StrategyMeasurement;
    try {
      await this.loadInto(host, entry);
      const raw = await host.evaluate(this.strategy.measureScript(geometry));
      const parsed = JSON.parse(raw) as StrategyMeasurement & { error?: string; stack?: string };
      if (parsed.error) {
        quireFail('MEASUREMENT_FAILED', `${entry}: ${parsed.error}\n${parsed.stack ?? ''}`.trim());
      }
      measured = parsed;
    } catch (err) {
      if (heldOverride === undefined) this.overrides.delete(entry);
      else this.overrides.set(entry, heldOverride);
      if (heldSource === undefined) this.sourceOverrides.delete(entry);
      else this.sourceOverrides.set(entry, heldSource);
      throw err;
    }

    // ── Commit ────────────────────────────────────────────────────────────
    // Staged into locals first, so a throw between here and the last assignment
    // cannot leave a page index spliced onto layouts it does not describe.
    const layouts = this.layouts.slice();
    layouts[at] = layoutFromMeasurement(entry, layouts[at].pageOffset, measured);
    let pageOffset = layouts[at].pageOffset + measured.pageCount;
    for (let i = at + 1; i < layouts.length; i++) {
      layouts[i] = { ...layouts[i], pageOffset };
      pageOffset += layouts[i].pageCount;
    }

    this.layouts = layouts;
    this.sourceOverrides.set(entry, newSourceXhtml);
    this.loadedDocument = at;
    this.buildPageIndex(pageOffset);
    this.report = this.buildReport(Date.now() - started);
    return this.report;
  }

  /**
   * Take the caller's stamped spine documents, having checked they describe this
   * book's spine and no other.
   *
   * Run after `archive.open()`, because the spine is what it is checked against,
   * and before anything is laid out, because these bytes ARE the book as far as
   * every later step is concerned. See {@link QuireOpenOptions.sources}.
   */
  private seedSources(sources: ReadonlyMap<string, string | Buffer>): void {
    const spine = this.archive.spine.map((s) => s.entry);
    const inSpine = new Set(spine);
    const missing = spine.filter((entry) => !sources.has(entry));
    const extra = [...sources.keys()].filter((entry) => !inSpine.has(entry));
    if (missing.length > 0 || extra.length > 0) {
      quireFail(
        'SOURCES_NOT_THE_SPINE',
        `${this.archive.epubPath} was opened with sources for `
        + `${sources.size} document(s), but its spine is ${spine.length} document(s)`
        + (missing.length > 0
          ? `; no source was given for ${missing.slice(0, 5).join(', ')}`
            + (missing.length > 5 ? ` (and ${missing.length - 5} more)` : '')
          : '')
        + (extra.length > 0
          ? `; ${extra.slice(0, 5).join(', ')} `
            + `${extra.length === 1 ? 'is' : 'are'} not in the spine`
            + (extra.length > 5 ? ` (and ${extra.length - 5} more)` : '')
          : '')
        + '. The caller and this book disagree about which documents the book is '
        + 'made of, and a page number measured under that disagreement would '
        + 'describe neither.',
      );
    }
    for (const entry of spine) {
      const source = sources.get(entry) as string | Buffer;
      this.sourceOverrides.set(
        entry, typeof source === 'string' ? source : source.toString('utf8'));
    }
  }

  /**
   * A spine document's source: what it was relaid out from, or the archive's.
   *
   * One reader, so a relaid document cannot come back from the file under a
   * caller that only asked for a different page size.
   */
  private async sourceFor(entry: string): Promise<string> {
    const relaid = this.sourceOverrides.get(entry);
    if (relaid !== undefined) return relaid;
    return this.archive.readText(entry);
  }

  /**
   * Load a spine document into a host and put the strategy's trusted code in
   * front of it.
   *
   * Every path that runs a strategy script goes through here, because a frame
   * that was loaded without the prelude is a frame where the fragmenter is not
   * present — and the honest outcome of that is a refusal naming the prelude,
   * not a measurement of an unpaginated document.
   */
  private async loadInto(host: QuireHost, entry: string): Promise<void> {
    await host.load(this.urlFor(entry));
    const prelude = this.strategy.preludeScript();
    if (prelude === null) return;
    const raw = await host.evaluate(prelude);
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; stack?: string };
    if (parsed.error) {
      quireFail(
        'PRELUDE_FAILED',
        `${this.strategy.name} could not put its engine into the frame for ${entry}: `
        + `${parsed.error}\n${parsed.stack ?? ''}`.trim(),
      );
    }
    if (parsed.ok !== true) {
      quireFail(
        'PRELUDE_FAILED',
        `${this.strategy.name}'s prelude for ${entry} returned ${raw.slice(0, 200)}, which is `
        + 'neither an ok nor an error',
      );
    }
  }

  private buildPageIndex(totalPages: number): void {
    this.pageIndex = Array.from({ length: totalPages }, () => [] as QuireBlock[]);
    for (const layout of this.layouts) {
      layout.localPages.forEach((blocks, localPage) => {
        const globalPage = layout.pageOffset + localPage;
        for (const block of blocks) {
          this.pageIndex[globalPage].push({
            ...block,
            bbox: { ...block.bbox },
            splitFrom: block.splitFrom === null ? null : layout.pageOffset + block.splitFrom,
            splitTo: block.splitTo === null ? null : layout.pageOffset + block.splitTo,
          });
        }
      });
    }
  }

  private buildReport(layoutMs: number): QuireReport {
    const stampedIds: string[] = [];
    const unplaced: QuireUnplaced[] = [];
    const overflows: QuireOverflow[] = [];
    for (const layout of this.layouts) {
      stampedIds.push(...layout.stampedIds);
      unplaced.push(...layout.unplaced);
      for (const over of layout.overflows) {
        overflows.push({ ...over, page: layout.pageOffset + over.page });
      }
    }
    return {
      documents: this.layouts.map((l) => l.entry),
      documentPageOffsets: this.layouts.map((l) => l.pageOffset),
      stampedIds,
      unplaced,
      overflows,
      spineWarnings: this.archive.spineWarnings,
      layoutMs,
    };
  }

  /** Everything the layout learned beyond the pages themselves. */
  getReport(): QuireReport {
    this.assertLaidOut();
    return this.report as QuireReport;
  }

  countPages(): number {
    this.assertLaidOut();
    return this.pageIndex.length;
  }

  loadPage(n: number): QuirePage {
    this.assertLaidOut();
    if (!Number.isInteger(n) || n < 0 || n >= this.pageIndex.length) {
      quireFail('PAGE_OUT_OF_RANGE', `page ${n} does not exist; the book has ${this.pageIndex.length}`);
    }
    return new QuirePage(this, n, this.pageIndex[n]);
  }

  /**
   * Fail loudly if any stamped element got no page.
   *
   * Callers whose correctness depends on every element having a page — anything
   * that maps a deletion back to markup — should call this rather than read
   * `getReport().unplaced` and hope. Books legitimately contain elements that
   * render nothing, so this is not called automatically; it is offered so that a
   * caller who cannot tolerate one says so.
   */
  assertEveryStampPlaced(): void {
    const { unplaced } = this.getReport();
    if (unplaced.length === 0) return;
    const sample = unplaced.slice(0, 10)
      .map((u) => `${u.id} (<${u.tag}> in ${u.document}, display:${u.display})`).join('; ');
    quireFail(
      'STAMPS_UNPLACED',
      `${unplaced.length} stamped element(s) got no page: ${sample}`
      + (unplaced.length > 10 ? ` … and ${unplaced.length - 10} more` : ''),
    );
  }

  // ── Display ───────────────────────────────────────────────────────────

  /** The document and local page a global page number belongs to. */
  private locate(page: number): { layout: DocumentLayout; localPage: number } {
    this.assertLaidOut();
    for (const layout of this.layouts) {
      if (page >= layout.pageOffset && page < layout.pageOffset + layout.pageCount) {
        return { layout, localPage: page - layout.pageOffset };
      }
    }
    quireFail('PAGE_OUT_OF_RANGE', `page ${page} belongs to no spine document`);
  }

  /**
   * Everything a display surface needs to put one page on screen, as plain data
   * that can cross to the renderer.
   */
  getPageMount(page: number, scale = 1): QuirePageMount {
    const geometry = this.requireGeometry();
    if (!Number.isFinite(scale) || scale <= 0) {
      quireFail('BAD_SCALE', `getPageMount(): scale must be a positive finite number, got ${String(scale)}`);
    }
    const { layout, localPage } = this.locate(page);
    return {
      page,
      document: layout.entry,
      url: this.urlFor(layout.entry),
      width: geometry.width,
      height: geometry.height,
      scale,
      boxModel: this.strategy.boxModel,
      localPage,
      documentPageCount: layout.pageCount,
      layoutCss: this.strategy.layoutCss(geometry),
      preludeScript: this.strategy.preludeScript(),
      presentScript: this.strategy.presentScript(geometry, localPage, scale),
    };
  }

  /**
   * Drive a host — a visible one — to show a page. The same call the analysis
   * host uses to line up a raster, which is what keeps what the user sees and
   * what was measured the same thing.
   */
  async presentPage(page: number, host: QuireHost, scale = 1): Promise<void> {
    const geometry = this.requireGeometry();
    const { layout, localPage } = this.locate(page);
    await this.loadInto(host, layout.entry);
    const raw = await host.evaluate(this.strategy.presentScript(geometry, localPage, scale));
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string };
    if (parsed.error) {
      quireFail('PRESENT_FAILED', `page ${page} (${layout.entry} local page ${localPage}): ${parsed.error}`);
    }
  }

  /** @internal — reached through `QuirePage.toPng`. */
  async renderPageToPng(page: number, scale: number): Promise<Buffer> {
    const geometry = this.requireGeometry();
    if (!Number.isFinite(scale) || scale <= 0) {
      quireFail('BAD_SCALE', `toPng(): scale must be a positive finite number, got ${String(scale)}`);
    }
    const host = this.analysisHost;
    if (!host) quireFail('NOT_LAID_OUT', 'toPng() needs the analysis surface, which is gone');
    const { layout, localPage } = this.locate(page);

    const spineIndex = this.archive.spine.findIndex((s) => s.entry === layout.entry);
    if (this.loadedDocument !== spineIndex) {
      await this.loadInto(host, layout.entry);
      this.loadedDocument = spineIndex;
      this.presentedPage = -1;
    }
    if (this.presentedPage !== localPage || this.presentedScale !== scale) {
      // The surface is sized BEFORE the page is brought to the origin, not
      // after. With `fragmented-boxes` the pages stack down one document and the
      // last one can only reach the origin if the viewport is exactly a page
      // tall; sizing afterwards would move it back off again.
      await host.resize(geometry.width * scale, geometry.height * scale);
      const raw = await host.evaluate(this.strategy.presentScript(geometry, localPage, scale));
      const parsed = JSON.parse(raw) as { ok?: boolean; error?: string };
      if (parsed.error) {
        quireFail('PRESENT_FAILED', `page ${page} (${layout.entry} local page ${localPage}): ${parsed.error}`);
      }
      this.presentedPage = localPage;
      this.presentedScale = scale;
    }
    if (!host.capture) {
      quireFail('HOST_CANNOT_CAPTURE', 'the analysis host does not rasterize');
    }
    return host.capture(geometry.width * scale, geometry.height * scale);
  }

  // ── Housekeeping ──────────────────────────────────────────────────────

  private urlFor(entry: string): string {
    return `quire://${this.sessionId}/${entry.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Validate a caller's page box and resolve the optional gap. One reader, two callers. */
  private resolveGeometry(options: QuireLayoutOptions, caller: string): QuireGeometry {
    for (const [key, value] of Object.entries(options)) {
      if (key === 'gap' && value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        quireFail('BAD_GEOMETRY', `${caller}: ${key} must be a positive finite number, got ${String(value)}`);
      }
    }
    return {
      width: options.width,
      height: options.height,
      fontSize: options.fontSize,
      gap: options.gap ?? QUIRE_COLUMN_GAP,
    };
  }

  private requireGeometry(): QuireGeometry {
    this.assertLaidOut();
    return this.geometry as QuireGeometry;
  }

  private assertOpen(): void {
    if (this.closed) quireFail('DOCUMENT_CLOSED', `${this.epubPath} has been closed`);
  }

  private assertLaidOut(): void {
    this.assertOpen();
    if (!this.report || !this.geometry) {
      quireFail(
        'NOT_LAID_OUT',
        'await doc.layout({width, height, fontSize}) first. layout() is asynchronous because a '
        + 'browser lays out asynchronously; answering from a stale layout would be worse than '
        + 'refusing.',
      );
    }
  }

  /** Idempotent, and safe to call from a `finally` on a path that never opened. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.analysisHost) { this.analysisHost.destroy(); this.analysisHost = null; }
    if (this.attached) { this.attached.detach(); this.attached = null; }
    if (this.ses) {
      try { await this.ses.clearStorageData(); } catch { /* an in-memory partition may already be gone */ }
      this.ses = null;
    }
    this.archive.close();
    this.overrides.clear();
    this.sourceOverrides.clear();
  }
}
