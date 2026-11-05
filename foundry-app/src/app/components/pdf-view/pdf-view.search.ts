/**
 * pdf-view.search — finding text in the PDF and stepping through the hits.
 */
import { Match, PageText, QUERY_DELAY_MS, itemAt } from './pdf-view.model';
import type { PdfViewComponent } from './pdf-view.component';

// ── Searching ────────────────────────────────────────────────────────────

/**
 * CASE-INSENSITIVE SUBSTRING, and nothing cleverer. No word boundaries, no
 * regex, no ligature or diacritic folding — the job this has to do is let
 * Owen type a word he can see on the scan and find out whether the layer
 * under it says the same thing, and for that a substring is the honest test.
 * Anything smarter would find matches the layer does not literally contain,
 * which is the one answer this feature must never give.
 */
export function onQuery(this: PdfViewComponent, text: string): void {
  this.query.set(text);
  if (this.queryTimer !== null) clearTimeout(this.queryTimer);
  this.queryTimer = setTimeout(() => { void this.run(text); }, QUERY_DELAY_MS);
}

export async function run(this: PdfViewComponent, text: string): Promise<void> {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) {
    this.matches.set([]);
    this.paintHit();
    return;
  }
  const index = await this.index();
  if (index === null || this.query().trim().toLowerCase() !== needle) return;

  const found: Match[] = [];
  for (const page of index) {
    const hay = page.lower;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      // The item the match STARTS in. A match that runs over the end of one
      // item is highlighted on the item it began in rather than on both —
      // the highlight is a pointer to the place, not a measurement of it.
      found.push({ page: page.number, item: itemAt(page.starts, at) });
    }
  }
  this.matches.set(found);
  this.at.set(0);
  if (found.length > 0) this.go(found[0]!);
  else this.paintHit();
}

/**
 * Every page's text, read once.
 *
 * This is the expensive thing in the file — a whole book through the worker —
 * so it happens on the first search rather than on open, and is kept until
 * the document changes. The toolbar says "reading…" while it runs, because a
 * search box that does nothing for four seconds looks broken.
 */
export async function index(this: PdfViewComponent): Promise<readonly PageText[] | null> {
  if (this.searchIndex) return this.searchIndex;
  const doc = this.doc();
  if (!doc) return null;
  const mine = this.generation;
  this.searching.set(true);
  try {
    const pages: PageText[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      if (mine !== this.generation) return null;
      const items = await this.textOf(page, number);
      let text = '';
      const starts: number[] = [];
      for (const item of items) {
        starts.push(text.length);
        // A newline where the item said the line ended, so two lines of the
        // layer cannot be read as one word run together.
        text += item.hasEOL ? `${item.str}\n` : item.str;
      }
      pages.push({ number, lower: text.toLowerCase(), starts });
    }
    if (mine !== this.generation) return null;
    this.searchIndex = pages;
    return pages;
  } finally {
    this.searching.set(false);
  }
}

export function step(this: PdfViewComponent, delta: number): void {
  const found = this.matches();
  if (found.length === 0) {
    // Enter on a query that has not run yet — run it now rather than nothing.
    if (this.query().trim().length > 0) void this.run(this.query());
    return;
  }
  const next = (this.at() + delta + found.length) % found.length;
  this.at.set(next);
  this.go(found[next]!);
}

export function go(this: PdfViewComponent, match: Match): void {
  this.jumpTo(match.page);
  // The page may not be drawn yet; `draw` calls paintHit when it finishes, so
  // this call is for the case where it already is.
  this.paintHit();
}

/** The current match's spans, in whichever panes are drawn. */
export function paintHit(this: PdfViewComponent): void {
  const found = this.matches();
  const hit = found[this.at()] ?? null;
  for (const [number, panes] of this.spans) {
    for (const pane of panes) {
      for (let index = 0; index < pane.length; index += 1) {
        const wanted = hit !== null && hit.page === number && hit.item === index;
        pane[index]?.classList.toggle('hit', wanted);
      }
    }
  }
}
