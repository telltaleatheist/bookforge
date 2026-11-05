/**
 * pdf-view.draw — opening the document and drawing its pages, text layers and thumbnails.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { api } from '../../core/foundry';
import { PageBox, TextItem, PdfPage, PDFJS_ASSETS, THUMB_WIDTH, pageOf, layoutText } from './pdf-view.model';
import type { PdfViewComponent } from './pdf-view.component';

// ── Opening ──────────────────────────────────────────────────────────────

/**
 * Read the file and take its measurements.
 *
 * EVERY PAGE'S SIZE IS ASKED FOR UP FRONT, which for a long book is a few
 * hundred round trips to the worker before the first page appears. It buys a
 * scrollbar that tells the truth: guessing the rest of the book from page one
 * makes every page after the first mixed-size one jump under the reader's
 * cursor, and a viewer that moves the page while you read it is worse than
 * one that took another moment to open.
 */
export async function open(this: PdfViewComponent, filePath: string): Promise<void> {
  this.generation += 1;
  const mine = this.generation;
  /*
   * WHERE THE READER WAS, kept across the re-open.
   *
   * A tab's document is re-read for two reasons and BOTH of them are the same
   * document: it was relocated onto the project's own copy of itself (the
   * bytes are identical), or it was generated again under the same name. In
   * neither case has the person stopped reading page 214 — but the pane threw
   * them back to page one, because a re-open is a fresh document as far as
   * everything below here is concerned.
   *
   * Restored only when the new document is long enough to have that page,
   * which is the whole of the safety: a shorter book simply opens where it
   * always did.
   */
  const wasAt = this.current();
  this.teardown();
  this.problem.set(null);
  this.boxes.set([]);
  this.itemCounts.set(new Map());
  this.pageProblems.set(new Map());
  this.matches.set([]);
  this.query.set('');
  this.current.set(1);

  if (!api) {
    this.problem.set('This window is not running inside Foundry, so it cannot read files.');
    return;
  }

  try {
    const bytes = await api.documentBytes(filePath);
    if (mine !== this.generation) return;

    const task = getDocument({
      data: bytes,
      worker: this.worker,
      // Everything pdf.js may need at runtime, shipped beside the worker.
      // Absent, an unusual scan renders blank and says nothing.
      cMapUrl: new URL('cmaps/', PDFJS_ASSETS).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', PDFJS_ASSETS).href,
      wasmUrl: new URL('wasm/', PDFJS_ASSETS).href,
      iccUrl: new URL('iccs/', PDFJS_ASSETS).href,
    });
    this.loadingTask = task;
    const doc = await task.promise;
    if (mine !== this.generation) { task.destroy().catch(() => undefined); return; }

    const boxes: PageBox[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      if (mine !== this.generation) return;
      const viewport = page.getViewport({ scale: 1 });
      boxes.push({ number, width: viewport.width, height: viewport.height });
    }
    this.doc.set(doc);
    this.boxes.set(boxes);
    this.fitWidth();
    // A frame later, because `jumpTo` measures the page divs `shells()` has
    // only just been given the numbers for.
    if (wasAt > 1 && wasAt <= boxes.length) {
      requestAnimationFrame(() => {
        if (mine === this.generation) this.jumpTo(wasAt);
      });
    }
  } catch (err) {
    if (mine !== this.generation) return;
    // By name, never swallowed: a tab showing nothing with no reason on it is
    // the failure this app refuses to ship (ARCHITECTURE §8).
    this.problem.set(err instanceof Error ? err.message : String(err));
  }
}

// ── Drawing ──────────────────────────────────────────────────────────────

export async function draw(this: PdfViewComponent, number: number): Promise<void> {
  const doc = this.doc();
  const factor = this.scale();
  if (!doc || this.drawn.get(number) === factor) return;
  const shell = this.pageEls().find((box) => pageOf(box.nativeElement) === number)?.nativeElement;
  const canvas = shell?.querySelector('canvas');
  const textEl = shell?.querySelector<HTMLElement>('.text');
  if (!shell || !canvas || !textEl) return;

  this.tasks.get(number)?.cancel();
  this.drawn.set(number, factor);
  const mine = this.generation;

  try {
    const page = await doc.getPage(number);
    if (mine !== this.generation || this.drawn.get(number) !== factor) return;
    const viewport = page.getViewport({ scale: factor });

    // devicePixelRatio-aware, capped. A 3× display would otherwise quadruple
    // the memory of every page on screen for a difference nobody can see on
    // a photograph of paper.
    const density = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewport.width * density);
    canvas.height = Math.round(viewport.height * density);
    const context = canvas.getContext('2d');
    if (!context) return;

    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
    });
    this.tasks.set(number, task);
    await task.promise;
    this.tasks.delete(number);
    if (mine !== this.generation) return;

    const items = await this.textOf(page, number);
    if (mine !== this.generation || this.drawn.get(number) !== factor) return;

    const layerEl = this.tab().layerView
      ? this.layerEls().find((box) => pageOf(box.nativeElement) === number)
        ?.nativeElement.querySelector<HTMLElement>('.text')
      : null;
    this.spans.set(number, [
      layoutText(items, viewport, textEl, this.ruler),
      layerEl ? layoutText(items, viewport, layerEl, this.ruler) : [],
    ]);
    this.paintHit();
  } catch (err) {
    // Our own cancel, by name — the one outcome that is not a failure.
    if (err instanceof Error && err.name === 'RenderingCancelledException') return;
    this.drawn.delete(number);
    // ON THE PAGE, not over the document. A page that will not draw is a fact
    // about that page, and taking the whole book down for it would hide the
    // 499 that are fine — the reason is still said, by name, where the thing
    // it is about would have been. A blank page with no explanation is the
    // failure ARCHITECTURE §8 is about; this is not that.
    this.pageProblems.update((problems) => new Map(problems)
      .set(number, err instanceof Error ? err.message : String(err)));
  }
}

/**
 * A page's text items, cached and stripped of the empty ones.
 *
 * pdf.js emits a zero-length item every time the text state changes, which
 * for foundry's layer is once per line. They would be zero-width spans in
 * both panes and holes in the search's item indexing, so they go here — once,
 * where every consumer sees the same list.
 */
export async function textOf(this: PdfViewComponent, page: PdfPage, number: number): Promise<readonly TextItem[]> {
  const cached = this.items.get(number);
  if (cached) return cached;
  const content = await page.getTextContent();
  const items = (content.items as TextItem[]).filter(
    (item) => typeof item.str === 'string' && item.str.length > 0,
  );
  this.items.set(number, items);
  this.itemCounts.update((counts) => new Map(counts).set(number, items.length));
  return items;
}

export async function drawThumb(this: PdfViewComponent, number: number): Promise<void> {
  const doc = this.doc();
  if (!doc || this.thumbsDrawn.has(number)) return;
  const canvas = this.thumbEls().find((box) => pageOf(box.nativeElement) === number)
    ?.nativeElement.querySelector('canvas');
  if (!canvas) return;
  this.thumbsDrawn.add(number);
  const mine = this.generation;
  try {
    const page = await doc.getPage(number);
    if (mine !== this.generation) return;
    const unit = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / unit.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) return;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
  } catch (err) {
    // A thumbnail that will not draw stays blank rather than taking the
    // viewer down with it — the page itself is where a real failure is said.
    if (!(err instanceof Error && err.name === 'RenderingCancelledException')) {
      this.thumbsDrawn.delete(number);
    }
  }
}
