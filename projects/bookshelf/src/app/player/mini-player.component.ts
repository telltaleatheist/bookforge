import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { PlayerService } from '../services/player.service';
import { IconComponent } from '../shared/icon.component';
import { encodePathId } from '../shared/path-id';
import { formatTime } from '../shared/format';

/**
 * Persistent bottom bar shown whenever a book is loaded but the full player
 * isn't on screen. Tapping the cover/title reopens the full player; the
 * play/pause button and seek bar control playback in place so the user can
 * keep browsing while listening.
 */
@Component({
  selector: 'app-mini-player',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (visible()) {
      <div class="mini" [class.dragging]="dragging()"
           [style.transform]="dragY() ? 'translateY(' + dragY() + 'px)' : null"
           [style.opacity]="dragY() > 0 ? closeOpacity() : 1"
           (touchstart)="onDragStart($event)" (touchmove)="onDragMove($event)"
           (touchend)="onDragEnd()" (touchcancel)="onDragEnd()">
        <div class="mini-main" (click)="reopen()">
          <div class="mini-cover">
            @if (p.coverSrc(); as src) { <img [src]="src" alt="" /> } @else { <span>🎧</span> }
          </div>
          <div class="mini-info">
            <div class="mini-title">{{ p.book()!.title }}</div>
            @if (p.book()!.author) { <div class="mini-author">{{ p.book()!.author }}</div> }
          </div>
          <button class="mini-play" (click)="togglePlay($event)" [title]="p.isPlaying() ? 'Pause' : 'Play'">
            <app-icon [name]="p.isPlaying() ? 'pause' : 'play'" [size]="20" />
          </button>
        </div>
        <div class="mini-seek">
          <span class="mini-time">{{ fmt(p.currentTime()) }}</span>
          <div class="scrub" (click)="$event.stopPropagation()">
            <div class="scrub-track">
              @for (seg of heardSegs(); track $index) {
                <span class="heard-seg" [style.left.%]="seg.left" [style.width.%]="seg.width"></span>
              }
            </div>
            @for (n of chapterNotches(); track $index) {
              <span class="notch" [style.left.%]="n"></span>
            }
            <input class="scrubber bare" type="range" min="0" [max]="p.duration() || 0" step="1"
              [value]="p.currentTime()" (input)="onScrub($event)"
              (pointerdown)="onScrubStart()" (pointerup)="onScrubEnd()" (pointercancel)="onScrubEnd()" (change)="onScrubEnd()" />
          </div>
          <span class="mini-time">{{ fmt(p.duration()) }}</span>
        </div>
      </div>
    }
  `,
  styles: [`
    /* Sits directly ABOVE the constant bottom nav rail, never overlapping it.
       The rail's total height is --bf-nav-h + the safe-area inset (content +
       home-indicator padding), so this offset lands flush on its top edge.
       Tapping anywhere but the play/scrub controls opens the full player. */
    .mini { position: fixed; left: 0; right: 0; bottom: calc(var(--bf-nav-h) + env(safe-area-inset-bottom)); z-index: 200; display: flex; flex-direction: column;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent); border-top: 0.5px solid var(--border-subtle);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); animation: slideUp 0.2s ease-out;
      touch-action: pan-x; transition: transform 0.24s cubic-bezier(0.22,1,0.36,1), opacity 0.24s ease; will-change: transform; }
    /* While a finger is down the bar tracks it 1:1 (no easing); on release the
       transition above springs it back, or it commits (expand / dismiss). */
    .mini.dragging { transition: none; }
    @keyframes slideUp { from { transform: translateY(120%); } to { transform: translateY(0); } }

    .mini-main { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 14px; cursor: pointer; }
    .mini-cover { width: 42px; height: 42px; flex-shrink: 0; border-radius: 6px; overflow: hidden; background: var(--bg-elevated);
      display: flex; align-items: center; justify-content: center; font-size: 20px; color: var(--text-tertiary); }
    .mini-cover img { width: 100%; height: 100%; object-fit: cover; }
    .mini-info { flex: 1; min-width: 0; }
    .mini-title { font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini-author { font-size: 11px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini-play { width: 44px; height: 44px; flex-shrink: 0; border: none; border-radius: 50%; background: var(--accent); color: var(--text-on-accent);
      cursor: pointer; display: flex; align-items: center; justify-content: center; }

    .mini-seek { display: flex; align-items: center; gap: 8px; padding: 0 14px 8px; }
    .mini-time { font-size: 10px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; min-width: 40px; text-align: center; flex-shrink: 0; }

    /* Scrubber with the same listened-purple + chapter notches as the full player. */
    .scrub { position: relative; flex: 1; display: flex; align-items: center; height: 18px; }
    .scrub-track { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden; pointer-events: none; }
    .heard-seg { position: absolute; top: 0; bottom: 0; background: var(--accent); }
    .notch { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 2px; height: 4px; background: var(--bg-surface); pointer-events: none; }
    .scrubber { flex: 1; -webkit-appearance: none; appearance: none; height: 4px; background: var(--bg-elevated); border-radius: 2px; outline: none; cursor: pointer; }
    .scrubber.bare { width: 100%; flex: none; position: relative; z-index: 1; background: transparent; }
    .scrubber.bare::-webkit-slider-runnable-track { height: 4px; background: transparent; }
    .scrubber.bare::-moz-range-track { background: transparent; }
    .scrubber::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: var(--accent); border: none; box-shadow: 0 0 0 2px var(--bg-surface), 0 1px 3px rgba(0,0,0,0.4); }
    .scrubber::-moz-range-thumb { width: 14px; height: 14px; border: none; border-radius: 50%; background: var(--accent); }
  `],
})
export class MiniPlayerComponent implements OnDestroy {
  readonly p = inject(PlayerService);
  private readonly router = inject(Router);

  private readonly url = signal(this.router.url);
  private readonly sub: Subscription;

  readonly fmt = formatTime;
  readonly visible = computed(() => !!this.p.book() && !this.url().startsWith('/play'));

  // Whole-book listened purple (committed + provisional) as % positions.
  readonly heardSegs = computed(() => {
    const dur = this.p.duration();
    if (dur <= 0) return [];
    const intervals = [...this.p.heard()];
    const prov = this.p.provisional();
    if (prov) intervals.push(prov);
    return intervals.map(([s, e]) => ({ left: (s / dur) * 100, width: ((e - s) / dur) * 100 }));
  });
  readonly chapterNotches = computed(() => {
    const dur = this.p.duration();
    if (dur <= 0) return [];
    return this.p.chapters().map((c) => (c.start / dur) * 100).filter((pct) => pct > 0.5 && pct < 99.5);
  });

  constructor() {
    this.sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.url.set(e.urlAfterRedirects);
    });
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  /** Tapping the bar (cover/title/anywhere but the play button + scrubber) opens
   *  the full player. A vertical drag instead expands (up) or dismisses (down). */
  reopen(): void {
    const b = this.p.book();
    if (b) this.router.navigate(['/play', encodePathId(b.downloadPath)]);
  }

  // ── Drag: swipe up to expand, swipe down to dismiss ────────────────────────
  // Mirrors the full player's finger-following drag (player.component.ts). The
  // bar tracks the finger; on release, an up-drag past half the viewport opens
  // the full player, a down-drag past a short threshold closes the book.
  readonly dragY = signal(0);
  readonly dragging = signal(false);
  /** Fade the bar out as it's dragged down toward dismissal. */
  readonly closeOpacity = computed(() => Math.max(0.35, 1 - this.dragY() / 200));
  private dragStartY = 0;
  private dragActive = false;
  private static readonly DRAG_EXCLUDE = 'button, input, .scrub';
  private static readonly CLOSE_PX = 80;

  onDragStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    // Don't hijack the play button or the seek bar.
    if ((e.target as HTMLElement).closest(MiniPlayerComponent.DRAG_EXCLUDE)) return;
    this.dragStartY = e.touches[0].clientY;
    this.dragActive = true;
  }

  onDragMove(e: TouchEvent): void {
    if (!this.dragActive) return;
    const dy = e.touches[0].clientY - this.dragStartY;
    // Wait until the gesture is clearly a drag before capturing it (lets taps
    // through to the (click) reopen handler).
    if (!this.dragging() && Math.abs(dy) < 6) return;
    this.dragging.set(true);
    e.preventDefault(); // suppress page scroll + the synthesized click
    this.dragY.set(dy);
  }

  onDragEnd(): void {
    if (!this.dragActive) return;
    this.dragActive = false;
    if (!this.dragging()) return; // was a tap — leave (click) to handle it
    const dy = this.dragY();
    this.dragging.set(false);
    this.dragY.set(0); // spring back unless we commit below
    if (-dy >= window.innerHeight * 0.5) {
      this.reopen();            // dragged up past half the screen → expand
    } else if (dy >= MiniPlayerComponent.CLOSE_PX) {
      this.p.close();           // dragged down → dismiss the book
    }
  }

  togglePlay(event: Event): void {
    event.stopPropagation();
    this.p.togglePlay();
  }

  private scrubbing = false;
  private scrubFromPos = 0;
  onScrubStart(): void { this.scrubbing = true; this.scrubFromPos = this.p.currentTime(); }
  onScrubEnd(): void {
    if (this.scrubbing && Math.abs(this.p.currentTime() - this.scrubFromPos) > 30) {
      this.p.markJumpFrom(this.scrubFromPos);
      this.p.armArrivalBookmark();
    }
    this.scrubbing = false;
  }

  onScrub(event: Event): void {
    let v = parseFloat((event.target as HTMLInputElement).value);
    if (this.scrubbing) v = this.snapToMarks(v);
    this.p.seekTo(v);
  }

  /** Snap a drag to listened-segment edges + chapter boundaries (whole book). */
  private snapToMarks(v: number): number {
    const dur = this.p.duration() || 0;
    if (dur <= 0) return v;
    const band = dur * 0.01;
    const marks: number[] = [];
    for (const [s, e] of this.p.heard()) marks.push(s, e);
    const chs = this.p.chapters();
    for (const c of chs) marks.push(c.start);
    if (chs.length) marks.push(chs[chs.length - 1].end);
    let best = v;
    let bestDist = band;
    for (const m of marks) {
      const d = Math.abs(v - m);
      if (d <= bestDist) { bestDist = d; best = m; }
    }
    return best;
  }
}
