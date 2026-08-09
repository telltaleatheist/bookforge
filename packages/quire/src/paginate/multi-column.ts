/**
 * The CSS multi-column strategy — quire's ADVERSARIAL TEST FIXTURE.
 *
 * This is not the product and it is not a fallback. `PagedStrategy` is what
 * `openDocument` uses; gate G0 decided that (README, "Strategy — SETTLED"), and
 * the reason was image placement: multi-column reproduces exactly mupdf's
 * failure of slicing an over-tall plate across a page break, because a column
 * fragments a flow and has no notion of "this thing does not fit, move it".
 *
 * What it is kept for is that it is the strategy whose page arithmetic can be
 * WRONG in an interesting way. Column N's left edge sits at `N * (width + gap)`,
 * so a pitch that disagrees with the layout produces page numbers that drift by
 * one more column every column — silently, and confidently. `tools/test-quire.js`
 * subclasses this to lay a document out at one gutter and measure it at another,
 * and requires quire to refuse. Delete this file and those tests have nothing to
 * fail against.
 *
 * Everything below is the original strategy, unchanged.
 *
 * The document is laid into columns whose width is the page width and whose gap
 * is the gutter, with a definite height and `column-fill: auto`. Chromium then
 * fragments the flow, and **column N is page N**. Column N's left edge sits at
 * `N * (width + gap)` from the flow's origin — the "pitch".
 *
 * ── The measurement subtlety that decides correctness ──────────────────────
 *
 * `getBoundingClientRect()` returns the UNION box of an element that spans a
 * column break. For a paragraph broken across a page, that union spans both
 * columns AND the gutter between them, so its left edge can land in the gutter
 * and yield a page number that is not merely imprecise but meaningless. This
 * strategy therefore never uses it. It uses `Range.getClientRects()` over the
 * element's contents — one rect per fragment — and maps each fragment to its
 * own column. An element's pages are the SET of columns its fragments occupy:
 * one page normally, a `splitFrom`/`splitTo` range when it spans.
 *
 * A fragment whose left edge lands in a gutter rather than in a column means the
 * pitch used for the arithmetic is not the pitch the layout used. There is no
 * sensible rounding for that — rounding would assign a page that is off by one
 * for every element after it — so it is refused by name.
 *
 * ── What this strategy does to the book ────────────────────────────────────
 *
 * As little as possible, and all of it stated. The book's own markup and its own
 * stylesheets are left in place and load normally, so `body > p.first` still
 * matches what the book meant by it. On top of that, and only on top of that:
 * the page box is forced onto `html` and `body` (margins, size, overflow), the
 * multi-column properties are forced onto `body`, and replaced elements are
 * capped at the column width so an oversized figure cannot silently redefine the
 * pitch. Everything else is the book's.
 */
import { quireFail } from '../errors';
import type { QuireGeometry, QuirePageBoxModel } from '../types';
import type { QuireStrategy } from './strategy';

/**
 * Slack, in CSS pixels, on the column arithmetic. Sub-pixel layout means an
 * exact comparison would be superstition; a whole pixel of drift means the
 * pitch is wrong. Chromium's LayoutUnit is 1/64px, so this is ~3 LayoutUnits.
 */
const PITCH_TOLERANCE = 0.05;

export class MultiColumnStrategy implements QuireStrategy {
  readonly name = 'css-multi-column';
  /**
   * One flow per spine document; a page is a window onto it. A grid of pages
   * therefore needs one document instance per visible cell.
   */
  readonly boxModel: QuirePageBoxModel = 'continuous-columns';

  layoutCss(g: QuireGeometry): string {
    const { width: w, height: h, gap, fontSize } = g;
    return [
      '/* quire: the page box. Appended last so it wins over the book. */',
      'html{',
      'margin:0!important;padding:0!important;border:0!important;',
      `width:${w}px!important;height:${h}px!important;`,
      // Explicit overflow on the root stops body's overflow being propagated up
      // to the viewport, which is what makes body its own scroll container and
      // therefore what makes body.scrollLeft and body.scrollWidth mean the flow.
      'overflow:hidden!important;',
      `font-size:${fontSize}px!important;`,
      '}',
      'body{',
      'margin:0!important;padding:0!important;border:0!important;',
      `width:${w}px!important;height:${h}px!important;`,
      `column-width:${w}px!important;column-gap:${gap}px!important;`,
      'column-fill:auto!important;column-rule:none!important;',
      'overflow:hidden!important;',
      '}',
      // A figure wider than the page would extend past its column into the
      // gutter. Capping it keeps the pitch honest. Height is deliberately NOT
      // touched: a tall figure is allowed to be sliced across pages, which is
      // exactly what mupdf's rasterizer does to the same figure.
      'body img,body svg,body video,body canvas,body object,body embed,body picture{',
      'max-width:100%!important;',
      '}',
    ].join('');
  }

  /**
   * The numbers the measurement works from, as their own seam so that a test can
   * doctor one of them and prove the assertions actually fire. `pitch` is
   * separate from `width + gap` for exactly that reason: it is the arithmetic,
   * and the arithmetic is the thing being checked.
   */
  protected measureConfig(g: QuireGeometry): {
    width: number; gap: number; pitch: number; tolerance: number;
  } {
    return { width: g.width, gap: g.gap, pitch: g.width + g.gap, tolerance: PITCH_TOLERANCE };
  }

  /** Nothing to inject: the measurement is the whole engine. */
  preludeScript(): string | null {
    return null;
  }

  measureScript(g: QuireGeometry): string {
    return `(${MEASURE_SOURCE})(${JSON.stringify(this.measureConfig(g))})`;
  }

  presentScript(g: QuireGeometry, localPage: number, scale: number): string {
    const cfg = JSON.stringify({
      page: localPage, pitch: g.width + g.gap, scale,
      width: g.width, height: g.height, tolerance: PITCH_TOLERANCE,
    });
    return `(${PRESENT_SOURCE})(${cfg})`;
  }
}

/**
 * The measurement, as source. It runs in an isolated world against the book's
 * DOM: it can read the layout, the book cannot read or reach it, and the page's
 * `script-src 'none'` does not apply to it.
 *
 * It is written as one self-contained function with no closure over anything, so
 * the only thing that crosses the boundary is a config object in and a JSON
 * string out.
 */
const MEASURE_SOURCE = function quireMeasure(cfg: {
  width: number; gap: number; pitch: number; tolerance: number;
}): string {
  const W = cfg.width, G = cfg.gap, P = cfg.pitch, TOL = cfg.tolerance;

  // The explicit annotation is load-bearing: without it TypeScript will not treat
  // a call to `fail` as terminating, and every check below would read as
  // fall-through.
  const fail: (code: string, detail: string) => never = (code, detail) => {
    throw new Error('QUIRE_MEASURE/' + code + ': ' + detail);
  };

  const REPLACED: Record<string, number> = {
    IMG: 1, SVG: 1, IMAGE: 1, CANVAS: 1, VIDEO: 1, OBJECT: 1, EMBED: 1, PICTURE: 1, IFRAME: 1,
  };
  const NO_TEXT: Record<string, number> = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1 };

  const tagOf = (el: Element): string => String(el.tagName || '').toUpperCase();
  const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

  try {
    const body = document.body;
    if (!body) fail('NO_BODY', 'the document has no <body>');

    // The measurement is taken with the flow at rest. If something has already
    // scrolled or transformed it, every rect below is shifted by an unknown
    // amount, and a shifted rect produces a confidently wrong page.
    if (body.scrollLeft !== 0 || body.scrollTop !== 0) {
      fail('FLOW_NOT_AT_REST',
        'the flow is scrolled to (' + body.scrollLeft + ',' + body.scrollTop + ') before measuring');
    }
    const rootTransform = getComputedStyle(document.documentElement).transform;
    if (rootTransform && rootTransform !== 'none') {
      fail('FLOW_NOT_AT_REST', 'the root element carries transform "' + rootTransform + '" before measuring');
    }

    const originRect = body.getBoundingClientRect();
    const ox = originRect.left, oy = originRect.top;

    // ── The pitch, checked against the layout directly ────────────────────
    //
    // The sweep below catches a wrong pitch by its consequences, but only once
    // the accumulated drift exceeds the gutter — which can take a dozen columns,
    // and a short document might end before it ever does. So the numbers are
    // ALSO compared with what the layout says they are, which catches a
    // disagreement in the first column of the first document.
    const bodyStyle = getComputedStyle(body);
    const laidOutGap = parseFloat(bodyStyle.columnGap);
    if (!isFinite(laidOutGap)) {
      fail('COLUMN_GAP_MISMATCH',
        'the laid-out column-gap is "' + bodyStyle.columnGap + '", which is not a length. '
        + 'quire cannot do column arithmetic against it.');
    }
    if (Math.abs(laidOutGap - G) > TOL) {
      fail('COLUMN_GAP_MISMATCH',
        'the document was laid out with a column-gap of ' + laidOutGap + 'px but the page '
        + 'arithmetic assumes ' + G + 'px. Every column after the first would be off by '
        + Math.abs(laidOutGap - G) + 'px more than the last.');
    }
    const laidOutWidth = parseFloat(bodyStyle.columnWidth);
    if (!isFinite(laidOutWidth) || Math.abs(laidOutWidth - W) > TOL) {
      fail('COLUMN_WIDTH_MISMATCH',
        'the document was laid out with a column-width of "' + bodyStyle.columnWidth
        + '" but the page arithmetic assumes ' + W + 'px.');
    }

    const columnOf = (x: number): number => Math.floor(x / P);

    // ── Page count, and the pitch assertion ───────────────────────────────
    //
    // NOT from body.scrollWidth. scrollWidth is the extent of everything that
    // overflows, which includes content overflowing SIDEWAYS inside a column — a
    // table too wide for the page, an unbreakable URL. On a real book that makes
    // it disagree with the column count by an arbitrary amount in one direction,
    // and a last column narrower than the page makes it disagree in the other.
    // It is a diagnostic here, never the answer.
    //
    // The answer is the highest column any content actually reaches, taken over
    // a Range across the WHOLE body rather than only the stamped elements, so
    // that unstamped trailing content still counts as a page.
    //
    // That same sweep is where the pitch is checked. Every fragment of the flow
    // must begin inside a column and not in a gutter. If the pitch used for the
    // arithmetic were wrong — off by the gap, most obviously — the error
    // compounds by one gap per column, so by the second or third column
    // fragments start landing in the gutters and this refuses. Rounding them
    // into the nearest column instead would hand back page numbers that are
    // confidently, invisibly wrong.
    const flowRange = document.createRange();
    flowRange.selectNodeContents(body);
    const flowRects = flowRange.getClientRects();
    let maxColumn = -1;
    const occupied: Record<number, number> = {};
    for (let i = 0; i < flowRects.length; i++) {
      const r = flowRects[i];
      if (r.width <= 0 && r.height <= 0) continue;
      const x = r.left - ox;
      if (x < -TOL) {
        fail('FRAGMENT_LEFT_OF_FLOW',
          'the flow has a fragment at x=' + x.toFixed(3) + ', left of the first column');
      }
      const col = columnOf(x);
      const localX = x - col * P;
      if (localX > W + TOL) {
        fail('FRAGMENT_IN_GUTTER',
          'the flow has a fragment whose left edge is at page-local x=' + localX.toFixed(3)
          + ', inside the ' + G + 'px gutter after the ' + W + 'px column (absolute x='
          + x.toFixed(3) + ', column ' + col + ', pitch ' + P + 'px). The column arithmetic '
          + 'does not match the layout, so every page number would be wrong. Refusing rather '
          + 'than rounding into a column.');
      }
      occupied[col] = 1;
      if (col > maxColumn) maxColumn = col;
    }
    // A document that renders nothing still takes a page, the way a blank leaf
    // in a printed book is still a leaf. This is a definition, not a guess: it
    // is what mupdf does with the same document, and dropping the page would
    // shift every page number after it.
    const pageCount = maxColumn < 0 ? 1 : maxColumn + 1;

    let emptyColumns = 0;
    for (let c = 0; c < pageCount; c++) if (!occupied[c]) emptyColumns++;

    const flowExtent = body.scrollWidth;
    const expectedExtent = pageCount * W + (pageCount - 1) * G;

    // ── Fragments of one element ──────────────────────────────────────────
    const fragmentsOf = (el: Element): DOMRect[] => {
      const out: DOMRect[] = [];
      const range = document.createRange();
      range.selectNodeContents(el);
      const viaRange = range.getClientRects();
      for (let i = 0; i < viaRange.length; i++) {
        const r = viaRange[i];
        if (r.width > 0 && r.height > 0) out.push(r);
      }
      if (out.length > 0) return out;
      // A replaced element has no contents to select — an <img> gives a Range
      // no rects at all — so its own border boxes are the fragments. Chromium
      // returns one per fragment here too, which is how a figure taller than the
      // page reports as a split rather than as a box that overhangs.
      const viaElement = el.getClientRects();
      for (let i = 0; i < viaElement.length; i++) {
        const r = viaElement[i];
        if (r.width > 0 && r.height > 0) out.push(r);
      }
      return out;
    };

    // ── Flattened text, for slicing a split element per page ──────────────
    interface Flat { nodes: Text[]; starts: number[]; total: number; }
    const flatten = (el: Element): Flat => {
      const nodes: Text[] = [];
      const walk = (n: Node): void => {
        if (n.nodeType === 1 && NO_TEXT[tagOf(n as Element)] === 1) return;
        if (n.nodeType === 3 || n.nodeType === 4) {
          const t = n as Text;
          if (t.nodeValue && t.nodeValue.length > 0) nodes.push(t);
          return;
        }
        for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
      };
      walk(el);
      const starts: number[] = [];
      let total = 0;
      for (let i = 0; i < nodes.length; i++) {
        starts.push(total);
        total += (nodes[i].nodeValue as string).length;
      }
      return { nodes, starts, total };
    };

    const locate = (flat: Flat, off: number): { node: Text; offset: number } => {
      let lo = 0, hi = flat.nodes.length - 1, k = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (flat.starts[mid] <= off) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return { node: flat.nodes[k], offset: off - flat.starts[k] };
    };

    /** Column of the single character at flat offset i, or -1 if it renders nowhere. */
    const columnOfChar = (flat: Flat, i: number): number => {
      const a = locate(flat, i), b = locate(flat, i + 1);
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      const rects = r.getClientRects();
      for (let j = 0; j < rects.length; j++) {
        if (rects[j].width > 0 && rects[j].height > 0) return columnOf(rects[j].left - ox);
      }
      return -1;
    };

    /** Column of the first character at or after i that renders; Infinity past the end. */
    const columnAtOrAfter = (flat: Flat, i: number): number => {
      for (let j = i; j < flat.total; j++) {
        const c = columnOfChar(flat, j);
        if (c >= 0) return c;
      }
      return Infinity;
    };

    /** Column of the last character strictly before i that renders; -Infinity if none. */
    const columnBefore = (flat: Flat, i: number): number => {
      for (let j = i - 1; j >= 0; j--) {
        const c = columnOfChar(flat, j);
        if (c >= 0) return c;
      }
      return -Infinity;
    };

    const sliceText = (flat: Flat, from: number, to: number): string => {
      let out = '';
      for (let i = 0; i < flat.nodes.length; i++) {
        const s = flat.starts[i];
        const v = flat.nodes[i].nodeValue as string;
        const e = s + v.length;
        if (e <= from || s >= to) continue;
        out += v.slice(Math.max(0, from - s), Math.min(v.length, to - s));
      }
      return collapse(out);
    };

    const placed: unknown[] = [];
    const unplaced: unknown[] = [];
    const overflows: unknown[] = [];

    const stamped = body.querySelectorAll('[data-quire-id]');
    for (let n = 0; n < stamped.length; n++) {
      const el = stamped[n];
      const rawId = el.getAttribute('data-quire-id') as string;
      const ids = rawId.split('|');
      const tag = tagOf(el).toLowerCase();

      const rects = fragmentsOf(el);
      if (rects.length === 0) {
        unplaced.push({
          ids, tag,
          display: getComputedStyle(el).display,
          hasText: collapse(el.textContent || '').length > 0,
        });
        continue;
      }

      // ── Column assignment, one fragment at a time ─────────────────────
      const boxes: Record<number, { x: number; y: number; r: number; b: number }> = {};
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const x = r.left - ox, y = r.top - oy;
        if (x < -TOL) {
          fail('FRAGMENT_LEFT_OF_FLOW',
            'element "' + rawId + '" has a fragment at x=' + x.toFixed(3)
            + ', left of the first column');
        }
        const col = columnOf(x);
        const localX = x - col * P;
        if (localX > W + TOL) {
          fail('FRAGMENT_IN_GUTTER',
            'element "' + rawId + '" has a fragment whose left edge is at page-local x='
            + localX.toFixed(3) + ', inside the ' + G + 'px gutter after the ' + W
            + 'px column (absolute x=' + x.toFixed(3) + ', column ' + col + ', pitch ' + P
            + 'px). The column arithmetic does not match the layout, so every page number '
            + 'from here on would be wrong. Refusing rather than rounding into a column.');
        }
        if (localX + r.width > W + TOL) {
          overflows.push({
            ids, page: col, axis: 'x', overshoot: +(localX + r.width - W).toFixed(3),
          });
        }
        const prev = boxes[col];
        if (!prev) {
          boxes[col] = { x: localX, y, r: localX + r.width, b: y + r.height };
        } else {
          if (localX < prev.x) prev.x = localX;
          if (y < prev.y) prev.y = y;
          if (localX + r.width > prev.r) prev.r = localX + r.width;
          if (y + r.height > prev.b) prev.b = y + r.height;
        }
      }

      const pages = Object.keys(boxes).map(Number).sort((a, b) => a - b);
      for (let i = 0; i < pages.length; i++) {
        if (pages[i] >= pageCount) {
          fail('PAGE_OUT_OF_RANGE',
            'element "' + rawId + '" landed in column ' + pages[i]
            + ' but the flow reports only ' + pageCount + ' columns');
        }
      }

      // ── Kind ──────────────────────────────────────────────────────────
      const renderedText = collapse(el.textContent || '');
      const isReplaced = REPLACED[tagOf(el)] === 1;
      const wrapsOnlyImages = renderedText.length === 0
        && el.querySelector('img,svg,image,canvas,video,object,embed,picture') !== null;
      const type: 'text' | 'image' = (isReplaced || wrapsOnlyImages) ? 'image' : 'text';

      // ── Per-page text ─────────────────────────────────────────────────
      // For an element that spans a break, each page gets the words that are
      // actually on it. The run of characters rendering in one column is
      // contiguous, so its bounds are two binary searches over "first offset
      // whose next rendering character is in column c or later".
      //
      // A column's run is allowed to be EMPTY. An element can occupy a page
      // without putting a word on it — a paragraph whose text ends on one page
      // but which carries a trailing figure onto the next occupies both, and the
      // honest answer for the second is "this element is here, and none of its
      // words are". Emitting the whole text on both pages instead would double
      // count every split sentence downstream.
      let runs: Array<{ from: number; to: number }> | null = null;
      let flat: Flat | null = null;
      const needsRuns = type === 'text' && pages.length > 1;
      const candidate = needsRuns ? flatten(el) : null;
      if (candidate && candidate.total > 0) {
        flat = candidate;
        const firstOffsetInColumnAtLeast = (target: number): number => {
          let lo = 0, hi = (flat as Flat).total, k = (flat as Flat).total;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (columnAtOrAfter(flat as Flat, mid) >= target) { k = mid; hi = mid - 1; } else { lo = mid + 1; }
          }
          return k;
        };
        runs = [];
        for (let i = 0; i < pages.length; i++) {
          const c = pages[i];
          const from = firstOffsetInColumnAtLeast(c);
          const to = firstOffsetInColumnAtLeast(c + 1);
          if (from < to) {
            // The searches assume character order and column order agree.
            // Out-of-flow content can break that, and a broken assumption here
            // puts a sentence on the wrong page silently, so the ends of every
            // non-empty run are checked rather than trusted.
            const atStart = columnAtOrAfter(flat, from);
            const atEnd = columnBefore(flat, to);
            if (atStart !== c || atEnd !== c) {
              fail('SPLIT_NOT_ORDERED',
                'element "' + rawId + '" spans columns ' + pages.join(',')
                + ' but its characters do not run in column order: the run for column ' + c
                + ' is offsets ' + from + '..' + to + ', whose first character is in column '
                + atStart + ' and whose last is in column ' + atEnd
                + '. quire cannot say which words are on which page here.');
            }
          }
          runs.push({ from, to });
        }
      }

      const fragments: unknown[] = [];
      for (let i = 0; i < pages.length; i++) {
        const col = pages[i];
        const box = boxes[col];
        let text: string | null = null;
        if (type === 'text') {
          if (runs && flat) text = sliceText(flat, runs[i].from, runs[i].to);
          else text = renderedText;
        }
        fragments.push({
          page: col,
          x: +box.x.toFixed(3), y: +box.y.toFixed(3),
          w: +(box.r - box.x).toFixed(3), h: +(box.b - box.y).toFixed(3),
          text,
        });
      }

      placed.push({ ids, tag, type, fragments });
    }

    return JSON.stringify({
      pageCount, placed, unplaced, overflows,
      diagnostics: { flowExtent, expectedExtent, emptyColumns },
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
}.toString();

/**
 * The presentation, as source. Brings one column to the surface origin. Its only
 * effects are a scroll offset and a visual transform — neither reflows, so the
 * pages it shows are the pages that were measured.
 */
const PRESENT_SOURCE = function quirePresent(cfg: {
  page: number; pitch: number; scale: number; width: number; height: number; tolerance: number;
}): string {
  try {
    const body = document.body;
    if (!body) throw new Error('the document has no <body>');
    const root = document.documentElement;

    root.style.transformOrigin = '0 0';
    root.style.transform = cfg.scale === 1 ? '' : 'scale(' + cfg.scale + ')';

    const want = cfg.page * cfg.pitch;
    body.scrollTop = 0;
    body.scrollLeft = want;
    const got = body.scrollLeft;
    if (Math.abs(got - want) > cfg.tolerance) {
      // If the flow will not scroll, the surface is showing page 0 while
      // claiming to show page N. Showing the wrong page silently is the one
      // outcome worth refusing outright.
      throw new Error(
        'the flow would not scroll to column ' + cfg.page + ': asked for scrollLeft=' + want
        + ', got ' + got + ' (body.scrollWidth=' + body.scrollWidth + ', clientWidth='
        + body.clientWidth + '). The page box is not a scroll container.');
    }
    return JSON.stringify({ ok: true, scrollLeft: got, scale: cfg.scale });
  } catch (err) {
    return JSON.stringify({ error: String((err && (err as Error).message) || err) });
  }
}.toString();
