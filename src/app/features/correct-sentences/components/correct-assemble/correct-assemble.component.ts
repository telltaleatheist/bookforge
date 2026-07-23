import {
  ChangeDetectionStrategy, Component, inject, input, OnInit, output, signal,
} from '@angular/core';
import { QueueService } from '../../../queue/services/queue.service';
import { ReassemblyJobConfig } from '../../../queue/models/queue.types';
import { CorrectSentencesSession } from '../../models/correct-sentences.types';
import { ElectronService } from '../../../../core/services/electron.service';

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
          @if (showGap()) {
            <div class="as-gap">
              <label class="as-gap-label" for="as-gap-input">Inter-sentence gap (seconds)</label>
              <input
                id="as-gap-input"
                class="as-gap-input"
                type="number"
                min="0"
                step="0.05"
                [value]="gapValue()"
                (input)="onGapInput($event)"
              />
              <p class="as-gap-help">
                @if (gapHasModel()) {
                  Tuned for {{ gapVoice() }}.
                } @else {
                  This model hasn't been gap-tested — using the 0.6s default. Adjust if needed.
                }
              </p>
            </div>
          }
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
    .as-gap { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; max-width: 320px; padding: 14px 16px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-surface); }
    .as-gap-label { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .as-gap-input { width: 120px; padding: 8px 10px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-input); color: var(--text-primary); font-size: 14px; text-align: center; }
    .as-gap-input:focus { outline: none; border-color: var(--accent); }
    .as-gap-help { font-size: 12px; color: var(--text-secondary); margin: 0; max-width: 300px; }
    .as-error { font-size: 13px; color: var(--error, #ff453a); }
    .as-btn { margin-top: 8px; padding: 11px 24px; border: none; border-radius: 8px; background: var(--accent-primary); color: #fff; font-weight: 600; cursor: pointer; }
    .as-btn:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class CorrectAssembleComponent implements OnInit {
  private readonly queue = inject(QueueService);
  private readonly electron = inject(ElectronService);

  readonly session = input.required<CorrectSentencesSession>();
  readonly audiobookFolder = input('');
  readonly bfpPath = input('');
  readonly metadata = input<AssembleMetadata>({ title: '', author: '' });
  readonly done = output<void>();
  readonly back = output<void>();

  readonly working = signal(false);
  readonly queued = signal(false);
  readonly error = signal<string | null>(null);

  // Inter-sentence gap (Orpheus-only). `showGap` gates the whole field: gap normalization
  // strips a trailing pad only Orpheus bakes, so non-Orpheus sessions get no field and no
  // normalization. `gapValue` is pre-filled from provenance — the voice's tuned model value,
  // or the visible 0.6s "untested model" default (see DEFAULT_SENTENCE_GAP in orpheus-models).
  readonly showGap = signal(false);
  readonly gapValue = signal(0.6);
  readonly gapHasModel = signal(false);
  readonly gapVoice = signal<string | undefined>(undefined);

  async ngOnInit(): Promise<void> {
    const processDir = this.session().processDir;
    if (!processDir) return;
    const res = await this.electron.resolveSentenceGap(processDir);
    if (!res.success || !res.data) {
      // Surface the failure loudly rather than silently defaulting the field — a session
      // whose provenance/manifest can't be read must not silently pick a gap.
      this.error.set(res.error || 'Failed to resolve the inter-sentence gap for this session.');
      return;
    }
    this.showGap.set(res.data.isOrpheus);
    if (res.data.isOrpheus) {
      this.gapValue.set(res.data.gap);
      this.gapHasModel.set(res.data.hasModelValue);
      this.gapVoice.set(res.data.voice);
    }
  }

  onGapInput(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      this.gapValue.set(parsed);
    }
  }

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
    // Orpheus-only: forward the (possibly user-overridden) gap so assembly normalizes to it.
    // Non-Orpheus sessions leave it unset → the backend skips gap normalization entirely.
    if (this.showGap()) {
      config.sentenceGap = this.gapValue();
    }
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
