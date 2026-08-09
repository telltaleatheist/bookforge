/**
 * The Paged.js strategy — quire's product fragmenter.
 *
 * Paged.js 0.4.3 (vendored, `packages/quire/vendor/pagedjs/`) chunks the flow
 * into real DOM page boxes: one `.pagedjs_page` subtree per page, inside ONE
 * document instance. That is the `fragmented-boxes` box model, and it is why
 * this and not CSS multi-column is what a reader sees — see the README's
 * "Strategy — SETTLED (gate G0)" for the numbers that decided it. The headline
 * one: on *Killing America* Paged.js puts all ten images each on exactly one
 * page, where mupdf and multi-column both slice two of bm01's plates across a
 * page break.
 *
 * ── How the engine gets into the frame ─────────────────────────────────────
 *
 * NOT as a `<script>` in the book's document. The book is served under
 * `script-src 'none'` and with every `<script>` stripped from the bytes, and
 * neither of those loosens for this. The bundle is quire's own trusted code and
 * it is injected the same way the measurement is: evaluated in an ISOLATED
 * world, from the main process, through {@link QuireStrategy.preludeScript}. The
 * book's world never sees `Paged`, cannot call it, and cannot tamper with the
 * pagination that decides its own page numbers.
 *
 * ── What this strategy does to the book ────────────────────────────────────
 *
 * More than multi-column does, and all of it stated:
 *
 *  - the book's own `<style>` and `<link rel=stylesheet>` are taken out of the
 *    document and handed to Paged.js's polisher as TEXT, read back from the
 *    CSSOM the browser already built. That is Paged.js's own design (it has to
 *    rewrite `@page`, `break-*` and the split pseudo-elements), and reading the
 *    CSSOM rather than re-fetching is what keeps it inside the sandbox: the
 *    `quire://` scheme deliberately does not support the fetch API, so the
 *    polisher's own `request()` path could not have worked. A `<link>` pointing
 *    off `quire://` produced no CSSOM because the sandbox refused it; that link
 *    is dropped, which is the sandbox working rather than a pagination failure.
 *  - Paged.js re-parents the content into page boxes, cloning the ancestor chain
 *    onto each page it continues on. A selector like `body > p` therefore stops
 *    matching, where under multi-column it still would. This is inherent to
 *    fragmenting into boxes and is the price of the box model.
 *  - replaced elements are capped at the PAGE BOX — `max-height` as well as
 *    `max-width`. Multi-column deliberately caps only width, so a tall figure is
 *    sliced; here it is not, and that is the whole point. A book that says
 *    `max-height: 100%` on a plate is saying nothing at all, because a
 *    percentage max-height resolves against an auto-height containing block and
 *    computes to `none` — which is how a 2400px plate ends up laid out at 2400px
 *    inside a 900px page.
 *
 * ── How a page number is decided ───────────────────────────────────────────
 *
 * Two independent answers, and a disagreement is refused rather than resolved:
 *
 *  1. quire's own: which page BOX an element's `Range.getClientRects()` land in.
 *     Geometry, measured, exactly as the multi-column strategy measures it.
 *  2. Paged.js's own: `data-ref` groups an element's clones, and
 *     `data-split-from` / `data-split-to` say which of them are continuations.
 *
 * Trusting (2) alone would trust an attribute; trusting (1) alone would throw
 * away the mapping the engine actually used. So both are computed and compared,
 * and `SPLIT_DISAGREEMENT` names the element when they differ.
 */
import * as fs from 'fs';
import * as path from 'path';
import { quireFail } from '../errors';
import type { QuireGeometry, QuirePageBoxModel } from '../types';
import type { QuireStrategy } from './strategy';

/** The version vendored under `packages/quire/vendor/pagedjs/`. */
export const PAGEDJS_VERSION = '0.4.3';

/**
 * Slack, in CSS pixels, on box arithmetic. Sub-pixel layout makes an exact
 * comparison superstition; half a pixel of drift is still agreement. Chromium's
 * LayoutUnit is 1/64px, so this is 32 of them.
 */
const BOX_TOLERANCE = 0.5;

/**
 * Pages one spine document may produce before quire calls it a runaway. This is
 * not a limit on how long a chapter may be — the longest chapter of a real book
 * is a couple of dozen pages — it is the guard that stops a fragmenter that
 * cannot converge from spinning forever with nothing to say about it.
 */
const RUNAWAY_PAGE_GUARD = 5000;

/** Read once per process; the bundle is a megabyte and does not change. */
let cachedBundle: string | null = null;

/**
 * The vendored bundle, from the ONE place it is allowed to live: the quire
 * package's own `vendor/` directory, resolved relative to this compiled module.
 * `npm run build:quire-vendor` is what puts it beside the compiled output; if it
 * is not there this refuses and says so, because paginating without the engine
 * that the page map is defined in terms of is not a thing quire can do
 * approximately.
 */
function vendoredPagedJs(): string {
  if (cachedBundle !== null) return cachedBundle;
  const file = path.join(__dirname, '..', '..', 'vendor', 'pagedjs', 'paged.js');
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    quireFail(
      'PAGEDJS_BUNDLE_MISSING',
      `the vendored Paged.js bundle is not at ${file} (${String((err as Error).message)}). `
      + 'It is a build artifact of `npm run build:quire-vendor`, which copies '
      + 'packages/quire/vendor/ into dist/. quire will not paginate without it and will not '
      + 'silently fall back to another fragmenter, because a page map is only meaningful '
      + 'together with the paginator that produced it.',
    );
  }
  const banner = new RegExp(`@license Paged\\.js v${PAGEDJS_VERSION.replace(/\./g, '\\.')}\\b`);
  if (!banner.test(source.slice(0, 512))) {
    quireFail(
      'PAGEDJS_BUNDLE_UNRECOGNISED',
      `${file} does not carry the Paged.js v${PAGEDJS_VERSION} licence banner in its first `
      + '512 bytes. quire pins the fragmenter version because the page map depends on it; '
      + 'refusing to paginate with a bundle it cannot identify.',
    );
  }
  cachedBundle = source;
  return source;
}

/** The numbers the in-page scripts work from. A seam, so a test can doctor one. */
export interface PagedConfig {
  /** Page box width in CSS pixels. */
  width: number;
  /** Page box height in CSS pixels. */
  height: number;
  /** Slack on every box comparison. */
  tolerance: number;
  /** Pages one document may produce before pagination is called a runaway. */
  maxPages: number;
  /**
   * quire's own page-box CSS, handed to Paged.js's polisher as the LAST sheet so
   * it wins. It is passed as text rather than harvested from the document's
   * `<style>` because that round trip goes through the CSSOM, and quire will not
   * discover after the fact that `@page { size: … }` did not survive it.
   */
  layoutCss: string;
}

export class PagedStrategy implements QuireStrategy {
  readonly name = `pagedjs-${PAGEDJS_VERSION}`;
  /**
   * Each page is its own DOM subtree inside ONE document instance, so a grid can
   * mount many pages without one frame per cell.
   */
  readonly boxModel: QuirePageBoxModel = 'fragmented-boxes';

  layoutCss(g: QuireGeometry): string {
    const { width: w, height: h, fontSize } = g;
    return [
      '/* quire: the page box. Appended last so it wins over the book, and handed',
      '   to Paged.js\'s polisher last for the same reason. */',
      `@page{size:${w}px ${h}px;margin:0;}`,
      'html{',
      'margin:0!important;padding:0!important;border:0!important;',
      `font-size:${fontSize}px!important;`,
      // NOT overflow:hidden. The page boxes stack down the document and the
      // present script scrolls one of them to the origin; a clipped root cannot
      // scroll, and a page that will not come to the origin is refused.
      //
      // The scrollbar that comes with that would take its width out of the
      // layout viewport, so a surface sized to the page would show the page
      // minus a scrollbar — and a raster of it would be a page with its right
      // edge sliced off. Taking the scrollbar's width to zero is a change to
      // what is drawn, never to what is laid out: the page boxes are absolute
      // pixels from `@page`, so they do not move.
      'scrollbar-width:none!important;',
      '}',
      'html::-webkit-scrollbar,body::-webkit-scrollbar{',
      'width:0!important;height:0!important;display:none!important;',
      '}',
      'body{margin:0!important;padding:0!important;border:0!important;}',
      // Page boxes stacked flush at x=0, so page N's origin is a scroll offset
      // and nothing else. Paged.js's base sheet leaves these alone; a book that
      // set them would move the page boxes out from under the arithmetic.
      '.pagedjs_pages{display:block!important;}',
      '.pagedjs_page{margin:0!important;}',
      // Capped at the PAGE BOX, height included — the difference from the
      // multi-column strategy, and the one that buys correct image placement. A
      // plate taller than the page is scaled to the page rather than sliced
      // across two, which is what a reader means by "the plate is on page 181".
      'body img,body svg,body video,body canvas,body object,body embed,body picture{',
      `max-width:${w}px!important;max-height:${h}px!important;height:auto!important;`,
      '}',
    ].join('');
  }

  /**
   * The numbers the in-page scripts work from, as their own seam so that a test
   * can doctor one and prove the assertions really fire.
   */
  protected pagedConfig(g: QuireGeometry): PagedConfig {
    return {
      width: g.width,
      height: g.height,
      tolerance: BOX_TOLERANCE,
      maxPages: RUNAWAY_PAGE_GUARD,
      layoutCss: this.layoutCss(g),
    };
  }

  /**
   * The fragmenter itself, as trusted code for the isolated world. Evaluated
   * once per frame load, before anything measures or presents.
   */
  preludeScript(): string {
    // Deliberately NOT strict-mode-wrapped and not an arrow: the bundle is UMD
    // and reads `this` at its call site. It prefers `globalThis` when there is
    // one — there always is here — so `Paged` lands on the ISOLATED world's
    // global and is invisible to the book's world.
    return '(function(){try{'
      + vendoredPagedJs()
      + '\n;if(!(globalThis.Paged&&globalThis.Paged.Previewer)){'
      + 'throw new Error("the bundle evaluated but defined no Paged.Previewer");}'
      + `return JSON.stringify({ok:true,engine:"pagedjs",version:${JSON.stringify(PAGEDJS_VERSION)}});`
      + '}catch(e){return JSON.stringify({error:String((e&&e.message)||e),'
      + 'stack:String((e&&e.stack)||"")});}})()';
  }

  measureScript(g: QuireGeometry): string {
    const cfg = JSON.stringify(this.pagedConfig(g));
    return `(${MEASURE_SOURCE})(${cfg},${PAGINATE_SOURCE})`;
  }

  presentScript(g: QuireGeometry, localPage: number, scale: number): string {
    const cfg = JSON.stringify({ ...this.pagedConfig(g), page: localPage, scale });
    return `(${PRESENT_SOURCE})(${cfg},${PAGINATE_SOURCE})`;
  }
}

// ── The in-page scripts ─────────────────────────────────────────────────────
//
// Written as self-contained functions with no closure over anything, so the only
// things that cross the boundary are a config object in and a JSON string out.
// They run in an isolated world against the book's DOM: they can read and lay
// out the document, the book can neither see nor reach them, and the page's
// `script-src 'none'` does not apply to them.

/** What {@link PAGINATE_SOURCE} hands back. */
interface PaginateResult {
  pageCount: number;
  paginateMs: number;
  /** True when a previous call had already chunked this frame. */
  reused: boolean;
  /** Book stylesheets handed to the polisher. */
  sheets: number;
  /** `<link>`s the sandbox had already refused, so they carried no CSSOM. */
  droppedRemoteSheets: number;
}

type PaginateFn = (
  cfg: PagedConfig,
  beforeHarvest: (() => void) | null,
) => Promise<PaginateResult>;

/**
 * Chunk the loaded document into `.pagedjs_page` boxes. Idempotent: a frame that
 * has already been chunked is left exactly as it is, because re-chunking would
 * silently produce a second, possibly different, page map for the same frame.
 *
 * `beforeHarvest` runs after images and fonts have settled and BEFORE the book's
 * stylesheets are removed — the only moment at which the un-paginated document
 * can be asked what it computes to. The measurement uses it to take the roster of
 * stamped elements; presentation passes null.
 */
const PAGINATE_SOURCE = (async function quirePagedPaginate(
  cfg: PagedConfig,
  beforeHarvest: (() => void) | null,
): Promise<PaginateResult> {
  const fail: (code: string, detail: string) => never = (code, detail) => {
    throw new Error('QUIRE_PAGED/' + code + ': ' + detail);
  };

  const already = document.querySelector('.pagedjs_pages');
  if (already) {
    return {
      pageCount: document.querySelectorAll('.pagedjs_page').length,
      paginateMs: 0, reused: true, sheets: 0, droppedRemoteSheets: 0,
    };
  }

  const paged = (globalThis as unknown as { Paged?: { Previewer: new () => unknown } }).Paged;
  if (!paged || !paged.Previewer) {
    fail('PAGEDJS_NOT_LOADED',
      'Paged.js is not present in this world. The strategy\'s preludeScript() must be '
      + 'evaluated in the same isolated world, after the frame loads and before anything '
      + 'measures or presents.');
  }
  const body = document.body;
  if (!body) fail('NO_BODY', 'the document has no <body>');

  // ── Let the content settle ────────────────────────────────────────────
  //
  // Paged.js decides where a page breaks from measured geometry. An <img> that
  // has not loaded measures 0px tall, so pagination would run against heights
  // that are about to change — which is not a slightly different page map, it is
  // a page map of a document that never existed. A refused remote image fires
  // `error`, which settles it just as well as `load`.
  const pending: HTMLImageElement[] = [];
  for (let i = 0; i < document.images.length; i++) {
    const img = document.images[i];
    if (!img.complete) pending.push(img);
  }
  if (pending.length > 0) {
    await Promise.all(pending.map((img) => new Promise<void>((resolve) => {
      const settled = (): void => resolve();
      img.addEventListener('load', settled, { once: true });
      img.addEventListener('error', settled, { once: true });
    })));
  }
  await document.fonts.ready;

  if (beforeHarvest) beforeHarvest();

  // ── The book's stylesheets, as text, from the CSSOM ───────────────────
  //
  // Paged.js's polisher needs the CSS as text because it rewrites it. Its own
  // path for a <link> is to fetch the href, and `quire://` is registered with
  // `supportFetchAPI: false` precisely so that nothing inside a book document
  // can fetch anything. So the text comes from the stylesheet the browser has
  // ALREADY parsed and applied. That round trip is lossless with respect to what
  // is actually in force: a rule Chromium did not parse was never applied.
  //
  // url() values come back absolutised against the sheet, so the polisher has
  // nothing to rebase and a figure referenced from a chapter's stylesheet still
  // resolves to its own `quire://` address.
  let droppedRemoteSheets = 0;
  const serializeSheet = (sheet: CSSStyleSheet, depth: number): string => {
    if (depth > 8) {
      fail('STYLESHEET_IMPORT_DEPTH',
        'a stylesheet @imports more than 8 levels deep; refusing to keep unwinding');
    }
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch (err) {
      fail('STYLESHEET_UNREADABLE',
        'the rules of "' + String(sheet.href || '<inline>') + '" could not be read ('
        + String((err as Error).message) + '). Every sheet in a quire document is same-origin, '
        + 'so this should not be possible; quire will not paginate against CSS it cannot see.');
    }
    let out = '';
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.type === CSSRule.IMPORT_RULE) {
        const href = String((rule as CSSImportRule).href || '');
        // Decided by ORIGIN, before anything is read. A blocked cross-origin
        // sheet is not absent — Chromium still hands out a CSSStyleSheet object
        // for it — it is merely unreadable, and telling those two apart by
        // catching the SecurityError would be reading the sandbox's mind. An
        // @import that does not point into the archive contributes nothing
        // because the sandbox already refused it.
        const absolute = new URL(href, sheet.href || location.href).href;
        if (absolute.indexOf('quire:') !== 0) {
          droppedRemoteSheets++;
          continue;
        }
        const imported = (rule as CSSImportRule).styleSheet;
        if (!imported) {
          fail('STYLESHEET_UNREADABLE',
            '@import "' + href + '" is inside the archive but produced no stylesheet');
        }
        out += serializeSheet(imported, depth + 1) + '\n';
        continue;
      }
      out += rule.cssText + '\n';
    }
    return out;
  };

  const sheets: Array<Record<string, string>> = [];
  const styleNodes: Element[] = [];
  const found = document.querySelectorAll('link[rel~="stylesheet"],style');
  for (let i = 0; i < found.length; i++) styleNodes.push(found[i]);
  let inlineOrdinal = 0;
  for (const el of styleNodes) {
    // quire's own page box comes from cfg.layoutCss below, verbatim. Serialising
    // it out of the CSSOM instead would mean discovering only at layout time
    // whether `@page { size: … }` survived the round trip.
    if (el.getAttribute('data-quire') === 'layout') { el.remove(); continue; }

    const isLink = String(el.tagName).toUpperCase() === 'LINK';
    const href = isLink ? String((el as HTMLLinkElement).href || '') : '';
    if (isLink && href.indexOf('quire:') !== 0) {
      // A stylesheet pointing off the archive. The CSP and the session's request
      // rule already refused it, so it carries nothing, and dropping it is what
      // the book was always going to get.
      //
      // Decided on the HREF and before anything is read, because a refused
      // remote sheet is not absent: Chromium still exposes a CSSStyleSheet for
      // it, and reading its `cssRules` throws a SecurityError. Reaching that
      // throw and treating it as "remote, therefore fine" would make a genuinely
      // unreadable sheet inside the archive look like a blocked one.
      droppedRemoteSheets++;
      el.remove();
      continue;
    }
    const sheet = (el as HTMLLinkElement | HTMLStyleElement).sheet;
    if (!sheet) {
      fail('STYLESHEET_UNREADABLE',
        'the ' + (isLink ? 'stylesheet "' + href + '"' : 'inline <style>')
        + ' produced no CSSOM. It is inside the archive, so it should have loaded; quire '
        + 'will not paginate against CSS it cannot see.');
    }
    let text = serializeSheet(sheet, 0);
    const media = String(el.getAttribute('media') || '').trim();
    if (media && media.toLowerCase() !== 'all') text = '@media ' + media + '{' + text + '}';
    const key = href || (location.href + '#quire-inline-' + inlineOrdinal++);
    const record: Record<string, string> = {};
    record[key] = text;
    sheets.push(record);
    el.remove();
  }
  const layoutRecord: Record<string, string> = {};
  layoutRecord[location.href + '#quire-layout'] = cfg.layoutCss;
  sheets.push(layoutRecord);

  // ── Chunk ─────────────────────────────────────────────────────────────
  const previewer = new (paged.Previewer as new () => {
    wrapContent(): DocumentFragment;
    preview(content: DocumentFragment, sheets: unknown[], renderTo: Element): Promise<{
      total: number;
    }>;
    on(event: string, handler: () => void): void;
    chunker: { stop(): void };
  })();

  let emitted = 0;
  let runaway: string | null = null;
  previewer.on('page', () => {
    emitted++;
    if (emitted > cfg.maxPages && !runaway) {
      runaway = 'Paged.js emitted more than ' + cfg.maxPages + ' pages for one spine document, '
        + 'which means the fragmentation is not converging rather than that the chapter is long.';
      previewer.chunker.stop();
    }
  });

  const content = previewer.wrapContent();
  const started = performance.now();
  const flow = await previewer.preview(content, sheets, body);
  const paginateMs = performance.now() - started;
  if (runaway) fail('PAGINATION_RUNAWAY', runaway);

  const boxes = document.querySelectorAll('.pagedjs_page').length;
  if (boxes === 0) {
    fail('NO_PAGE_BOXES',
      'Paged.js reported ' + flow.total + ' page(s) but left no .pagedjs_page box in the '
      + 'document, so there is nothing to assign a page number against.');
  }
  if (boxes !== flow.total) {
    fail('PAGE_COUNT_DISAGREEMENT',
      'Paged.js reports ' + flow.total + ' pages but the document holds ' + boxes
      + ' .pagedjs_page boxes. quire cannot say which of the two is the page count.');
  }

  return {
    pageCount: boxes,
    paginateMs: +paginateMs.toFixed(1),
    reused: false,
    sheets: sheets.length,
    droppedRemoteSheets,
  };
}).toString();

/**
 * The measurement. Paginates, then reads the page map two ways — geometry, and
 * Paged.js's own `data-ref` / `data-split-*` — and refuses if they disagree.
 */
const MEASURE_SOURCE = (async function quirePagedMeasure(
  cfg: PagedConfig,
  paginate: PaginateFn,
): Promise<string> {
  // The explicit annotation is load-bearing: without it TypeScript will not
  // treat a call to `fail` as terminating, and every check below would read as
  // fall-through.
  const fail: (code: string, detail: string) => never = (code, detail) => {
    throw new Error('QUIRE_MEASURE/' + code + ': ' + detail);
  };

  const REPLACED: Record<string, number> = {
    IMG: 1, SVG: 1, IMAGE: 1, CANVAS: 1, VIDEO: 1, OBJECT: 1, EMBED: 1, PICTURE: 1, IFRAME: 1,
  };
  const tagOf = (el: Element): string => String(el.tagName || '').toUpperCase();
  const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

  try {
    const W = cfg.width, H = cfg.height, TOL = cfg.tolerance;

    // ── The roster, taken before the book's CSS is removed ───────────────
    //
    // An element that gets no page has to be reported as itself — its tag, what
    // it computed to, whether it had words — and the only moment those are
    // knowable is while the un-paginated document is still standing with its own
    // stylesheets applied. After chunking, an element that rendered nothing is
    // simply not there to ask.
    interface RosterEntry { rawId: string; tag: string; display: string; hasText: boolean; }
    const roster: RosterEntry[] = [];
    const rosterByRawId: Record<string, number> = {};
    const takeRoster = (): void => {
      const stamped = document.body.querySelectorAll('[data-quire-id]');
      for (let i = 0; i < stamped.length; i++) {
        const el = stamped[i];
        const rawId = el.getAttribute('data-quire-id') as string;
        if (rosterByRawId[rawId] !== undefined) {
          fail('DUPLICATE_STAMP',
            'the stamp "' + rawId + '" is on more than one element in this document. quire '
            + 'reports the caller\'s own id and cannot say which element a page number '
            + 'belongs to when two share one.');
        }
        rosterByRawId[rawId] = roster.length;
        roster.push({
          rawId,
          tag: tagOf(el).toLowerCase(),
          display: getComputedStyle(el).display,
          hasText: collapse(el.textContent || '').length > 0,
        });
      }
    };

    const pagination = await paginate(cfg, takeRoster);
    const pageCount = pagination.pageCount;

    // ── The page boxes ───────────────────────────────────────────────────
    const pageEls: Element[] = [];
    const boxes = document.querySelectorAll('.pagedjs_page');
    for (let i = 0; i < boxes.length; i++) pageEls.push(boxes[i]);
    if (pageEls.length !== pageCount) {
      fail('PAGE_COUNT_DISAGREEMENT',
        'pagination reported ' + pageCount + ' pages but the document now holds '
        + pageEls.length + ' page boxes');
    }

    const originX: number[] = [];
    const originY: number[] = [];
    for (let i = 0; i < pageEls.length; i++) {
      const numbered = pageEls[i].getAttribute('data-page-number');
      if (numbered === null) {
        fail('PAGE_NOT_NUMBERED', 'page box ' + i + ' carries no data-page-number');
      }
      // Paged.js numbers from 1 and lays the boxes out in order. If those two
      // ever disagree, every page number after the disagreement is off, so it is
      // checked rather than assumed.
      if (Number(numbered) !== i + 1) {
        fail('PAGE_OUT_OF_ORDER',
          'page box at position ' + i + ' says it is page ' + numbered
          + '; the boxes are not in page order and quire will not reorder them.');
      }
      const content = pageEls[i].querySelector('.pagedjs_page_content');
      if (!content) {
        fail('PAGE_BOX_INCOMPLETE',
          'page box ' + i + ' has no .pagedjs_page_content, so it has no content origin');
      }
      const rect = content.getBoundingClientRect();
      // The direct check on the layout, the counterpart of the multi-column
      // strategy's COLUMN_GAP_MISMATCH: if `@page { size }` did not reach the
      // fragmenter, Paged.js silently uses its own default (US Letter) and every
      // box would be measured against a page that is not the page. Caught on the
      // first box of the first document rather than inferred later.
      if (Math.abs(rect.width - W) > TOL || Math.abs(rect.height - H) > TOL) {
        fail('PAGE_BOX_MISMATCH',
          'page box ' + i + ' lays out at ' + rect.width.toFixed(3) + '×'
          + rect.height.toFixed(3) + 'px but the page arithmetic assumes ' + W + '×' + H
          + 'px. The @page size quire asked for did not reach the fragmenter, so every '
          + 'page-local coordinate would be measured against the wrong box.');
      }
      originX.push(rect.left);
      originY.push(rect.top);
    }

    // ── Occurrences, grouped by Paged.js's own identity for the element ──
    //
    // `data-ref` is what Paged.js itself uses to know that the <p> on page 12 and
    // the <p> on page 13 are one paragraph. Grouping by it rather than by the
    // stamp means quire is reading the engine's answer, not re-deriving one.
    interface Occurrence {
      page: number; els: Element[]; splitFrom: boolean; splitTo: boolean;
    }
    interface Group { rawId: string; tag: string; pages: number[]; byPage: Record<number, Occurrence>; }
    const groups: Record<string, Group> = {};
    const groupOrder: string[] = [];
    let occurrences = 0;
    let duplicateOccurrences = 0;

    for (let p = 0; p < pageEls.length; p++) {
      const stamped = pageEls[p].querySelectorAll('[data-quire-id]');
      for (let i = 0; i < stamped.length; i++) {
        const el = stamped[i];
        const rawId = el.getAttribute('data-quire-id') as string;
        const ref = el.getAttribute('data-ref');
        if (ref === null) {
          fail('NO_DATA_REF',
            'the element stamped "' + rawId + '" on page ' + p + ' carries no data-ref, so '
            + 'Paged.js\'s own account of which fragments are one element is missing for it.');
        }
        occurrences++;
        let group = groups[ref];
        if (!group) {
          group = { rawId, tag: tagOf(el).toLowerCase(), pages: [], byPage: {} };
          groups[ref] = group;
          groupOrder.push(ref);
        } else if (group.rawId !== rawId) {
          fail('REF_COLLISION',
            'Paged.js gave data-ref "' + ref + '" to two elements stamped differently ("'
            + group.rawId + '" and "' + rawId + '"), so its account of element identity and '
            + 'quire\'s cannot be reconciled.');
        }
        let occurrence = group.byPage[p];
        if (!occurrence) {
          occurrence = { page: p, els: [], splitFrom: false, splitTo: false };
          group.byPage[p] = occurrence;
          group.pages.push(p);
        } else {
          duplicateOccurrences++;
        }
        occurrence.els.push(el);
        if (el.hasAttribute('data-split-from')) occurrence.splitFrom = true;
        if (el.hasAttribute('data-split-to')) occurrence.splitTo = true;
      }
    }

    // ── Fragments, and the two accounts compared ─────────────────────────
    const rectsOf = (el: Element): DOMRect[] => {
      const out: DOMRect[] = [];
      const range = document.createRange();
      range.selectNodeContents(el);
      const viaRange = range.getClientRects();
      for (let i = 0; i < viaRange.length; i++) {
        const r = viaRange[i];
        if (r.width > 0 && r.height > 0) out.push(r);
      }
      if (out.length > 0) return out;
      // A replaced element has no contents to select — an <img> gives a Range no
      // rects at all — so its own border boxes are the fragments.
      const viaElement = el.getClientRects();
      for (let i = 0; i < viaElement.length; i++) {
        const r = viaElement[i];
        if (r.width > 0 && r.height > 0) out.push(r);
      }
      return out;
    };

    const placed: unknown[] = [];
    const overflows: unknown[] = [];
    const placedRawIds: Record<string, number> = {};
    let inkless = 0;

    for (const ref of groupOrder) {
      const group = groups[ref];
      const pages = group.pages;

      if (rosterByRawId[group.rawId] === undefined) {
        fail('STAMP_NOT_IN_ROSTER',
          'the stamp "' + group.rawId + '" appears in a page box but was not in the document '
          + 'before pagination. quire only reports ids the caller stamped.');
      }

      // 1. Paged.js's own account must be internally coherent: the clones of one
      //    element run over consecutive pages, and the continuation markers say
      //    exactly which of them are continuations.
      for (let k = 1; k < pages.length; k++) {
        if (pages[k] !== pages[0] + k) {
          fail('OCCURRENCES_NOT_CONTIGUOUS',
            'the element stamped "' + group.rawId + '" appears on pages ' + pages.join(',')
            + ', which are not consecutive. An element cannot leave a page and come back.');
        }
      }
      for (let k = 0; k < pages.length; k++) {
        const occurrence = group.byPage[pages[k]];
        const expectFrom = k > 0;
        const expectTo = k < pages.length - 1;
        if (occurrence.splitFrom !== expectFrom || occurrence.splitTo !== expectTo) {
          fail('SPLIT_DISAGREEMENT',
            'the element stamped "' + group.rawId + '" (<' + group.tag + '>) occupies page'
            + (pages.length > 1 ? 's ' : ' ') + pages.join(',') + ', so its fragment on page '
            + pages[k] + ' should ' + (expectFrom ? '' : 'not ') + 'be marked data-split-from '
            + 'and should ' + (expectTo ? '' : 'not ') + 'be marked data-split-to; Paged.js '
            + 'marks it split-from=' + occurrence.splitFrom + ' split-to=' + occurrence.splitTo
            + '. quire measured the pages and Paged.js recorded the split, and they do not '
            + 'agree — refusing rather than believing either one.');
        }
      }

      // 2. quire's own account: which page boxes the element actually inks, and
      //    where inside them.
      //
      //    Note what is NOT being decided here. Under `continuous-columns` the
      //    geometry IS the page number — a fragment's left edge is the only thing
      //    that says which column it is in — so a fragment landing in a gutter is
      //    an ambiguity and gets refused. Under `fragmented-boxes` the page is
      //    settled before any rect is read: the element is a descendant of one
      //    `.pagedjs_page` and of no other. So a rect outside the page box is not
      //    an ambiguity, it is a fact about the layout — a table wider than the
      //    page, a plate the fragmenter could not move — and the honest thing is
      //    to report it with the box it really has rather than refuse a page
      //    number that was never in doubt. Paged.js clips it (`.pagedjs_sheet`
      //    is `overflow: hidden`), so it is content the reader will not see, and
      //    `report.overflows` is where a caller finds that out.
      const boxByPage: Record<number, { x: number; y: number; r: number; b: number }> = {};
      const inkedPages: number[] = [];
      for (const p of pages) {
        const occurrence = group.byPage[p];
        let box: { x: number; y: number; r: number; b: number } | null = null;
        for (const el of occurrence.els) {
          const rects = rectsOf(el);
          for (const rect of rects) {
            const x = rect.left - originX[p];
            const y = rect.top - originY[p];
            if (!box) {
              box = { x, y, r: x + rect.width, b: y + rect.height };
            } else {
              if (x < box.x) box.x = x;
              if (y < box.y) box.y = y;
              if (x + rect.width > box.r) box.r = x + rect.width;
              if (y + rect.height > box.b) box.b = y + rect.height;
            }
          }
        }
        if (box) {
          boxByPage[p] = box;
          inkedPages.push(p);
          const outX = Math.max(-box.x, box.r - W);
          if (outX > TOL) {
            overflows.push({
              ids: group.rawId.split('|'), page: p, axis: 'x', overshoot: +outX.toFixed(3),
            });
          }
          const outY = Math.max(-box.y, box.b - H);
          if (outY > TOL) {
            overflows.push({
              ids: group.rawId.split('|'), page: p, axis: 'y', overshoot: +outY.toFixed(3),
            });
          }
        }
      }

      if (inkedPages.length === 0) {
        // Present in the page boxes and rendering nothing — a display:none
        // wrapper, an empty paragraph. It belongs with the unplaced, reported by
        // what it computed to before pagination.
        inkless++;
        continue;
      }
      // An element may render nothing on the first or last page it is cloned
      // onto — a paragraph whose words end exactly at the break carries an empty
      // continuation. That is a legitimate trim at the ENDS. A hole in the middle
      // is not: it would mean the element left a page and came back.
      for (let k = 1; k < inkedPages.length; k++) {
        if (inkedPages[k] !== inkedPages[0] + k) {
          fail('FRAGMENTS_NOT_CONTIGUOUS',
            'the element stamped "' + group.rawId + '" renders on pages ' + inkedPages.join(',')
            + ', which are not consecutive');
        }
      }

      placedRawIds[group.rawId] = 1;

      // ── Kind ─────────────────────────────────────────────────────────
      // Decided over ALL the element's clones, not one page's: a figure whose
      // caption falls on the next page still has words, and a plate that carries
      // none on its own page is still a picture.
      let allText = '';
      for (const p of pages) {
        for (const el of group.byPage[p].els) allText += el.textContent || '';
      }
      const renderedText = collapse(allText);
      const isReplaced = REPLACED[group.tag.toUpperCase()] === 1;
      let wrapsOnlyImages = false;
      if (renderedText.length === 0) {
        for (const p of pages) {
          for (const el of group.byPage[p].els) {
            if (el.querySelector('img,svg,image,canvas,video,object,embed,picture')) {
              wrapsOnlyImages = true;
            }
          }
        }
      }
      const type: 'text' | 'image' = (isReplaced || wrapsOnlyImages) ? 'image' : 'text';

      const fragments: unknown[] = [];
      for (const p of inkedPages) {
        const box = boxByPage[p];
        let text: string | null = null;
        if (type === 'text') {
          // Each page's clone physically HOLDS that page's words — Paged.js cuts
          // the text node at the break rather than hiding the overflow — so the
          // fragments divide the paragraph rather than repeating it, and no
          // character-by-character search is needed to find out where.
          let onThisPage = '';
          for (const el of group.byPage[p].els) onThisPage += el.textContent || '';
          text = collapse(onThisPage);
        }
        fragments.push({
          page: p,
          x: +box.x.toFixed(3), y: +box.y.toFixed(3),
          w: +(box.r - box.x).toFixed(3), h: +(box.b - box.y).toFixed(3),
          text,
        });
      }

      placed.push({ ids: group.rawId.split('|'), tag: group.tag, type, fragments });
    }

    // ── What got no page ────────────────────────────────────────────────
    const unplaced: unknown[] = [];
    for (const entry of roster) {
      if (placedRawIds[entry.rawId] === 1) continue;
      unplaced.push({
        ids: entry.rawId.split('|'),
        tag: entry.tag,
        display: entry.display,
        hasText: entry.hasText,
      });
    }

    return JSON.stringify({
      pageCount, placed, unplaced, overflows,
      diagnostics: {
        pageBoxes: pageEls.length,
        stampedRoster: roster.length,
        occurrences,
        duplicateOccurrences,
        inklessElements: inkless,
        bookStylesheets: pagination.sheets,
        droppedRemoteSheets: pagination.droppedRemoteSheets,
        paginateMs: pagination.paginateMs,
        domNodes: document.getElementsByTagName('*').length,
      },
    });
  } catch (err) {
    // The error has to survive the process boundary as data — an Error thrown
    // out of executeJavaScript arrives on the other side as a bare "script
    // failed", which names nothing.
    return JSON.stringify({
      error: String((err && (err as Error).message) || err),
      stack: String((err && (err as Error).stack) || ''),
    });
  }
}).toString();

/**
 * The presentation. Paginates the frame if it has not been paginated already,
 * then brings one page box to the surface origin.
 *
 * Its only effects are a scroll offset and a visual transform. Neither reflows,
 * so the page it shows is the page that was measured — and if the page will not
 * come to the origin it throws rather than leave a surface showing page 0 while
 * claiming to be page 40.
 */
const PRESENT_SOURCE = (async function quirePagedPresent(
  cfg: PagedConfig & { page: number; scale: number },
  paginate: PaginateFn,
): Promise<string> {
  try {
    const pagination = await paginate(cfg, null);
    const pages = document.querySelectorAll('.pagedjs_page');
    if (cfg.page < 0 || cfg.page >= pages.length) {
      throw new Error(
        'this document has ' + pages.length + ' page box(es); there is no page ' + cfg.page);
    }
    const target = pages[cfg.page] as HTMLElement;
    const container = target.parentElement;
    if (!container) throw new Error('the page boxes have no container to scale');

    container.style.transformOrigin = '0 0';
    container.style.transform = cfg.scale === 1 ? '' : 'scale(' + cfg.scale + ')';

    const before = target.getBoundingClientRect();
    window.scrollBy(before.left, before.top);

    // Wait for the surface to actually PAINT the new position before saying it
    // is showing this page. `capturePage` hands back the last painted frame, so
    // a raster taken the instant after a scroll is a picture of where the page
    // used to be — which is not a slightly-off screenshot, it is a confident
    // picture of the wrong page. Two frames: one to commit the scroll, one to
    // paint it.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => resolve()); });
    });

    const after = target.getBoundingClientRect();
    if (Math.abs(after.left) > cfg.tolerance || Math.abs(after.top) > cfg.tolerance) {
      throw new Error(
        'page ' + cfg.page + ' would not come to the origin: after scrolling it sits at ('
        + after.left.toFixed(1) + ',' + after.top.toFixed(1) + '). The surface is '
        + window.innerWidth + '×' + window.innerHeight + ' and the document is '
        + document.documentElement.scrollWidth + '×' + document.documentElement.scrollHeight
        + '. A surface smaller than the scaled page cannot scroll the last page into view.');
    }
    return JSON.stringify({
      ok: true, page: cfg.page, pages: pages.length, scale: cfg.scale,
      reused: pagination.reused, left: +after.left.toFixed(3), top: +after.top.toFixed(3),
    });
  } catch (err) {
    return JSON.stringify({
      error: String((err && (err as Error).message) || err),
      stack: String((err && (err as Error).stack) || ''),
    });
  }
}).toString();
