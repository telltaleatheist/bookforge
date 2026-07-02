import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { PlayerService } from '../services/player.service';
import { ReaderStateService } from '../services/reader-state.service';
import { IconComponent } from '../shared/icon.component';
import { encodePathId } from '../shared/path-id';

/**
 * Persistent bottom bar shown whenever a book is open in the reader but the full
 * reader isn't on screen (minimized). Tapping it reopens the reader at the saved
 * position; ✕ ends the reading session. Sits above the audio mini-player when
 * both are present so the two bars don't overlap.
 */
@Component({
  selector: 'app-mini-reader',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (visible()) {
      <div class="mini" [style.bottom]="bottomOffset()">
        <div class="mini-main" (click)="reopen()">
          <div class="mini-cover">
            @if (session()!.cover; as src) { <img [src]="src" alt="" /> } @else { <app-icon name="book" [size]="20" /> }
          </div>
          <div class="mini-info">
            <div class="mini-title">{{ session()!.title }}</div>
            <div class="mini-sub">Reading@if (reader.progress()) { <span> · {{ reader.progress() }}</span> }</div>
          </div>
          <button class="mini-close" (click)="close($event)" title="Close book">✕</button>
        </div>
      </div>
    }
  `,
  styles: [`
    .mini { position: fixed; left: 0; right: 0; z-index: 200; display: flex; flex-direction: column;
      background: var(--bg-surface); border-top: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); animation: slideUp 0.2s ease-out; }
    @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .mini-main { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 14px; cursor: pointer; }
    .mini-cover { width: 42px; height: 42px; flex-shrink: 0; border-radius: 6px; overflow: hidden; background: var(--bg-elevated);
      display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); }
    .mini-cover img { width: 100%; height: 100%; object-fit: cover; }
    .mini-info { flex: 1; min-width: 0; }
    .mini-title { font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini-sub { font-size: 11px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini-close { width: 40px; height: 40px; flex-shrink: 0; border: none; border-radius: 8px; background: transparent; color: var(--text-secondary);
      font-size: 15px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  `],
})
export class MiniReaderComponent implements OnDestroy {
  readonly reader = inject(ReaderStateService);
  private readonly player = inject(PlayerService);
  private readonly router = inject(Router);

  private readonly url = signal(this.router.url);
  private readonly sub: Subscription;

  readonly session = this.reader.session;
  readonly visible = computed(() => !!this.session() && !this.url().startsWith('/read'));
  // Sit above the constant nav rail; stack further up above the audio mini-player
  // when it's also showing. Heights come from the shell's CSS vars.
  readonly bottomOffset = computed(() =>
    this.player.book() && !this.url().startsWith('/play')
      ? 'calc(var(--bf-nav-h) + var(--bf-mini-h) + env(safe-area-inset-bottom))'
      : 'calc(var(--bf-nav-h) + env(safe-area-inset-bottom))',
  );

  constructor() {
    this.sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.url.set(e.urlAfterRedirects);
    });
  }

  ngOnDestroy(): void { this.sub.unsubscribe(); }

  reopen(): void {
    const s = this.session();
    if (s) this.router.navigate(['/read', encodePathId(s.ref)]);
  }

  close(event: Event): void {
    event.stopPropagation();
    this.reader.end();
  }
}
