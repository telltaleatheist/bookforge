/**
 * How a document becomes pages.
 *
 * The answer IS settled — `PagedStrategy` (Paged.js 0.4.3, vendored) is what
 * quire paginates with, see the README's "Strategy — SETTLED (gate G0)". The
 * interface survives the decision for two reasons that are not "we might change
 * our minds": `MultiColumnStrategy` stays in the tree as the adversarial test
 * fixture the pitch-refusal tests subclass, and the seam is what lets those tests
 * doctor one number and require a refusal. It is NOT a fallback chain. A book
 * paginates with the strategy it was opened with, or the open fails naming why.
 *
 * A strategy owns four artifacts and nothing else:
 *
 *  - the CSS that turns a loaded document into page boxes,
 *  - trusted code the frame needs before either script can run (a PRELUDE),
 *  - a pure script that MEASURES the laid-out document,
 *  - a pure script that PRESENTS one page at the surface origin.
 *
 * The scripts are strings evaluated in an isolated world. They are pure in the
 * sense that matters here: they read the DOM and return a JSON string, and the
 * present script's only side effects are a scroll offset and a visual transform.
 * Neither knows whether the surface it runs in is visible, which is why the
 * analysis host and the display host can share them.
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
  /** Fragments that started inside a page box but ran past one of its edges. */
  overflows: Array<{ ids: string[]; page: number; axis: 'x' | 'y'; overshoot: number }>;
  /**
   * Numbers that describe the layout without gating it. What they ARE is the
   * strategy's business — a column strip and a stack of page boxes do not have
   * the same facts about them — so this is an open bag rather than a shape one
   * strategy's vocabulary imposes on the other. They are reported, never used as
   * an answer.
   */
  diagnostics: Record<string, number>;
}

/**
 * The type an element is actually set in, as the browser computed it.
 *
 * A fact of the layout rather than a description of it: only the engine that
 * applied the book's stylesheets can say what size a heading came out at, and
 * the caller has no second way to find out. Reported per ELEMENT, not per
 * fragment — a paragraph broken over a page turn is set in one face — and `null`
 * for a replaced element, which is set in no face at all.
 */
export interface StrategyFont {
  /** `font-size` in CSS pixels. */
  size: number;
  /** `font-family` as computed — the declared list, not the face that was used. */
  family: string;
  /** `font-weight` as a number (`normal` computes to 400, `bold` to 700). */
  weight: number;
  /** `font-style`: `normal`, `italic`, `oblique …`. */
  style: string;
}

export interface StrategyPlacement {
  /** Every id stamped on this element, in the order the caller wrote them. */
  ids: string[];
  tag: string;
  type: 'text' | 'image';
  /** How this element is set. `null` for `type: 'image'`. */
  font: StrategyFont | null;
  /** One entry per page this element touches, in ascending page order. */
  fragments: Array<{
    /** Page index LOCAL to this document's flow. */
    page: number;
    x: number; y: number; w: number; h: number;
    /** Rendered text of the fragment on this page; null for image elements. */
    text: string | null;
    /**
     * How many LINE BOXES this fragment set, counted from the client rects of a
     * Range over its contents.
     *
     * A measurement rather than an estimate — height divided by line-height is
     * wrong the moment a paragraph mixes type sizes — and one a caller cannot
     * make for itself. `0` for an image, which sets no lines.
     */
    lines: number;
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
  /**
   * Trusted code the frame must have before it can be measured or presented, or
   * `null` for a strategy that needs none.
   *
   * This is where a fragmenter that is a LIBRARY gets into the frame. It is
   * evaluated in the isolated world, from the main process, exactly like the
   * measure script — never as a `<script>` in the book's document, which is
   * served under `script-src 'none'` with every `<script>` already stripped from
   * the bytes. The book's world never sees it.
   *
   * It must evaluate to a JSON string: `{"ok":true,…}`, or `{"error":"…"}`.
   */
  preludeScript(): string | null;
  /** Expression evaluating to a JSON {@link StrategyMeasurement}. */
  measureScript(geometry: QuireGeometry): string;
  /**
   * Expression that brings `localPage` to the surface origin and evaluates to a
   * JSON string. `scale` applies a visual transform only — it must never reflow,
   * because reflowing would invalidate the measurement the pages came from.
   */
  presentScript(geometry: QuireGeometry, localPage: number, scale: number): string;
}
