import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, output, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { ElectronService } from '../../../../core/services/electron.service';
import { QueueService } from '../../../queue/services/queue.service';
import type { PassRecord } from '@shared/document/version-family';
import { derivePassStatus } from '@shared/document/rail-tasks';

/**
 * Footnote removal, run where the user is standing.
 *
 * RULED 2026-08-04. Owen: "footnote removal is pretty fast. instead of adding to
 * the queue lets have it do it quickly in a modal with a progress bar, just like
 * the OCR modal on pdfs." So this is the OCR dialog's shape, minus everything
 * that dialog needs and this one does not:
 *
 *  - **Inline is the default.** The run happens in the main process
 *    (`document:footnotes-epub`) and reports on the `document:stage-*` channels;
 *    the bar below IS the run. Closing this window changes nothing about it —
 *    the stage belongs to main, not to this component.
 *  - **"Run in background" hands it over IN FRONT OF THE USER.** The pass goes
 *    to the queue and the app moves the user to the Queue, so the hand-off is
 *    witnessed rather than inferred. Both routes run the same function in main
 *    (`runEpubFootnotesOnBook`), so the book's record is identical either way —
 *    the choice is about who watches, never about what happens.
 *  - **Cancel is real.** The run is claimed in the document stage registry with
 *    its AbortController, so `document:cancel-stage` kills the foundry
 *    subprocess. foundry never writes to its input and this app renames the
 *    finished file into place, so a cancelled run leaves the book exactly as it
 *    stood.
 *
 * There are no options. `--ask-everything` is foundry's own escape hatch for a
 * book whose note bodies and index entries should also be asked about, and it
 * is not something this station offers — a second answer to "what should the
 * model be asked" is how two books get processed differently for no recorded
 * reason.
 */

/** A stage as this dialog shows it — which one, its own last line, how far. */
interface StageView {
  stage: string;
  /** foundry's own line, verbatim. */
  message: string;
  done: number;
  total: number;
}

@Component({
  selector: 'app-footnotes-modal',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" (click)="requestClose()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Remove footnote markers</h2>
          <button class="close-btn" (click)="requestClose()">×</button>
        </div>

        <div class="modal-body">
          <p class="hint">
            The markers a narrator reads out loud as a number —
            <code>&lt;sup&gt;&lt;a href="#fn3"&gt;3&lt;/a&gt;&lt;/sup&gt;</code> — are removed from
            the book itself. Every removal is recorded, and what changed is readable
            afterwards from the Footnotes star on the versions page.
          </p>

          <p class="hint">{{ previousRunLine() }}</p>

          @if (!running()) {
            <div class="section">
              <h3 class="section-title">While it runs</h3>
              <label class="checkbox-option">
                <input
                  type="checkbox"
                  [checked]="runInBackground()"
                  (change)="runInBackgroundChange.emit($any($event.target).checked)"
                />
                <span class="checkbox-label">
                  <strong>Run in background</strong>
                  <span class="checkbox-hint">
                    Hand it to the queue and go there, so you can see where it went. Leave
                    this off and the progress below is the run — it takes minutes, not hours.
                  </span>
                </span>
              </label>
            </div>
          }

          @if (running()) {
            <div class="section">
              <h3 class="section-title">Progress</h3>
              <div class="progress-bar" [class.indeterminate]="progressPercent() === 0">
                <div class="progress-fill" [style.width.%]="progressPercent()"></div>
              </div>
              <div class="progress-status">
                <span class="progress-text">{{ progressText() }}</span>
                <span class="elapsed-time">{{ elapsedTimeText() }}</span>
              </div>
              @if (runState()?.message) {
                <!-- foundry's own line, verbatim: it is the only place a refusal
                     or a rescued document ever gets said. -->
                <pre class="foundry-line">{{ runState()!.message }}</pre>
              }
            </div>
          }

          @if (queued()) {
            <div class="section">
              <h3 class="section-title">Queued</h3>
              <p class="result-line">
                The run is in the queue. It starts when the queue reaches it — watch it
                on the Queue tab.
              </p>
            </div>
          }

          @if (resultLine()) {
            <div class="section">
              <h3 class="section-title">Result</h3>
              <p class="result-line">{{ resultLine() }}</p>
            </div>
          }

          @if (error()) {
            <div class="error-box">
              <span class="error-icon">⚠</span>
              <pre class="error-text">{{ error() }}</pre>
            </div>
          }
        </div>

        <div class="modal-footer">
          @if (!running()) {
            <desktop-button variant="ghost" (click)="requestClose()">Close</desktop-button>
            <desktop-button variant="primary" [disabled]="!canStart()" (click)="start()">
              {{ startLabel() }}
            </desktop-button>
          } @else {
            <desktop-button
              variant="ghost"
              (click)="requestClose()"
              title="The run continues in the main process — closing this changes nothing about it"
            >Stop watching</desktop-button>
            <desktop-button variant="danger" (click)="cancelRun()">Cancel</desktop-button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
    }

    .modal-content {
      background: var(--bg-surface);
      border-radius: $radius-lg;
      box-shadow: $shadow-xl;
      width: 90%;
      max-width: 520px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-spacing-lg);
      border-bottom: 1px solid var(--border-subtle);

      h2 {
        margin: 0;
        font-size: var(--ui-font-xl);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      .close-btn {
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: 24px;
        cursor: pointer;
        border-radius: $radius-sm;

        &:hover { background: var(--bg-hover); }
      }
    }

    .modal-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-lg);
    }

    .hint {
      margin: 0 0 var(--ui-spacing-md) 0;
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      line-height: 1.5;

      code {
        font-family: monospace;
        font-size: var(--ui-font-xs);
        color: var(--text-secondary);
      }
    }

    .section {
      margin-bottom: var(--ui-spacing-lg);
      &:last-child { margin-bottom: 0; }
    }

    .section-title {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-semibold;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0 0 var(--ui-spacing-sm) 0;
    }

    .checkbox-option {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      cursor: pointer;

      &:hover { background: var(--bg-hover); }

      input { margin-top: 3px; accent-color: var(--accent); }
    }

    .checkbox-label {
      display: flex;
      flex-direction: column;
      gap: 2px;

      strong { color: var(--text-primary); font-size: var(--ui-font-base); }
      .checkbox-hint {
        color: var(--text-tertiary);
        font-size: var(--ui-font-sm);
        line-height: 1.45;
      }
    }

    .progress-bar {
      height: 8px;
      background: var(--bg-elevated);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: var(--ui-spacing-xs);
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.3s ease-out;
    }

    .progress-bar.indeterminate .progress-fill {
      width: 30% !important;
      animation: indeterminate 1.5s infinite ease-in-out;
    }

    @keyframes indeterminate {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(400%); }
    }

    .progress-status {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--ui-spacing-sm);
    }

    .progress-text { font-size: var(--ui-font-sm); color: var(--text-secondary); }

    .elapsed-time {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    .foundry-line {
      margin: 0;
      padding: var(--ui-spacing-sm);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      font-family: monospace;
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 90px;
      overflow-y: auto;
    }

    .result-line {
      margin: 0;
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      line-height: 1.5;
    }

    .error-box {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md);
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: $radius-md;
      color: var(--error);
    }

    .error-icon { font-size: 18px; }

    .error-text {
      margin: 0;
      font-size: var(--ui-font-sm);
      font-family: monospace;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow-y: auto;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
    }
  `],
})
export class FootnotesModalComponent implements OnDestroy {
  /** The project whose BOOK is rewritten. Empty is refused before anything runs. */
  readonly projectDir = input.required<string>();
  /**
   * What the book already records, so the dialog can say whether this pass has
   * run before — read from the same provenance the rail's status is derived
   * from, rather than from a second reading of it.
   */
  readonly appliedPasses = input.required<readonly PassRecord[]>();
  /** The window's long-run habit, owned by the picker so the two cannot disagree. */
  readonly runInBackground = input.required<boolean>();

  readonly close = output<void>();
  readonly runInBackgroundChange = output<boolean>();
  /** The run went to the queue, and so does the user. The window says how. */
  readonly handOffToQueue = output<void>();
  /**
   * The book on disk is not the book it was. Carries nothing: the window
   * re-reads the file, which is the only thing that knows what is in it now.
   */
  readonly bookReplaced = output<void>();

  private readonly electronService = inject(ElectronService);
  private readonly queueService = inject(QueueService);

  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly runState = signal<StageView | null>(null);
  readonly resultLine = signal('');
  readonly elapsedSeconds = signal(0);
  /** What the book already records about this pass, or null when it records none. */
  private readonly previousRun = signal<string | null>(null);

  /**
   * A footnotes pass for this book is in the queue and has not finished.
   *
   * Read from the queue rather than remembered: this component is destroyed
   * every time the dialog closes, and a flag of its own would forget a run that
   * is still waiting its turn and offer to queue a second one.
   */
  readonly queued = computed(() =>
    this.queueService.jobs().some((job) =>
      job.type === 'foundry-footnotes'
      && (job.config as { projectDir?: string } | undefined)?.projectDir === this.projectDir()
      && (job.status === 'pending' || job.status === 'processing')));

  private startTime = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    // The run is main's, so this dialog only ever watches it — including a run
    // it did not start, and one that was already going when it opened.
    const unsubStarted = this.electronService.onDocumentStageStarted((event) => {
      if (event.projectDir !== this.projectDir()) return;
      this.error.set(null);
      this.resultLine.set('');
      this.running.set(true);
      this.runState.set({ stage: event.stage, message: '', done: 0, total: 0 });
      if (!this.elapsedTimer) this.startElapsedTimer();
    });
    const unsubProgress = this.electronService.onDocumentStageProgress((event) => {
      if (event.projectDir !== this.projectDir()) return;
      this.running.set(true);
      this.runState.set({
        stage: event.stage, message: event.message, done: event.done, total: event.total,
      });
    });
    const unsubFinished = this.electronService.onDocumentStageFinished((event) => {
      if (event.projectDir !== this.projectDir()) return;
      this.running.set(false);
      this.stopElapsedTimer();
    });
    this.unsubscribe = () => { unsubStarted(); unsubProgress(); unsubFinished(); };

    // What the book records, said on open. A pass that has run before is worth
    // knowing about before running it again.
    effect(() => {
      const status = derivePassStatus('footnotes', this.appliedPasses());
      this.previousRun.set(status.kind === 'done' ? status.detail : null);
    }, { allowSignalWrites: true });
  }

  ngOnDestroy(): void {
    this.stopElapsedTimer();
    // Unsubscribing does NOT stop anything. That is the point of the run living
    // in main: closing this dialog is a UI action, not a decision about the work.
    this.unsubscribe?.();
  }

  previousRunLine(): string {
    const previous = this.previousRun();
    return previous
      ? `This book has had its footnote markers removed before (${previous}). `
        + 'Running it again asks the model about the markers that are left.'
      : 'This book has not had its footnote markers removed yet.';
  }

  canStart(): boolean {
    return !this.running() && !this.queued() && this.projectDir().length > 0;
  }

  startLabel(): string {
    return this.runInBackground() ? 'Queue it' : 'Remove the markers';
  }

  async start(): Promise<void> {
    this.error.set(null);
    this.resultLine.set('');

    if (this.runInBackground()) {
      // The queue runs the SAME function in main. What changes is who watches
      // it — and the user goes with it, so the hand-off is witnessed.
      try {
        const result = await this.queueService.submitProcessingRun({
          projectDir: this.projectDir(),
          passes: [{ kind: 'footnotes' }],
        });
        if (!result.success) {
          this.error.set(result.error || 'The run was refused and no reason was given.');
          return;
        }
        this.handOffToQueue.emit();
      } catch (err) {
        this.error.set(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Inline. `running` is set by the stage-started event, which is main's own
    // word for "it has begun" — this only waits for the answer.
    this.running.set(true);
    this.startElapsedTimer();
    try {
      const outcome = await this.electronService.documentFootnotesEpub(this.projectDir());
      this.resultLine.set(
        `${outcome.markersRemoved} marker${outcome.markersRemoved === 1 ? '' : 's'} removed across `
        + `${outcome.documentsEdited} document${outcome.documentsEdited === 1 ? '' : 's'}, by `
        + `${outcome.model}. What changed is on the book's Footnotes star.`
      );
      // The book has been replaced in place; the window has to show the new one.
      this.bookReplaced.emit();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.running.set(false);
      this.stopElapsedTimer();
    }
  }

  async cancelRun(): Promise<void> {
    try {
      // Aborted where it stands. foundry writes its output to a temporary file
      // and this app renames it into place, so a stopped run leaves the book
      // exactly as it stood before it started.
      await this.electronService.documentCancelStage(this.projectDir());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Closing while a run is going leaves the run alone — it belongs to main. */
  requestClose(): void {
    this.close.emit();
  }

  progressPercent(): number {
    const state = this.runState();
    if (!state || state.total <= 0) return 0;
    return Math.min(100, (state.done / state.total) * 100);
  }

  progressText(): string {
    const state = this.runState();
    if (!state) return '';
    if (state.total > 0) return `Removing footnote markers — ${state.done}%`;
    return 'Removing footnote markers…';
  }

  elapsedTimeText(): string {
    const seconds = this.elapsedSeconds();
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  private startElapsedTimer(): void {
    this.startTime = Date.now();
    this.elapsedSeconds.set(0);
    this.elapsedTimer = setInterval(() => {
      this.elapsedSeconds.set(Math.floor((Date.now() - this.startTime) / 1000));
    }, 1000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}
