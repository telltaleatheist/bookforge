/**
 * capture-grid.carry — carrying cards across the table: picking up, landing, putting down, and chasing the edge.
 */
import { PAGE_MIME, SCROLL_BAND, SCROLL_STEP, carriesFiles } from './capture-grid.model';
import type { CaptureGridComponent } from './capture-grid.component';

export function pickUp(this: CaptureGridComponent, event: DragEvent, id: string): void {
  this.carrying = id;
  event.dataTransfer?.setData(PAGE_MIME, id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

/**
 * The pointer is over the table with a card in hand.
 *
 * Without `preventDefault` the browser refuses the drop and the whole gesture
 * ends in the "return to origin" animation with nothing having happened. The
 * guard comes first: a drag carrying FILES must fall through untouched, or
 * this handler would claim it and the window's intake would never hear it.
 */
export function overTable(this: CaptureGridComponent, event: DragEvent): void {
  if (this.carrying === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  this.landing.set(this.landingFor(event));
  this.chase(event.clientY);
}

/**
 * WHERE THE POINTER SAYS THIS CARD GOES — by MIDPOINT, which is the fix.
 *
 * ── The half of the card the pointer is in decides the side ──────────────
 *
 * Aiming at a card used to mean "in front of this one", so the only way to put
 * something after card N was to aim at card N+1 — and past the last card there
 * is no N+1 to aim at. Reading the halves gives every card two answers and the
 * last one an answer nobody could express before, and it is also what people
 * already expect: the line appears on the side of the card the hand is on.
 *
 * ── AND THE TABLE'S OWN SPACE IS AN ANSWER RATHER THAN A MISS ────────────
 *
 * A pointer over the padding below the last row, or over the gap at the end of
 * a half-full row, is not aiming at nothing — it is aiming past everything. So
 * it lands at the end of the book, which is the only place it could sensibly
 * mean.
 */
export function landingFor(this: CaptureGridComponent, event: DragEvent): number {
  const ids = this.cards().map((card) => card.id);
  const target = event.target;
  const slot = target instanceof Element ? target.closest('[data-id]') : null;
  const id = slot?.getAttribute('data-id') ?? null;
  const index = id === null ? -1 : ids.indexOf(id);
  if (slot === null || index === -1) return ids.length;
  const box = slot.getBoundingClientRect();
  return event.clientX > box.left + box.width / 2 ? index + 1 : index;
}

export function landOnTable(this: CaptureGridComponent, event: DragEvent): void {
  const carried = this.carrying;
  const to = this.landingFor(event);
  this.putDown();
  if (carried === null) return;
  event.preventDefault();
  // Inside the grid only — a file dropped on the table is not a reorder, and
  // letting it fall through to the window would open it as a document.
  event.stopPropagation();

  const ids = this.cards().map((card) => card.id);
  const from = ids.indexOf(carried);
  if (from === -1) return;
  // Landing on either side of where it already is moves nothing, and emitting
  // an identical arrangement would mark the project changed for a gesture that
  // did not change it.
  if (to === from || to === from + 1) return;

  const rest = ids.filter((id) => id !== carried);
  // The insertion is an index into the ORIGINAL list; once the carried card is
  // removed, every position after it shifts down by one.
  const at = from < to ? to - 1 : to;
  this.reorder.emit([...rest.slice(0, at), carried, ...rest.slice(at)]);
}

export function putDown(this: CaptureGridComponent): void {
  this.carrying = null;
  this.landing.set(null);
  this.stopChasing();
}

/**
 * The pointer left the table with a card still in hand — stop scrolling.
 *
 * `dragleave` also fires on every crossing BETWEEN children, which is
 * continuous while somebody drags across fifty cards, so the relatedTarget is
 * asked whether the pointer is still inside. Without that guard the scroll
 * would stall the moment the pointer crossed a card boundary — which is to
 * say, always.
 */
export function leftTable(this: CaptureGridComponent, event: DragEvent): void {
  const table = this.tableEl();
  const into = event.relatedTarget;
  if (table !== null && into instanceof Node && table.contains(into)) return;
  this.stopChasing();
}

export function chase(this: CaptureGridComponent, y: number): void {
  this.chasingAt = y;
  if (this.chasing !== 0) return;
  const step = (): void => {
    const table = this.tableEl();
    const at = this.chasingAt;
    if (table === null || at === null) {
      this.chasing = 0;
      return;
    }
    const box = table.getBoundingClientRect();
    const above = (box.top + SCROLL_BAND - at) / SCROLL_BAND;
    const below = (at - (box.bottom - SCROLL_BAND)) / SCROLL_BAND;
    if (above > 0) table.scrollTop -= Math.min(1, above) * SCROLL_STEP;
    else if (below > 0) table.scrollTop += Math.min(1, below) * SCROLL_STEP;
    this.chasing = requestAnimationFrame(step);
  };
  this.chasing = requestAnimationFrame(step);
}

export function stopChasing(this: CaptureGridComponent): void {
  if (this.chasing !== 0) cancelAnimationFrame(this.chasing);
  this.chasing = 0;
  this.chasingAt = null;
}

export function tableEl(this: CaptureGridComponent): HTMLElement | null {
  return this.host.nativeElement.querySelector('.table');
}

export function warm(this: CaptureGridComponent, event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  this.hot.set(true);
}

export function cool(this: CaptureGridComponent): void {
  this.hot.set(false);
}

export function take(this: CaptureGridComponent, event: DragEvent): void {
  this.cool();
  if (!carriesFiles(event)) return;
  event.preventDefault();
  // See the class docblock: the window now intakes too, so without this a
  // drop on the strip would be answered twice.
  event.stopPropagation();
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) this.dropped.emit(files);
}
