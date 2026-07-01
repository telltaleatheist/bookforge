import { Directive, ElementRef, inject, output, OnInit, OnDestroy } from '@angular/core';

/**
 * Emits `visible` exactly once, the first time the host element scrolls into
 * (or near) the viewport. Used to lazy-load cover images on the shelf grid.
 */
@Directive({
  selector: '[appVisible]',
  standalone: true,
})
export class VisibleDirective implements OnInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  readonly visible = output<void>();
  private observer: IntersectionObserver | null = null;

  ngOnInit(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.visible.emit();
            this.observer?.disconnect();
            this.observer = null;
            break;
          }
        }
      },
      { rootMargin: '200px', threshold: 0 }
    );
    this.observer.observe(this.el.nativeElement);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
