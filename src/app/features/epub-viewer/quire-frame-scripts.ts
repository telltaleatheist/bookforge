/**
 * What the viewer says to a page frame.
 *
 * A quire page is live DOM inside a sandboxed frame the app does not share an
 * origin with. Everything this viewer does to that page — lay its page boxes
 * into a grid, read where every stamped element ended up, strike an element out,
 * highlight a selection — is a self-contained script evaluated in the frame,
 * exactly the channel `packages/quire/src/mount.ts` already uses for quire's own
 * prelude and present scripts.
 *
 * They live here, in one named file, for one reason: these are the ONLY places
 * in BookForge that know what a Paged.js page box looks like in the DOM
 * (`.pagedjs_page`, `.pagedjs_pages`). quire's mount contract hands a surface a
 * script that brings ONE page to the origin, and no script that says "show all
 * of this document's pages at once", so a grid has to arrange the boxes itself.
 * That is a real seam in the contract rather than a convenience, so it is
 * concentrated where it can be seen, named, and moved into the strategy later.
 *
 * Three rules hold for everything in this file:
 *
 *  - **No script reaches the book's own world as script.** These strings are
 *    evaluated by the embedder against the frame; the book is still served under
 *    `script-src 'none'` with every `<script>` stripped from its bytes. Nothing
 *    here writes markup from the app into the book, and nothing here brings the
 *    book's markup into the app — only ids, numbers and rectangles cross back.
 *  - **Styling is a stylesheet, never inline markup surgery.** The viewer's
 *    marks are CSS classes on elements that are already there, applied through
 *    one `<style>` element, which is what quire's CSP admits
 *    (`style-src quire: 'unsafe-inline'`).
 *  - **Geometry is measured in the frame, after the boxes are in their final
 *    places, and never carried over a re-parent** (gate G0: page assignment
 *    survives a move, pixel geometry does not).
 */

/** The attribute quire reports identity from, and the only one measured here. */
const QUIRE_ID_ATTRIBUTE = 'data-quire-id';
/** Several ids on one element are joined by this — see quire's README, "Identity". */
const QUIRE_ID_SEPARATOR = '|';

/** Where one page box sits inside its frame, in unscaled CSS pixels. */
export interface QuireFramePage {
  /** Index within this spine document's own flow — `QuirePageMount.localPage`. */
  localPage: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where one stamped element sits inside its frame, in unscaled CSS pixels. */
export interface QuireFrameElement {
  /** The caller's own key, exactly as `data-quire-id` carries it. */
  id: string;
  localPage: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What {@link arrangeScript} hands back. */
export interface QuireFrameArrangement {
  pages: QuireFramePage[];
  elements: QuireFrameElement[];
  /** Rendered nodes in this frame — the virtualisation budget, measured not guessed. */
  nodes: number;
  /** Elements carrying an id that no page box contains. Always zero, or a bug. */
  orphans: number;
}

/** The marks the viewer paints on the live page, as class names. */
export const QUIRE_VIEW_CLASSES = {
  struck: 'bf-struck',
  selected: 'bf-selected',
  tocSelected: 'bf-toc-selected',
  /** On a `.pagedjs_page`, not on an element: the whole page is excluded. */
  pageStruck: 'bf-page-struck',
} as const;

/**
 * The viewer's stylesheet.
 *
 * Deliberately the same vocabulary as the raster viewer's block overlay: a
 * struck block is dimmed and crossed out in the same red, a selected block wears
 * the accent. The raster viewer draws two SVG lines corner to corner over a
 * bitmap; there is no bitmap here, so the cross is a pair of CSS gradients over
 * the real element and the strikethrough is the browser's own.
 *
 * `!important` throughout, and only on the viewer's own properties: the book's
 * stylesheet is a stranger's and specific enough to win otherwise, and a strike
 * the reader cannot see is worse than no strike at all.
 */
export const QUIRE_VIEW_STYLESHEET = `
[${QUIRE_ID_ATTRIBUTE}] { position: relative; }
.${QUIRE_VIEW_CLASSES.selected} {
  background-color: rgba(6, 182, 212, 0.18) !important;
  outline: 2px solid #06b6d4 !important;
  outline-offset: 1px !important;
}
.${QUIRE_VIEW_CLASSES.tocSelected} {
  outline: 2px dashed #a855f7 !important;
  outline-offset: 1px !important;
}
.${QUIRE_VIEW_CLASSES.struck} {
  opacity: 0.42 !important;
  text-decoration: line-through !important;
  text-decoration-color: #ff4444 !important;
  text-decoration-thickness: 2px !important;
  background-image:
    linear-gradient(to bottom right, transparent calc(50% - 1px), #ff4444 calc(50% - 1px),
                    #ff4444 calc(50% + 1px), transparent calc(50% + 1px)),
    linear-gradient(to bottom left, transparent calc(50% - 1px), #ff4444 calc(50% - 1px),
                    #ff4444 calc(50% + 1px), transparent calc(50% + 1px)) !important;
  background-repeat: no-repeat !important;
  background-size: 100% 100% !important;
}
.${QUIRE_VIEW_CLASSES.struck} img,
.${QUIRE_VIEW_CLASSES.struck} svg { filter: grayscale(1) !important; }
.${QUIRE_VIEW_CLASSES.pageStruck} { opacity: 0.3 !important; }
`;

/**
 * Wrap a body so it always answers with a JSON string, never with a value the
 * embedder has to guess the shape of and never with a thrown error it cannot
 * attribute. Same convention as quire's own prelude/present scripts.
 */
function evaluable(body: string): string {
  return `(function(){try{${body}}catch(e){`
    + 'return JSON.stringify({error:String((e&&e.message)||e),stack:String((e&&e.stack)||"")});'
    + '}})()';
}

/**
 * Lay this document's page boxes into a grid, put the viewer's stylesheet in,
 * and measure everything the app will need to point at.
 *
 * Run ONCE per frame, after quire's own present script has paginated it. The
 * order inside matters and is not interchangeable:
 *
 *  1. arrange the boxes,
 *  2. force layout and measure — at scale 1, with the container transform
 *     removed, so the numbers are the page's own and a later zoom cannot
 *     invalidate them,
 *  3. only then apply the zoom transform.
 *
 * Measuring after step 3 would fold the zoom into every rectangle and make the
 * app's arithmetic depend on when it asked. Measuring before step 1 would
 * measure boxes that are about to move (gate G0).
 *
 * Coordinates come back relative to the page-box container's own origin, so the
 * app can place the frame and then treat every rectangle as frame-local.
 */
export function arrangeScript(columns: number, gap: number, scale: number): string {
  const cfg = JSON.stringify({ columns, gap, scale, attr: QUIRE_ID_ATTRIBUTE, sep: QUIRE_ID_SEPARATOR });
  const style = JSON.stringify(QUIRE_VIEW_STYLESHEET);
  return evaluable(`
    var cfg = ${cfg};
    var container = document.querySelector('.pagedjs_pages');
    if (!container) {
      return JSON.stringify({error: 'this frame has no .pagedjs_page container, so it was never '
        + 'paginated — the mount ran the arrange script before quire\\'s present script'});
    }

    // quire's layout CSS pins .pagedjs_pages{display:block!important}, so the
    // grid has to carry !important too. A container that quietly stayed a block
    // would look like a one-column reader rather than like a failure.
    container.style.setProperty('display', 'grid', 'important');
    container.style.setProperty('grid-template-columns',
      'repeat(' + cfg.columns + ', max-content)', 'important');
    container.style.setProperty('gap', cfg.gap + 'px', 'important');
    container.style.setProperty('justify-content', 'start', 'important');
    container.style.setProperty('align-content', 'start', 'important');
    container.style.transformOrigin = '0 0';
    container.style.transform = '';

    if (!document.getElementById('bf-quire-view-style')) {
      var sheet = document.createElement('style');
      sheet.id = 'bf-quire-view-style';
      sheet.textContent = ${style};
      document.head.appendChild(sheet);
    }

    // The frame's own scroll must be at the origin, because every rectangle
    // below is viewport-relative and the app will treat them as frame-local.
    window.scrollTo(0, 0);
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      return JSON.stringify({error: 'the frame will not scroll to its origin (it sits at '
        + window.scrollX + ',' + window.scrollY + '), so no rectangle measured in it can be '
        + 'placed on screen'});
    }

    var boxes = document.querySelectorAll('.pagedjs_page');
    if (boxes.length === 0) return JSON.stringify({error: 'no .pagedjs_page boxes in this frame'});
    var origin = container.getBoundingClientRect();
    var pages = [];
    var pageOf = new Map();
    for (var i = 0; i < boxes.length; i++) {
      var r = boxes[i].getBoundingClientRect();
      pages.push({localPage: i, x: +(r.left - origin.left).toFixed(2), y: +(r.top - origin.top).toFixed(2),
                  w: +r.width.toFixed(2), h: +r.height.toFixed(2)});
      pageOf.set(boxes[i], i);
    }

    // Identity comes from DOM containment, the same rule quire measures by: an
    // element is a descendant of exactly one page box. An element Paged.js split
    // across pages appears once per box, each clone carrying the same stamp, so
    // one id can legitimately produce several rectangles.
    var stamped = document.querySelectorAll('[' + cfg.attr + ']');
    var elements = [];
    var orphans = 0;
    for (var j = 0; j < stamped.length; j++) {
      var el = stamped[j];
      var box = el.closest('.pagedjs_page');
      var local = box ? pageOf.get(box) : undefined;
      if (local === undefined) { orphans++; continue; }
      var er = el.getBoundingClientRect();
      var ids = String(el.getAttribute(cfg.attr) || '').split(cfg.sep);
      for (var k = 0; k < ids.length; k++) {
        if (!ids[k]) continue;
        elements.push({id: ids[k], localPage: local,
          x: +(er.left - origin.left).toFixed(2), y: +(er.top - origin.top).toFixed(2),
          w: +er.width.toFixed(2), h: +er.height.toFixed(2)});
      }
    }

    // The zoom, last, so nothing above was measured through it.
    container.style.transform = cfg.scale === 1 ? '' : 'scale(' + cfg.scale + ')';

    return JSON.stringify({pages: pages, elements: elements, orphans: orphans,
      nodes: document.getElementsByTagName('*').length});
  `);
}

/**
 * Change the zoom, and nothing else.
 *
 * A transform, never a reflow — the same mechanism and the same reason as
 * `QuirePageMount.scale`: pagination identity must not change with zoom. If a
 * zoom re-fragmented the flow, page 41 would stop being page 41 and every
 * recorded page number in the project would quietly mean something else.
 */
export function zoomScript(scale: number): string {
  return evaluable(`
    var container = document.querySelector('.pagedjs_pages');
    if (!container) return JSON.stringify({error: 'this frame has no page-box container to scale'});
    container.style.transformOrigin = '0 0';
    container.style.transform = ${JSON.stringify(scale === 1 ? '' : `scale(${scale})`)};
    return JSON.stringify({ok: true, scale: ${scale}});
  `);
}

/** What {@link flowArrangeScript} hands back: a chapter's flow, measured. */
export interface QuireFlowArrangement {
  /** Content height at scale 1, in CSS pixels — what the band must reserve. */
  height: number;
  /** Every stamped element's rectangle, `localPage` 0 throughout — a flow has no pages. */
  elements: QuireFrameElement[];
  nodes: number;
}

/**
 * Style a FLOW frame — a chapter mounted without pagination — and measure it.
 *
 * The paginated frame's counterpart of `arrangeScript`, for a frame in which
 * no page boxes exist and none will: the document flows top to bottom exactly
 * as served. The stylesheet gives the flow the SAME typographic frame the
 * paginator used — the analysis root font size, the page's content width as
 * the column measure, the page margin as the column padding — plus a layer of
 * READING defaults (a book serif, a reading line-height, heading and
 * scene-break shapes) written entirely in `:where()` so they carry zero
 * specificity: any rule the book's own stylesheet states, however weakly,
 * outranks them. A styled book looks like itself; an unstyled one looks like
 * a book instead of a browser default.
 *
 * Same non-negotiable order as `arrangeScript`: style, force layout and
 * measure at scale 1 with the transform removed, and only then apply the
 * scale, so no rectangle is ever measured through a zoom.
 */
export function flowArrangeScript(
  pageWidth: number, margin: number, fontSize: number, scale: number,
): string {
  const cfg = JSON.stringify({
    pageWidth, margin, fontSize, scale, attr: QUIRE_ID_ATTRIBUTE, sep: QUIRE_ID_SEPARATOR,
  });
  const style = JSON.stringify(QUIRE_VIEW_STYLESHEET);
  return evaluable(`
    var cfg = ${cfg};
    if (document.querySelector('.pagedjs_page')) {
      return JSON.stringify({error: 'this frame holds page boxes, so it was mounted paginated — '
        + 'the flow arrange script styles an UNPAGINATED document and will not restyle this one'});
    }

    if (!document.getElementById('bf-quire-flow-style')) {
      var flowSheet = document.createElement('style');
      flowSheet.id = 'bf-quire-flow-style';
      flowSheet.textContent = [
        'html{margin:0!important;padding:0!important;border:0!important;',
        'font-size:' + cfg.fontSize + 'px!important;background:#fff!important;',
        'scrollbar-width:none!important;}',
        'html::-webkit-scrollbar,body::-webkit-scrollbar{',
        'width:0!important;height:0!important;display:none!important;}',
        'body{box-sizing:border-box!important;width:' + cfg.pageWidth + 'px!important;',
        'margin:0!important;border:0!important;padding:' + cfg.margin + 'px!important;',
        'background:#fff!important;transform-origin:0 0;}',
        // The same cap the paginated layout applies, for the same reason: an
        // image is content, and the content box is the page width less the
        // margins.
        'body img,body svg,body video,body canvas,body object,body embed,body picture{',
        'max-width:' + (cfg.pageWidth - 2 * cfg.margin) + 'px!important;height:auto!important;}',
        // Reading defaults, all at ZERO specificity (:where) so the book's own
        // stylesheet — any rule in it at all — wins. These decide only what an
        // undeclared property looks like: books published without CSS get book
        // typography instead of Times-at-browser-default.
        ':where(body){font-family:Georgia,"Palatino Linotype","Book Antiqua",serif;',
        'color:#1c1c1e;line-height:1.7;-webkit-font-smoothing:antialiased;',
        'text-rendering:optimizeLegibility;font-kerning:normal;}',
        ':where(h1,h2,h3,h4,h5,h6){line-height:1.25;margin:1.6em 0 0.7em;text-wrap:balance;}',
        ':where(h1){margin-top:0.4em;}',
        ':where(hr){border:0;border-top:1px solid #d5d5d0;width:40%;margin:2.2em auto;}',
      ].join('');
      document.head.appendChild(flowSheet);
    }

    if (!document.getElementById('bf-quire-view-style')) {
      var sheet = document.createElement('style');
      sheet.id = 'bf-quire-view-style';
      sheet.textContent = ${style};
      document.head.appendChild(sheet);
    }

    document.body.style.transform = '';
    window.scrollTo(0, 0);
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      return JSON.stringify({error: 'the frame will not scroll to its origin (it sits at '
        + window.scrollX + ',' + window.scrollY + '), so no rectangle measured in it can be '
        + 'placed on screen'});
    }

    // The flow's height is the body's own box (border-box, so the padding is
    // in it) — never scrollHeight, which is clamped UP to the viewport and
    // would report a short chapter as being as tall as the frame's estimate.
    var bodyRect = document.body.getBoundingClientRect();
    var height = Math.ceil(Math.max(bodyRect.height, document.body.scrollHeight));

    var stamped = document.querySelectorAll('[' + cfg.attr + ']');
    var elements = [];
    for (var j = 0; j < stamped.length; j++) {
      var er = stamped[j].getBoundingClientRect();
      var ids = String(stamped[j].getAttribute(cfg.attr) || '').split(cfg.sep);
      for (var k = 0; k < ids.length; k++) {
        if (!ids[k]) continue;
        elements.push({id: ids[k], localPage: 0,
          x: +er.left.toFixed(2), y: +er.top.toFixed(2),
          w: +er.width.toFixed(2), h: +er.height.toFixed(2)});
      }
    }

    document.body.style.transform = cfg.scale === 1 ? '' : 'scale(' + cfg.scale + ')';

    return JSON.stringify({height: height, elements: elements,
      nodes: document.getElementsByTagName('*').length});
  `);
}

/** Change a FLOW frame's zoom, and nothing else — the body-transform sibling of {@link zoomScript}. */
export function flowZoomScript(scale: number): string {
  return evaluable(`
    document.body.style.transformOrigin = '0 0';
    document.body.style.transform = ${JSON.stringify(scale === 1 ? '' : `scale(${scale})`)};
    return JSON.stringify({ok: true, scale: ${scale}});
  `);
}

/** The marks a frame should be wearing, as sets of element keys and page indices. */
export interface QuireFrameMarks {
  struck: string[];
  selected: string[];
  tocSelected: string[];
  /** Page indices LOCAL to this frame's document. */
  struckPages: number[];
  /**
   * The distinct category colours on this book, as `#RRGGBB`, and which one
   * each element wears. A selected element is highlighted in ITS OWN
   * category's colour — the raster viewer's behaviour, where selecting a
   * heading looks different from selecting body text — instead of one flat
   * accent for everything. The classes are generated per palette INDEX, so the
   * stylesheet stays as small as the number of colours, not of elements.
   */
  palette: string[];
  categoryOf: Record<string, number>;
  /**
   * Elements to paint in their category colour even while unselected — the
   * picker's colour layer. Empty when the layer is off. The caller subtracts
   * selected/toc-selected elements itself, so wash never fights a stronger
   * mark's outline.
   */
  wash: string[];
}

/**
 * Make the frame wear exactly these marks — the whole state, not a diff.
 *
 * Whole-state rather than incremental on purpose: a diff that drifts leaves a
 * strike on screen for a block that is no longer struck, and a viewer that shows
 * a deletion the project does not hold is the failure this component exists to
 * avoid. Re-applying every class costs one pass over an index the frame builds
 * once, which is cheaper than being wrong.
 */
export function applyMarksScript(marks: QuireFrameMarks): string {
  const cfg = JSON.stringify({ ...marks, attr: QUIRE_ID_ATTRIBUTE, sep: QUIRE_ID_SEPARATOR });
  const classes = JSON.stringify(QUIRE_VIEW_CLASSES);
  return evaluable(`
    var cfg = ${cfg};
    var cls = ${classes};

    // The category stylesheet: one selected-colour and one wash rule per
    // palette entry, regenerated whole on every apply (the palette is a
    // handful of colours; correctness beats caching). It sits AFTER the view
    // stylesheet, and the selected rule carries two classes so it outranks the
    // base .bf-selected accent by specificity, not by luck of ordering.
    var catSheet = document.getElementById('bf-quire-category-style');
    if (!catSheet) {
      catSheet = document.createElement('style');
      catSheet.id = 'bf-quire-category-style';
      document.head.appendChild(catSheet);
    }
    var rules = [];
    for (var p = 0; p < cfg.palette.length; p++) {
      var col = cfg.palette[p];
      rules.push('.' + cls.selected + '.bf-sel-' + p + '{background-color:' + col
        + '2e !important;outline-color:' + col + ' !important;}');
      rules.push('.bf-wash-' + p + '{background-color:' + col
        + '22 !important;outline:1px solid ' + col + '55 !important;outline-offset:0 !important;}');
    }
    catSheet.textContent = rules.join('\\n');

    var view = window.__bfQuireView;
    if (!view) {
      // One index per frame, built the first time it is marked: id -> the
      // elements carrying it (several, when Paged.js split the element across
      // page boxes and cloned the stamp onto each fragment).
      view = window.__bfQuireView = {byId: new Map()};
      var stamped = document.querySelectorAll('[' + cfg.attr + ']');
      for (var i = 0; i < stamped.length; i++) {
        var ids = String(stamped[i].getAttribute(cfg.attr) || '').split(cfg.sep);
        for (var k = 0; k < ids.length; k++) {
          if (!ids[k]) continue;
          var list = view.byId.get(ids[k]);
          if (list) list.push(stamped[i]); else view.byId.set(ids[k], [stamped[i]]);
        }
      }
    }

    var every = [cls.struck, cls.selected, cls.tocSelected];
    view.byId.forEach(function (els) {
      for (var i = 0; i < els.length; i++) {
        var list = els[i].classList;
        // The per-colour classes are dynamic, so they are stripped by prefix —
        // a whole-state apply must leave nothing from the previous state.
        var dyn = [];
        for (var c = 0; c < list.length; c++) {
          if (list[c].indexOf('bf-sel-') === 0 || list[c].indexOf('bf-wash-') === 0) dyn.push(list[c]);
        }
        list.remove.apply(list, every.concat(dyn));
      }
    });

    var missing = [];
    function mark(ids, className, withColour) {
      for (var i = 0; i < ids.length; i++) {
        var els = view.byId.get(ids[i]);
        if (!els) { missing.push(ids[i]); continue; }
        var idx = withColour ? cfg.categoryOf[ids[i]] : undefined;
        for (var j = 0; j < els.length; j++) {
          els[j].classList.add(className);
          if (idx !== undefined) els[j].classList.add('bf-sel-' + idx);
        }
      }
    }
    mark(cfg.struck, cls.struck, false);
    mark(cfg.selected, cls.selected, true);
    mark(cfg.tocSelected, cls.tocSelected, false);
    for (var w = 0; w < cfg.wash.length; w++) {
      var washEls = view.byId.get(cfg.wash[w]);
      if (!washEls) { missing.push(cfg.wash[w]); continue; }
      var washIdx = cfg.categoryOf[cfg.wash[w]];
      if (washIdx === undefined) continue;
      for (var q = 0; q < washEls.length; q++) washEls[q].classList.add('bf-wash-' + washIdx);
    }

    var boxes = document.querySelectorAll('.pagedjs_page');
    for (var p = 0; p < boxes.length; p++) {
      boxes[p].classList.toggle(cls.pageStruck, cfg.struckPages.indexOf(p) !== -1);
    }

    return JSON.stringify({ok: true, marked: cfg.struck.length + cfg.selected.length,
      unknownIds: missing.slice(0, 10), unknownIdCount: missing.length});
  `);
}
