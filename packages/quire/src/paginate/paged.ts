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
 *  - the book's own elements are held to `overflow: visible` inside a page box.
 *    See {@link MONOLITHIC_OVERFLOW_RULE}: an element that scrolls cannot be
 *    fragmented, and an unfragmentable element taller than the page makes
 *    Paged.js emit the SAME content on two pages.
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
import { QUIRE_PAGE_MARGIN } from '../types';
import type { QuireGeometry, QuirePageBoxModel } from '../types';
import type { QuireStrategy } from './strategy';

/** The version vendored under `packages/quire/vendor/pagedjs/`. */
export const PAGEDJS_VERSION = '0.4.3';

/**
 * Inner margin of every page box, in CSS pixels, on all four sides.
 *
 * `@page { margin }` — Paged.js insets the CONTENT area and the page box keeps
 * its size, so nothing that measures `.pagedjs_page` boxes changes. What does
 * change is pagination: less content fits a page, so this number is part of a
 * page map's identity exactly as the page size is. It is a constant of this
 * strategy, not a caller option — every consumer of quire's page numbers must
 * lay books out identically, and `QUIRE_ANALYSIS_VERSION` (electron side) was
 * bumped when this stopped being zero.
 *
 * 48px on a 600px page leaves a 504px measure — about 62 characters at the
 * 18px analysis font, which is a book's, not a browser's, line length.
 *
 * The value itself lives in `types.ts` (which imports nothing) so the renderer
 * side can share it; this re-export keeps the strategy's own name for it.
 */
export const PAGE_MARGIN = QUIRE_PAGE_MARGIN;

/**
 * Slack, in CSS pixels, on box arithmetic. Sub-pixel layout makes an exact
 * comparison superstition; half a pixel of drift is still agreement. Chromium's
 * LayoutUnit is 1/64px, so this is 32 of them.
 */
const BOX_TOLERANCE = 0.5;

/**
 * The book's own elements do not scroll inside a page box.
 *
 * A PAGINATION-WIDE rule — it changes where every book breaks — and here is why
 * it earns that. CSS Fragmentation calls a box with `overflow` other than
 * `visible` MONOLITHIC: it establishes a scroll container, and a scroll
 * container is never broken across fragmentainers. Paged.js fragments by laying
 * the page content out as a one-column-wide multi-column box and moving whatever
 * lands past the first column onto the next page. A monolithic box TALLER than
 * that column therefore cannot go anywhere: Chromium pushes it out of the first
 * column whole, leaving the visible column empty, and Paged.js's
 * `findBreakToken` — reaching a break token identical to the one the page
 * started at — takes its "stop removal if we are in a loop" branch, keeps the
 * overflow in the page, warns `Unable to layout item`, and resumes the NEXT page
 * at the following sibling. The result is not a slightly wrong break. It is a
 * blank page, followed by a page whose every element is ALSO still sitting in
 * the previous page's clipped overflow — one element, two pages, no
 * `data-split-*` on either, which is what quire refuses as `CONTENT_REPEATED`.
 *
 * Measured 2026-08-10 on the CES letter, whose converter emits
 * `.tablewrap { overflow-x: auto }` around every table: a 20-row table 859px
 * tall in an 804px content box produced exactly that, three times in one
 * chapter, and the book could not be opened at all.
 *
 * `overflow: auto` is a statement about a scrolling viewport, and a page box is
 * not one — there is nothing to scroll on a page and nothing the reader could do
 * about it if there were. So it is neutralised, and the book gets fragmentation
 * instead, which is what it wanted.
 *
 * GATED narrowly, three ways:
 *  - only inside `.pagedjs_page_content`, which holds the book's content and
 *    nothing of Paged.js's own — the sheet's clip, the footnote area's, and the
 *    page-box chrome all live outside it and are untouched;
 *  - only `overflow`. No other property of the book is overridden;
 *  - not on replaced elements, where `overflow` means "clip the replaced
 *    content" rather than "refuse to be fragmented", and where forcing it
 *    visible would let an `<svg>` paint outside its own viewport.
 *
 * It is not a substitute for the check. A book can still defeat it with an
 * id-selector `!important`, and a genuinely unfragmentable element — say
 * `break-inside: avoid` on something taller than a page — reaches the same
 * Paged.js branch by another road. So `CONTENT_REPEATED` stays, and stays a
 * refusal.
 */
export const MONOLITHIC_OVERFLOW_RULE =
  '.pagedjs_page .pagedjs_page_content *'
  + ':not(img):not(svg):not(video):not(canvas):not(iframe):not(object):not(embed)'
  + '{overflow:visible!important;}';

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
  /** Inner page margin in CSS pixels — the content box is the page box less this on every side. */
  margin: number;
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
    if (!Number.isFinite(PAGE_MARGIN)) {
      // Interpolated into CSS below, where a non-number would not error — the
      // browser drops the invalid `margin:` declaration and paginates with NO
      // margin, silently producing a different book. (Measured 2026-08-09: a
      // mixed build did exactly this and poisoned a page-map cache with a
      // marginless layout under the current version's name.)
      throw new Error(
        `[quire] PAGE_MARGIN is ${String(PAGE_MARGIN)}, not a number — this build is `
        + 'inconsistent (types.js and paged.js are from different compilations). Rebuild '
        + 'before paginating anything: a page laid out without its margin is a different '
        + 'pagination wearing the same version number.',
      );
    }
    const cw = w - 2 * PAGE_MARGIN;
    const ch = h - 2 * PAGE_MARGIN;
    return [
      '/* quire: the page box. Appended last so it wins over the book, and handed',
      '   to Paged.js\'s polisher last for the same reason. */',
      `@page{size:${w}px ${h}px;margin:${PAGE_MARGIN}px;}`,
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
      // Capped at the CONTENT BOX, height included — the difference from the
      // multi-column strategy, and the one that buys correct image placement. A
      // plate taller than the content area is scaled to it rather than sliced
      // across two pages, which is what a reader means by "the plate is on page
      // 181". The cap is the content box, not the page box, because an image is
      // content: sized to the page box it would run 2×margin past the content
      // edge and be clipped by the sheet.
      'body img,body svg,body video,body canvas,body object,body embed,body picture{',
      `max-width:${cw}px!important;max-height:${ch}px!important;height:auto!important;`,
      '}',
      // The book's own elements do not scroll inside a page box, because a box
      // that scrolls is a box that cannot be fragmented. See the rule's own
      // documentation for the failure it exists to prevent.
      MONOLITHIC_OVERFLOW_RULE,
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
      margin: PAGE_MARGIN,
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

  /**
   * How many LINE BOXES a set of elements set, from the client rects of a Range
   * over their contents.
   *
   * A Range hands back one rect per line box; a rect is a new line when its top
   * clears the previous run by more than a pixel of sub-pixel noise. Nested
   * block children contribute rects at the same tops as the text they hold, so
   * they collapse into the same runs rather than counting twice.
   */
  const countLines = (els: Element[]): number => {
    const tops: number[] = [];
    for (const el of els) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        if (rects[i].height === 0 && rects[i].width === 0) continue;
        tops.push(rects[i].top);
      }
    }
    if (tops.length === 0) return 0;
    tops.sort((a, b) => a - b);
    let lines = 1;
    for (let i = 1; i < tops.length; i++) {
      if (tops[i] - tops[i - 1] > 1) lines++;
    }
    return lines;
  };

  try {
    const W = cfg.width, H = cfg.height, TOL = cfg.tolerance;
    // The CONTENT box — the page box less the margin on every side. Coordinates
    // are content-relative (the origins below are the content area's), so this
    // is the box that overflow and size assertions speak about.
    const CW = W - 2 * cfg.margin, CH = H - 2 * cfg.margin;

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
      // strategy's COLUMN_GAP_MISMATCH: if `@page { size }` or `@page { margin }`
      // did not reach the fragmenter, Paged.js silently uses its own defaults
      // (US Letter) and every box would be measured against a page that is not
      // the page. The content area is what is measured here, so the expectation
      // is the content box — page size less the margin on every side. Caught on
      // the first box of the first document rather than inferred later.
      if (Math.abs(rect.width - CW) > TOL || Math.abs(rect.height - CH) > TOL) {
        fail('PAGE_BOX_MISMATCH',
          'page box ' + i + ' lays its content out at ' + rect.width.toFixed(3) + '×'
          + rect.height.toFixed(3) + 'px but the page arithmetic assumes ' + CW + '×' + CH
          + 'px (' + W + '×' + H + ' less a ' + cfg.margin + 'px margin). The @page rule '
          + 'quire asked for did not reach the fragmenter, so every page-local coordinate '
          + 'would be measured against the wrong box.');
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

      /** What this element's clones on one page actually say, whitespace-collapsed. */
      const wordsOn = (p: number): string => {
        let s = '';
        for (const el of group.byPage[p].els) s += el.textContent || '';
        return collapse(s);
      };

      for (let k = 0; k < pages.length; k++) {
        const occurrence = group.byPage[pages[k]];
        const expectFrom = k > 0;
        const expectTo = k < pages.length - 1;
        if (occurrence.splitFrom === expectFrom && occurrence.splitTo === expectTo) continue;

        // Told apart before either is reported, because they are different
        // faults with different cures. A SPLIT that Paged.js mis-recorded is a
        // bookkeeping disagreement about a page break that did happen; REPEATED
        // content is a page break that did not happen at all — Paged.js gave up
        // on an item it could not fragment, kept it (and everything after it) in
        // the page it could not fit, and resumed the next page at the following
        // sibling. Both pages then hold the WHOLE element, and no marker is on
        // either because no split was made. The usual cause is a monolithic box
        // taller than the page; see MONOLITHIC_OVERFLOW_RULE.
        const repeated = pages.length > 1
          && !occurrence.splitFrom && !occurrence.splitTo
          && wordsOn(pages[k]).length > 0
          && pages.some((p) => p !== pages[k] && wordsOn(p) === wordsOn(pages[k]));
        if (repeated) {
          fail('CONTENT_REPEATED',
            'the element stamped "' + group.rawId + '" (<' + group.tag + '>) is present WHOLE on '
            + 'pages ' + pages.join(',') + ' — the same words on each, and no data-split-from or '
            + 'data-split-to on any of them. Paged.js did not split it; it emitted it twice, '
            + 'which it does when it cannot fragment an item (a box that scrolls, or one that '
            + 'refuses to break, taller than the page): it leaves the item and everything after '
            + 'it in the page as clipped overflow and restarts the next page at the following '
            + 'sibling. quire will not hand out a page number for content that is on two pages '
            + 'at once. Look at the page BEFORE the first one listed here for a box the '
            + 'fragmenter could not break.');
        }
        fail('SPLIT_DISAGREEMENT',
          'the element stamped "' + group.rawId + '" (<' + group.tag + '>) occupies page'
          + (pages.length > 1 ? 's ' : ' ') + pages.join(',') + ', so its fragment on page '
          + pages[k] + ' should ' + (expectFrom ? '' : 'not ') + 'be marked data-split-from '
          + 'and should ' + (expectTo ? '' : 'not ') + 'be marked data-split-to; Paged.js '
          + 'marks it split-from=' + occurrence.splitFrom + ' split-to=' + occurrence.splitTo
          + '. The pages come from Paged.js\'s own page boxes and the markers from Paged.js\'s '
          + 'own record of the split, and the two do not agree — refusing rather than believing '
          + 'either one.');
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
          const outX = Math.max(-box.x, box.r - CW);
          if (outX > TOL) {
            overflows.push({
              ids: group.rawId.split('|'), page: p, axis: 'x', overshoot: +outX.toFixed(3),
            });
          }
          const outY = Math.max(-box.y, box.b - CH);
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
          lines: type === 'image' ? 0 : countLines(group.byPage[p].els),
        });
      }

      // How the element is SET, read off the first clone that rendered anything.
      // Paged.js copies the ancestor chain onto every page an element continues
      // on, so every clone computes the same type; the first is read because
      // there is always one and asking them all could only agree.
      let font: unknown = null;
      if (type === 'text') {
        const first = group.byPage[inkedPages[0]].els[0];
        const cs = getComputedStyle(first);
        font = {
          size: parseFloat(cs.fontSize),
          family: cs.fontFamily,
          weight: Number(cs.fontWeight),
          style: cs.fontStyle,
        };
        const f = font as { size: number; weight: number };
        if (!isFinite(f.size) || !isFinite(f.weight)) {
          fail('FONT_UNREADABLE',
            'the element stamped "' + group.rawId + '" computes to font-size "' + cs.fontSize
            + '" and font-weight "' + cs.fontWeight + '", neither of which is a number. quire '
            + 'reports the type an element is set in as a fact of the layout and will not '
            + 'substitute one.');
        }
      }

      placed.push({ ids: group.rawId.split('|'), tag: group.tag, type, font, fragments });
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
