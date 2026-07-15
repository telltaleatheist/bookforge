import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, viewChild,
} from '@angular/core';
import { IconComponent } from '../../../../shared/icon.component';
import { ElectronService } from '../../../../core/services/electron.service';
import { CorrectSentencesSession, SentenceCue } from '../../models/correct-sentences.types';

/**
 * Phase 1 — listen through the book (playing the cached per-sentence FLACs in order,
 * highlighting the one playing) and flag any that sound wrong. A lean shell that reuses
 * the player's segment-card visual language but adds a per-row flag control and drives
 * the highlight purely from the sequencer index (no VTT time-sync needed — we own the
 * sequence). Bottom chrome (sleep timer, cover, chapters, bookmarks) is intentionally absent.
 */
@Component({
  selector: 'app-sentence-qa-player',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="qa">
      <header class="qa-top">
        <button class="qa-link" (click)="close.emit()">← Cancel</button>
        <div class="qa-title">{{ title() || 'Correct Sentences' }}</div>
        <span class="qa-flagcount">{{ flaggedCount() ? flaggedCount() + ' flagged' : '' }}</span>
      </header>
      <p class="qa-hint">Listen through the book. Flag any sentence that sounds wrong — playback keeps going. When you’re done, review and regenerate the flagged ones.</p>

      <div class="qa-list" #list>
        @for (cue of visibleCues(); track cue.index) {
          <div class="seg" [class.active]="cue.index === currentIndex()" [class.flagged]="isFlagged(cue.index)" [attr.data-index]="cue.index">
            <button class="seg-play" (click)="jumpTo(cue.index)" [title]="cue.index === currentIndex() && isPlaying() ? 'Pause' : 'Play from here'">
              <app-icon [name]="cue.index === currentIndex() && isPlaying() ? 'pause' : 'play'" [size]="15" />
            </button>
            <p class="seg-text" (click)="jumpTo(cue.index)">{{ cue.text }}</p>
            <button class="seg-flag" [class.on]="isFlagged(cue.index)" (click)="toggleFlag(cue.index)" [title]="isFlagged(cue.index) ? 'Unflag' : 'Flag as wrong'">⚑</button>
          </div>
        }
      </div>

      <div class="qa-transport">
        <button class="tb" (click)="prev()" title="Previous / restart"><app-icon name="prev" [size]="20" /></button>
        <button class="tb play" (click)="togglePlay()" [title]="isPlaying() ? 'Pause' : 'Play'">
          <app-icon [name]="isPlaying() ? 'pause' : 'play'" [size]="26" />
        </button>
        <button class="tb" (click)="next()" title="Next sentence"><app-icon name="next" [size]="20" /></button>
        <span class="qa-pos">{{ currentIndex() + 1 }} / {{ cues().length }}</span>
      </div>

      <div class="qa-foot">
        <span class="qa-foot-hint">Flag any sentence that sounds wrong, then continue to review.</span>
        <button class="qa-done" [disabled]="flaggedCount() === 0" (click)="finish()">
          Done{{ flaggedCount() ? ' (' + flaggedCount() + ')' : '' }}
        </button>
      </div>

      <audio #audio (ended)="onEnded()" (play)="isPlaying.set(true)" (pause)="isPlaying.set(false)"></audio>
    </div>
  `,
  styles: [`
    :host { display: flex; flex: 1; min-height: 0; }
    .qa { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
    .qa-top { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border-default); }
    .qa-link { border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
    .qa-title { flex: 1; text-align: center; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qa-flagcount { font-size: 12px; font-weight: 600; color: var(--error, #ff453a); min-width: 60px; text-align: right; }
    .qa-foot { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border-default); }
    .qa-foot-hint { flex: 1; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); }
    .qa-done { padding: 9px 22px; border: none; border-radius: 8px; background: var(--accent-primary); color: #fff; font-weight: 600; cursor: pointer; }
    .qa-done:disabled { opacity: 0.4; cursor: default; }
    .qa-hint { margin: 8px 16px 4px; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); }

    .qa-list { flex: 1; overflow-y: auto; padding: 8px 14px; }
    .seg { display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 5px; border-radius: 8px; border: 2px solid transparent; background: var(--bg-surface); transition: border-color 0.2s, background 0.2s; }
    .seg:hover { background: var(--bg-hover, var(--bg-elevated)); }
    .seg.active { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-surface)); }
    .seg.flagged { border-color: var(--error, #ff453a); }
    .seg-play { flex-shrink: 0; width: 30px; height: 30px; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .seg-text { flex: 1; min-width: 0; margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-primary); cursor: pointer; }
    .seg-flag { flex-shrink: 0; width: 30px; height: 30px; border: 1px solid var(--border-default); border-radius: 50%; background: transparent; color: var(--text-tertiary, var(--text-secondary)); cursor: pointer; font-size: 15px; line-height: 1; }
    .seg-flag.on { background: var(--error, #ff453a); border-color: var(--error, #ff453a); color: #fff; }

    .qa-transport { flex-shrink: 0; display: flex; align-items: center; justify-content: center; gap: 18px; padding: 12px; border-top: 1px solid var(--border-default); }
    .tb { width: 46px; height: 46px; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .tb.play { width: 58px; height: 58px; background: var(--accent-primary); color: #fff; }
    .qa-pos { position: absolute; right: 20px; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); font-variant-numeric: tabular-nums; }
    audio { display: none; }
  `],
})
export class SentenceQaPlayerComponent {
  private readonly electron = inject(ElectronService);
  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');
  private readonly listRef = viewChild<ElementRef<HTMLDivElement>>('list');

  readonly session = input.required<CorrectSentencesSession>();
  readonly title = input('');
  readonly author = input('');
  readonly done = output<number[]>();
  readonly close = output<void>();

  readonly cues = computed<SentenceCue[]>(() => this.session().cues ?? []);
  readonly currentIndex = signal(0);
  readonly isPlaying = signal(false);
  readonly flagged = signal<Set<number>>(new Set());
  readonly flaggedCount = computed(() => this.flagged().size);

  // Progressive render so a multi-thousand-sentence book doesn't freeze on open.
  private static readonly INITIAL = 80;
  private static readonly CHUNK = 200;
  readonly visibleCount = signal(SentenceQaPlayerComponent.INITIAL);
  readonly visibleCues = computed(() => {
    const all = this.cues();
    const n = this.visibleCount();
    return n >= all.length ? all : all.slice(0, n);
  });

  private readonly urlCache = new Map<number, string>();

  constructor() {
    effect(() => {
      const total = this.cues().length;
      this.visibleCount.set(Math.min(SentenceQaPlayerComponent.INITIAL, total));
      this.grow(total);
    });
  }

  private grow(total: number): void {
    const step = () => {
      const cur = this.visibleCount();
      if (cur >= total) return;
      this.visibleCount.set(Math.min(total, cur + SentenceQaPlayerComponent.CHUNK));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  isFlagged(i: number): boolean { return this.flagged().has(i); }
  toggleFlag(i: number): void {
    const s = new Set(this.flagged());
    if (s.has(i)) s.delete(i); else s.add(i);
    this.flagged.set(s);
  }

  private flacPath(index: number): string {
    return `${this.session().sentencesDir ?? ''}/${index}.flac`;
  }

  private async loadUrl(index: number): Promise<string | null> {
    if (this.urlCache.has(index)) return this.urlCache.get(index)!;
    const res = await this.electron.readAudioFile(this.flacPath(index));
    if (res?.success && res.dataUrl) { this.urlCache.set(index, res.dataUrl); return res.dataUrl; }
    return null;
  }

  private ensureVisible(index: number): void {
    if (index >= this.visibleCount()) this.visibleCount.set(Math.min(this.cues().length, index + 1));
  }

  async jumpTo(index: number): Promise<void> {
    if (index === this.currentIndex() && this.isPlaying()) {
      this.audioRef()?.nativeElement.pause();
      return;
    }
    this.currentIndex.set(index);
    await this.playCurrent();
  }

  private async playCurrent(): Promise<void> {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    const idx = this.currentIndex();
    const url = await this.loadUrl(idx);
    if (!url) { this.next(); return; }
    audio.src = url;
    try { await audio.play(); } catch { /* autoplay guard */ }
    this.scrollToActive(idx);
    void this.loadUrl(idx + 1); // prefetch
  }

  togglePlay(): void {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    if (this.isPlaying()) audio.pause();
    else if (audio.src) audio.play().catch(() => {});
    else void this.playCurrent();
  }

  onEnded(): void {
    const next = this.currentIndex() + 1;
    if (next < this.cues().length) {
      this.currentIndex.set(next);
      this.ensureVisible(next);
      void this.playCurrent();
    } else {
      this.isPlaying.set(false);
    }
  }

  next(): void {
    const i = Math.min(this.currentIndex() + 1, this.cues().length - 1);
    this.ensureVisible(i);
    void this.jumpTo(i);
  }

  prev(): void {
    const audio = this.audioRef()?.nativeElement;
    if (audio && audio.currentTime > 2) { audio.currentTime = 0; return; }
    const i = Math.max(this.currentIndex() - 1, 0);
    void this.jumpTo(i);
  }

  finish(): void {
    this.audioRef()?.nativeElement.pause();
    this.done.emit([...this.flagged()].sort((a, b) => a - b));
  }

  private scrollToActive(index: number): void {
    requestAnimationFrame(() => {
      const el = this.listRef()?.nativeElement.querySelector(`[data-index="${index}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}
