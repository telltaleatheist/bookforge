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
}

interface DocumentLayout {
  entry: string;
  pageOffset: number;
  pageCount: number;
  measurement: StrategyMeasurement;
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
    this.archive = new QuireArchive(epubPath);
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
    for (const [key, value] of Object.entries(options)) {
      if (key === 'gap' && value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        quireFail('BAD_GEOMETRY', `layout(): ${key} must be a positive finite number, got ${String(value)}`);
      }
    }
    const geometry: QuireGeometry = {
      width: options.width,
      height: options.height,
      fontSize: options.fontSize,
      gap: options.gap ?? QUIRE_COLUMN_GAP,
    };
    this.geometry = geometry;

    const started = Date.now();
    const layoutCss = this.strategy.layoutCss(geometry);

    // Build every shell up front so the protocol handler can answer for any
    // document — the display surface may ask for a page in a chapter the
    // analysis host never got to.
    for (const spineDoc of this.archive.spine) {
      const source = await this.archive.readText(spineDoc.entry);
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
      this.layouts.push({
        entry: spineDoc.entry, pageOffset, pageCount: parsed.pageCount, measurement: parsed,
      });
      pageOffset += parsed.pageCount;
    }
    this.loadedDocument = this.archive.spine.length - 1;
    this.presentedPage = -1;

    this.buildPageIndex(pageOffset);
    this.report = this.buildReport(Date.now() - started);
    return this.report;
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
      for (const placement of layout.measurement.placed) {
        const pages = placement.fragments.map((f) => f.page);
        const spans = pages.length > 1;
        const splitFrom = spans ? layout.pageOffset + Math.min(...pages) : null;
        const splitTo = spans ? layout.pageOffset + Math.max(...pages) : null;
        for (const fragment of placement.fragments) {
          const globalPage = layout.pageOffset + fragment.page;
          for (const id of placement.ids) {
            this.pageIndex[globalPage].push({
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
    }
  }

  private buildReport(layoutMs: number): QuireReport {
    const stampedIds: string[] = [];
    const unplaced: QuireUnplaced[] = [];
    const overflows: QuireOverflow[] = [];
    for (const layout of this.layouts) {
      for (const placement of layout.measurement.placed) {
        for (const id of placement.ids) stampedIds.push(id);
      }
      for (const miss of layout.measurement.unplaced) {
        for (const id of miss.ids) {
          stampedIds.push(id);
          unplaced.push({
            id, document: layout.entry, tag: miss.tag,
            reason: 'not-rendered', display: miss.display, hasText: miss.hasText,
          });
        }
      }
      for (const over of layout.measurement.overflows) {
        for (const id of over.ids) {
          overflows.push({
            id, document: layout.entry,
            page: layout.pageOffset + over.page, axis: over.axis, overshoot: over.overshoot,
          });
        }
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
  }
}
