import { Component, input, output, signal, computed, effect, inject, ChangeDetectionStrategy, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { ElectronService, CorpusOcrRunState, FoundryRunState } from '../../../../core/services/electron.service';
import { QueueService } from '../../../queue/services/queue.service';
import { OcrTextLine } from '../../services/ocr-job.service';

/**
 * The OCR dialog.
 *
 * ── THERE IS NO ENGINE CHOICE ANY MORE ───────────────────────────────────────
 *
 * This dialog used to open with a grid of engine cards — Tesseract, whatever OCR
 * plugins were installed — and a language picker. They are gone, and their
 * absence is the feature: OCR is now the foundry PIPELINE, and the pipeline is
 * not a list of interchangeable recognizers.
 *
 *   render pages at 200 dpi → scan → ocr → blocks
 *
 * foundry's Tesseract is PINNED — an exact version, an exact tessdata, an exact
 * dpi — because the three models downstream were trained against that
 * segmentation. Offering a different recognizer here would not be offering a
 * choice; it would be offering a way to feed the models an input distribution
 * they have never seen, which produces a book that is quietly worse rather than
 * an error. So there is one button, and it runs the one pipeline.
 *
 * There are no options at all. Footnote-marker removal used to be a checkbox
 * here; it is the `foundry-footnotes` PASS now — a thing the user puts in a
 * processing run, ordered against the other passes, with a diff and a provenance
 * record. A second way to ask for it would be a second answer to "has this book
 * had its markers removed".
 *
 * ── THE RUN IS QUEUE WORK ────────────────────────────────────────────────────
 *
 * This dialog does not start a foundry run. It SUBMITS the same processing chain
 * the wizard submits — one OCR-correction pass over this project, which reads the
 * pages, repairs what it read and labels the blocks — through
 * `processing:submit-chain`, and then only watches. There is
 * one way to run OCR and it is visible on the Queue tab, where it serializes
 * against everything else that wants the GPU; a private direct-run path here was
 * a second way to spend half an hour that no queue row knew about.
 *
 * The run itself still belongs to MAIN (`electron/foundry-run.ts`), so closing
 * this dialog, reloading the window or switching tabs touches nothing. "Run in
 * Background" is literally "close this dialog".
 *
 * ── THE CORPUS PATH IS NOT THIS PATH ─────────────────────────────────────────
 *
 * `corpusBookDir` means this window is labelling a TRAINING book, and that flow
 * still runs the main-owned Tesseract pass (`corpus-ocr-run.ts`) because the
 * corpus is pinned to that segmenter by the training contract — the labels only
 * mean anything against the blocks the trainer will see. Every other document
 * goes to foundry, and there is no fallback in either direction.
 */

export type OcrEngine = string;
export type OcrScope = 'all' | 'current' | 'selected' | 'range';

export interface OcrSettings {
  engine: string;
  language: string;
  tesseractPsm: number;
}

export interface OcrJob {
  scope: OcrScope;
  pages?: number[];
  rangeStart?: number;
  rangeEnd?: number;
}

export type { OcrTextLine };

export interface OcrPageResult {
  page: number;
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];
}

export interface OcrCompletionEvent {
  results: OcrPageResult[];
}

/** What the window is told when a foundry run finishes and can be painted. */
export interface FoundryRunFinished {
  bookKey: string;
  pages: number[];
}

@Component({
  selector: 'app-ocr-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" (click)="close.emit()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>{{ corpusMode() ? 'OCR — Training Book' : 'OCR — Read This Book' }}</h2>
          <button class="close-btn" (click)="close.emit()">×</button>
        </div>

        <div class="modal-body">
          @if (!corpusMode()) {
            <!-- What is about to happen. Named, in order, because a 30-minute
                 run with an opaque spinner is indistinguishable from a hang. -->
            <div class="section">
              <h3 class="section-title">Pipeline</h3>
              <ol class="pipeline">
                @for (step of pipelineSteps; track step.id) {
                  <li
                    class="pipeline-step"
                    [class.active]="runState()?.stage === step.id"
                    [class.done]="stageIsDone(step.id)"
                  >
                    <span class="step-name">{{ step.name }}</span>
                    <span class="step-note">{{ step.note }}</span>
                  </li>
                }
              </ol>
            </div>
          }

          <div class="section">
            <h3 class="section-title">Pages</h3>
            @if (corpusMode()) {
              <div class="scope-options">
                <label class="radio-option">
                  <input type="radio" name="scope" value="all"
                    [checked]="scope() === 'all'" (change)="scope.set('all')" />
                  <span class="radio-label">
                    <strong>All pages</strong>
                    <span class="radio-hint">{{ totalPages() }} pages</span>
                  </span>
                </label>

                <label class="radio-option">
                  <input type="radio" name="scope" value="current"
                    [checked]="scope() === 'current'" (change)="scope.set('current')" />
                  <span class="radio-label">
                    <strong>Current page</strong>
                    <span class="radio-hint">Page {{ currentPage() + 1 }}</span>
                  </span>
                </label>

                <label class="radio-option">
                  <input type="radio" name="scope" value="range"
                    [checked]="scope() === 'range'" (change)="scope.set('range')" />
                  <span class="radio-label"><strong>Page range</strong></span>
                </label>

                @if (scope() === 'range') {
                  <div class="range-inputs">
                    <input type="number" class="range-input" [min]="1" [max]="totalPages()"
                      [ngModel]="rangeStart()" (ngModelChange)="rangeStart.set($event)" placeholder="From" />
                    <span class="range-separator">to</span>
                    <input type="number" class="range-input" [min]="1" [max]="totalPages()"
                      [ngModel]="rangeEnd()" (ngModelChange)="rangeEnd.set($event)" placeholder="To" />
                  </div>
                }
              </div>
            } @else {
              <!-- Stated, not chosen. A run directory covers ONE page set and the
                   book is exported from it, so a part of the document would build
                   a book out of a part of the document. -->
              <p class="estimate">
                The whole document — {{ totalPages() }} pages, in the order this editor has them.
              </p>
            }
          </div>

          @if (!corpusMode() && estimate()) {
            <p class="estimate">{{ estimate() }}</p>
          }

          @if (running()) {
            <div class="section">
              <h3 class="section-title">Progress</h3>
              <div class="progress-container">
                <div class="progress-bar" [class.indeterminate]="progressPercent() === 0">
                  <div class="progress-fill" [style.width.%]="progressPercent()"></div>
                </div>
                <div class="progress-status">
                  <span class="progress-text">{{ progressText() }}</span>
                  <span class="elapsed-time">{{ elapsedTimeText() }}</span>
                </div>
                @if (runState()?.message) {
                  <!-- foundry's own line, verbatim: it is the only place a
                       DEGRADED calibration or a rescued page ever gets said. -->
                  <pre class="foundry-line">{{ runState()!.message }}</pre>
                }
              </div>
            </div>
          }

          @if (queued() && !running() && !completed()) {
            <div class="section">
              <h3 class="section-title">Queued</h3>
              <p class="result-line">
                The run is in the queue. It starts when the queue reaches it, and
                the progress above fills in then — watch it here or on the Queue tab.
              </p>
            </div>
          }

          @if (completed()) {
            <div class="section">
              <h3 class="section-title">Result</h3>
              <p class="result-line">{{ resultLine() }}</p>
            </div>
          }

          @if (staleRun()) {
            <div class="warn-box">
              This book has a part-finished OCR run that nothing is working on —
              the app was closed while it was going.
              @if (corpusMode()) {
                Starting again picks up from the stage it reached; nothing already
                done is repeated.
              } @else {
                Starting again reads the book from the beginning: an OCR
                correction pass always rasterizes the pages and re-runs every
                stage, so nothing half-finished is carried into it.
              }
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
            <desktop-button variant="ghost" (click)="close.emit()">Close</desktop-button>
            @if (completed()) {
              <desktop-button variant="secondary" (click)="startRun(true)">Run again</desktop-button>
            }
            <desktop-button variant="primary" [disabled]="!canStart()" (click)="startRun(false)">
              {{ startLabel() }}
            </desktop-button>
          } @else {
            <desktop-button variant="ghost" (click)="close.emit()"
              title="The run continues in the main process — closing this changes nothing about it">
              Run in Background
            </desktop-button>
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
      max-width: 560px;
      min-height: 480px;
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

    .pipeline {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      counter-reset: step;
    }

    .pipeline-step {
      display: flex;
      align-items: baseline;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      border-left: 2px solid var(--border-subtle);
      counter-increment: step;

      &::before {
        content: counter(step);
        font-variant-numeric: tabular-nums;
        font-size: var(--ui-font-xs);
        color: var(--text-tertiary);
        min-width: 12px;
      }

      &.active {
        border-left-color: var(--accent);
        background: var(--accent-muted);
      }

      &.done {
        border-left-color: var(--success);
        opacity: 0.75;
      }
    }

    .step-name {
      font-size: var(--ui-font-base);
      color: var(--text-primary);
    }

    .step-note {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .scope-options {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
    }

    .radio-option, .checkbox-option {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      cursor: pointer;
      transition: background $duration-fast $ease-out;

      &:hover { background: var(--bg-hover); }

      input { margin-top: 3px; accent-color: var(--accent); }
    }

    .radio-label, .checkbox-label {
      display: flex;
      flex-direction: column;
      gap: 2px;

      strong { color: var(--text-primary); font-size: var(--ui-font-base); }
      .radio-hint, .checkbox-hint {
        color: var(--text-tertiary);
        font-size: var(--ui-font-sm);
        line-height: 1.45;
      }
    }

    .range-inputs {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-left: 24px;
      margin-top: var(--ui-spacing-sm);
    }

    .range-input {
      width: 80px;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
      text-align: center;

      &:focus { outline: none; border-color: var(--accent); }
    }

    .range-separator { color: var(--text-tertiary); font-size: var(--ui-font-sm); }

    .estimate {
      margin: 0;
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      line-height: 1.5;
    }

    .progress-container { margin-bottom: var(--ui-spacing-md); }

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

    .warn-box {
      padding: var(--ui-spacing-md);
      background: rgba(255, 152, 0, 0.1);
      border: 1px solid rgba(255, 152, 0, 0.3);
      border-radius: $radius-md;
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      line-height: 1.5;
      margin-bottom: var(--ui-spacing-md);
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
  `]
})
export class OcrSettingsModalComponent implements OnDestroy {
  // ── Inputs ────────────────────────────────────────────────────────────────
  currentSettings = input<OcrSettings>({ engine: 'tesseract', language: 'eng', tesseractPsm: 3 });
  totalPages = input<number>(0);
  currentPage = input<number>(0);
  /**
   * Kept for the corpus path and for the window's own render needs. The foundry
   * pipeline does NOT use it: main rasterizes straight out of the PDF with the
   * mupdf pool, grayscale at exactly 200 dpi, because that is the only render
   * foundry's pinned Tesseract is allowed to see.
   */
  getPageImage = input.required<(page: number) => string | null | Promise<string | null>>();
  documentId = input<string>('');
  documentName = input<string>('Document');
  lightweightMode = input<boolean>(false);
  pdfPath = input<string>('');
  /**
   * The document's file hash — the run key.
   *
   * It has to be stable across a renderer reload (so a fresh window re-attaches
   * to the run instead of offering to start a second one) and it has to change
   * when the document does. A path is not the first; a session id is not either.
   */
  bookKey = input<string>('');
  /**
   * The project the passes are queued against — an absolute project directory.
   *
   * Empty means the window is looking at a file that belongs to no project, and
   * that is refused rather than made into one here: minting a project as a side
   * effect of pressing OCR is what "the picker is the pipeline's front door"
   * meant, and it is what this change removes.
   */
  projectDir = input<string>('');
  /** Set when this window is labelling a TRAINING book. See the class comment. */
  corpusBookDir = input<string>('');

  // ── Outputs ───────────────────────────────────────────────────────────────
  close = output<void>();
  /** The legacy corpus/background path still reports page results this way. */
  ocrCompleted = output<OcrCompletionEvent>();
  backgroundJobStarted = output<string>();
  /** A foundry run finished — the window should read it and paint the blocks. */
  foundryFinished = output<FoundryRunFinished>();

  private readonly electronService = inject(ElectronService);
  private readonly queueService = inject(QueueService);

  readonly settings = signal<OcrSettings>({ engine: 'tesseract', language: 'eng', tesseractPsm: 3 });
  readonly scope = signal<OcrScope>('all');
  readonly rangeStart = signal<number>(1);
  readonly rangeEnd = signal<number>(1);

  /**
   * A foundry pass for this book is in the queue and has not started working.
   *
   * Read from the queue rather than remembered locally: this component is
   * destroyed every time the dialog closes, so a flag of its own would forget a
   * run that is still waiting its turn and offer to queue a second one.
   */
  readonly queued = computed(() =>
    this.queueService.jobs().some((job) =>
      (job.type === 'document-get-text' || job.type === 'document-blocks'
        || job.type === 'document-reflow')
      && (job.config as { bookKey?: string } | undefined)?.bookKey === this.bookKey()
      && (job.status === 'pending' || job.status === 'processing')));
  readonly running = signal(false);
  readonly completed = signal(false);
  readonly error = signal<string | null>(null);
  readonly runState = signal<FoundryRunState | null>(null);
  readonly resultLine = signal('');
  /** A run whose worker died with the app: real artifacts, nobody working. */
  readonly staleRun = signal(false);

  private startTime = 0;
  readonly elapsedSeconds = signal(0);
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Guards against emitting `foundryFinished` twice for the same run. */
  private announcedFinish = '';

  readonly corpusMode = computed(() => this.corpusBookDir().length > 0);

  /** Fixed: this dialog runs scan → ocr → blocks and nothing else. */
  readonly pipelineSteps = [
    { id: 'render', name: 'Render pages', note: '200 dpi grayscale' },
    { id: 'scan', name: 'Find the lines', note: 'pinned Tesseract' },
    { id: 'ocr', name: 'Repair the text', note: 'corrects what the scanner misread' },
    { id: 'blocks', name: 'Label the blocks', note: 'body, chapter, footnote, running head…' },
  ];

  constructor() {
    effect(() => {
      this.settings.set({ ...this.currentSettings() });
      this.rangeEnd.set(this.totalPages());
    }, { allowSignalWrites: true });

    this.watchRuns();
  }

  ngOnDestroy(): void {
    this.stopElapsedTimer();
    // Unsubscribing does NOT stop anything. That is the point of the run living
    // in main: closing this panel is a UI action, not a decision about the work.
    this.unsubscribe?.();
  }

  // ── Watching ──────────────────────────────────────────────────────────────

  private watchRuns(): void {
    const unsubCorpus = this.electronService.onCorpusOcrProgress((state) => {
      if (state.bookDir !== this.corpusBookDir()) return;
      this.applyCorpusRunState(state);
    });
    const unsubFoundry = this.electronService.onFoundryRunProgress((state) => {
      if (state.bookKey !== this.bookKey()) return;
      this.applyFoundryRunState(state);
    });
    this.unsubscribe = () => { unsubCorpus(); unsubFoundry(); };

    // Attach on open. This is what makes reopening the dialog mid-run show the
    // run rather than an invitation to start a second one.
    effect(() => {
      const corpusDir = this.corpusBookDir();
      if (corpusDir) {
        void this.electronService.corpusOcrAttach(corpusDir)
          .then(({ state }) => { if (state) this.applyCorpusRunState(state); })
          .catch(err => console.error('[OCR] Could not read the corpus run state:', err));
        return;
      }
      const key = this.bookKey();
      if (!key) return;
      void this.electronService.foundryRunAttach(key)
        .then(({ state, cleared }) => {
          // A failed run is swept by the attach, and the reason comes back
          // exactly once. This panel is where somebody opened to ask what
          // happened, so it says so in its own error line rather than showing
          // the blank "nothing has been read yet" face that the sweep leaves.
          if (cleared) {
            this.error.set(
              `The last run failed at the ${cleared.stage ?? 'foundry'} stage and was cleared, `
              + `so nothing from it was kept: ${cleared.message}`);
          }
          if (state) this.applyFoundryRunState(state);
        })
        .catch(err => console.error('[OCR] Could not read the foundry run state:', err));
    }, { allowSignalWrites: true });
  }

  private applyFoundryRunState(state: FoundryRunState): void {
    this.runState.set(state);

    const running = state.status === 'running' && state.live;
    this.running.set(running);
    this.staleRun.set(state.status === 'running' && !state.live);
    if (running && !this.elapsedTimer) this.startElapsedTimer(state.startedAt);

    if (!running) {
      this.stopElapsedTimer();
      this.completed.set(state.status === 'done');
      if (state.status === 'error') this.error.set(state.error ?? state.message);
      if (state.status === 'done') {
        this.error.set(null);
        this.resultLine.set(
          `${state.pages.length} ${state.pages.length === 1 ? 'page' : 'pages'} read. `
          + 'The text and the block labels are on the pages now — scan through them, '
          + 'delete anything that should not be in the book, then export.'
        );
        // Announced once per run. The window reads the run directory and paints
        // it; this component deliberately never holds the blocks, because it is
        // destroyed on close and a long run finishes most often after that.
        const stamp = `${state.bookKey}:${state.updatedAt}`;
        if (this.announcedFinish !== stamp) {
          this.announcedFinish = stamp;
          this.foundryFinished.emit({ bookKey: state.bookKey, pages: state.pages });
        }
      }
    }
  }

  private applyCorpusRunState(state: CorpusOcrRunState): void {
    const running = state.status === 'running';
    this.running.set(running);
    this.runState.set({
      bookKey: state.bookDir,
      runDir: state.bookDir,
      pdfPath: '',
      pages: [],
      status: state.status === 'cancelled' ? 'cancelled' : state.status,
      live: running,
      stage: 'scan',
      stageIndex: 1,
      stageCount: 1,
      message: state.currentPage !== null ? `page ${state.currentPage + 1}` : '',
      done: state.journalPages,
      total: state.bookPages,
      error: state.error,
      startedAt: state.startedAt,
      updatedAt: Date.now(),
    });
    if (running && !this.elapsedTimer) this.startElapsedTimer(state.startedAt);
    if (!running) {
      this.stopElapsedTimer();
      this.completed.set(state.status === 'done');
      if (state.status === 'error' && state.error) this.error.set(state.error);
      this.resultLine.set(`${state.journalPages} of ${state.bookPages} pages recognized.`);
    }
  }

  // ── Starting ──────────────────────────────────────────────────────────────

  canStart(): boolean {
    if (this.running() || this.queued()) return false;
    if (this.totalPages() <= 0) return false;
    if (this.corpusMode()) return true;
    return !!this.bookKey() && !!this.pdfPath() && !!this.projectDir();
  }

  startLabel(): string {
    // Only the corpus pipeline resumes. A project's OCR-correction pass starts
    // the run directory over every time it is submitted, so "Resume" would be a
    // button promising something the run does not do.
    if (this.staleRun() && this.corpusMode()) return 'Resume';
    return this.corpusMode() ? 'Start OCR' : 'Read this book';
  }

  async startRun(redo: boolean): Promise<void> {
    this.error.set(null);
    this.completed.set(false);
    this.resultLine.set('');

    if (this.corpusMode()) {
      const pages = this.getPageList();
      if (pages.length === 0) {
        this.error.set('No pages selected.');
        return;
      }
      try {
        const state = await this.electronService.corpusOcrStart({
          bookDir: this.corpusBookDir(),
          engine: this.settings().engine,
          language: this.settings().language,
          pages,
          redo,
        });
        this.applyCorpusRunState(state);
      } catch (err) {
        this.error.set(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (!this.projectDir()) {
      // No project, no run. The chain writes provenance and a book EPUB into a
      // manifest, and there is nothing here to write them into — say so and name
      // where a project comes from, rather than making one on the way past.
      this.error.set(
        'This document does not belong to a BookForge project, and an OCR run writes its '
        + 'result into one. Import it from Studio, then run the passes from the Process tab.'
      );
      return;
    }

    // The SAME submission the wizard uses — the document passes over this
    // project's PDF, planned in main and queued as one run. This dialog's whole
    // purpose is to take a book from an untouched PDF to a curatable one, so it
    // asks for both rather than making the user compose them; the wizard is where
    // a run is slimmed down to one pass.
    //
    // There is no run identity to pass. A document pass is about the PROJECT and
    // the PDF the plan resolved, and its output is the working document beside
    // them — so there is no run directory for a key to name, and no window
    // watching one.
    //
    // NO FALLBACK. If foundry is not installed, or a GGUF is missing, or the
    // ordering cannot work, main says exactly which and this dialog prints it.
    try {
      const result = await this.queueService.submitProcessingRun({
        projectDir: this.projectDir(),
        sourcePath: this.pdfPath(),
        // Detect AFTER the cast, and not optional here: Get Text replaces the
        // working document, which leaves it carrying no annotations at all. The
        // planner refuses the pair the other way round, by name.
        passes: [{ kind: 'get-text' }, { kind: 'blocks' }],
      });
      if (!result.success) {
        this.error.set(result.error || 'The run was refused and no reason was given.');
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  async cancelRun(): Promise<void> {
    try {
      if (this.corpusMode()) {
        await this.electronService.corpusOcrCancel(this.corpusBookDir());
      } else {
        // Stops at the next stage boundary. Every artifact already written stays
        // on disk and the editor can still read it — but starting the pass again
        // does NOT resume from it: an OCR-correction pass reads the book from the
        // page images every time.
        await this.electronService.foundryRunCancel(this.bookKey());
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Display ───────────────────────────────────────────────────────────────

  stageIsDone(stage: string): boolean {
    const state = this.runState();
    if (!state) return false;
    if (state.status === 'done') return true;
    const order = this.pipelineSteps.map(s => s.id);
    const current = state.stage ? order.indexOf(state.stage) : -1;
    return current > order.indexOf(stage);
  }

  progressPercent(): number {
    const state = this.runState();
    if (!state || state.total <= 0) return 0;
    return Math.min(100, (state.done / state.total) * 100);
  }

  progressText(): string {
    const state = this.runState();
    if (!state) return '';
    const stage = this.pipelineSteps.find(s => s.id === state.stage);
    const name = stage?.name ?? state.stage ?? 'Working';
    if (state.total > 0) {
      return `${name} — ${state.done} of ${state.total}`;
    }
    return `${name}…`;
  }

  /**
   * A rough duration, from the one measured rate that dominates.
   *
   * The ocr stage is ~0.8 s a line serialized and everything else is minutes at
   * most, so lines are the whole estimate. Lines per page varies by book, hence
   * "about"; a number with no hedge on a 30-minute wait is worse than a range.
   */
  estimate(): string | null {
    const pages = this.corpusMode() ? this.getPageList().length : this.totalPages();
    if (pages === 0) return null;
    const minutes = Math.round((pages * 40 * 0.8) / 60);
    const shape = minutes < 1 ? 'under a minute'
      : minutes < 60 ? `about ${minutes} minute${minutes === 1 ? '' : 's'}`
      : `about ${(minutes / 60).toFixed(1)} hours`;
    return `${pages} page${pages === 1 ? '' : 's'} — ${shape}. `
      + 'It keeps going if you close this dialog, and picks up where it stopped if you cancel.';
  }

  elapsedTimeText(): string {
    const seconds = this.elapsedSeconds();
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    return `${mins}m ${seconds % 60}s`;
  }

  private startElapsedTimer(startedAt: number): void {
    this.startTime = startedAt || Date.now();
    this.elapsedSeconds.set(Math.floor((Date.now() - this.startTime) / 1000));
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

  getPageList(): number[] {
    switch (this.scope()) {
      case 'all':
        return Array.from({ length: this.totalPages() }, (_, i) => i);
      case 'current':
        return [this.currentPage()];
      case 'range': {
        const start = Math.max(0, this.rangeStart() - 1);
        const end = Math.min(this.totalPages(), this.rangeEnd());
        return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
      }
      default:
        return [];
    }
  }
}
