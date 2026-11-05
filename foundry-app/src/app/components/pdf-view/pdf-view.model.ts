/**
 * pdf-view.model — the viewer's shapes and constants, and laying out a page's text.
 */
import { computed } from '@angular/core';
import { Util, type PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';

// ─────────────────────────────────────────────────────────────────────────────

export interface PageBox { number: number; width: number; height: number }

export interface Shell { number: number; width: number; height: number }

export interface Match { page: number; item: number }

export interface PageText { number: number; lower: string; starts: readonly number[] }

/**
 * A text item, as much of one as this file touches.
 *
 * Declared here rather than imported from pdfjs-dist's deep type paths: four
 * fields is the whole of the contract, and a structural type cannot break on a
 * version that moves a declaration file.
 */
export interface TextItem {
  str: string;
  width: number;
  height: number;
  hasEOL: boolean;
  transform: number[];
}

/** Only the two methods this file calls, so the page proxy need not be imported. */
export interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
}

/**
 * Where pdf.js's own files were copied to, addressed off the document.
 *
 * `/pdfjs/…` under `ng serve` and `./pdfjs/…` beside index.html in a packaged
 * build, because the production configuration sets baseHref to `./` and a
 * packaged renderer is a `file://` page with no server under it.
 */
export const PDFJS_ASSETS = new URL('pdfjs/', document.baseURI);

export const ZOOM_STEPS = [0.25, 0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4] as const;

/** e^(100·rate) ≈ 1.2 — one wheel notch is one comfortable zoom step. */
export const WHEEL_RATE = 0.0018;

export const THUMB_WIDTH = 84;

/** Long enough that typing a word is one search, short enough to feel live. */
export const QUERY_DELAY_MS = 250;

export function pageOf(target: Element): number | null {
  const raw = target.getAttribute('data-page');
  if (raw === null) return null;
  const number = Number.parseInt(raw, 10);
  return Number.isFinite(number) ? number : null;
}

/** Which item a character offset falls in. The starts are ascending, so this is a walk. */
export function itemAt(starts: readonly number[], offset: number): number {
  let found = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index]! > offset) break;
    found = index;
  }
  return found;
}

/**
 * Put every text item where the page put it — THE arithmetic of this file.
 *
 * `Util.transform(viewport.transform, item.transform)` composes the item's text
 * matrix with the viewport's, which is what turns PDF user space (y up, origin
 * bottom-left, points) into CSS pixels (y down, origin top-left, at the scale
 * the canvas beside it was drawn at). Both panes call this, so a layer that is
 * half a page off is half a page off in both — which is the only way the right
 * pane can be evidence about the left.
 *
 * The horizontal squeeze is measured rather than assumed: the layer's own font
 * is not on this machine, so a span set at the right size is still the wrong
 * WIDTH, and a line of text 15% too long is a line that no longer sits over its
 * ink. The item carries the width it occupied; the ruler says what the browser
 * will actually draw; the ratio between them goes on as a scaleX.
 */
export function layoutText(
  items: readonly TextItem[],
  viewport: PageViewport,
  into: HTMLElement,
  ruler: CanvasRenderingContext2D | null,
): HTMLElement[] {
  const spans: HTMLElement[] = [];
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const tx = Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(tx[2]!, tx[3]!);
    const angle = Math.atan2(tx[1]!, tx[0]!);
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.fontFamily = LAYER_FONT;
    span.style.fontSize = `${size}px`;
    // An upright item's baseline box hangs from its origin; a rotated one's
    // hangs along the rotation. foundry never writes an angled line, but a page
    // bound sideways or somebody else's layer can carry one.
    span.style.left = `${angle === 0 ? tx[4]! : tx[4]! + size * Math.sin(angle)}px`;
    span.style.top = `${angle === 0 ? tx[5]! - size : tx[5]! - size * Math.cos(angle)}px`;

    let transform = angle === 0 ? '' : `rotate(${angle}rad)`;
    if (ruler) {
      ruler.font = `${size}px ${LAYER_FONT}`;
      const drawn = ruler.measureText(item.str).width;
      const wanted = item.width * viewport.scale;
      if (drawn > 0 && wanted > 0) transform += ` scaleX(${wanted / drawn})`;
    }
    if (transform.length > 0) span.style.transform = transform;

    spans.push(span);
    fragment.append(span);
  }
  into.replaceChildren(fragment);
  return spans;
}

/**
 * One family for both panes and for the ruler that measures them.
 *
 * The point is not that it resembles the scan's typeface — it cannot, and the
 * squeeze above corrects the width regardless. The point is that the measuring
 * and the drawing use the SAME font, because the moment they disagree every
 * span is scaled by a ratio computed for a different shape.
 */
export const LAYER_FONT = 'serif';
