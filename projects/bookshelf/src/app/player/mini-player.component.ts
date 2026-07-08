import { Component, computed, ElementRef, inject, OnDestroy, signal } from '@angular/core';
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
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  private readonly url = signal(this.router.url);
  private readonly sub: Subscription;

  readonly fmt = formatTime;
  // Stay mounted while an expand drag is in flight even though the route is now
  // /play — touch events keep flowing to this (the touchstart target), so this
  // bar drives the whole gesture until release.
  readonly visible = computed(() =>
    !!this.p.book() && (!this.url().startsWith('/play') || this.p.expandY() !== null));

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

  // ── Drag: up to expand (the full player slides up under the finger), down to
  //    dismiss. Dragging up navigates to /play immediately and then drives the
  //    player panel's translateY via PlayerService.expandY, so the panel rises
  //    from the bottom following the finger — revealing top-bar, title, then the
  //    sentences in order. Release past half the screen snaps it fully open;
  //    short of that it slides back down to the mini bar.
  readonly dragY = signal(0); // used only for the down-to-dismiss affordance
  readonly dragging = signal(false);
  /** Fade the bar out as it's dragged down toward dismissal. */
  readonly closeOpacity = computed(() => Math.max(0.35, 1 - this.dragY() / 200));
  private dragStartY = 0;
  private dragActive = false;
  private expanding = false;
  /** Rest offset for the current expand: the top of the mini bar (above the nav
   *  rail), so the panel slides up from there rather than the screen bottom. */
  private expandRest = 0;
  private static readonly DRAG_EXCLUDE = 'button, input, .scrub';
  private static readonly CLOSE_PX = 80;
  private static readonly SNAP_MS = 260;

  private vh(): number { return window.innerHeight || 1; }
  /** Viewport-y of the top edge of the mini bar (where the slide originates). */
  private miniTop(): number {
    const el = this.hostRef.nativeElement.querySelector('.mini') as HTMLElement | null;
    return el ? el.getBoundingClientRect().top : this.vh();
  }

  onDragStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    // Don't hijack the play button or the seek bar.
    if ((e.target as HTMLElement).closest(MiniPlayerComponent.DRAG_EXCLUDE)) return;
    this.dragStartY = e.touches[0].clientY;
    this.dragActive = true;
    this.expanding = false;
  }

  onDragMove(e: TouchEvent): void {
    if (!this.dragActive) return;
    const dy = e.touches[0].clientY - this.dragStartY;
    // Wait until the gesture is clearly a drag before capturing it (lets taps
    // through to the (click) reopen handler).
    if (!this.dragging() && Math.abs(dy) < 6) return;
    this.dragging.set(true);
    e.preventDefault(); // suppress page scroll + the synthesized click
    const up = -dy;
    if (this.expanding || up > 0) {
      // Expand mode: the full player follows the finger up from the mini bar.
      if (!this.expanding) {
        this.expanding = true;
        this.expandRest = this.miniTop(); // originate at the mini bar, not the screen bottom
        this.p.expandRest.set(this.expandRest);
        this.p.expandDragging.set(true);
        const b = this.p.book();
        if (b) this.router.navigate(['/play', encodePathId(b.downloadPath)]);
      }
      const rest = this.expandRest;
      this.p.expandY.set(Math.max(0, Math.min(rest, rest - up)));
    } else {
      this.dragY.set(dy); // downward from rest → dismiss affordance
    }
  }

  onDragEnd(): void {
    if (!this.dragActive) return;
    this.dragActive = false;
    const wasDrag = this.dragging();
    this.dragging.set(false);

    if (this.expanding) {
      this.expanding = false;
      this.p.expandDragging.set(false); // re-enable transition for the snap
      const rest = this.expandRest || this.vh();
      const risen = rest - (this.p.expandY() ?? rest);
      if (risen >= rest * 0.5) {
        this.p.expandY.set(0); // committed → snap fully open (stay on /play)
        setTimeout(() => this.p.expandY.set(null), MiniPlayerComponent.SNAP_MS);
      } else {
        this.p.expandY.set(rest); // fell short → slide back down to the mini bar
        // Navigate FIRST (unmount the player), then clear the offset, so the panel
        // never flashes to fully-open between clearing expandY and unmounting.
        setTimeout(() => { void this.router.navigate(['/']).then(() => this.p.expandY.set(null)); }, MiniPlayerComponent.SNAP_MS);
      }
      return;
    }

    if (!wasDrag) return; // was a tap — leave (click) to reopen
    const dy = this.dragY();
    this.dragY.set(0);
    if (dy >= MiniPlayerComponent.CLOSE_PX) this.p.close(); // dragged down → dismiss
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
