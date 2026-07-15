import {
  ChangeDetectionStrategy, Component, inject, input, output, signal,
} from '@angular/core';
import { QueueService } from '../../../queue/services/queue.service';
import { ReassemblyJobConfig } from '../../../queue/models/queue.types';
import { CorrectSentencesSession } from '../../models/correct-sentences.types';

interface AssembleMetadata {
  title: string;
  author: string;
  year?: string;
  coverPath?: string;
  outputFilename?: string;
}

/**
 * Phase 3 — rebuild the audiobook from the (now corrected) sentence cache. Reuses the
 * standard `reassembly` queue job, which re-stitches the M4B AND regenerates the VTT
 * with corrected timings (e2a re-measures every FLAC), so subtitles stay aligned.
 */
@Component({
  selector: 'app-correct-assemble',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    <div class="as">
      <header class="as-top">
        <button class="as-link" (click)="back.emit()">← Back</button>
        <div class="as-title">Rebuild audiobook</div>
        <span></span>
      </header>

      <div class="as-body">
        @if (!queued()) {
          <div class="as-icon">🎧</div>
          <p class="as-lead">Your corrected sentences are saved. Rebuild the audiobook to stitch them into the final M4B.</p>
          <p class="as-note">The subtitle track and all timings regenerate automatically as part of the rebuild.</p>
          @if (error()) { <p class="as-error">{{ error() }}</p> }
          <button class="as-btn" [disabled]="working()" (click)="rebuild()">
            {{ working() ? 'Queuing…' : 'Rebuild Audiobook' }}
          </button>
        } @else {
          <div class="as-icon">✅</div>
          <p class="as-lead">Rebuild queued.</p>
          <p class="as-note">Track progress in the Queue. You can close this panel.</p>
          <button class="as-btn" (click)="done.emit()">Done</button>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: flex; flex: 1; min-height: 0; }
    .as { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
    .as-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border-default); }
    .as-link { border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
    .as-title { font-weight: 600; color: var(--text-primary); }
    .as-body { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 24px; }
    .as-icon { font-size: 44px; }
    .as-lead { font-size: 15px; font-weight: 600; color: var(--text-primary); max-width: 440px; }
    .as-note { font-size: 13px; color: var(--text-secondary); max-width: 440px; }
    .as-error { font-size: 13px; color: var(--error, #ff453a); }
    .as-btn { margin-top: 8px; padding: 11px 24px; border: none; border-radius: 8px; background: var(--accent-primary); color: #fff; font-weight: 600; cursor: pointer; }
    .as-btn:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class CorrectAssembleComponent {
  private readonly queue = inject(QueueService);

  readonly session = input.required<CorrectSentencesSession>();
  readonly audiobookFolder = input('');
  readonly bfpPath = input('');
  readonly metadata = input<AssembleMetadata>({ title: '', author: '' });
  readonly done = output<void>();
  readonly back = output<void>();

  readonly working = signal(false);
  readonly queued = signal(false);
  readonly error = signal<string | null>(null);

  async rebuild(): Promise<void> {
    this.working.set(true);
    this.error.set(null);
    const s = this.session();
    const m = this.metadata();
    const config: ReassemblyJobConfig = {
      type: 'reassembly',
      sessionId: s.sessionId!,
      sessionDir: s.sessionDir!,
      processDir: s.processDir!,
      outputDir: this.audiobookFolder(),
      metadata: {
        title: m.title,
        author: m.author,
        year: m.year,
        coverPath: m.coverPath,
        outputFilename: m.outputFilename,
      },
      excludedChapters: [],
    };
    try {
      await this.queue.addJob({
        type: 'reassembly',
        epubPath: s.processDir,
        bfpPath: this.bfpPath(),
        config,
        metadata: { title: m.title, author: m.author, year: m.year } as any,
      });
      this.queued.set(true);
    } catch (e: any) {
      this.error.set(e?.message || 'Failed to queue rebuild.');
    } finally {
      this.working.set(false);
    }
  }
}
