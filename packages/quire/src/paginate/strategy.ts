/**
 * How a document becomes pages.
 *
 * This is an interface because the answer is NOT settled. CSS multi-column is
 * implemented and is what we expect to keep, but a parallel spike is measuring
 * it against Paged.js on a real book — including whether Chromium's column
 * layout is deterministic run to run. If that spike changes the answer, the
 * thing that changes is a file under `strategies/`; nothing above this line
 * moves, because everything above this line talks in pages and boxes.
 *
 * A strategy owns three artifacts and nothing else:
 *
 *  - the CSS that turns a loaded document into page boxes,
 *  - a pure script that MEASURES the laid-out document,
 *  - a pure script that PRESENTS one page at the surface origin.
 *
 * Both scripts are strings evaluated in an isolated world. They are pure in the
 * sense that matters here: they read the DOM and return a JSON string, and the
 * present script's only side effect is to move the viewport. Neither knows
 * whether the surface it runs in is visible, which is why the analysis host and
 * the display host can share them.
 */
import type { QuireGeometry, QuirePageBoxModel } from '../types';

/** Raw measurement of one spine document, as the in-page script reports it. */
export interface StrategyMeasurement {
  /** Pages this document's flow occupies. */
  pageCount: number;
  /** One entry per stamped element that got at least one box. */
  placed: StrategyPlacement[];
  /** One entry per stamped element that got no box at all. */
  unplaced: StrategyUnplaced[];
  /** Fragments that started inside a column but ran past its right edge. */
  overflows: Array<{ ids: string[]; page: number; overshoot: number }>;
  /**
   * Numbers that describe the layout without gating it. `flowExtent` is
   * `body.scrollWidth`; `expectedExtent` is what `pageCount` columns of content
   * would span. `flowExtent` larger than `expectedExtent` means content
   * overflows a column sideways, which is exactly why the page count is not
   * derived from it.
   */
  diagnostics: { flowExtent: number; expectedExtent: number; emptyColumns: number };
}

export interface StrategyPlacement {
  /** Every id stamped on this element, in the order the caller wrote them. */
  ids: string[];
  tag: string;
  type: 'text' | 'image';
  /** One entry per page this element touches, in ascending page order. */
  fragments: Array<{
    /** Page index LOCAL to this document's flow. */
    page: number;
    x: number; y: number; w: number; h: number;
    /** Rendered text of the fragment on this page; null for image elements. */
    text: string | null;
  }>;
}

export interface StrategyUnplaced {
  ids: string[];
  tag: string;
  display: string;
  hasText: boolean;
}

export interface QuireStrategy {
  /** Stable name, reported in errors and in the CLI harness output. */
  readonly name: string;
  /** How this strategy relates pages to DOM. See {@link QuirePageBoxModel}. */
  readonly boxModel: QuirePageBoxModel;
  /** CSS appended last to the document's `<head>`, so it wins over the book's own. */
  layoutCss(geometry: QuireGeometry): string;
  /** Expression evaluating to a JSON {@link StrategyMeasurement}. */
  measureScript(geometry: QuireGeometry): string;
  /**
   * Expression that brings `localPage` to the surface origin and evaluates to a
   * JSON string. `scale` applies a visual transform only — it must never reflow,
   * because reflowing would invalidate the measurement the pages came from.
   */
  presentScript(geometry: QuireGeometry, localPage: number, scale: number): string;
}
