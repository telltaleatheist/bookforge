/**
 * quire — the public shape.
 *
 * Deliberately close to the slice of mupdf that BookForge drives today
 * (`doc.layout` / `doc.countPages` / `doc.loadPage` / `page.toPixmap`), so that
 * the EPUB half of `pdf-analyzer.ts` can be moved across without the call sites
 * being rewritten around a new idea.
 *
 * The one place the shapes differ on purpose is {@link QuireBlock.id}: mupdf
 * hands back a bare bounding box and leaves "which markup element was that?" to
 * be guessed. quire never guesses, because it never has to — the caller stamped
 * the element and quire hands the stamp straight back.
 */

/** The page geometry a document is laid out into. */
export interface QuireLayoutOptions {
  /** Page width in CSS pixels. mupdf's first `layout()` argument. */
  width: number;
  /** Page height in CSS pixels. mupdf's second `layout()` argument. */
  height: number;
  /** Root font size in CSS pixels. mupdf's third `layout()` argument (its "em"). */
  fontSize: number;
  /**
   * Gutter between columns, in CSS pixels.
   *
   * This has no counterpart in mupdf — mupdf has no columns — so it is not a
   * value the caller can be "missing". Omitting it selects
   * {@link QUIRE_COLUMN_GAP}, which is a layout constant of the multi-column
   * strategy, not a stand-in for something that could not be determined.
   *
   * It matters because the whole page arithmetic is `column pitch = width + gap`.
   * A wrong gap does not produce slightly wrong pages, it produces fragments
   * that land in the gutter — which quire refuses rather than rounds.
   */
  gap?: number;
}

/** Fully-resolved page geometry. Every field required — this is what measurement uses. */
export interface QuireGeometry {
  width: number;
  height: number;
  fontSize: number;
  gap: number;
}

/** Page-local box, in CSS pixels, measured from the top-left of the page. */
export interface QuireBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One stamped element's footprint on one page.
 *
 * An element that spans a page break produces one block per page it touches,
 * each carrying the same `id` and the same `splitFrom`/`splitTo`, and each
 * carrying only the box — and only the text — that is actually on that page.
 */
export interface QuireBlock {
  /**
   * `'image'` when the element is a replaced element (`img`, `svg`, `image`,
   * `canvas`, `video`, `object`, `embed`, `picture`, `iframe`), or when it
   * renders no text at all and contains at least one such element.
   * `'text'` otherwise. This is a definition, not an inference.
   */
  type: 'text' | 'image';
  /** Page-local coordinates. */
  bbox: QuireBox;
  /**
   * The rendered text of this element's fragment on this page — whitespace
   * collapsed the way the browser collapses it, then trimmed. `null` for
   * `type: 'image'`.
   */
  text: string | null;
  /**
   * The exact string the caller put in `data-quire-id`. quire mints nothing.
   * See the README section "Identity".
   */
  id: string;
  /** First page this element occupies — `null` unless it spans more than one. */
  splitFrom: number | null;
  /** Last page this element occupies — `null` unless it spans more than one. */
  splitTo: number | null;
}

/**
 * A stamped element that got no page at all.
 *
 * This is the number that decides whether identity is really guaranteed, so it
 * is a first-class result rather than a silent omission. An element lands here
 * when it renders nothing: `display:none`, an empty paragraph, a wrapper whose
 * every child is out of flow.
 */
export interface QuireUnplaced {
  id: string;
  /** The spine document the stamp was found in. */
  document: string;
  /** Lowercase tag name of the stamped element. */
  tag: string;
  /** Why it has no box, as far as the DOM can say. */
  reason: 'not-rendered';
  /** The element's computed `display`, which is usually the whole story. */
  display: string;
  /** Whether the element renders any non-whitespace text. */
  hasText: boolean;
}

/**
 * A fragment that starts inside its column but runs past the column's right
 * edge — a too-wide image, an unbreakable URL. The page assignment is still
 * unambiguous (it is made from the fragment's *start*), so this is reported
 * rather than refused; a fragment that *starts* in the gutter is refused.
 */
export interface QuireOverflow {
  id: string;
  document: string;
  page: number;
  /** How far past the column's right edge the fragment reaches, in CSS pixels. */
  overshoot: number;
}

/** A spine itemref that produced no document, mirroring EpubProcessor's own rule. */
export interface QuireSpineWarning {
  idref: string;
  reason: string;
}

/** What a whole book's pagination produced, beyond the pages themselves. */
export interface QuireReport {
  /** Spine documents actually paginated, in spine order. */
  documents: string[];
  /** Global page index each spine document starts at. */
  documentPageOffsets: number[];
  /** Every stamped id quire found, in document then flow order. */
  stampedIds: string[];
  /** Stamped ids that got no page. Callers that need identity MUST check this. */
  unplaced: QuireUnplaced[];
  /** Fragments that ran past their column's right edge. */
  overflows: QuireOverflow[];
  /** Spine itemrefs that yielded no document. */
  spineWarnings: QuireSpineWarning[];
  /** Wall-clock milliseconds spent laying the book out. */
  layoutMs: number;
}

/**
 * How a strategy relates pages to DOM. This is the fact a display surface has
 * to plan around, so it is part of the public shape rather than a private
 * detail of whichever strategy is current.
 *
 * - `continuous-columns` — the document is ONE flow and a page is a window onto
 *   it. Showing page N means loading the document and translating it by N page
 *   pitches. A grid of pages therefore needs one document instance per visible
 *   cell, and virtualisation is mandatory.
 * - `fragmented-boxes` — each page is its own DOM subtree inside one document
 *   instance. A grid can mount many pages from a single instance, and cells can
 *   be attached and detached without re-laying-out the chapter.
 *
 * quire ships `continuous-columns` today. The seam exists because the choice is
 * not settled — see README, "Strategy".
 */
export type QuirePageBoxModel = 'continuous-columns' | 'fragmented-boxes';

/**
 * Everything a display surface needs to put ONE page on screen, as plain data.
 *
 * This is the primary product of the package. A page is a live DOM subtree
 * showing the book's real markup — selectable text, real fonts, no raster round
 * trip. {@link QuireBlock}s are the map that goes with it, not a substitute for
 * it, and `toPng` is a thumbnail exporter, not the display path.
 *
 * It is deliberately serialisable so it can cross the main/renderer boundary.
 */
export interface QuirePageMount {
  /** Global page index, the same number `loadPage()` takes. */
  page: number;
  /** Spine document (zip entry name) this page belongs to. */
  document: string;
  /** `quire://<session>/<entry>` — loadable only inside a quire-sandboxed frame. */
  url: string;
  /** Page box size in CSS pixels, before `scale`. */
  width: number;
  height: number;
  /**
   * Visual scale this mount's `presentScript` was built for. A transform only —
   * it never reflows, so a scaled page is the same page that was measured. The
   * frame should be `width * scale` by `height * scale`.
   */
  scale: number;
  /** See {@link QuirePageBoxModel}. */
  boxModel: QuirePageBoxModel;
  /** This page's index within its own document's flow. */
  localPage: number;
  /** How many pages that document's flow has, so a surface can reuse an instance. */
  documentPageCount: number;
  /** CSS the frame must carry for the document to be laid out into page boxes. */
  layoutCss: string;
  /** Script to run in the frame once loaded, to bring this page to the frame origin. */
  presentScript: string;
}

/** The character that separates several ids stamped on one element. */
export const QUIRE_ID_SEPARATOR = '|';

/**
 * The gutter used when {@link QuireLayoutOptions.gap} is omitted.
 * A layout constant of the multi-column strategy. See the doc comment on `gap`.
 */
export const QUIRE_COLUMN_GAP = 24;

/** The attribute the caller stamps, and the only place quire looks for identity. */
export const QUIRE_ID_ATTRIBUTE = 'data-quire-id';
