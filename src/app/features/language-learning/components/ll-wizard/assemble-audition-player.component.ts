import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild,
} from '@angular/core';
import { IconComponent } from '../../../../shared/icon.component';
import { ElectronService } from '../../../../core/services/electron.service';
import type { CorrectSentencesSession, SentenceCue } from '../../../correct-sentences/models/correct-sentences.types';

/**
 * Raw-sentence AUDITION player for the assemble step. A lean fork of
 * sentence-qa-player: same proven playback engine (per-sentence FLAC → base64 data URL
 * via electron.readAudioFile, sequential playback with highlight + one-ahead prefetch +
 * progressive list render) but WITHOUT the correct-sentences flagging/Done chrome — this
 * is judge-only, so the user can decide which of the three opt-in assembly passes
 * (de-ring / denoise / RVC) the narration needs.
 *
 * RAW audio ONLY: it plays the cached sentences verbatim. It never previews processed
 * audio — denoise and RVC are GPU passes that must not run during audition.
 */
@Component({
  selector: 'app-assemble-audition-player',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="aud">
      <div class="aud-list" #list>
        @for (cue of visibleCues(); track cue.index) {
          <div class="seg" [class.active]="cue.index === currentIndex()" [attr.data-index]="cue.index">
            <button class="seg-play" (click)="jumpTo(cue.index)" [title]="cue.index === currentIndex() && isPlaying() ? 'Pause' : 'Play from here'">
              <app-icon [name]="cue.index === currentIndex() && isPlaying() ? 'pause' : 'play'" [size]="14" />
            </button>
            <p class="seg-text" (click)="jumpTo(cue.index)">{{ cue.text }}</p>
          </div>
        }
      </div>

      <div class="aud-transport">
        <button class="tb" (click)="prev()" title="Previous / restart"><app-icon name="prev" [size]="18" /></button>
        <button class="tb play" (click)="togglePlay()" [title]="isPlaying() ? 'Pause' : 'Play'">
          <app-icon [name]="isPlaying() ? 'pause' : 'play'" [size]="22" />
        </button>
        <button class="tb" (click)="next()" title="Next sentence"><app-icon name="next" [size]="18" /></button>
        <span class="aud-pos">{{ currentIndex() + 1 }} / {{ cues().length }}</span>
      </div>

      <audio #audio (ended)="onEnded()" (play)="isPlaying.set(true)" (pause)="isPlaying.set(false)"></audio>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .aud { display: flex; flex-direction: column; border: 1px solid var(--border-default); border-radius: 10px; overflow: hidden; background: var(--bg-sunken, var(--bg-surface)); }
    .aud-list { max-height: 320px; overflow-y: auto; padding: 6px 8px; }
    .seg { display: flex; align-items: center; gap: 9px; padding: 6px 8px; margin-bottom: 4px; border-radius: 7px; border: 2px solid transparent; background: var(--bg-surface); transition: border-color 0.2s, background 0.2s; }
    .seg:hover { background: var(--bg-hover, var(--bg-elevated)); }
    .seg.active { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-surface)); }
    .seg-play { flex-shrink: 0; width: 28px; height: 28px; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .seg-text { flex: 1; min-width: 0; margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-primary); cursor: pointer; }
    .aud-transport { position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center; gap: 16px; padding: 10px; border-top: 1px solid var(--border-default); }
    .tb { width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .tb.play { width: 50px; height: 50px; background: var(--accent-primary); color: #fff; }
    .aud-pos { position: absolute; right: 16px; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); font-variant-numeric: tabular-nums; }
    audio { display: none; }
  `],
})
export class AssembleAuditionPlayerComponent {
  private readonly electron = inject(ElectronService);
  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');
  private readonly listRef = viewChild<ElementRef<HTMLDivElement>>('list');

  readonly session = input.required<CorrectSentencesSession>();

  readonly cues = computed<SentenceCue[]>(() => this.session().cues ?? []);
  readonly currentIndex = signal(0);
  readonly isPlaying = signal(false);

  // Progressive render so a multi-thousand-sentence book doesn't freeze on open.
  private static readonly INITIAL = 80;
  private static readonly CHUNK = 200;
  readonly visibleCount = signal(AssembleAuditionPlayerComponent.INITIAL);
  readonly visibleCues = computed(() => {
    const all = this.cues();
    const n = this.visibleCount();
    return n >= all.length ? all : all.slice(0, n);
  });

  private readonly urlCache = new Map<number, string>();

  constructor() {
    effect(() => {
      const total = this.cues().length;
      this.visibleCount.set(Math.min(AssembleAuditionPlayerComponent.INITIAL, total));
      this.grow(total);
    });
  }

  private grow(total: number): void {
    const step = () => {
      const cur = this.visibleCount();
      if (cur >= total) return;
      this.visibleCount.set(Math.min(total, cur + AssembleAuditionPlayerComponent.CHUNK));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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

  private scrollToActive(index: number): void {
    requestAnimationFrame(() => {
      const el = this.listRef()?.nativeElement.querySelector(`[data-index="${index}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}
