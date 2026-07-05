import { Directive, Input, OnChanges } from '@angular/core';
import { CdkVirtualScrollViewport, VIRTUAL_SCROLL_STRATEGY, VirtualScrollStrategy } from '@angular/cdk/scrolling';
import { Observable, Subject } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

/**
 * A variable-height virtual-scroll strategy for CDK's `cdk-virtual-scroll-viewport`.
 *
 * CDK ships only a FIXED-size strategy (every row must be one height), and the
 * `autosize` strategy that measures rows lives in `@angular/cdk-experimental`,
 * which we don't bundle (and which stutters on iOS momentum scroll). A synced
 * transcript is the opposite of fixed height — a cue is anywhere from one line
 * to six — so neither fits.
 *
 * This strategy takes a per-row ESTIMATED height (the caller computes it from
 * the cue's character count → wrapped line count → px) and positions rows from
 * the running prefix-sum of those estimates. There is no measure-then-correct
 * loop, so there is no scroll "jump": every offset comes from the same estimate
 * basis, so the math is self-consistent. Rows still render at their REAL height
 * inside the content wrapper — only the scrollbar proportion and scroll-to
 * targets are approximate, which is imperceptible for a reading transcript.
 *
 * Rendered window = the viewport plus one screenful of overscan on each side, so
 * estimate error well under a screen never leaves a visible gap.
 */
export class VarSizeVirtualScrollStrategy implements VirtualScrollStrategy {
  private viewport: CdkVirtualScrollViewport | null = null;
  private sizes: number[] = [];
  /** Prefix sums: offsets[i] = top of row i; length sizes.length + 1 (last = total). */
  private offsets: number[] = [0];

  private readonly indexSubject = new Subject<number>();
  readonly scrolledIndexChange: Observable<number> = this.indexSubject.pipe(distinctUntilChanged());

  attach(viewport: CdkVirtualScrollViewport): void {
    this.viewport = viewport;
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  detach(): void {
    this.viewport = null;
  }

  /** Replace the per-row estimated heights and re-lay-out (called on data change). */
  updateItemSizes(sizes: number[]): void {
    this.sizes = sizes;
    this.offsets = new Array(sizes.length + 1);
    this.offsets[0] = 0;
    for (let i = 0; i < sizes.length; i++) this.offsets[i + 1] = this.offsets[i] + sizes[i];
    if (this.viewport) {
      this.updateTotalContentSize();
      this.updateRenderedRange();
    }
  }

  onContentScrolled(): void { this.updateRenderedRange(); }
  onDataLengthChanged(): void { this.updateTotalContentSize(); this.updateRenderedRange(); }
  onContentRendered(): void { /* no re-measure — estimates drive layout */ }
  onRenderedOffsetChanged(): void { /* nothing to reconcile */ }

  scrollToIndex(index: number, behavior: ScrollBehavior): void {
    if (!this.viewport) return;
    const i = Math.max(0, Math.min(index, this.sizes.length - 1));
    this.viewport.scrollToOffset(this.offsets[i] ?? 0, behavior);
  }

  /** Top offset (px) of a row — lets the caller center a row itself. */
  offsetOf(index: number): number {
    const i = Math.max(0, Math.min(index, this.sizes.length));
    return this.offsets[i] ?? 0;
  }

  private updateTotalContentSize(): void {
    this.viewport?.setTotalContentSize(this.offsets[this.sizes.length] ?? 0);
  }

  /** Largest row index whose top is at or above `offset` (binary search). */
  private indexAtOffset(offset: number): number {
    const n = this.sizes.length;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private updateRenderedRange(): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const n = this.sizes.length;
    if (n === 0) {
      viewport.setRenderedRange({ start: 0, end: 0 });
      viewport.setRenderedContentOffset(0);
      return;
    }

    const scrollOffset = viewport.measureScrollOffset();
    const viewportSize = viewport.getViewportSize();
    const buffer = viewportSize; // one screenful of overscan each side

    const start = this.indexAtOffset(Math.max(0, scrollOffset - buffer));
    // +1 to make the range END exclusive, +1 more so a partly-visible last row is included.
    const end = Math.min(n, this.indexAtOffset(scrollOffset + viewportSize + buffer) + 2);

    const current = viewport.getRenderedRange();
    if (current.start !== start || current.end !== end) {
      viewport.setRenderedRange({ start, end });
    }
    viewport.setRenderedContentOffset(this.offsets[start]);
    this.indexSubject.next(this.indexAtOffset(scrollOffset));
  }
}

/**
 * Attaches {@link VarSizeVirtualScrollStrategy} to a `cdk-virtual-scroll-viewport`.
 * Bind the per-row estimated heights: `[appVarVirtualScroll]="rowSizes()"`.
 * Mirrors CDK's own `CdkFixedSizeVirtualScroll` directive wiring.
 */
@Directive({
  selector: 'cdk-virtual-scroll-viewport[appVarVirtualScroll]',
  standalone: true,
  providers: [{
    provide: VIRTUAL_SCROLL_STRATEGY,
    useFactory: (d: VarVirtualScrollDirective) => d.strategy,
    deps: [VarVirtualScrollDirective],
  }],
})
export class VarVirtualScrollDirective implements OnChanges {
  /** Estimated height in px for each row, in render order. */
  @Input('appVarVirtualScroll') itemSizes: number[] = [];

  readonly strategy = new VarSizeVirtualScrollStrategy();

  ngOnChanges(): void {
    this.strategy.updateItemSizes(this.itemSizes ?? []);
  }
}
