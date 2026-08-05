import { Component, input, output, signal, computed, effect, inject, ChangeDetectionStrategy, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { ElectronService, CorpusOcrRunState } from '../../../../core/services/electron.service';
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
 * The only options are the two about WATCHING — run in background, open when
 * finished — and neither changes the work. Footnote-marker removal used to be a
 * checkbox here; it is a pass on the EPUB station now, with a diff and a
 * provenance record, and a second way to ask for it would be a second answer to
 * "has this book had its markers removed".
 *
 * ── IT SUBMITS THE CAST, AND ONLY THE CAST ───────────────────────────────────
 *
 * RULED 2026-08-04 (docs/PIPELINE_V2_PLAN.md, Owen's first real session):
 * "detect is a separate step that shouldnt be grouped with ocr correction. it
 * added detect to the queue even though i hadnt chosen to detect yet."
 *
 * So this dialog submits ONE document pass — `get-text`, which casts the working
 * PDF and puts the words in it — through `processing:submit-chain`, and then
 * only watches. Detect is a press of its own, offered as the primary action at
 * the Working station the moment a book has been read and not yet detected.
 * (The cast really does leave the document with no annotations at all; that is
 * why the Working station SAYS so, rather than why this dialog quietly bought a
 * second stage.)
 *
 * There is one way to read a book and it is visible on the Queue tab, where it
 * serializes against everything else that wants the GPU; a private direct-run
 * path here was a second way to spend half an hour that no queue row knew about.
 *
 * The stages belong to MAIN, so closing this dialog, reloading the window or
 * switching tabs touches nothing. Progress is reported INLINE here by default;
 * "run in background" hands the run to the queue and takes the user with it.
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

/**
 * A stage as this dialog shows it: which one, its own most recent line, and how
 * far through it is.
 *
 * Deliberately not a status. A document stage is a process — when it stops there
 * is nothing left holding a state for this to mirror, and whether the BOOK is
 * ready is read off the document instead (`readDocumentState`). This is only
 * what to draw while something is working.
 */
interface StageView {
  stage: string;
  /** foundry's own line, verbatim: the only place a DEGRADED calibration is said. */
  message: string;
  done: number;
  total: number;
}

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
              <!-- Stated, not chosen. Get Text REPLACES the working document, so
                   reading part of the book would leave a working copy that is
                   part of the book, and everything after it would build one. -->
              <p class="estimate">
                The whole document — {{ totalPages() }} pages, in the order this editor has them.
              </p>
            }
          </div>

          @if (!corpusMode() && estimate()) {
            <p class="estimate">{{ estimate() }}</p>
          }

          @if (!corpusMode()) {
            <!--
              How the run is WATCHED, never what it does. It runs in the main
              process either way; these say whether this dialog stays to watch
              it and whether the window follows the working copy it makes.
            -->
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
                    Hand it to the queue and go there, so you can see where it went. It
                    serializes on the Queue tab against everything else that wants the GPU.
                    Leave this off and the progress below is the run.
                  </span>
                </span>
              </label>
              <label class="checkbox-option">
                <input
                  type="checkbox"
                  [checked]="openWhenFinished()"
                  (change)="openWhenFinishedChange.emit($any($event.target).checked)"
                />
                <span class="checkbox-label">
                  <strong>Open when finished</strong>
                  <span class="checkbox-hint">
                    Show the working copy the moment the run lands, wherever you are by then —
                    the app opens this book's editor even if you closed it.
                  </span>
                </span>
              </label>
            </div>
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

          @if (waiting() && !running() && !completed()) {
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
                Starting again reads the book from the beginning: Get Text
                rasterizes every page and casts the working copy afresh, so
                nothing half-finished is carried into it.
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
              title="The stage continues in the main process — closing this changes nothing about it">
              Stop watching
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
  /**
   * The window's two long-run habits, owned by the picker so this dialog and the
   * station bar cannot answer them differently. Neither changes the WORK.
   */
  runInBackground = input<boolean>(false);
  openWhenFinished = input<boolean>(true);

  // ── Outputs ───────────────────────────────────────────────────────────────
  close = output<void>();
  runInBackgroundChange = output<boolean>();
  openWhenFinishedChange = output<boolean>();
  /** The legacy corpus/background path still reports page results this way. */
  ocrCompleted = output<OcrCompletionEvent>();
  backgroundJobStarted = output<string>();
  /**
   * The run was handed to the queue and the user goes with it.
   *
   * The dialog says WHEN; the window it lives in says how, because "leave the
   * picker and land on the Queue" is a different action from a detached editor
   * window than from an embedded tab, and this component knows which it is in
   * about as well as it knows what the queue is doing.
   */
  handOffToQueue = output<void>();
  /**
   * The working document now carries a block layer — the window should read it
   * and paint it.
   *
   * Carries nothing. There is no run to identify and no page list to hand over:
   * the window re-reads the document, which is the only thing that knows what is
   * in it.
   */
  documentReadyToPaint = output<void>();

  private readonly electronService = inject(ElectronService);
  private readonly queueService = inject(QueueService);

  readonly settings = signal<OcrSettings>({ engine: 'tesseract', language: 'eng', tesseractPsm: 3 });
  readonly scope = signal<OcrScope>('all');
  readonly rangeStart = signal<number>(1);
  readonly rangeEnd = signal<number>(1);

  /**
   * A document pass for this book is in the queue and has not started working.
   *
   * Read from the queue rather than remembered locally: this component is
   * destroyed every time the dialog closes, so a flag of its own would forget a
   * run that is still waiting its turn and offer to queue a second one.
   *
   * It can only ever answer in the MAIN window. `processing:submit-chain` sends
   * the plan to the main window and nowhere else, so the QueueService in a
   * detached editor window — which is where the picker actually lives — never
   * hears about the run and holds no job for it. That is what `submitted` below
   * is for, and why the two are read together rather than one standing in for
   * the other.
   */
  readonly queued = computed(() =>
    this.queueService.jobs().some((job) =>
      (job.type === 'document-get-text' || job.type === 'document-blocks'
        || job.type === 'document-reflow')
      && (job.config as { projectDir?: string } | undefined)?.projectDir === this.projectDir()
      && (job.status === 'pending' || job.status === 'processing')));

  /**
   * THIS dialog submitted a run and no stage has reported starting yet.
   *
   * The gap is short and real: the plan travels to main, comes back as a queue
   * message to another window, and the row starts when the queue reaches it.
   * Without this the button would still read "Read this book" in that gap and a
   * second press would queue a second cast of the same book.
   *
   * Deliberately not persisted and not a status. It is cleared the moment a
   * stage says it started, which is when `running` takes over.
   */
  readonly submitted = signal(false);

  /** A run for this book exists and has not begun reporting. */
  readonly waiting = computed(() => this.queued() || this.submitted());
  readonly running = signal(false);
  readonly completed = signal(false);
  readonly error = signal<string | null>(null);
  readonly runState = signal<StageView | null>(null);
  readonly resultLine = signal('');
  /** A run whose worker died with the app: real artifacts, nobody working. */
  readonly staleRun = signal(false);
  /** The working document carries a block layer — the book is ready to curate. */
  readonly documentReady = signal(false);

  private startTime = 0;
  readonly elapsedSeconds = signal(0);
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Guards against announcing the same document state twice. */
  private announcedFinish = '';

  readonly corpusMode = computed(() => this.corpusBookDir().length > 0);

  /**
   * Fixed: this dialog runs the CAST, and nothing else.
   *
   * Labelling the blocks is not here, and neither is repairing what Tesseract
   * misread — and both absences are the point. Detect is its own press at the
   * Working station (Owen's ruling, 2026-08-04); repair happens inside Build the
   * book, on the blocks that survived curation, so the running heads and
   * footnotes deleted on the next screen cost no GPU at all. Naming either here
   * would promise work this run does not do.
   *
   * `render` only happens for a scanned book — a PDF that carries the
   * publisher's own text layer is read straight out of it in one pass — so the
   * step draws only when the run reports it.
   */
  readonly pipelineSteps = [
    { id: 'render', name: 'Render pages', note: '200 dpi grayscale — scans only' },
    { id: 'get-text', name: 'Read the pages', note: 'written into the working PDF' },
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

    // A document stage reports itself three ways — started, each line while it
    // works, finished — and all three are keyed by PROJECT, because that is what
    // a stage is about. There is no run to attach to and no run identity to
    // match: the stage is a process, and when it stops there is nothing left
    // holding a status.
    const unsubStarted = this.electronService.onDocumentStageStarted((event) => {
      if (event.projectDir !== this.projectDir()) return;
      this.error.set(null);
      this.completed.set(false);
      // The wait is over the moment a stage says it started; `running` is the
      // truth from here on, and two ways of saying "something is happening"
      // would eventually disagree.
      this.submitted.set(false);
      this.running.set(true);
      this.runState.set({ stage: event.stage, message: '', done: 0, total: 0 });
      if (!this.elapsedTimer) this.startElapsedTimer(Date.now());
    });
    const unsubProgress = this.electronService.onDocumentStageProgress((event) => {
      if (event.projectDir !== this.projectDir()) return;
      this.running.set(true);
      this.runState.set({
        stage: event.stage,
        message: event.message,
        done: event.done,
        total: event.total,
      });
    });
    const unsubFinished = this.electronService.onDocumentStageFinished((event) => {
      if (event.projectDir !== this.projectDir()) return;
      this.running.set(false);
      this.stopElapsedTimer();
      // Whether the book is READY is a fact about the document, not about the
      // stage that just stopped — a Get Text that finished is a book with no
      // blocks yet. So it is read back off the document rather than inferred
      // from the stage having ended.
      void this.readDocumentState();
    });

    this.unsubscribe = () => {
      unsubCorpus(); unsubStarted(); unsubProgress(); unsubFinished();
    };

    // On open. This is what makes reopening the dialog after a run show what the
    // book actually carries rather than an invitation to read it again.
    effect(() => {
      const corpusDir = this.corpusBookDir();
      if (corpusDir) {
        void this.electronService.corpusOcrAttach(corpusDir)
          .then(({ state }) => { if (state) this.applyCorpusRunState(state); })
          .catch(err => console.error('[OCR] Could not read the corpus run state:', err));
        return;
      }
      if (!this.projectDir()) return;
      void this.readDocumentState();
    }, { allowSignalWrites: true });
  }

  /**
   * What this book's documents say has happened to them.
   *
   * The whole of "has this book been read yet", measured off the files: a marker
   * means Get Text has run. A book whose working document was never cast simply
   * reports nothing, which is an ordinary state and not an error — so nothing is
   * said about it.
   *
   * The question is `stages.getText` and NOT `stages.blocks`, because this
   * dialog submits the cast and only the cast: keyed to the block layer, it
   * would report a finished cast as unfinished forever on a book nobody had
   * detected yet, which is now every book the moment it lands.
   */
  private async readDocumentState(): Promise<void> {
    try {
      const state = await this.electronService.documentState({
        projectDir: this.projectDir(),
        sourcePath: this.pdfPath(),
      });
      this.documentReady.set(state.stages.getText);
      this.completed.set(state.stages.getText);
      if (state.stages.getText) {
        this.resultLine.set(
          `The pages are read: ${this.totalPages()} page${this.totalPages() === 1 ? '' : 's'} of `
          + 'text are in the working copy now. '
          + (state.stages.blocks
            ? `It carries ${state.blockCount} labelled block${state.blockCount === 1 ? '' : 's'} — `
              + 'curate them and build the book.'
            : 'Nothing is labelled yet — press Detect on the Working station, which is the next step.')
        );
        // Announced once per document state. The window re-reads the working
        // document and paints it; this component deliberately never holds the
        // blocks, because it is destroyed on close and a long run most often
        // finishes after that.
        const stamp = `${this.projectDir()}:${state.blockCount}`;
        if (this.announcedFinish !== stamp) {
          this.announcedFinish = stamp;
          this.documentReadyToPaint.emit();
        }
      }
    } catch (err) {
      // A book with no working document yet is the ordinary case on first open
      // and reads as "nothing has happened", not as a failure — the error names
      // the stage that casts one, which is exactly what this dialog offers.
      this.documentReady.set(false);
      console.log('[OCR] No working document for this book yet:', (err as Error).message);
    }
  }

  private applyCorpusRunState(state: CorpusOcrRunState): void {
    const running = state.status === 'running';
    this.running.set(running);
    this.runState.set({
      stage: 'get-text',
      message: state.currentPage !== null ? `page ${state.currentPage + 1}` : '',
      done: state.journalPages,
      total: state.bookPages,
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
    if (this.running() || this.waiting()) return false;
    if (this.totalPages() <= 0) return false;
    if (this.corpusMode()) return true;
    return !!this.pdfPath() && !!this.projectDir();
  }

  startLabel(): string {
    // Only the corpus pipeline resumes. Get Text REPLACES the working document
    // every time it is submitted, so "Resume" would be a button promising
    // something the stage does not do.
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
        'This document does not belong to a BookForge project, and reading a book writes the '
        + 'working copy into one. Import it from Studio first.'
      );
      return;
    }

    // THE CAST, and only the cast. Detect is a separate step and a separate
    // queue job (Owen's ruling, 2026-08-04) — bundling it here is what put a
    // Detect in the queue that nobody had asked for.
    //
    // There is no run identity to pass. A document pass is about the PROJECT and
    // the PDF the plan resolved, and its output is the working document beside
    // them — so there is nothing for a key to name and no window watching one.
    //
    // NO FALLBACK. If foundry is not installed, or a GGUF is missing, or the
    // ordering cannot work, main says exactly which and this dialog prints it.
    try {
      // Asked for BEFORE the run is submitted, and asked for whether or not this
      // dialog stays: the promise belongs to the app, and a run started with the
      // box ticked pays out even after this window is gone.
      if (this.openWhenFinished()) {
        await this.electronService.documentRequestOpenWhenFinished(this.projectDir(), 'working');
      }
      const result = await this.queueService.submitProcessingRun({
        projectDir: this.projectDir(),
        sourcePath: this.pdfPath(),
        passes: [{ kind: 'get-text' }],
      });
      if (!result.success) {
        this.error.set(result.error || 'The run was refused and no reason was given.');
        // A refused run will never finish, so the promise it staged has to come
        // back off the shelf — otherwise the NEXT stage over this book, whatever
        // it is, would pay out a request the user never got.
        await this.electronService.documentCancelOpenWhenFinished(this.projectDir());
        return;
      }
      this.submitted.set(true);
      // Inline is the default: this dialog stays and the progress above IS the
      // run. "Run in background" hands it over in front of the user — the window
      // leaves the picker and lands on the Queue, so the hand-off is witnessed
      // rather than inferred.
      if (this.runInBackground()) this.handOffToQueue.emit();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  async cancelRun(): Promise<void> {
    try {
      if (this.corpusMode()) {
        await this.electronService.corpusOcrCancel(this.corpusBookDir());
      } else {
        // Aborted where it stands. foundry builds each update completely in
        // memory and renames a staged temp into place, so a stopped stage leaves
        // the working document exactly as it stood before it started — there is
        // no half-written state to resume from, and none to clean up.
        await this.electronService.documentCancelStage(this.projectDir());
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Display ───────────────────────────────────────────────────────────────

  stageIsDone(stage: string): boolean {
    if (this.documentReady()) return true;
    const state = this.runState();
    if (!state) return false;
    const order = this.pipelineSteps.map(s => s.id);
    return order.indexOf(state.stage) > order.indexOf(stage);
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
    // A stage the step list does not name still reports itself by its own name —
    // this dialog submits two stages, and the queue may be running a third over
    // the same book.
    const name = stage ? stage.name : state.stage;
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
      + 'It runs in the main process, so it keeps going if you close this dialog. Cancelling '
      + 'stops it where it stands and leaves the book exactly as it was — the cast is all or '
      + 'nothing, and starting again reads the whole book again.';
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
