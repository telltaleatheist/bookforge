import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, OnDestroy,
} from '@angular/core';
import { ElectronService } from '../../core/services/electron.service';
import { CorrectSentencesSession } from './models/correct-sentences.types';
import { SentenceQaPlayerComponent } from './components/sentence-qa-player/sentence-qa-player.component';
import { SentenceReviewComponent } from './components/sentence-review/sentence-review.component';
import { CorrectAssembleComponent } from './components/correct-assemble/correct-assemble.component';

/**
 * Correct Sentences — a 3-phase guided pipeline rendered in-place in the main Studio
 * window: Listen (flag bad sentences) → Review (audition + re-roll fresh takes) →
 * Assemble (rebuild the audiobook). Reuses the cached e2a sentence FLACs + VTT.
 */
@Component({
  selector: 'app-correct-sentences',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SentenceQaPlayerComponent, SentenceReviewComponent, CorrectAssembleComponent],
  template: `
    <div class="cs-root">
      @if (loading()) {
        <div class="cs-center"><div class="cs-spinner"></div><span>Loading sentences…</span></div>
      } @else if (!session()?.available) {
        <div class="cs-center cs-unavailable">
          <div class="cs-icon">🔒</div>
          <p>{{ session()?.reason || 'Correction isn’t available for this book.' }}</p>
          <button class="cs-btn" (click)="close.emit()">Back</button>
        </div>
      } @else {
        @switch (step()) {
          @case ('listen') {
            <app-sentence-qa-player
              [session]="session()!"
              [title]="title()"
              [author]="author()"
              (done)="onListenDone($event)"
              (close)="close.emit()"
            />
          }
          @case ('review') {
            <app-sentence-review
              [session]="session()!"
              [projectDir]="projectDir()"
              [flagged]="flagged()"
              (done)="step.set('assemble')"
              (back)="step.set('listen')"
            />
          }
          @case ('assemble') {
            <app-correct-assemble
              [session]="session()!"
              [audiobookFolder]="audiobookFolder()"
              [bfpPath]="bfpPath()"
              [metadata]="metadata()"
              (done)="finish()"
              (back)="close.emit()"
            />
          }
        }
      }
    </div>
  `,
  styles: [`
    :host { display: flex; flex: 1; min-height: 0; }
    .cs-root { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
    .cs-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--text-secondary); }
    .cs-unavailable { text-align: center; padding: 24px; }
    .cs-icon { font-size: 40px; opacity: 0.7; }
    .cs-spinner { width: 32px; height: 32px; border-radius: 50%; border: 3px solid var(--border-default); border-top-color: var(--accent-primary); animation: cs-spin 0.8s linear infinite; }
    @keyframes cs-spin { to { transform: rotate(360deg); } }
    .cs-btn { padding: 9px 18px; border: none; border-radius: 8px; background: var(--accent-primary); color: #fff; font-weight: 600; cursor: pointer; }
  `],
})
export class CorrectSentencesComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);

  readonly projectDir = input.required<string>();
  readonly title = input('');
  readonly author = input('');
  readonly year = input('');
  readonly coverPath = input('');
  readonly audiobookFolder = input('');
  readonly bfpPath = input('');
  readonly outputFilename = input('');

  readonly close = output<void>();
  readonly queued = output<void>();

  readonly loading = signal(true);
  readonly session = signal<CorrectSentencesSession | null>(null);
  readonly step = signal<'listen' | 'review' | 'assemble'>('listen');
  readonly flagged = signal<number[]>([]);

  readonly metadata = computed(() => ({
    title: this.title(),
    author: this.author(),
    year: this.year(),
    coverPath: this.coverPath(),
    outputFilename: this.outputFilename(),
  }));

  private loaded = false;

  constructor() {
    effect(() => {
      const dir = this.projectDir();
      if (dir && !this.loaded) {
        this.loaded = true;
        void this.load(dir);
      }
    });
  }

  private async load(dir: string): Promise<void> {
    this.loading.set(true);
    const res = await this.electron.correctSentencesGetSession(dir);
    this.session.set((res?.data as CorrectSentencesSession) ?? {
      available: false,
      reason: res?.error || 'Failed to load session.',
    });
    this.loading.set(false);
  }

  onListenDone(indices: number[]): void {
    if (!indices.length) {
      // Nothing flagged — nothing to correct.
      this.close.emit();
      return;
    }
    this.flagged.set(indices);
    this.step.set('review');
  }

  finish(): void {
    this.queued.emit();
  }

  ngOnDestroy(): void {
    const s = this.session();
    if (s?.sessionId) void this.electron.correctSentencesCleanup(s.sessionId);
  }
}
