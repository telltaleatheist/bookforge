import {
  Component, effect, ElementRef, inject, OnDestroy, OnInit, signal, viewChild,
} from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { PlayerService } from '../services/player.service';
import { IconComponent } from '../shared/icon.component';
import { formatTime } from '../shared/format';
import { decodePathId } from '../shared/path-id';
import { Audiobook, Chapter } from '../models/types';

/**
 * Full-screen player view. State and audio live in PlayerService, so the
 * "down" button just navigates away — playback continues and the mini-bar
 * takes over. This component owns only the transcript scrolling and the
 * chapter / bookmark sheets.
 */
@Component({
  selector: 'app-player',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="player">
      <header class="topbar">
        <button class="icon-btn" (click)="minimize()" title="Minimize"><app-icon name="chevron-down" [size]="24" /></button>
        <div class="topbar-title">
          <div class="t-title">{{ p.book()?.title || 'Player' }}</div>
          @if (p.book()?.author) { <div class="t-author">{{ p.book()!.author }}</div> }
        </div>
        <a class="icon-btn" [href]="downloadHref()" [attr.download]="''" title="Download"><app-icon name="download" [size]="20" /></a>
      </header>

      @if (p.error()) {
        <div class="state"><div class="icon">⚠️</div><p>{{ p.error() }}</p></div>
      } @else if (p.loading()) {
        <div class="state"><div class="spinner"></div><p>Loading…</p></div>
      } @else {
        <div class="text-area" #textArea (scroll)="onUserScroll()">
          @if (p.cues().length > 0) {
            @for (cue of p.cues(); track cue.index) {
              @if (p.chapterStartMap().get(cue.index); as chapterTitle) {
                <div class="chapter-header">{{ chapterTitle }}</div>
              }
              <div class="segment"
                [class.active]="cue.index === p.currentCueIndex()"
                [class.past]="cue.index < p.currentCueIndex()"
                [attr.data-index]="cue.index"
                (click)="p.seekToCue(cue.index)">
                <p>{{ cue.text }}</p>
              </div>
            }
          } @else {
            <div class="no-text">
              @if (p.coverSrc(); as src) { <img class="big-cover" [src]="src" alt="Cover" /> }
              @else { <div class="big-cover placeholder">🎧</div> }
              <div class="nt-title">{{ p.book()?.title }}</div>
              @if (p.book()?.author) { <div class="nt-author">{{ p.book()!.author }}</div> }
              <p class="nt-note">No synced text for this audiobook — chapter navigation only.</p>
            </div>
          }
        </div>

        <div class="controls">
          @if (p.currentChapter(); as ch) {
            <button class="now-chapter" (click)="chaptersOpen.set(true)" title="Chapters">
              <span class="nc-label">{{ ch.title }}</span>
              <app-icon name="chevron-down" [size]="14" />
            </button>
          }

          <div class="scrub-row">
            <span class="time">{{ fmt(p.currentTime()) }}</span>
            <input class="scrubber" type="range" min="0" [max]="p.duration() || 0" step="1"
              [value]="p.currentTime()" (input)="onScrub($event)" />
            <span class="time">{{ fmt(p.duration()) }}</span>
          </div>

          <div class="transport">
            <button class="t-btn" (click)="p.prevChapter()" [disabled]="!p.canPrevChapter()" title="Previous chapter"><app-icon name="prev" [size]="24" /></button>
            <button class="t-btn skip-btn" (click)="p.skip(-15)" title="Back 15s">
              <app-icon name="replay" [size]="28" /><span class="skip-num">15</span>
            </button>
            <button class="t-btn play" (click)="p.togglePlay()" [title]="p.isPlaying() ? 'Pause' : 'Play'">
              <app-icon [name]="p.isPlaying() ? 'pause' : 'play'" [size]="28" />
            </button>
            <button class="t-btn skip-btn fwd" (click)="p.skip(30)" title="Forward 30s">
              <app-icon name="replay" [size]="28" /><span class="skip-num">30</span>
            </button>
            <button class="t-btn" (click)="p.nextChapter()" [disabled]="!p.canNextChapter()" title="Next chapter"><app-icon name="next" [size]="24" /></button>
          </div>

          <div class="bottom-row">
            <button class="chip" [class.on]="bookmarksOpen()" (click)="bookmarksOpen.set(!bookmarksOpen())">
              <app-icon name="bookmark" [size]="15" /> Bookmarks
            </button>
            <div class="speed">
              <input class="speed-slider" type="range" min="0.5" max="2" step="0.05" [value]="p.speed()" (input)="onSpeed($event)" />
              <span class="speed-val">{{ p.speed().toFixed(2) }}x</span>
            </div>
          </div>
        </div>

        @if (chaptersOpen()) {
          <div class="sheet-backdrop" (click)="chaptersOpen.set(false)"></div>
          <div class="sheet">
            <div class="sheet-head"><span>Chapters</span><button class="icon-btn sm" (click)="chaptersOpen.set(false)">✕</button></div>
            <div class="sheet-body">
              @for (ch of p.chapters(); track ch.start; let i = $index) {
                <button class="row-item" [class.active]="ch === p.currentChapter()" (click)="pickChapter(ch)">
                  <span class="row-num">{{ i + 1 }}</span>
                  <span class="row-title">{{ ch.title }}</span>
                  <span class="row-time">{{ fmt(ch.start) }}</span>
                </button>
              } @empty {
                <p class="sheet-empty">No chapters in this audiobook.</p>
              }
            </div>
          </div>
        }

        @if (bookmarksOpen()) {
          <div class="sheet-backdrop" (click)="bookmarksOpen.set(false)"></div>
          <div class="sheet">
            <div class="sheet-head"><span>Bookmarks</span><button class="icon-btn sm" (click)="bookmarksOpen.set(false)">✕</button></div>
            <div class="sheet-body">
              @for (bm of p.bookmarks(); track bm.id) {
                <div class="row-item bm">
                  <button class="bm-jump" (click)="pickBookmark(bm)">
                    <span class="row-title">{{ bm.label }}</span>
                    <span class="row-time">{{ fmt(bm.position) }}</span>
                  </button>
                  <button class="bm-del" (click)="p.removeBookmark(bm.id)" title="Delete">✕</button>
                </div>
              } @empty {
                <p class="sheet-empty">No bookmarks yet.</p>
              }
            </div>
            <button class="sheet-action" (click)="addBookmark()">+ Bookmark this spot</button>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; max-width: var(--app-max); height: 100%; }
    @media (min-width: 768px) { :host { border-inline: 1px solid var(--border-subtle); } }
    .player { display: flex; flex-direction: column; height: 100%; background: var(--bg-base); }

    .topbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0;
      padding: calc(8px + env(safe-area-inset-top)) 8px 8px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle); }
    .topbar-title { flex: 1; min-width: 0; text-align: center; }
    .t-title { font-size: 14px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t-author { font-size: 11px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-btn { width: 40px; height: 40px; flex-shrink: 0; border: none; background: var(--bg-elevated); border-radius: 8px; color: var(--text-primary);
      font-size: 22px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; text-decoration: none; }
    .icon-btn.sm { width: 30px; height: 30px; font-size: 14px; background: transparent; color: var(--text-tertiary); }

    .state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: var(--text-secondary); }
    .state .icon { font-size: 44px; }

    .text-area { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 12px 14px; scroll-behavior: smooth; }
    .chapter-header { padding: 18px 6px 8px; font-size: 15px; font-weight: 700; color: var(--accent); border-bottom: 1px solid var(--border-subtle); margin-bottom: 8px; }
    .chapter-header:first-child { padding-top: 4px; }
    .segment { padding: 10px 12px; margin-bottom: 6px; border-radius: 8px; background: var(--bg-surface); border: 2px solid transparent;
      cursor: pointer; transition: opacity 0.2s, border-color 0.2s, background 0.2s; opacity: 0.62; }
    .segment.past { opacity: 0.4; }
    .segment.active { opacity: 1; border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface)); }
    .segment p { margin: 0; font-size: 17px; line-height: 1.6; color: var(--text-primary); }

    .no-text { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 24px; }
    .big-cover { width: 220px; max-width: 64vw; aspect-ratio: 2/3; object-fit: cover; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); background: var(--bg-elevated); }
    .big-cover.placeholder { display: flex; align-items: center; justify-content: center; font-size: 72px; color: var(--text-tertiary); }
    .nt-title { font-size: 18px; font-weight: 600; margin-top: 12px; }
    .nt-author { font-size: 14px; color: var(--text-tertiary); }
    .nt-note { font-size: 13px; color: var(--text-tertiary); margin-top: 12px; }

    .controls { flex-shrink: 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: var(--bg-surface); border-top: 1px solid var(--border-subtle); }
    .now-chapter { display: flex; align-items: center; gap: 6px; max-width: 100%; margin: 0 auto 8px; padding: 4px 12px; border: none; border-radius: 14px;
      background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 12px; font-weight: 500; cursor: pointer; }
    .nc-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70vw; }

    .scrub-row { display: flex; align-items: center; gap: 10px; }
    .time { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }

    /* Shared range styling so the scrubber + speed slider match the UI. */
    .scrubber, .speed-slider { -webkit-appearance: none; appearance: none; height: 4px; background: var(--bg-elevated); border-radius: 2px; outline: none; cursor: pointer; }
    .scrubber { flex: 1; }
    .scrubber::-webkit-slider-thumb, .speed-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 15px; height: 15px; border-radius: 50%; background: var(--accent); border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
    .scrubber::-moz-range-thumb, .speed-slider::-moz-range-thumb { width: 15px; height: 15px; border: none; border-radius: 50%; background: var(--accent); }
    .scrubber::-webkit-slider-runnable-track, .speed-slider::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: var(--bg-elevated); }
    .scrubber::-moz-range-track, .speed-slider::-moz-range-track { height: 4px; border-radius: 2px; background: var(--bg-elevated); }

    .transport { display: flex; align-items: center; justify-content: center; gap: 18px; padding: 10px 0 6px; }
    .t-btn { position: relative; min-width: 44px; width: 44px; height: 44px; border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary);
      cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .t-btn:disabled { opacity: 0.3; }
    .skip-num { position: absolute; top: 52%; left: 50%; transform: translate(-50%, -50%); font-size: 9px; font-weight: 700; pointer-events: none; }
    .t-btn.fwd app-icon { transform: scaleX(-1); }
    .t-btn.play { width: 60px; height: 60px; background: var(--accent); color: #fff; }

    .bottom-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 4px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border: 1px solid var(--border-subtle); border-radius: 16px; background: var(--bg-elevated); color: var(--text-secondary); font-size: 13px; cursor: pointer; }
    .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .speed { display: flex; align-items: center; gap: 8px; }
    .speed-slider { width: 110px; }
    .speed-val { font-size: 12px; font-weight: 600; color: var(--text-secondary); min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }

    .sheet-backdrop { position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,0.5); }
    .sheet { position: fixed; left: 0; right: 0; bottom: 0; margin-inline: auto; width: 100%; max-width: var(--app-max); z-index: 301; max-height: 70vh; display: flex; flex-direction: column;
      background: var(--bg-elevated); border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom); animation: sheetUp 0.2s ease-out; }
    @keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; font-weight: 600; border-bottom: 1px solid var(--border-subtle); }
    .sheet-body { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 6px; }
    .sheet-empty { padding: 24px; text-align: center; color: var(--text-tertiary); font-size: 13px; }
    .sheet-action { margin: 4px 10px 10px; padding: 12px; border: 1px solid var(--accent); border-radius: 10px; background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent); font-size: 14px; font-weight: 600; cursor: pointer; }
    .row-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary);
      text-align: left; cursor: pointer; border-radius: 8px; }
    .row-item.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
    .row-item.bm { padding: 0; }
    .bm-jump { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .bm-del { flex-shrink: 0; width: 36px; height: 36px; margin-right: 6px; border: none; background: transparent; color: var(--text-tertiary); font-size: 13px; cursor: pointer; border-radius: 8px; }
    .bm-del:hover { color: var(--error); }
    .row-num { flex-shrink: 0; width: 24px; font-size: 12px; color: var(--text-tertiary); text-align: right; }
    .row-title { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-time { flex-shrink: 0; font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
  `],
})
export class PlayerComponent implements OnInit, OnDestroy {
  readonly p = inject(PlayerService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  private readonly textAreaRef = viewChild<ElementRef<HTMLDivElement>>('textArea');

  readonly chaptersOpen = signal(false);
  readonly bookmarksOpen = signal(false);

  private userScrolledAt = 0;
  readonly fmt = formatTime;

  readonly downloadHref = () => {
    const b = this.p.book();
    return b ? this.apiDownloadHref(b) : '#';
  };

  constructor() {
    // Auto-scroll the active line during playback (unless the user just scrolled).
    effect(() => {
      const idx = this.p.currentCueIndex();
      if (!this.p.isPlaying()) return;
      if (Date.now() - this.userScrolledAt < 4000) return;
      this.scrollCueIntoView(idx);
    });
    // Discrete seeks (chapter/skip/bookmark) scroll even while paused.
    effect(() => {
      this.p.scrollTick();
      requestAnimationFrame(() => this.scrollCueIntoView(this.p.currentCueIndex()));
    });
  }

  async ngOnInit(): Promise<void> {
    const downloadPath = decodePathId(this.route.snapshot.paramMap.get('id') ?? '');
    if (!downloadPath) {
      this.p.error.set('No audiobook specified');
      return;
    }
    await this.p.open(downloadPath, (history.state?.book as Audiobook | undefined) ?? null);
  }

  ngOnDestroy(): void {
    // Intentionally do NOT stop audio — it keeps playing under the mini-bar.
  }

  /** Down button: leave the full view; audio keeps playing and the mini-bar appears. */
  minimize(): void {
    if (history.length > 1) this.location.back();
    else this.router.navigate(['/']);
  }

  pickChapter(ch: Chapter): void {
    this.chaptersOpen.set(false);
    this.p.seekToChapter(ch);
  }

  pickBookmark(bm: { position: number }): void {
    this.bookmarksOpen.set(false);
    this.p.seekTo(bm.position, true);
  }

  addBookmark(): void {
    const ch = this.p.currentChapter();
    const t = this.fmt(this.p.currentTime());
    this.p.addBookmark(ch ? `${ch.title} · ${t}` : t);
  }

  onScrub(event: Event): void {
    this.p.seekTo(parseFloat((event.target as HTMLInputElement).value));
  }

  onSpeed(event: Event): void {
    this.p.setSpeed(parseFloat((event.target as HTMLInputElement).value));
  }

  onUserScroll(): void {
    this.userScrolledAt = Date.now();
  }

  private scrollCueIntoView(index: number): void {
    const container = this.textAreaRef()?.nativeElement;
    if (!container) return;
    const el = container.querySelector(`[data-index="${index}"]`) as HTMLElement | null;
    if (!el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const relTop = elRect.top - containerRect.top + container.scrollTop;
    const top = relTop - container.clientHeight / 2 + el.offsetHeight / 2;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  private apiDownloadHref(b: Audiobook): string {
    const name = b.outputFilename || b.downloadPath.split(/[/\\]/).pop() || 'audiobook.m4b';
    return `/api/download?path=${encodeURIComponent(b.downloadPath)}&filename=${encodeURIComponent(name)}`;
  }
}
